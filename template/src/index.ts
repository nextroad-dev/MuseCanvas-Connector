import type {
  BoundedOutput,
  ExecutionContext,
  IntegerParameterDescriptor,
  JsonValue,
  MediaInputImage,
  MediaModelDeclaration,
  MediaProviderManifest,
  MediaProviderPlugin,
  MediaRequest,
  OperationResult,
  OutputDescriptor,
  ParameterDescriptor,
  ProbeResult,
  ProviderConfig,
  SafeHttpResponse,
} from './host-types'
import { diagnostic, diagnosticFromHttp, providerError } from './errors'
import { hostMatchesAllowlist } from './url-guard'
// The single source of the manifest. esbuild inlines the JSON, so the bundle carries
// the same declaration the admin console reads from manifest.json.
import manifestFile from '../manifest.json'

/*
 * Example async video plugin (template).
 *
 * Placeholder vendor API (replace with the real one):
 *   POST {base}/v1/videos              -> 200 { id }
 *   GET  {base}/v1/videos/{id}         -> 200 { status, progress?, video?: { url, duration_seconds?, mime_type? }, error?: { code, message } }
 *   POST {base}/v1/videos/{id}/cancel  -> 200 { status } | 404
 *   GET  {base}/v1/models              -> probe
 *
 * Rules this file follows (wiki/video-plugin-spec.md):
 * - all network through context.http, every call with timeoutMs (2.3, 2.4);
 * - transient errors never map to `failed` (3.1);
 * - opaqueState only holds identifiers (5.1);
 * - parameter limits are read from the manifest's capabilities, not restated (2.6, 7);
 * - no runtime imports, no fetch, no process.*, no top-level await (10.2).
 */

// Strip the `package` block: bundle.manifest must equal manifest.json minus `package`.
const { package: _package, ...declared } = manifestFile
export const manifest = declared as MediaProviderManifest

const PLUGIN_ID = manifest.id
const PLUGIN_VERSION = manifest.version

const DEFAULT_BASE_URL = manifest.credential?.baseUrl.default ?? 'https://api.example-video.example'
const DEFAULT_RETRY_AFTER_MS = 5_000
const MAX_RETRY_AFTER_MS = 30_000
const DEFAULT_PROBE_TIMEOUT_MS = 15_000
const MAX_PROMPT_CHARS = 4_000
const MAX_INPUT_IMAGE_BYTES = 20_000_000
const MAX_OUTPUT_BYTES = 100_000_000
const MAX_VIDEO_URL_CHARS = 4_096

function fail(code: Parameters<typeof providerError>[2], detail: string) {
  return providerError(PLUGIN_ID, PLUGIN_VERSION, code, detail)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function modelFor(modelId: string): MediaModelDeclaration | undefined {
  return manifest.models?.find(model => model.id === modelId)
}

function descriptorFor(modelId: string, name: string): ParameterDescriptor | undefined {
  return modelFor(modelId)?.capabilities?.parameters.find(descriptor => descriptor.name === name)
}

/** Checks one value against its declared descriptor (enum / integer only in this template). */
function checkDeclaredValue(descriptor: ParameterDescriptor, value: JsonValue): string | null {
  if (descriptor.type === 'enum') {
    const options = descriptor.options.map(option => (typeof option === 'string' ? option : option.value))
    return typeof value === 'string' && options.includes(value) ? null : `must be one of ${options.join(', ')}`
  }
  if (descriptor.type === 'integer') {
    const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = descriptor as IntegerParameterDescriptor
    return Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? null : `must be an integer between ${min} and ${max}`
  }
  return `has unsupported descriptor type '${descriptor.type}'`
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw.trim())
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, Math.round(seconds * 1_000)))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

/** Wire fields this plugin forwards: a whitelist built from declared parameters only. */
type VideoControls = { duration?: number; aspect_ratio?: string; resolution?: string; seed?: number }

export class ExampleVideoPlugin implements MediaProviderPlugin {
  readonly manifest = manifest

  async probe(config: ProviderConfig, context: ExecutionContext): Promise<ProbeResult> {
    // Invalid config is an error (thrown); a reachable-but-unhealthy vendor is a result.
    this.validateConfig(config)
    const start = Date.now()
    try {
      const response = await context.http.get(`${this.baseUrl(config)}/v1/models`, {
        headers: this.authHeaders(config),
        timeoutMs: config.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      })
      if (response.ok) return { healthy: true, latencyMs: Date.now() - start }
      const message = response.status === 401 || response.status === 403 ? 'API key rejected' : `HTTP ${response.status}`
      return { healthy: false, message, latencyMs: Date.now() - start }
    } catch (error) {
      return { healthy: false, message: error instanceof Error ? error.message : 'probe failed', latencyMs: Date.now() - start }
    }
  }

