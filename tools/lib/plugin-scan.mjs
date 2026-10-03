/*
 * CONVENIENCE COPY — NOT THE AUTHORITY.
 *
 * Port of MuseCanvas `packages/providers/src/core/plugin-scan.ts` (scanPluginSource,
 * validatePluginManifest) and `core/url-guard.ts` (hostMatchesAllowlist,
 * isPrivateProviderHost, urlHostOf), as of main repo commit c6616dd.
 *
 * MuseCanvas re-runs the real rules on upload and in the worker; whatever it decides
 * wins. This copy exists so an author sees the same findings before uploading.
 *
 * Deliberate gap: `validateModelCapabilities` (packages/contracts, ~1000 lines) is NOT
 * ported. `checkCapabilitiesShape` below only catches gross structural mistakes; the
 * full parameter-contract validation happens on the server. Use the admin console's
 * validate (pre-check) endpoint for an authoritative answer.
 *
 * When the server rules change, update this file and note the commit above.
 */

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,40}$/
export const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+$/
export const SUPPORTED_CREDENTIAL_SCHEMAS = ['legacy-api-key-v1', 'json-v1', 'access-token-v1']
export const SUPPORTED_LANGUAGE_PROTOCOLS = ['openai_chat', 'openai_responses', 'anthropic_messages']
export const SUPPORTED_MEDIA_MODALITIES = ['image', 'video']
/** PLUGIN_ARTIFACT_MAX_BYTES in plugin-scan.ts. */
export const PLUGIN_ARTIFACT_MAX_BYTES = 5_242_880

const NODE_BUILTIN_NAMES = new Set([
  'fs', 'path', 'os', 'net', 'http', 'https', 'dns', 'dgram', 'tls', 'child_process',
  'worker_threads', 'cluster', 'vm', 'module', 'crypto', 'v8', 'perf_hooks', 'worker',
])

const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/

