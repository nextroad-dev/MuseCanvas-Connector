import { createHash } from 'node:crypto'
import { readCentralDirectory, readEntryData, ZipFormatError } from './zip.mjs'
import { probeImage } from './image.mjs'
import { isRecord, PLUGIN_ARTIFACT_MAX_BYTES, scanPluginSource, validatePluginManifest } from './plugin-scan.mjs'

/*
 * CONVENIENCE COPY — MuseCanvas IS THE AUTHORITY.
 *
 * Local version of the upload checks in wiki/plugin-package-spec.md section 4
 * (and the worker's manifest comparison in section 5.3). Mirrors MuseCanvas
 * `packages/providers/src/core/plugin-package.ts` (inspectPluginPackage, in progress
 * at the time of writing; verdicts and response codes cross-checked against its
 * working-tree version) plus `core/plugin-scan.ts`. When the two disagree, the server
 * wins and this file should be updated. Passing here does not guarantee installation.
 * Not mirrored: the server's full pixel decode of the icon (sharp) and the full
 * `validateModelCapabilities`.
 *
 * Finding shape: { code, rule, severity: 'error'|'warn', message, path?, line?, column? }
 * `code` is the response code from spec 4.1 (or the existing upload codes);
 * `rule` is the finer-grained reason.
 */

const KiB = 1024
const MiB = 1024 * KiB

export const LIMITS = Object.freeze({
  zipBytes: 6 * MiB,
  totalUncompressedBytes: 8 * MiB,
  entries: 32,
  entryBytes: PLUGIN_ARTIFACT_MAX_BYTES, // 5 MiB
  manifestBytes: 256 * KiB,
  docBytes: 256 * KiB,
  iconBytes: 256 * KiB,
  iconMaxEdge: 512,
  compressionRatio: 100,
  pathBytes: 200,
})

export const PACKAGE_FORMAT = 1

/**
 * Built-in identities as of MuseCanvas c6616dd (spec 10.4). The server derives the
 * live list from its registry; this snapshot can go stale.
 */
export const RESERVED_PLUGIN_IDS = ['openai-image', 'seedream-image', 'seedance-video', 'veo-video', 'openai-language', 'anthropic-language']
export const RESERVED_PROVIDER_IDS = ['openai', 'anthropic', 'volcengine', 'google']

const DOC_EXTENSIONS = ['.md', '.txt']
const ICON_EXTENSIONS = ['.png', '.webp']
const PACKAGE_KEYS = ['format', 'entry', 'icon', 'readme', 'license', 'author', 'homepage']

const utf8 = new TextDecoder('utf-8', { fatal: true })

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Validate a zip package. Never writes to disk.
 *
 * @param {Uint8Array} zipBytes
 * @param {{ importEntry?: boolean }} [options] importEntry (default true): import the
 *   entry bundle in-process (data: URL) to compare `bundle.manifest` with manifest.json.
 *   This EXECUTES the bundle's top-level code; it only happens after every static
 *   check passed. Pass false for packages you do not trust.
 */
