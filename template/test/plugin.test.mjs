// Lifecycle tests for the template plugin, run against the *built bundle* (the
// artifact that is uploaded), with a mocked ExecutionContext. No network.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { buildBundle } from '../../tools/lib/pack.mjs'

const TEMPLATE_DIR = fileURLToPath(new URL('..', import.meta.url))
const API = 'https://api.example-video.example'
const CDN = 'https://cdn.example-video.example'

let plugin
before(async () => {
  const { code } = await buildBundle(TEMPLATE_DIR)
  plugin = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default
})

const config = { credential: { schema: 'legacy-api-key-v1', apiKey: 'test-key' }, timeoutMs: 10_000 }

function response(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  return {
    status,
    statusText: String(status),
    ok: status >= 200 && status < 300,
    url: `${API}/v1/videos`,
    headers: new Headers(headers),
    text: async () => text,
    json: async () => JSON.parse(text),
    buffer: async () => new TextEncoder().encode(text),
    stream: () => { throw new Error('unused') },
  }
}

function mockContext(...responses) {
  const calls = []
  const next = (method, url, init) => {
    calls.push({ method, url, ...init })
    const r = responses.shift()
    if (!r) throw new Error(`unexpected ${method} ${url}`)
    return Promise.resolve(r)
  }
  return {
    calls,
    context: {
      pluginId: 'example-video',
      version: '0.1.0',
      http: {
        request: (url, init = {}) => next(init.method || 'GET', url, init),
        get: (url, init = {}) => next('GET', url, init),
        post: (url, body, init = {}) => next('POST', url, { ...init, body }),
      },
      readOutput: async (descriptor, options) => {
        calls.push({ method: 'READ', url: descriptor.url, ...options })
        return { data: new Uint8Array([1]), mimeType: descriptor.mimeType, sizeBytes: 1 }
      },
    },
  }
}

const request = (overrides = {}) => ({
  modality: 'video',
  vendorModelId: 'example-video-1',
  prompt: 'a cat surfing',
  parameters: { durationSeconds: 5, aspectRatio: '16:9', resolution: '720p' },
  ...overrides,
})

test('manifest has no package block and matches manifest.json', async () => {
  assert.equal(plugin.manifest.package, undefined)
  assert.equal(plugin.manifest.id, 'example-video')
  assert.deepEqual(plugin.manifest.allowedHosts, ['api.example-video.example', 'cdn.example-video.example'])
})

test('validateConfig requires a key and the fixed https endpoint', () => {
  assert.throws(() => plugin.validateConfig({}), e => e.message === 'PROVIDER_NOT_CONFIGURED' && e.diagnostic.code === 'PROVIDER_NOT_CONFIGURED')
  assert.throws(() => plugin.validateConfig({ ...config, baseUrl: 'http://api.example-video.example' }), e => e.message === 'INVALID_CONFIG')
  assert.throws(() => plugin.validateConfig({ ...config, baseUrl: 'https://evil.example' }), e => e.message === 'INVALID_CONFIG')
  plugin.validateConfig({ ...config, baseUrl: API })
})

test('validateRequest enforces declared capabilities', () => {
  plugin.validateRequest(request(), config)
  const invalid = e => e.message === 'INVALID_REQUEST'
  assert.throws(() => plugin.validateRequest(request({ vendorModelId: 'nope' })), invalid)
  assert.throws(() => plugin.validateRequest(request({ prompt: '  ' })), invalid)
  assert.throws(() => plugin.validateRequest(request({ parameters: { durationSeconds: 11 } })), invalid)
  assert.throws(() => plugin.validateRequest(request({ parameters: { aspectRatio: '4:3' } })), invalid)
  assert.throws(() => plugin.validateRequest(request({ count: 2 })), invalid)
  assert.throws(() => plugin.validateRequest(request({ inputImages: [{ data: 'aaa', mimeType: 'image/gif' }] })), invalid)
  assert.throws(() => plugin.validateRequest(request({ inputImages: [{ data: 'a', mimeType: 'image/png' }, { data: 'b', mimeType: 'image/png' }] })), invalid)
})

test('submit posts to the vendor and returns waiting with identifier-only opaqueState', async () => {
  const { context, calls } = mockContext(response(200, { id: 'task-1' }))
  const result = await plugin.submit(request({ inputImages: [{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }] }), { ...config, clientRequestId: 'req-1' }, context)
  assert.equal(result.status, 'waiting')
  assert.equal(result.remoteId, 'task-1')
  assert.deepEqual(result.opaqueState, { taskId: 'task-1', model: 'example-video-1', durationSeconds: 5 })
  assert.equal(calls[0].url, `${API}/v1/videos`)
  assert.equal(calls[0].headers.authorization, 'Bearer test-key')
  assert.equal(calls[0].headers['idempotency-key'], 'req-1')
  assert.equal(calls[0].timeoutMs, 10_000)
  const body = JSON.parse(calls[0].body)
  assert.deepEqual(body, { model: 'example-video-1', prompt: 'a cat surfing', duration: 5, aspect_ratio: '16:9', resolution: '720p', first_frame: 'data:image/png;base64,AQID' })
})

