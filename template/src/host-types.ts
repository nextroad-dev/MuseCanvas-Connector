/*
 * Host contract types, vendored (type-only) from MuseCanvas:
 *   packages/providers/src/core/types.ts          (MediaProviderPlugin, ExecutionContext, ...)
 *   packages/contracts/src/index.ts / media-parameters.ts  (ModelCapabilities, descriptors)
 * as of main repo commit c6616dd.
 *
 * Why a local copy instead of `import type ... from '@musecanvas/providers'`:
 * the host packages are workspace-internal (not published to npm, and they export raw
 * TypeScript), so a plugin repo cannot depend on them. Everything in this file is
 * erased at build time, so the bundle still has zero runtime imports.
 *
 * Trimmed to what a media plugin touches. `Buffer` is written as `Uint8Array`
 * (Buffer is a Uint8Array subclass). If the host contract changes, update this file.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/* ---------------- capability contract (packages/contracts) ---------------- */

export type MediaKind = 'image' | 'video'
export type GenerationMode = 'text_to_image' | 'image_to_image' | 'inpaint' | 'text_to_video' | 'image_to_video'

export interface ParameterUiHint {
  control?: 'select' | 'segmented' | 'number' | 'slider' | 'text' | 'switch' | 'size-picker'
  advanced?: boolean
  order?: number
  unit?: string
}

export interface ParameterOption {
  value: string
  label?: string
  description?: string
  experimental?: boolean
}

export interface ParameterDependency {
  parameter: string
  values: JsonPrimitive[]
}

interface DescriptorBase {
  name: string
  label?: string
  description?: string
  required?: boolean
  dependsOn?: ParameterDependency
  ui?: ParameterUiHint
}

export interface EnumParameterDescriptor extends DescriptorBase {
  type: 'enum'
  options: Array<string | ParameterOption>
  defaultValue?: string
}

export interface IntegerParameterDescriptor extends DescriptorBase {
  type: 'integer'
  min?: number
  max?: number
  step?: number
  defaultValue?: number
}

export interface NumberParameterDescriptor extends DescriptorBase {
  type: 'number'
  min?: number
  max?: number
  step?: number
  precision?: number
  defaultValue?: number
}

export interface BooleanParameterDescriptor extends DescriptorBase {
  type: 'boolean'
  defaultValue?: boolean
}

export interface TextParameterDescriptor extends DescriptorBase {
  type: 'text'
  minLength?: number
  maxLength?: number
  pattern?: string
  defaultValue?: string
}

export type ParameterDescriptor =
  | EnumParameterDescriptor
  | IntegerParameterDescriptor
  | NumberParameterDescriptor
  | BooleanParameterDescriptor
  | TextParameterDescriptor
  | { type: 'image-size'; name: string; [key: string]: unknown }

export interface InputSlotDescriptor {
  role: string
  required: boolean
  minCount: number
  maxCount: number
  allowedMediaKinds: MediaKind[]
  label?: string
  description?: string
}

export interface ModelCapabilities {
  modes: GenerationMode[]
  parameters: ParameterDescriptor[]
  inputSlots: InputSlotDescriptor[]
  maxCount?: number
  supportedMediaKinds?: MediaKind[]
  flags?: Record<string, boolean | undefined>
  crossFieldConstraints?: Array<Record<string, unknown>>
  declaredBy?: 'plugin-manifest' | 'host-synthesized' | 'undeclared'
}

/* ---------------- provider kernel (packages/providers/src/core/types.ts) ---------------- */

export type PluginCredentialSpec = {
  providerId: string
  schemaId: string
  secret: { format: 'text' | 'json'; label: string; placeholder?: string; help?: string }
  baseUrl: { default?: string; policy: 'fixed' | 'allowlisted' | 'any-https' }
}

export interface MediaModelDeclaration {
  id: string
  name?: string
  modalities: MediaKind[]
  supportsMask?: boolean
  capabilities?: ModelCapabilities
  defaults?: Record<string, JsonValue>
  deprecated?: boolean
  deprecationNote?: string
}

export type MediaProviderManifest = {
  kind: 'media'
  id: string
  version: string
  displayName: string
  modalities: MediaKind[]
  description?: string
  allowedHosts: string[]
  credentialSchemas: string[]
  credential?: PluginCredentialSpec
  models?: MediaModelDeclaration[]
}

export type DecodedCredential = {
  schema: string
  apiKey?: string
  baseUrl?: string
  extra?: Record<string, unknown>
}