export async function checkPackage(zipBytes, options = {}) {
  const importEntry = options.importEntry !== false
  const findings = []
  const add = (code, rule, message, extra = {}) => findings.push({ code, rule, severity: 'error', message, ...extra })
  const warn = (code, rule, message, extra = {}) => findings.push({ code, rule, severity: 'warn', message, ...extra })
  const result = (more = {}) => ({
    ok: !findings.some(f => f.severity === 'error'),
    findings,
    sha256: sha256Hex(zipBytes),
    sizeBytes: zipBytes.length,
    ...more,
  })

  // 1. Size pre-check, before reading any entry.
  if (zipBytes.length > LIMITS.zipBytes) {
    add('PLUGIN_PACKAGE_TOO_LARGE', 'ZIP_TOO_LARGE', `zip is ${zipBytes.length} bytes; limit ${LIMITS.zipBytes}`)
    return result()
  }

  // 2. Structure: central directory only, no zip64 / encryption / exotic methods.
  let entries
  try {
    entries = readCentralDirectory(zipBytes)
  } catch (error) {
    if (!(error instanceof ZipFormatError)) throw error
    add(error.code, 'ZIP_STRUCTURE', error.message, error.path ? { path: error.path } : {})
    return result()
  }
  if (entries.length > LIMITS.entries) {
    add('PLUGIN_PACKAGE_TOO_LARGE', 'TOO_MANY_ENTRIES', `${entries.length} entries; limit ${LIMITS.entries}`)
    return result()
  }

  // 3. Path safety.
  const seenKeys = new Map()
  for (const entry of entries) {
    const problem = unsafePathReason(entry)
    if (problem) {
      add('PLUGIN_PACKAGE_UNSAFE_PATH', problem.rule, problem.message, { path: entry.name })
      continue
    }
    const key = entry.name.replace(/\/$/, '').normalize('NFC').toLowerCase()
    if (seenKeys.has(key)) {
      add('PLUGIN_PACKAGE_UNSAFE_PATH', 'DUPLICATE_PATH', `collides with '${seenKeys.get(key)}' after NFC + lower-casing`, { path: entry.name })
      continue
    }
    seenKeys.set(key, entry.name)
  }
  if (!findings.length) {
    // A path nested under a name that is itself a file would clash on extraction.
    const fileKeys = entries.filter(e => !e.name.endsWith('/')).map(e => e.name.normalize('NFC').toLowerCase())
    for (const entry of entries) {
      const key = entry.name.replace(/\/$/, '').normalize('NFC').toLowerCase()
      const parent = fileKeys.find(fileKey => key.startsWith(`${fileKey}/`))
      if (parent) add('PLUGIN_PACKAGE_UNSAFE_PATH', 'NESTED_UNDER_FILE', `is nested under '${parent}', which is a file`, { path: entry.name })
    }
  }
  if (findings.length) return result()

  // macOS archiver metadata (__MACOSX/, .DS_Store) is dropped silently, as on the
  // server: it already passed path safety and the entry cap above, and its bytes
  // still count toward the uncompressed total below, but it is never read, never
  // listed and does not count as a second top-level directory.
  const ignoredFiles = entries.filter(entry => !entry.name.endsWith('/') && isIgnoredPackagePath(entry.name))
  const kept = entries.filter(entry => !isIgnoredPackagePath(entry.name))

  // Layout: flat, or wrapped in exactly one top-level directory.
  const files = kept.filter(entry => !entry.name.endsWith('/'))
  const directories = kept.filter(entry => entry.name.endsWith('/'))
  for (const dir of entries.filter(entry => entry.name.endsWith('/'))) {
    if (dir.uncompressedSize !== 0) add('PLUGIN_PACKAGE_INVALID', 'DIRECTORY_WITH_DATA', 'directory entry carries data', { path: dir.name })
  }
  const prefix = resolveRootPrefix(files, directories)
  if (prefix === null) {
    add('PLUGIN_PACKAGE_INVALID', 'LAYOUT', 'manifest.json must sit at the zip root, or inside exactly one top-level directory that holds everything')
    return result()
  }
  for (const file of files) file.path = file.name.slice(prefix.length)

  // 4a. Package-level sizes and ratio, from central-directory values (pre-check).
  const total = [...files, ...ignoredFiles].reduce((sum, file) => sum + file.uncompressedSize, 0)
  if (total > LIMITS.totalUncompressedBytes) {
    add('PLUGIN_PACKAGE_TOO_LARGE', 'UNCOMPRESSED_TOO_LARGE', `uncompressed total ${total} bytes; limit ${LIMITS.totalUncompressedBytes}`)
  }
  for (const file of files) {
    if (exceedsRatio(file)) {
      add('PLUGIN_PACKAGE_BOMB', 'COMPRESSION_RATIO', `declared ratio exceeds ${LIMITS.compressionRatio}:1`, { path: file.path })
    }
  }
  if (findings.length) return result()

  // 5. manifest.json (needed before the whitelist: it names the entry and the icon).
  const manifestFile = files.find(file => file.path === 'manifest.json')
  if (!manifestFile) {
    add('PLUGIN_PACKAGE_INVALID', 'MANIFEST_MISSING', 'manifest.json not found at the package root')
    return result()
  }
  if (manifestFile.uncompressedSize > LIMITS.manifestBytes) {
    add('PLUGIN_PACKAGE_TOO_LARGE', 'FILE_TOO_LARGE', `manifest.json limit is ${LIMITS.manifestBytes} bytes`, { path: 'manifest.json' })
    return result()
  }
  const contents = new Map()
  const read = (file) => {
    if (!contents.has(file.path)) contents.set(file.path, readEntryData(zipBytes, file))
    return contents.get(file.path)
  }
  let manifestJson
  try {
    manifestJson = JSON.parse(stripBom(utf8.decode(read(manifestFile))))
  } catch (error) {
    const code = error instanceof ZipFormatError ? error.code : 'INVALID_PLUGIN_MANIFEST'
    add(code, 'MANIFEST_NOT_JSON', `manifest.json must be UTF-8 JSON (${error.message})`, { path: 'manifest.json' })
    return result()
  }
  if (!isRecord(manifestJson)) {
    add('INVALID_PLUGIN_MANIFEST', 'MANIFEST_NOT_OBJECT', 'manifest.json must be a JSON object', { path: 'manifest.json' })
    return result()
  }
  const pkg = validatePackageBlock(manifestJson.package, add)
  const { package: _package, ...pluginManifest } = manifestJson
  const validated = validatePluginManifest(pluginManifest)
  if (!validated.ok) {
    for (const finding of validated.findings) add('PLUGIN_SCAN_FAILED', finding.rule, finding.message, { path: 'manifest.json' })
  } else {
    checkReservedIdentity(validated.manifest, add)
  }
  if (!pkg) return result({ manifest: pluginManifest })

  // 4b. Whitelist and per-file limits.
  const docs = []
  let entryFile = null
  let iconFile = null
  for (const file of files) {
    const ext = extensionOf(file.path)
    const base = file.path.split('/').pop()
    let limit
    if (file.path === 'manifest.json') {
      continue
    } else if (ext === '.mjs') {
      if (file.path !== pkg.entry) {
        add('PLUGIN_PACKAGE_FORBIDDEN_FILE', 'EXTRA_MODULE', `only package.entry ('${pkg.entry}') may be a .mjs file`, { path: file.path })
        continue
      }
      entryFile = file
      limit = LIMITS.entryBytes
    } else if (DOC_EXTENSIONS.includes(ext) || base === 'LICENSE') {
      docs.push(file)
      limit = LIMITS.docBytes
    } else if (ICON_EXTENSIONS.includes(ext)) {
      if (file.path !== pkg.icon) {
        add('PLUGIN_PACKAGE_FORBIDDEN_FILE', 'UNREFERENCED_ICON', 'image files are allowed only as the icon named by package.icon', { path: file.path })
        continue
      }
      iconFile = file
      limit = LIMITS.iconBytes
    } else {
      add('PLUGIN_PACKAGE_FORBIDDEN_FILE', 'FORBIDDEN_FILE_TYPE', `file type not allowed in a plugin package${ext === '.svg' ? ' (.svg can carry script)' : ''}`, { path: file.path })
      continue
    }
    if (file.uncompressedSize > limit) {
      add('PLUGIN_PACKAGE_TOO_LARGE', 'FILE_TOO_LARGE', `${file.uncompressedSize} bytes; limit ${limit}`, { path: file.path })
    }
  }
  if (!entryFile) add('PLUGIN_PACKAGE_ENTRY_MISSING', 'ENTRY_MISSING', `package.entry '${pkg.entry}' is not in the package`, { path: pkg.entry })
  if (pkg.icon && !iconFile) add('PLUGIN_PACKAGE_INVALID', 'ICON_MISSING', `package.icon '${pkg.icon}' is not in the package`, { path: pkg.icon })
  if (pkg.readme && !docs.some(doc => doc.path === pkg.readme)) {
    add('PLUGIN_PACKAGE_INVALID', 'README_MISSING', `package.readme '${pkg.readme}' is not in the package`, { path: pkg.readme })
  }
  if (findings.some(f => f.severity === 'error')) return result({ manifest: pluginManifest })

  // Decompress everything once (bounded per entry), so later steps see real bytes.
  const fileList = []
  try {
    for (const file of files) {
      const data = read(file)
      fileList.push({ path: file.path, sizeBytes: data.length, sha256: sha256Hex(data) })
    }
  } catch (error) {
    if (!(error instanceof ZipFormatError)) throw error
    add(error.code, 'ZIP_DATA', error.message, { path: error.path })
    return result({ manifest: pluginManifest })
  }

  // 6. Entry: scanPluginSource, rules unchanged.
  let source
  try {
    source = utf8.decode(read(entryFile))
  } catch {
    add('PLUGIN_SCAN_FAILED', 'ENTRY_NOT_UTF8', 'entry must be UTF-8 text', { path: entryFile.path })
    return result({ manifest: pluginManifest, files: fileList })
  }
  for (const finding of scanPluginSource(source)) {
    findings.push({ code: 'PLUGIN_SCAN_FAILED', path: entryFile.path, ...finding })
  }

  // 7. Resources: icon format/size, docs valid UTF-8.
  if (iconFile) {
    try {
      const image = probeImage(read(iconFile))
      const declared = extensionOf(iconFile.path).slice(1)
      if (image.format !== declared) add('PLUGIN_PACKAGE_INVALID', 'ICON_FORMAT', `icon content is ${image.format} but the extension says ${declared}`, { path: iconFile.path })
      if (image.animated) add('PLUGIN_PACKAGE_INVALID', 'ICON_ANIMATED', 'animated icons are not supported', { path: iconFile.path })
      if (image.width > LIMITS.iconMaxEdge || image.height > LIMITS.iconMaxEdge) {
        add('PLUGIN_PACKAGE_TOO_LARGE', 'ICON_DIMENSIONS', `icon is ${image.width}x${image.height}; max edge ${LIMITS.iconMaxEdge}px`, { path: iconFile.path })
      }
    } catch (error) {
      add('PLUGIN_PACKAGE_INVALID', 'ICON_UNDECODABLE', error.message, { path: iconFile.path })
    }
  }
  for (const doc of docs) {
    let valid = false
    try {
      valid = !utf8.decode(read(doc)).includes('\u0000')
    } catch {}
    if (!valid) add('PLUGIN_PACKAGE_INVALID', 'DOC_NOT_UTF8', 'documents must be valid UTF-8 without NUL characters', { path: doc.path })
  }

  // 5.3 (worker side, run locally): bundle.manifest must equal manifest.json minus `package`.
  let bundleChecked = false
  if (importEntry && !findings.some(f => f.severity === 'error')) {
    bundleChecked = true
    await compareBundleManifest(source, pluginManifest, entryFile.path, add, warn)
  }

  return result({
    manifest: validated.ok ? validated.manifest : pluginManifest,
    package: pkg,
    files: fileList,
    bundleChecked,
  })
}