  validateConfig(config: ProviderConfig): void {
    if (!this.apiKey(config)) throw fail('PROVIDER_NOT_CONFIGURED', 'Example Video API key is missing')
    const allowed = new URL(DEFAULT_BASE_URL).hostname
    for (const candidate of [config.baseUrl, config.credential?.baseUrl]) {
      if (candidate === undefined || candidate === '') continue
      let parsed: URL
      try {
        parsed = new URL(candidate)
      } catch {
        throw fail('INVALID_CONFIG', 'baseUrl is not a valid URL')
      }
      if (parsed.protocol !== 'https:') throw fail('INVALID_CONFIG', 'baseUrl must use https')
      // baseUrl.policy is 'fixed': only the declared default host is acceptable.
      if (parsed.hostname !== allowed || !hostMatchesAllowlist(parsed.hostname, manifest.allowedHosts)) {
        throw fail('INVALID_CONFIG', 'baseUrl host is not the fixed Example Video endpoint')
      }
    }
  }

  validateRequest(request: MediaRequest, _config?: ProviderConfig): void {
    if (request.modality !== 'video') throw fail('INVALID_REQUEST', `video modality only, got '${request.modality}'`)
    const model = modelFor(request.vendorModelId)
    if (!model) throw fail('INVALID_REQUEST', `model '${request.vendorModelId}' is not declared by this plugin`)
    if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw fail('INVALID_REQUEST', 'prompt must be a non-empty string')
    if (request.prompt.length > MAX_PROMPT_CHARS) throw fail('INVALID_REQUEST', `prompt exceeds ${MAX_PROMPT_CHARS} characters`)

    const maxCount = model.capabilities?.maxCount ?? 1
    if (request.count !== undefined && (!Number.isInteger(request.count) || request.count < 1 || request.count > maxCount)) {
      throw fail('INVALID_REQUEST', `count must be an integer between 1 and ${maxCount}`)
    }

    const images = request.inputImages ?? []
    const slot = model.capabilities?.inputSlots.find(candidate => candidate.role === 'first_frame')
    const maxImages = slot?.maxCount ?? 0
    if (images.length > maxImages) throw fail('INVALID_REQUEST', `at most ${maxImages} input image(s) are supported`)
    for (const image of images) this.checkInputImage(image)

    this.videoControls(request)
  }

  async submit(request: MediaRequest, config: ProviderConfig, context: ExecutionContext): Promise<OperationResult> {
    this.validateConfig(config)
    this.validateRequest(request, config)

    const body: Record<string, unknown> = {
      model: request.vendorModelId,
      prompt: request.prompt,
      ...this.videoControls(request),
    }
    const firstFrame = request.inputImages?.[0]
    if (firstFrame) {
      const data = typeof firstFrame.data === 'string' ? firstFrame.data : bytesToBase64(firstFrame.data)
      body.first_frame = `data:${firstFrame.mimeType};base64,${data}`
    }

    const headers: Record<string, string> = { ...this.authHeaders(config), 'content-type': 'application/json' }
    const idempotencyKey = this.idempotencyKey(config)
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey

    const response = await context.http.post(`${this.baseUrl(config)}/v1/videos`, JSON.stringify(body), {
      headers,
      timeoutMs: config.timeoutMs,
    })

    if (!response.ok) {
      const error = diagnosticFromHttp(PLUGIN_ID, PLUGIN_VERSION, response, await response.text())
      // 429/5xx: the vendor may or may not have accepted the task -> let the worker re-drive.
      if (error.code === 'PROVIDER_TEMPORARY_ERROR') {
        return { status: 'submission_unknown', retryAfterMs: parseRetryAfterMs(response.headers) ?? DEFAULT_RETRY_AFTER_MS, error }
      }
      return { status: 'failed', error }
    }

    const json = await this.readJson(response)
    const id = typeof json.id === 'string' && json.id ? json.id : undefined
    if (!id) {
      return { status: 'submission_unknown', error: diagnostic(PLUGIN_ID, PLUGIN_VERSION, 'PROVIDER_EMPTY_RESULT', 'vendor returned no task id') }
    }
    const duration = this.videoControls(request).duration
    return {
      status: 'waiting',
      remoteId: id,
      retryAfterMs: parseRetryAfterMs(response.headers) ?? DEFAULT_RETRY_AFTER_MS,
      // Identifiers only: never keys, tokens or URLs.
      opaqueState: { taskId: id, model: request.vendorModelId, ...(duration !== undefined ? { durationSeconds: duration } : {}) },
    }
  }