const PATTERN_RULES = [
  {
    rule: 'FORBIDDEN_GLOBAL_FETCH',
    pattern: /globalThis\s*\.\s*fetch\b|globalThis\s*\[\s*['"`]fetch['"`]\s*\]|\bfetch\s*\(/g,
    message: 'global fetch is unavailable; every outbound request must go through ExecutionContext.http',
    precedence: 0,
  },
  {
    rule: 'FORBIDDEN_PROCESS_BRIDGE',
    pattern: /\bprocess\s*\.\s*(?:binding|mainModule)\b/g,
    message: 'process native bridges are forbidden',
    precedence: -1,
  },
  {
    rule: 'FORBIDDEN_PROCESS_ENV',
    pattern: /\bprocess\s*[.[]/g,
    message: 'process.* is forbidden; configuration arrives only through ProviderConfig',
    precedence: 0,
  },
  {
    rule: 'FORBIDDEN_REQUIRE',
    pattern: /\brequire\s*\(|\bcreateRequire\b/g,
    message: 'CommonJS require is forbidden in a self-contained ESM bundle',
    precedence: 0,
  },
  {
    rule: 'FORBIDDEN_DYNAMIC_EVAL',
    pattern: /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/g,
    message: 'runtime code generation is forbidden',
    precedence: 0,
  },
  {
    rule: 'FORBIDDEN_BRACKET_GLOBAL',
    pattern: /globalThis\s*\[/g,
    message: 'computed globalThis access is forbidden',
    precedence: 0,
  },
]

/** Port of scanPluginSource: textual lint, not a sandbox. Same rules, same ordering. */
export function scanPluginSource(source) {
  const lineStarts = collectLineStarts(source)
  const hits = []

  const report = (offset, precedence, rule, message, severity = 'error') => {
    const { line, column } = positionOf(lineStarts, offset)
    hits.push({ offset, precedence, finding: { rule, severity, line, column, message } })
  }

  for (const rule of PATTERN_RULES) {
    for (const match of matchAll(source, rule.pattern)) {
      report(match.index, rule.precedence, rule.rule, rule.message)
    }
  }

  for (const match of matchAll(source, /\bimport\b/g)) {
    if (isMemberAccess(source, match.index)) continue
    const tail = source.slice(match.index + 'import'.length, match.index + 'import'.length + 40)
    if (/^\s*type\b/.test(tail) || /^\s*\./.test(tail)) continue
    report(
      match.index,
      0,
      'FORBIDDEN_RUNTIME_IMPORT',
      /^\s*\(/.test(tail)
        ? 'dynamic import() is forbidden; the artifact must carry zero runtime imports'
        : 'import statements are forbidden; the artifact must be a self-contained bundle (type-only imports are erased)',
    )
  }
  for (const pattern of [/\bexport\s+(?!type\b)\{[^}]*\}\s*from\b/g, /\bexport\s+(?!type\b)\*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s+from\b/g]) {
    for (const match of matchAll(source, pattern)) {
      report(match.index, 0, 'FORBIDDEN_RUNTIME_IMPORT', 're-exporting from another module is a runtime import')
    }
  }

  for (const match of matchAll(source, /(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*['"`]([^'"`\n]+)['"`]/g)) {
    const specifier = match[1].trim()
    if (!isNodeBuiltinSpecifier(specifier)) continue
    report(match.index + match[0].indexOf(match[1]), 0, 'FORBIDDEN_NODE_BUILTIN', `'${specifier}' is a Node builtin; the bundle cannot import platform modules`)
  }

  for (const offset of topLevelAwaitOffsets(source)) {
    report(offset, 0, 'FORBIDDEN_TOP_LEVEL_AWAIT', 'top-level await runs at import time, before any manifest or scan check')
  }

  if (!/\bexport\s+default\b/.test(source)) {
    hits.push({
      offset: source.length,
      precedence: 0,
      finding: { rule: 'NO_DEFAULT_EXPORT', severity: 'warn', message: 'the plugin object is expected as `export default`' },
    })
  }

  const seen = new Set()
  const findings = []
  for (const hit of hits.sort((a, b) => a.offset - b.offset || a.precedence - b.precedence)) {
    const key = `${hit.finding.line}:${hit.finding.column}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push(hit.finding)
  }
  return findings
}

/**
 * Port of validatePluginManifest. Returns the same normalized shape, except that
 * model `capabilities` are only shape-checked (see header) and copied through as-is.
 */
export function validatePluginManifest(input) {
  const source = isRecord(input) ? input : {}
  const findings = []
  const reject = (rule, message) => {
    findings.push({ rule, severity: 'error', message })
  }

  const id = typeof source.id === 'string' ? source.id : ''
  if (!PLUGIN_ID_PATTERN.test(id)) reject('INVALID_PLUGIN_ID', 'id must match ^[a-z][a-z0-9-]{1,40}$')

  const version = typeof source.version === 'string' ? source.version : ''
  if (!PLUGIN_VERSION_PATTERN.test(version)) reject('INVALID_PLUGIN_VERSION', 'version must match ^\\d+\\.\\d+\\.\\d+$')

  const kind = source.kind
  if (kind !== 'media' && kind !== 'language') reject('INVALID_PLUGIN_KIND', "kind must be 'media' or 'language'")

  const displayName = typeof source.displayName === 'string' ? source.displayName.trim() : ''
  if (!displayName) reject('INVALID_DISPLAY_NAME', 'displayName must be a non-empty string')

  const hosts = Array.isArray(source.allowedHosts) ? source.allowedHosts : null
  if (!hosts || hosts.length === 0) reject('EMPTY_ALLOWED_HOSTS', 'allowedHosts must be a non-empty array; an empty allowlist permits no egress')
  for (const host of hosts || []) validateHost(host, reject)

  const schemas = Array.isArray(source.credentialSchemas) ? source.credentialSchemas : null
  if (!schemas || schemas.length === 0) reject('UNSUPPORTED_CREDENTIAL_SCHEMA', 'credentialSchemas must be a non-empty array')
  for (const schema of schemas || []) {
    if (!SUPPORTED_CREDENTIAL_SCHEMAS.includes(schema)) reject('UNSUPPORTED_CREDENTIAL_SCHEMA', `credentialSchemas entry '${String(schema)}' is not one of ${SUPPORTED_CREDENTIAL_SCHEMAS.join(', ')}`)
  }

  const credential = source.credential === undefined
    ? undefined
    : parseCredentialSpec(source.credential, schemas || [], hosts || [], reject)

  const models = Array.isArray(source.models) ? source.models : null
  if (!models || models.length === 0) {
    reject('EMPTY_MODEL_LIST', 'models must be a non-empty array; the active version rejects models outside this list, so an empty list silently permits everything')
  } else {
    for (const model of models) {
      if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) {
        reject('EMPTY_MODEL_LIST', 'every models entry needs a non-empty string id')
        continue
      }
      if (kind === 'media') {
        for (const finding of checkCapabilitiesShape(model)) {
          reject(finding.rule, `model '${model.id}': ${finding.message}`)
        }
      }
    }
  }

  const declaredModalities = Array.isArray(source.modalities) ? source.modalities : null
  if (kind === 'media') {
    if (!declaredModalities || declaredModalities.length === 0) {
      reject('INVALID_MODALITIES', 'media manifests must declare a non-empty modalities array')
    } else {
      for (const modality of declaredModalities) {
        if (!SUPPORTED_MEDIA_MODALITIES.includes(modality)) {
          reject('INVALID_MODALITIES', `modalities entry '${String(modality)}' must be 'image' or 'video'`)
        }
      }
    }
  }

  const declaredProtocols = Array.isArray(source.languageProtocols) ? source.languageProtocols : null
  if (kind === 'language') {
    if (!declaredProtocols || declaredProtocols.length === 0) {
      reject('INVALID_LANGUAGE_PROTOCOLS', 'language manifests must declare a non-empty languageProtocols array')
    } else {
      for (const protocol of declaredProtocols) {
        if (!SUPPORTED_LANGUAGE_PROTOCOLS.includes(protocol)) {
          reject('INVALID_LANGUAGE_PROTOCOLS', `languageProtocols entry '${String(protocol)}' must be one of ${SUPPORTED_LANGUAGE_PROTOCOLS.join(', ')}`)
        }
      }
    }
  }

  if (findings.length) return { ok: false, findings }

  const manifest = kind === 'media'
    ? {
        kind: 'media',
        id,
        version,
        displayName,
        modalities: dedupeStrings(declaredModalities),
        ...(typeof source.description === 'string' ? { description: source.description } : {}),
        allowedHosts: dedupeStrings(hosts),
        credentialSchemas: dedupeStrings(schemas),
        ...(credential ? { credential } : {}),
        models: models.map(model => normalizeMediaModel(model, declaredModalities)),
      }
    : {
        kind: 'language',
        id,
        version,
        displayName,
        ...(typeof source.description === 'string' ? { description: source.description } : {}),
        languageProtocols: dedupeStrings(declaredProtocols),
        allowedHosts: dedupeStrings(hosts),
        credentialSchemas: dedupeStrings(schemas),
        ...(credential ? { credential } : {}),
        models: models.map(normalizeLanguageModel),
      }

  return { ok: true, manifest }
}

const CREDENTIAL_TEXT_MAX = 200

function parseCredentialSpec(value, schemas, hosts, reject) {
  const fail = (message) => {
    reject('INVALID_CREDENTIAL_SPEC', message)
    return undefined
  }
  if (!isRecord(value)) return fail('credential must be an object')
  const providerId = typeof value.providerId === 'string' ? value.providerId : ''
  if (!PLUGIN_ID_PATTERN.test(providerId)) return fail('credential.providerId must match ^[a-z][a-z0-9-]{1,40}$')
  const schemaId = typeof value.schemaId === 'string' ? value.schemaId : ''
  if (!schemas.includes(schemaId)) return fail('credential.schemaId must be one of the declared credentialSchemas')
  const secret = isRecord(value.secret) ? value.secret : null
  if (!secret) return fail('credential.secret must be an object')
  if (secret.format !== 'text' && secret.format !== 'json') return fail("credential.secret.format must be 'text' or 'json'")
  const label = typeof secret.label === 'string' ? secret.label.trim() : ''
  if (!label || label.length > CREDENTIAL_TEXT_MAX) return fail(`credential.secret.label must be a non-empty string of at most ${CREDENTIAL_TEXT_MAX} characters`)
  const optionalText = (field) => {
    const raw = secret[field]
    if (raw === undefined) return undefined
    return typeof raw === 'string' && raw.length <= CREDENTIAL_TEXT_MAX ? raw : false
  }
  const placeholder = optionalText('placeholder')
  const help = optionalText('help')
  if (placeholder === false || help === false) return fail(`credential.secret.placeholder/help must be strings of at most ${CREDENTIAL_TEXT_MAX} characters`)
  const baseUrl = isRecord(value.baseUrl) ? value.baseUrl : null
  if (!baseUrl) return fail('credential.baseUrl must be an object')
  if (baseUrl.policy !== 'fixed' && baseUrl.policy !== 'allowlisted') return fail("credential.baseUrl.policy must be 'fixed' or 'allowlisted'")
  let defaultUrl
  if (baseUrl.default !== undefined) {
    const raw = typeof baseUrl.default === 'string' ? baseUrl.default : ''
    const host = raw.startsWith('https://') ? urlHostOf(raw) : null
    const allowlist = hosts.filter(entry => typeof entry === 'string')
    if (!host || !hostMatchesAllowlist(host, allowlist)) return fail('credential.baseUrl.default must be an https URL whose host is in allowedHosts')
    defaultUrl = raw
  } else if (baseUrl.policy === 'fixed') {
    return fail("credential.baseUrl.default is required when policy is 'fixed'")
  }
  return {
    providerId,
    schemaId,
    secret: {
      format: secret.format,
      label,
      ...(placeholder ? { placeholder } : {}),
      ...(help ? { help } : {}),
    },
    baseUrl: { ...(defaultUrl ? { default: defaultUrl } : {}), policy: baseUrl.policy },
  }
}

function validateHost(host, reject) {
  const raw = typeof host === 'string' ? host.trim() : ''
  if (!raw || /\s/.test(raw)) {
    reject('INVALID_HOST_PATTERN', 'allowedHosts entries must be non-empty host strings without whitespace')
    return
  }
  if (raw === '*' || (raw.includes('*') && !raw.startsWith('*.'))) {
    reject('WILDCARD_HOST_FORBIDDEN', `'${raw}' is too broad; only an exact host or a '*.' prefix is permitted`)
    return
  }
  const bare = raw.startsWith('*.') ? raw.slice(2) : raw
  if (isIpLiteralHost(bare)) {
    reject('IP_HOST_FORBIDDEN', `'${raw}' is an IP literal; hostnames only`)
    return
  }
  if (isPrivateProviderHost(bare)) {
    reject('PRIVATE_HOST_FORBIDDEN', `'${raw}' is a loopback or private address range`)
    return
  }
  if (!HOST_PATTERN.test(raw)) {
    reject('INVALID_HOST_PATTERN', `'${raw}' must be an exact hostname (scheme, port and path are not permitted)`)
  }
}

function isIpLiteralHost(host) {
  if (IPV4_PATTERN.test(host)) return true
  if (/^\[[^\]]*\]$/.test(host)) return true
  return /^[0-9a-f:.]+$/.test(host.toLowerCase()) && host.includes(':')
}

function isNodeBuiltinSpecifier(specifier) {
  if (specifier.startsWith('node:')) return true
  return NODE_BUILTIN_NAMES.has(specifier.split('/')[0])
}

/* ---- url-guard.ts ---- */

export function isPrivateProviderHost(host) {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '0.0.0.0' || h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
}

export function urlHostOf(value) {
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}

export function hostMatchesAllowlist(hostname, patterns) {
  const host = hostname.toLowerCase()
  return patterns.some(pattern => {
    const p = pattern.toLowerCase().trim()
    if (!p) return false
    if (p.startsWith('*.')) {
      const suffix = p.slice(1)
      return host.endsWith(suffix) && host.length > suffix.length
    }
    if (p.startsWith('*-')) {
      const suffix = p.slice(1)
      if (!host.endsWith(suffix) || host.length <= suffix.length) return false
      return !host.slice(0, host.length - suffix.length).includes('.')
    }
    return host === p
  })
}

/* ---- capabilities: shape only (NOT a port of validateModelCapabilities) ---- */

const DESCRIPTOR_TYPES = new Set(['enum', 'integer', 'number', 'boolean', 'text', 'image-size'])
const GENERATION_MODES = new Set(['text_to_image', 'image_to_image', 'text_to_video', 'image_to_video'])

function checkCapabilitiesShape(model) {
  const raw = model.capabilities
  if (raw === undefined) return []
  const out = []
  const reject = (rule, message) => out.push({ rule, message })
  if (!isRecord(raw)) {
    reject('INVALID_MODEL_CAPABILITIES', 'capabilities must be an object when present')
    return out
  }
  if (!Array.isArray(raw.modes)) reject('INVALID_MODEL_CAPABILITIES', 'modes must be an array')
  for (const mode of Array.isArray(raw.modes) ? raw.modes : []) {
    if (!GENERATION_MODES.has(mode)) reject('INVALID_MODEL_CAPABILITIES', `unknown generation mode '${String(mode)}'`)
  }
  if (!Array.isArray(raw.parameters)) {
    reject('INVALID_MODEL_CAPABILITIES', 'parameters must be an array')
  } else {
    const seen = new Set()
    for (const entry of raw.parameters) {
      const name = isRecord(entry) && typeof entry.name === 'string' ? entry.name.trim() : ''
      if (!name) {
        reject('INVALID_MODEL_CAPABILITIES', 'every parameter needs a non-empty name')
        continue
      }
      if (seen.has(name)) reject('INVALID_MODEL_CAPABILITIES', `parameter '${name}' is declared twice`)
      seen.add(name)
      if (!DESCRIPTOR_TYPES.has(entry.type)) reject('UNKNOWN_PARAMETER_TYPE', `parameter '${name}' declares unknown type '${String(entry.type)}'`)
    }
  }
  if (!Array.isArray(raw.inputSlots)) reject('INVALID_MODEL_CAPABILITIES', 'inputSlots must be an array')
  if (model.defaults !== undefined && !isRecord(model.defaults)) reject('INVALID_MODEL_CAPABILITIES', 'defaults must be an object')
  return out
}

function normalizeMediaModel(model, inheritedModalities) {
  const own = Array.isArray(model.modalities) ? model.modalities.filter(v => v === 'image' || v === 'video') : []
  return {
    id: String(model.id),
    ...(typeof model.name === 'string' ? { name: model.name } : {}),
    modalities: own.length ? own : inheritedModalities,
    ...(Array.isArray(model.supportedAspectRatios)
      ? { supportedAspectRatios: model.supportedAspectRatios.filter(value => typeof value === 'string') }
      : {}),
    ...(typeof model.maxBatchSize === 'number' ? { maxBatchSize: model.maxBatchSize } : {}),
    ...(typeof model.maxInputImages === 'number' ? { maxInputImages: model.maxInputImages } : {}),
    ...(typeof model.supportsMask === 'boolean' ? { supportsMask: model.supportsMask } : {}),
    // Not rebuilt field-by-field like the server does; copied for comparison only.
    ...(isRecord(model.capabilities) ? { capabilities: model.capabilities } : {}),
    ...(isRecord(model.defaults) ? { defaults: model.defaults } : {}),
    ...(typeof model.deprecated === 'boolean' ? { deprecated: model.deprecated } : {}),
    ...(typeof model.deprecationNote === 'string' ? { deprecationNote: model.deprecationNote } : {}),
  }
}

function normalizeLanguageModel(model) {
  return {
    id: String(model.id),
    ...(typeof model.name === 'string' ? { name: model.name } : {}),
    ...(typeof model.maxInputTokens === 'number' ? { maxInputTokens: model.maxInputTokens } : {}),
    ...(typeof model.maxOutputTokensDefault === 'number' ? { maxOutputTokensDefault: model.maxOutputTokensDefault } : {}),
    ...(typeof model.supportsStructuredOutput === 'boolean' ? { supportsStructuredOutput: model.supportsStructuredOutput } : {}),
  }
}

/* ---- helpers (verbatim) ---- */

function dedupeStrings(values) {
  return [...new Set(values.map(value => value.trim()))]
}

export function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function matchAll(source, pattern) {
  const clone = new RegExp(pattern.source, pattern.flags)
  const matches = []
  let match
  while ((match = clone.exec(source)) !== null) {
    if (match[0] === '') clone.lastIndex += 1
    matches.push(match)
  }
  return matches
}

function isMemberAccess(source, index) {
  const previous = source[index - 1]
  return previous === '.' || previous === '$'
}

function collectLineStarts(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

function positionOf(lineStarts, index) {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (lineStarts[middle] <= index) low = middle
    else high = middle - 1
  }
  return { line: low + 1, column: index - lineStarts[low] + 1 }
}

function topLevelAwaitOffsets(source) {
  const offsets = []
  let depth = 0
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index)
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index)
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      index = skipQuoted(source, index)
      continue
    }
    if (char === '{') {
      depth += 1
      index += 1
      continue
    }
    if (char === '}') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (isIdentifierStart(char)) {
      const end = readIdentifier(source, index)
      const word = source.slice(index, end)
      if (word === 'await' && depth === 0 && source[index - 1] !== '.' && !isInsideNonBracedAsync(source, index)) offsets.push(index)
      index = end
      continue
    }
    index += 1
  }
  return offsets
}

function isInsideNonBracedAsync(source, index) {
  return /\basync\b[^{};]*$/.test(source.slice(Math.max(0, index - 120), index))
}

function isIdentifierStart(char) {
  return /[A-Za-z_$]/.test(char)
}

function readIdentifier(source, start) {
  let index = start
  while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1
  return index
}

function skipLineComment(source, start) {
  const newline = source.indexOf('\n', start)
  return newline === -1 ? source.length : newline + 1
}

function skipBlockComment(source, start) {
  const end = source.indexOf('*/', start + 2)
  return end === -1 ? source.length : end + 2
}

function skipQuoted(source, start) {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) return index + 1
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      index = skipInterpolation(source, index + 1)
      continue
    }
    if (quote !== '`' && char === '\n') return index + 1
    index += 1
  }
  return index
}

function skipInterpolation(source, start) {
  let depth = 0
  let index = start
  while (index < source.length) {
    const char = source[index]
    if (char === '"' || char === "'" || char === '`') {
      index = skipQuoted(source, index)
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      index += 1
      if (depth === 0) return index
      continue
    }
    index += 1
  }
  return index
}