/* ------------------------------------------------------------------ helpers */

function unsafePathReason(entry) {
  const name = entry.name
  if (!name) return { rule: 'EMPTY_PATH', message: 'empty entry name' }
  if (entry.nameBytes.length > LIMITS.pathBytes) return { rule: 'PATH_TOO_LONG', message: `path exceeds ${LIMITS.pathBytes} UTF-8 bytes` }
  if (/[\x00-\x1f\x7f]/.test(name)) return { rule: 'CONTROL_CHARACTER', message: 'path contains NUL or control characters' }
  if (name.includes('\\')) return { rule: 'BACKSLASH', message: 'path contains a backslash' }
  if (name.startsWith('/')) return { rule: 'ABSOLUTE_PATH', message: 'absolute path' }
  if (/^[A-Za-z]:/.test(name)) return { rule: 'DRIVE_LETTER', message: 'path starts with a drive letter' }
  if (name.includes(':')) return { rule: 'COLON', message: "':' is not allowed in paths (drive letters, NTFS alternate streams)" }
  const segments = name.replace(/\/$/, '').split('/')
  if (segments.some(segment => segment === '..')) return { rule: 'PATH_TRAVERSAL', message: "path contains a '..' segment" }
  if (segments.some(segment => segment === '' || segment === '.')) return { rule: 'EMPTY_SEGMENT', message: "path contains an empty or '.' segment" }

  // External attributes: on a Unix-made entry the high 16 bits are st_mode.
  const host = entry.versionMadeBy >> 8
  if (host === 3 || host === 19) { // Unix, OS X
    const type = (entry.externalAttrs >>> 16) & 0o170000
    if (type === 0o120000) return { rule: 'SYMLINK', message: 'symbolic links are not allowed' }
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) return { rule: 'SPECIAL_FILE', message: 'device files, FIFOs and sockets are not allowed' }
    if (type === 0o040000 && !name.endsWith('/')) return { rule: 'SPECIAL_FILE', message: 'directory attribute on a file name' }
  }
  return null
}