  async poll(remoteId: string, opaqueState: Record<string, unknown> | undefined, config: ProviderConfig, context: ExecutionContext): Promise<OperationResult> {
    this.validateConfig(config)
    if (!remoteId) throw fail('INVALID_REQUEST', 'remoteId is required for poll')
    const state = opaqueState ?? { taskId: remoteId }

    const response = await context.http.get(`${this.baseUrl(config)}/v1/videos/${encodeURIComponent(remoteId)}`, {
      headers: this.authHeaders(config),
      timeoutMs: config.timeoutMs,
    })
    const retryAfterMs = parseRetryAfterMs(response.headers) ?? DEFAULT_RETRY_AFTER_MS
    if (!response.ok) {
      const error = diagnosticFromHttp(PLUGIN_ID, PLUGIN_VERSION, response, await response.text())
      if (error.code === 'PROVIDER_TEMPORARY_ERROR') return { status: 'waiting', remoteId, retryAfterMs, opaqueState: state, error }
      return { status: 'failed', remoteId, opaqueState: state, error }
    }

    const json = await this.readJson(response)
    const status = typeof json.status === 'string' ? json.status.toLowerCase() : ''

    if (status === 'queued' || status === 'running') {
      const progress = typeof json.progress === 'number' && Number.isFinite(json.progress) ? Math.min(100, Math.max(0, json.progress)) : undefined
      return { status: 'waiting', remoteId, retryAfterMs, opaqueState: state, ...(progress !== undefined ? { progress } : {}) }
    }

    if (status === 'succeeded') {
      const video = isRecord(json.video) ? json.video : {}
      const url = typeof video.url === 'string' ? video.url : ''
      if (!url || url.length > MAX_VIDEO_URL_CHARS) {
        return { status: 'failed', remoteId, opaqueState: state, error: diagnostic(PLUGIN_ID, PLUGIN_VERSION, 'PROVIDER_EMPTY_RESULT', 'task succeeded without a video url') }
      }
      if (!this.isAllowedOutputUrl(url)) {
        return { status: 'failed', remoteId, opaqueState: state, error: diagnostic(PLUGIN_ID, PLUGIN_VERSION, 'UNSAFE_URL', 'video url is not https or not in allowedHosts') }
      }
      const reported = typeof video.duration_seconds === 'number' && Number.isFinite(video.duration_seconds) ? video.duration_seconds : undefined
      const durationSeconds = reported ?? (typeof state.durationSeconds === 'number' ? state.durationSeconds : undefined)
      const mimeType = typeof video.mime_type === 'string' && video.mime_type.startsWith('video/') ? video.mime_type : 'video/mp4'
      const output: OutputDescriptor = {
        index: 0,
        mimeType,
        url,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        metadata: { remoteId },
      }
      return { status: 'succeeded', remoteId, opaqueState: state, outputs: [output] }
    }

    if (status === 'canceled' || status === 'cancelled') return { status: 'canceled', remoteId, opaqueState: state }

    if (status === 'failed') {
      const error = isRecord(json.error) ? json.error : {}
      const code = typeof error.code === 'string' ? error.code : ''
      const message = typeof error.message === 'string' ? error.message : ''
      // Content moderation and vendor task failures are deterministic: terminal.
      return {
        status: 'failed',
        remoteId,
        opaqueState: state,
        error: diagnostic(PLUGIN_ID, PLUGIN_VERSION, 'PROVIDER_REJECTED', `task failed${code ? ` [${code}]` : ''}${message ? `: ${message}` : ''}`),
      }
    }

    // Unknown non-terminal status: keep waiting (forward compatible).
    return { status: 'waiting', remoteId, retryAfterMs, opaqueState: state }
  }

  async cancel(remoteId: string, opaqueState: Record<string, unknown> | undefined, config: ProviderConfig, context: ExecutionContext): Promise<OperationResult> {
    this.validateConfig(config)
    if (!remoteId) throw fail('INVALID_REQUEST', 'remoteId is required for cancel')
    const state = opaqueState ?? { taskId: remoteId }

    const response = await context.http.post(`${this.baseUrl(config)}/v1/videos/${encodeURIComponent(remoteId)}/cancel`, undefined, {
      headers: this.authHeaders(config),
      timeoutMs: config.timeoutMs,
    })
    // The task no longer exists: already terminal, treat as canceled.
    if (response.status === 404) return { status: 'canceled', remoteId, opaqueState: state }
    if (!response.ok) {
      const error = diagnosticFromHttp(PLUGIN_ID, PLUGIN_VERSION, response, await response.text())
      if (error.code === 'PROVIDER_TEMPORARY_ERROR') return { status: 'waiting', remoteId, retryAfterMs: DEFAULT_RETRY_AFTER_MS, opaqueState: state, error }
      return { status: 'failed', remoteId, opaqueState: state, error }
    }
    const json = await this.readJson(response)
    const status = typeof json.status === 'string' ? json.status.toLowerCase() : ''
    if (status === '' || status === 'canceled' || status === 'cancelled') return { status: 'canceled', remoteId, opaqueState: state }
    // Accepted but still draining.
    return { status: 'waiting', remoteId, retryAfterMs: 3_000, opaqueState: state }
  }