test('submit maps 429/5xx to submission_unknown and 4xx to failed', async () => {
  const temporary = await plugin.submit(request(), config, mockContext(response(503, 'busy', { 'retry-after': '7' })).context)
  assert.equal(temporary.status, 'submission_unknown')
  assert.equal(temporary.retryAfterMs, 7_000)
  assert.equal(temporary.error.code, 'PROVIDER_TEMPORARY_ERROR')
  const rejected = await plugin.submit(request(), config, mockContext(response(400, 'bad prompt')).context)
  assert.equal(rejected.status, 'failed')
  assert.equal(rejected.error.code, 'PROVIDER_REJECTED')
})

test('poll maps vendor states', async () => {
  const state = { taskId: 't', model: 'example-video-1', durationSeconds: 5 }
  const running = await plugin.poll('t', state, config, mockContext(response(200, { status: 'running', progress: 40 })).context)
  assert.deepEqual([running.status, running.progress], ['waiting', 40])

  const done = await plugin.poll('t', state, config, mockContext(response(200, { status: 'succeeded', video: { url: `${CDN}/v/t.mp4` } })).context)
  assert.equal(done.status, 'succeeded')
  assert.deepEqual(done.outputs, [{ index: 0, mimeType: 'video/mp4', url: `${CDN}/v/t.mp4`, durationSeconds: 5, metadata: { remoteId: 't' } }])

  const unsafe = await plugin.poll('t', state, config, mockContext(response(200, { status: 'succeeded', video: { url: 'https://elsewhere.example/v.mp4' } })).context)
  assert.deepEqual([unsafe.status, unsafe.error.code], ['failed', 'UNSAFE_URL'])

  const empty = await plugin.poll('t', state, config, mockContext(response(200, { status: 'succeeded' })).context)
  assert.deepEqual([empty.status, empty.error.code], ['failed', 'PROVIDER_EMPTY_RESULT'])

  const failed = await plugin.poll('t', state, config, mockContext(response(200, { status: 'failed', error: { code: 'moderation', message: 'blocked' } })).context)
  assert.deepEqual([failed.status, failed.error.code], ['failed', 'PROVIDER_REJECTED'])

  const transient = await plugin.poll('t', state, config, mockContext(response(502, 'gateway')).context)
  assert.deepEqual([transient.status, transient.error.code], ['waiting', 'PROVIDER_TEMPORARY_ERROR'])
})

test('cancel: confirmed, draining and 404', async () => {
  assert.equal((await plugin.cancel('t', undefined, config, mockContext(response(200, { status: 'canceled' })).context)).status, 'canceled')
  assert.equal((await plugin.cancel('t', undefined, config, mockContext(response(200, { status: 'canceling' })).context)).status, 'waiting')
  assert.equal((await plugin.cancel('t', undefined, config, mockContext(response(404, 'gone')).context)).status, 'canceled')
})

test('openOutput re-checks https, allowlist and mime type', async () => {
  const { context, calls } = mockContext()
  await plugin.openOutput({ index: 0, mimeType: 'video/mp4', url: `${CDN}/v.mp4` }, config, context)
  assert.equal(calls[0].method, 'READ')
  assert.equal(calls[0].maxBytes, 100_000_000)
  await assert.rejects(plugin.openOutput({ index: 0, mimeType: 'video/mp4', url: 'http://cdn.example-video.example/v.mp4' }, config, context), e => e.message === 'UNSAFE_URL')
  await assert.rejects(plugin.openOutput({ index: 0, mimeType: 'video/mp4', url: 'https://other.example/v.mp4' }, config, context), e => e.message === 'UNSAFE_URL')
  await assert.rejects(plugin.openOutput({ index: 0, mimeType: 'image/png', url: `${CDN}/v.png` }, config, context), e => e.message === 'INVALID_REQUEST')
})

test('probe validates config first and reports health', async () => {
  await assert.rejects(plugin.probe({}, mockContext().context), e => e.message === 'PROVIDER_NOT_CONFIGURED')
  assert.equal((await plugin.probe(config, mockContext(response(200, {})).context)).healthy, true)
  const denied = await plugin.probe(config, mockContext(response(401, 'no')).context)
  assert.deepEqual([denied.healthy, denied.message], [false, 'API key rejected'])
})