/**
 * macOS archiver metadata dropped without a finding (mirrors the server's
 * isIgnoredPackagePath): anything under a `__MACOSX` directory at any depth, and
 * any `.DS_Store` file. Exact, case-sensitive names, as Finder writes them.
 */
export function isIgnoredPackagePath(name) {
  const segments = name.replace(/\/$/, '').split('/')
  return segments.includes('__MACOSX') || segments[segments.length - 1] === '.DS_Store'
}

/** '' for a flat package, '<dir>/' for a single wrapping directory, null when neither fits. */
function resolveRootPrefix(files, directories) {
  if (files.some(file => file.name === 'manifest.json')) return ''
  if (files.length === 0) return null
  const tops = new Set(files.map(file => (file.name.includes('/') ? file.name.split('/')[0] : null)))
  if (tops.size !== 1 || tops.has(null)) return null
  const prefix = `${[...tops][0]}/`
  if (!files.some(file => file.name === `${prefix}manifest.json`)) return null
  if (directories.some(dir => !dir.name.startsWith(prefix))) return null
  return prefix
}

function exceedsRatio(file) {
  // Same formula as the server: an empty compressed stream counts as 1 byte.
  return file.uncompressedSize > LIMITS.compressionRatio * Math.max(file.compressedSize, 1)
}