  async openOutput(descriptor: OutputDescriptor, config: ProviderConfig, context: ExecutionContext): Promise<BoundedOutput> {
    if (!descriptor.mimeType || !descriptor.mimeType.startsWith('video/')) {
      throw fail('INVALID_REQUEST', `only video outputs can be opened, got '${descriptor.mimeType}'`)
    }
    if (!descriptor.url) throw fail('INVALID_REQUEST', 'output descriptor has no url')
    // Defensive re-check: the output byte path is a security boundary even after poll validated it.
    if (!this.isAllowedOutputUrl(descriptor.url)) throw fail('UNSAFE_URL', 'output url is not https or not in allowedHosts')
    const maxBytes = typeof config.maxBytes === 'number' && config.maxBytes > 0 ? Math.min(config.maxBytes, MAX_OUTPUT_BYTES) : MAX_OUTPUT_BYTES
    return context.readOutput(descriptor, { maxBytes, timeoutMs: config.timeoutMs })
  }

  /* ---------------------------------------------------------------- helpers */

  /**
   * Validated controls, read from `request.parameters` (falling back to the typed
   * field for duration). Undeclared keys are never looked at, so nothing
   * unvalidated reaches the wire.
   */
  private videoControls(request: MediaRequest): VideoControls {
    const params = request.parameters ?? {}
    const pick = (name: string, fallback?: JsonValue): JsonValue | undefined => {
      const value = params[name] ?? fallback
      if (value === undefined || value === null) return undefined
      const descriptor = descriptorFor(request.vendorModelId, name)
      if (!descriptor) throw fail('INVALID_REQUEST', `parameter '${name}' is not declared for model '${request.vendorModelId}'`)
      const problem = checkDeclaredValue(descriptor, value)
      if (problem) throw fail('INVALID_REQUEST', `parameter '${name}' ${problem}`)
      return value
    }
    const controls: VideoControls = {}
    const duration = pick('durationSeconds', request.durationSeconds)
    if (duration !== undefined) controls.duration = duration as number
    const aspectRatio = pick('aspectRatio')
    if (aspectRatio !== undefined) controls.aspect_ratio = aspectRatio as string
    const resolution = pick('resolution')
    if (resolution !== undefined) controls.resolution = resolution as string
    const seed = pick('seed')
    if (seed !== undefined) controls.seed = seed as number
    return controls
  }

  private checkInputImage(image: MediaInputImage): void {
    if (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') {
      throw fail('INVALID_REQUEST', `unsupported input image type '${image.mimeType}'`)
    }
    if (image.data.length === 0) throw fail('INVALID_REQUEST', 'input image data must be non-empty')
    if (image.sizeBytes !== undefined && image.sizeBytes > MAX_INPUT_IMAGE_BYTES) {
      throw fail('INVALID_REQUEST', 'input image exceeds 20 MB')
    }
  }

  private isAllowedOutputUrl(value: string): boolean {
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'https:' && hostMatchesAllowlist(parsed.hostname, manifest.allowedHosts)
    } catch {
      return false
    }
  }

  private async readJson(response: SafeHttpResponse): Promise<Record<string, unknown>> {
    try {
      const json = await response.json<unknown>()
      return isRecord(json) ? json : {}
    } catch {
      return {}
    }
  }

  private apiKey(config: ProviderConfig): string {
    return config.credential?.apiKey || ''
  }

  private authHeaders(config: ProviderConfig): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey(config)}` }
  }

  private baseUrl(config: ProviderConfig): string {
    const explicit = config.credential?.baseUrl || config.baseUrl
    return (explicit || DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  private idempotencyKey(config: ProviderConfig): string | undefined {
    const value = config.clientRequestId ?? config.credential?.extra?.clientRequestId
    return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,128}$/.test(value) ? value : undefined
  }
}

const plugin = new ExampleVideoPlugin()
export default plugin