export type ProviderConfig = {
  baseUrl?: string
  credential?: DecodedCredential
  timeoutMs?: number
  maxBytes?: number
  customHeaders?: Record<string, string>
  [key: string]: unknown
}

export type MediaInputImage = {
  data: string | Uint8Array
  mimeType: 'image/png' | 'image/jpeg'
  width?: number
  height?: number
  sizeBytes?: number
  role?: string
}

export type MediaRequest = {
  modality: 'image' | 'video'
  vendorModelId: string
  prompt: string
  size?: string
  width?: number
  height?: number
  quality?: string
  count?: number
  watermark?: boolean
  durationSeconds?: number
  fps?: number
  inputImages?: MediaInputImage[]
  parameters?: Record<string, JsonValue>
  extra?: Record<string, unknown>
}

export type OperationStatus = 'submitting' | 'submission_unknown' | 'waiting' | 'succeeded' | 'failed' | 'canceled'

export type OutputDescriptor = {
  index: number
  mimeType: string
  url?: string
  b64Json?: string
  width?: number
  height?: number
  durationSeconds?: number
  sizeBytes?: number
  metadata?: Record<string, unknown>
}

export type ProviderErrorCode =
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_TEMPORARY_ERROR'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_EMPTY_RESULT'
  | 'INVALID_REQUEST'
  | 'INVALID_CONFIG'
  | 'INVALID_CREDENTIAL'
  | 'UNSAFE_URL'
  | 'OUTPUT_READ_FAILED'
  | 'UNKNOWN_ERROR'

export type NormalizedProviderErrorDiagnostic = {
  pluginId: string
  version: string
  status?: number
  statusText?: string
  endpoint?: string
  detail: string
  occurredAt: string
  providerReferenceId?: string
  code: ProviderErrorCode
}

export type OperationResult = {
  status: OperationStatus
  remoteId?: string
  progress?: number
  retryAfterMs?: number
  opaqueState?: Record<string, unknown>
  outputs?: OutputDescriptor[]
  error?: NormalizedProviderErrorDiagnostic
}

export type BoundedOutput = {
  data: Uint8Array
  mimeType: string
  width?: number
  height?: number
  sizeBytes: number
  metadata?: Record<string, unknown>
}

export type ProbeResult = {
  healthy: boolean
  message?: string
  latencyMs?: number
}

export type SafeHttpRequestInit = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  headers?: Record<string, string>
  body?: string | FormData | Uint8Array
  timeoutMs?: number
  maxBytes?: number
  allowedHosts?: string[]
}

export type SafeHttpResponse = {
  status: number
  statusText: string
  headers: Headers
  ok: boolean
  url: string
  text: () => Promise<string>
  json: <T = unknown>() => Promise<T>
  buffer: () => Promise<Uint8Array>
  stream: () => ReadableStream<Uint8Array>
}

export interface SafeHttpClient {
  request(url: string, init?: SafeHttpRequestInit): Promise<SafeHttpResponse>
  get(url: string, init?: Omit<SafeHttpRequestInit, 'method'>): Promise<SafeHttpResponse>
  post(url: string, body?: string | FormData | Uint8Array, init?: Omit<SafeHttpRequestInit, 'method' | 'body'>): Promise<SafeHttpResponse>
}

export type ExecutionContext = {
  pluginId: string
  version: string
  http: SafeHttpClient
  readOutput: (
    descriptor: OutputDescriptor,
    options?: { maxBytes?: number; timeoutMs?: number; allowedHosts?: string[] },
  ) => Promise<BoundedOutput>
}

export interface MediaProviderPlugin {
  readonly manifest: MediaProviderManifest
  probe?(config: ProviderConfig, context: ExecutionContext): Promise<ProbeResult>
  validateConfig(config: ProviderConfig): void | Promise<void>
  validateRequest(request: MediaRequest, config: ProviderConfig): void | Promise<void>
  submit(request: MediaRequest, config: ProviderConfig, context: ExecutionContext): Promise<OperationResult>
  poll?(remoteId: string, opaqueState: Record<string, unknown> | undefined, config: ProviderConfig, context: ExecutionContext): Promise<OperationResult>
  cancel?(remoteId: string, opaqueState: Record<string, unknown> | undefined, config: ProviderConfig, context: ExecutionContext): Promise<OperationResult>
  openOutput?(descriptor: OutputDescriptor, config: ProviderConfig, context: ExecutionContext): Promise<BoundedOutput>
}