function extensionOf(path) {
  const base = path.split('/').pop()
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > LIMITS.pathBytes) return false
  if (/[\x00-\x1f\x7f\\]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** Validates spec section 3's `package` block. Returns the normalized block or null. */
function validatePackageBlock(raw, add) {
  // Codes follow the server: entry problems -> ENTRY_MISSING, svg icon -> FORBIDDEN_FILE,
  // everything else in the block -> PLUGIN_PACKAGE_INVALID.
  let ok = true
  const fail = (message, code = 'PLUGIN_PACKAGE_INVALID') => {
    add(code, 'INVALID_PACKAGE_BLOCK', message, { path: 'manifest.json' })
    ok = false
  }
  if (!isRecord(raw)) {
    fail('manifest.json needs a `package` object with `format` and `entry` (spec section 3)', 'PLUGIN_PACKAGE_ENTRY_MISSING')
    return null
  }
  for (const key of Object.keys(raw)) {
    if (!PACKAGE_KEYS.includes(key)) fail(`package.${key} is not a recognised field of package format ${PACKAGE_FORMAT}`)
  }
  if (raw.format !== PACKAGE_FORMAT) fail(`package.format must be ${PACKAGE_FORMAT}`)
  if (!isSafeRelativePath(raw.entry) || !raw.entry.endsWith('.mjs')) fail('package.entry must be a safe relative path ending in .mjs', 'PLUGIN_PACKAGE_ENTRY_MISSING')
  if (typeof raw.icon === 'string' && extensionOf(raw.icon) === '.svg') {
    fail('package.icon may not be SVG (it can carry script); use .png or .webp', 'PLUGIN_PACKAGE_FORBIDDEN_FILE')
  } else if (raw.icon !== undefined && (!isSafeRelativePath(raw.icon) || !ICON_EXTENSIONS.includes(extensionOf(raw.icon)))) {
    fail('package.icon must be a safe relative path to a .png or .webp file')
  }
  if (raw.readme !== undefined && (!isSafeRelativePath(raw.readme) || !DOC_EXTENSIONS.includes(extensionOf(raw.readme)))) {
    fail('package.readme must be a safe relative path to a .md or .txt file')
  }
  if (raw.license !== undefined && (typeof raw.license !== 'string' || !/^[A-Za-z0-9.+\-() ]{1,100}$/.test(raw.license))) {
    fail('package.license must be an SPDX license expression')
  }
  if (raw.author !== undefined && (typeof raw.author !== 'string' || !raw.author.trim() || raw.author.length > 200)) {
    fail('package.author must be a non-empty string of at most 200 characters')
  }
  if (raw.homepage !== undefined) {
    let parsed = null
    try {
      parsed = typeof raw.homepage === 'string' ? new URL(raw.homepage) : null
    } catch {}
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) fail('package.homepage must be an https URL without credentials')
  }
  if (!ok) return null
  return {
    format: raw.format,
    entry: raw.entry,
    ...(raw.icon !== undefined ? { icon: raw.icon } : {}),
    ...(raw.readme !== undefined ? { readme: raw.readme } : {}),
    ...(raw.license !== undefined ? { license: raw.license } : {}),
    ...(raw.author !== undefined ? { author: raw.author } : {}),
    ...(raw.homepage !== undefined ? { homepage: raw.homepage } : {}),
  }
}

function checkReservedIdentity(manifest, add) {
  if (RESERVED_PLUGIN_IDS.includes(manifest.id)) {
    add('PLUGIN_ID_RESERVED', 'PLUGIN_ID_RESERVED', `'${manifest.id}' is a built-in plugin id`, { path: 'manifest.json' })
  }
  // Same derivation as pluginCredentialSpec: no credential block => providerId = manifest.id.
  const providerId = manifest.credential ? manifest.credential.providerId : manifest.id
  if (RESERVED_PROVIDER_IDS.includes(providerId)) {
    add('PROVIDER_ID_RESERVED', 'PROVIDER_ID_RESERVED', `provider '${providerId}' belongs to built-in plugins; use your own credential.providerId`, { path: 'manifest.json' })
  }
}

async function compareBundleManifest(source, pluginManifest, entryPath, add, warn) {
  let mod
  try {
    mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)
  } catch (error) {
    add('PLUGIN_SCAN_FAILED', 'ENTRY_IMPORT_FAILED', `entry failed to import: ${error.message}`, { path: entryPath })
    return
  }
  const plugin = mod?.default
  if (!plugin || typeof plugin !== 'object') {
    add('PLUGIN_NO_DEFAULT_EXPORT', 'PLUGIN_NO_DEFAULT_EXPORT', 'the bundle must carry the plugin object as `export default`', { path: entryPath })
    return
  }
  const bundleManifest = jsonClone(plugin.manifest)
  const fromFile = validatePluginManifest(pluginManifest)
  const fromBundle = validatePluginManifest(bundleManifest)
  if (!fromBundle.ok) {
    for (const finding of fromBundle.findings) add('PLUGIN_SCAN_FAILED', finding.rule, `bundle.manifest: ${finding.message}`, { path: entryPath })
    return
  }
  if (fromFile.ok) {
    const diff = firstDifference(fromBundle.manifest, fromFile.manifest)
    if (diff !== null) {
      add('PLUGIN_MANIFEST_MISMATCH', 'PLUGIN_MANIFEST_MISMATCH', `bundle.manifest differs from manifest.json (minus package) at ${diff}`, { path: entryPath })
    } else {
      const rawDiff = firstDifference(bundleManifest, jsonClone(pluginManifest))
      if (rawDiff !== null) warn('PLUGIN_MANIFEST_MISMATCH', 'RAW_MANIFEST_DIFFERS', `normalized manifests match, but the raw objects differ at ${rawDiff}`, { path: entryPath })
    }
  }
  const kind = fromBundle.manifest.kind
  const required = kind === 'language' ? ['validateConfig', 'complete'] : ['validateConfig', 'validateRequest', 'submit']
  const optional = kind === 'language' ? ['probe'] : ['probe', 'poll', 'cancel', 'openOutput']
  for (const name of required) {
    if (typeof plugin[name] !== 'function') add('PLUGIN_INTERFACE_INVALID', 'PLUGIN_INTERFACE_INVALID', `required function '${name}' is missing`, { path: entryPath })
  }
  for (const name of optional) {
    if (plugin[name] !== undefined && typeof plugin[name] !== 'function') add('PLUGIN_INTERFACE_INVALID', 'PLUGIN_INTERFACE_INVALID', `'${name}' must be a function when present`, { path: entryPath })
  }
}

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** JSON-path of the first difference (key order ignored), or null when deep-equal. */
export function firstDifference(a, b, path = '$') {
  if (a === b) return null
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return path
    if (a.length !== b.length) return `${path}.length`
    for (let i = 0; i < a.length; i++) {
      const diff = firstDifference(a[i], b[i], `${path}[${i}]`)
      if (diff) return diff
    }
    return null
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of [...keys].sort()) {
      const diff = firstDifference(a[key], b[key], `${path}.${key}`)
      if (diff) return diff
    }
    return null
  }
  return path
}
