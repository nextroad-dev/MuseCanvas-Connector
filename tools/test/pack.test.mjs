import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync as zlibDeflate } from 'node:zlib'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { packPlugin } from '../lib/pack.mjs'
import { checkPackage, isIgnoredPackagePath, LIMITS } from '../lib/check-package.mjs'
import { readCentralDirectory, readEntryData, writeZip, METHOD_DEFLATE, crc32 } from '../lib/zip.mjs'
import { deflateSync } from 'fflate'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TEMPLATE = join(ROOT, 'template')
const CLI = join(ROOT, 'tools', 'cli.mjs')
const run = promisify(execFile)

let packed // result of packing the template once
let baseFiles // [{ path, data }] extracted from the template zip

before(async () => {
  packed = await packPlugin(TEMPLATE)
  baseFiles = readCentralDirectory(packed.zip).map(entry => ({ path: entry.name, data: readEntryData(packed.zip, entry) }))
})

const text = (s) => new TextEncoder().encode(s)
const decode = (b) => new TextDecoder().decode(b)

/** Rebuild the template file set with edits: { path: Uint8Array | string | null }. */
function variant(edits = {}, options) {
  const files = baseFiles.map(f => ({ ...f }))
  for (const [path, data] of Object.entries(edits)) {
    const at = files.findIndex(f => f.path === path)
    if (data === null) {
      files.splice(at, 1)
      continue
    }
    const bytes = typeof data === 'string' ? text(data) : data
    if (at >= 0) files[at].data = bytes
    else files.push({ path, data: bytes })
  }
  return writeZip(files, options)
}

function manifestWith(mutate) {
  const manifest = JSON.parse(decode(baseFiles.find(f => f.path === 'manifest.json').data))
  mutate(manifest)
  return JSON.stringify(manifest, null, 2)
}

const entrySource = () => decode(baseFiles.find(f => f.path === 'plugin.mjs').data)

function codes(result) {
  return result.findings.filter(f => f.severity === 'error').map(f => `${f.code}/${f.rule}`)
}

function assertRejected(result, code, rule) {
  assert.equal(result.ok, false, 'expected rejection')
  assert.ok(codes(result).includes(`${code}/${rule}`), `expected ${code}/${rule}, got ${JSON.stringify(codes(result))}`)
}

function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 0 // grayscale
  const raw = Buffer.alloc((width + 1) * height)
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibDeflate(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}

/* ---------------------------------------------------------------- template */

test('template packs and passes every local check', () => {
  assert.equal(packed.check.ok, true, JSON.stringify(packed.check.findings))
  assert.deepEqual(packed.check.findings, [], 'no warnings either')
  assert.equal(packed.check.bundleChecked, true)
  assert.deepEqual(packed.check.files.map(f => f.path), ['manifest.json', 'CHANGELOG.md', 'LICENSE', 'README.md', 'assets/icon.png', 'plugin.mjs'])
})

test('packing is reproducible (same zip sha256)', async () => {
  const again = await packPlugin(TEMPLATE)
  assert.equal(again.check.sha256, packed.check.sha256)
  assert.deepEqual(again.zip, packed.zip)
})

test('bundle has zero runtime imports and literal export default', () => {
  const source = entrySource()
  assert.match(source, /\nexport default \w+;\n$/)
  assert.doesNotMatch(source, /^\s*import\s/m)
})

test('a single wrapping directory is accepted', async () => {
  const wrapped = writeZip([
    { path: 'example-video-0.1.0/', data: new Uint8Array() },
    ...baseFiles.map(f => ({ path: `example-video-0.1.0/${f.path}`, data: f.data })),
  ])
  const result = await checkPackage(wrapped)
  assert.equal(result.ok, true, JSON.stringify(result.findings))
})

test('macOS Finder metadata (__MACOSX/, .DS_Store) is ignored, wrapped or flat', async () => {
  const fork = new Uint8Array([0, 5, 22, 7, 0, 2, 0, 0])
  const finder = writeZip([
    { path: 'example-video-0.1.0/', data: new Uint8Array() },
    ...baseFiles.map(f => ({ path: `example-video-0.1.0/${f.path}`, data: f.data })),
    { path: 'example-video-0.1.0/.DS_Store', data: text('Bud1') },
    { path: 'example-video-0.1.0/assets/.DS_Store', data: text('Bud1') },
    { path: '__MACOSX/', data: new Uint8Array() },
    { path: '__MACOSX/example-video-0.1.0/', data: new Uint8Array() },
    { path: '__MACOSX/example-video-0.1.0/._manifest.json', data: fork },
    { path: '__MACOSX/example-video-0.1.0/._plugin.mjs', data: fork },
  ])
  const wrapped = await checkPackage(finder)
  assert.equal(wrapped.ok, true, JSON.stringify(wrapped.findings))
  assert.deepEqual(wrapped.files.map(f => f.path), baseFiles.map(f => f.path))

  const flat = await checkPackage(variant({ '.DS_Store': 'Bud1', '__MACOSX/._plugin.mjs': fork }))
  assert.equal(flat.ok, true, JSON.stringify(flat.findings))
  assert.equal(flat.files.some(f => f.path.includes('.DS_Store') || f.path.includes('__MACOSX')), false)
})

test('ignored macOS entries still count toward the entry cap and uncompressed total, and stay path-checked', async () => {
  const crowded = {}
  for (let i = 0; i <= LIMITS.entries - baseFiles.length; i++) crowded[`__MACOSX/._n${i}`] = 'x'
  assertRejected(await checkPackage(variant(crowded)), 'PLUGIN_PACKAGE_TOO_LARGE', 'TOO_MANY_ENTRIES')

  // Declared size only: the entry is never inflated, so a lying header is enough.
  const big = variant({ '__MACOSX/._big': 'x' }, {
    raw: f => (f.path === '__MACOSX/._big' ? { declaredSize: LIMITS.totalUncompressedBytes + 1 } : null),
  })
  assertRejected(await checkPackage(big), 'PLUGIN_PACKAGE_TOO_LARGE', 'UNCOMPRESSED_TOO_LARGE')

  assertRejected(await checkPackage(variant({ '__MACOSX/../evil.md': 'x' })), 'PLUGIN_PACKAGE_UNSAFE_PATH', 'PATH_TRAVERSAL')
  // Look-alikes are not ignored.
  assertRejected(await checkPackage(variant({ '__MACOSX/a:b': 'x' })), 'PLUGIN_PACKAGE_UNSAFE_PATH', 'COLON')
  assertRejected(await checkPackage(variant({ '__macosx/x.bin': 'x' })), 'PLUGIN_PACKAGE_FORBIDDEN_FILE', 'FORBIDDEN_FILE_TYPE')
})

test('the packer never emits macOS metadata', async () => {
  for (const file of packed.check.files) assert.equal(isIgnoredPackagePath(file.path), false, file.path)
  const dir = await mkdtemp(join(tmpdir(), 'mc-junk-'))
  const manifest = JSON.parse(decode(baseFiles.find(f => f.path === 'manifest.json').data))
  // Only reachable through package.readme / package.icon, since nothing is globbed.
  manifest.package.readme = '__MACOSX/README.md'
  delete manifest.package.icon
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, '__MACOSX'), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(dir, 'src', 'index.js'), 'export default { manifest: {} }')
  await writeFile(join(dir, '__MACOSX', 'README.md'), '# x')
  await assert.rejects(packPlugin(dir), /__MACOSX/)
})

test('colons in paths and non-UTF-8 names are unsafe; UTF-8 names without the flag are read as UTF-8', async () => {
  assertRejected(await checkPackage(variant({ 'docs/a:b.md': 'x' })), 'PLUGIN_PACKAGE_UNSAFE_PATH', 'COLON')
  const latin1 = variant({ 'docs/x.md': 'x' }, { raw: f => (f.path === 'docs/x.md' ? { nameBytes: new Uint8Array([0x64, 0x2f, 0xe9, 0x2e, 0x6d, 0x64]) } : null) })
  assertRejected(await checkPackage(latin1), 'PLUGIN_PACKAGE_UNSAFE_PATH', 'ZIP_STRUCTURE')
  const unflagged = variant({ 'docs/说明.md': '# 说明' }, { raw: f => (f.path === 'docs/说明.md' ? { flags: 0 } : null) })
  const result = await checkPackage(unflagged)
  assert.equal(result.ok, true, JSON.stringify(result.findings))
})

/* ---------------------------------------------------------------- rejections */

test('rejects a second .mjs', async () => {
  assertRejected(await checkPackage(variant({ 'lib/helper.mjs': 'export const x = 1' })), 'PLUGIN_PACKAGE_FORBIDDEN_FILE', 'EXTRA_MODULE')
})

test('rejects a path traversal entry', async () => {
  assertRejected(await checkPackage(variant({ '../evil.md': '# x' })), 'PLUGIN_PACKAGE_UNSAFE_PATH', 'PATH_TRAVERSAL')
})

test('rejects absolute, backslash and drive-letter paths', async () => {
  assertRejected(await checkPackage(variant({ '/abs.md': 'x' })), 'PLUGIN_PACKAGE_UNSAFE_PATH', 'ABSOLUTE_PATH')
  assertRejected(await checkPackage(variant({ 'docs\\a.md': 'x' })), 'PLUGIN_PACKAGE_UNSAFE_PATH', 'BACKSLASH')
  assertRejected(await checkPackage(variant({ 'C:/a.md': 'x' })), 'PLUGIN_PACKAGE_UNSAFE_PATH', 'DRIVE_LETTER')
})

test('rejects case-insensitive duplicate paths', async () => {
  assertRejected(await checkPackage(variant({ 'readme.md': '# dup' })), 'PLUGIN_PACKAGE_UNSAFE_PATH', 'DUPLICATE_PATH')
})

test('rejects unix symlink entries', async () => {
  const zip = variant({ 'NOTES.md': 'target' }, {
    raw: f => (f.path === 'NOTES.md' ? { versionMadeBy: (3 << 8) | 20, externalAttrs: (0o120777 << 16) >>> 0 } : null),
  })
  assertRejected(await checkPackage(zip), 'PLUGIN_PACKAGE_UNSAFE_PATH', 'SYMLINK')
})

test('rejects encrypted entries', async () => {
  const zip = variant({}, { raw: f => (f.path === 'README.md' ? { flags: 0x0001 } : null) })
  assertRejected(await checkPackage(zip), 'PLUGIN_PACKAGE_INVALID', 'ZIP_STRUCTURE')
})

test('rejects two directory levels', async () => {
  const nested = writeZip(baseFiles.map(f => ({ path: `a/b/${f.path}`, data: f.data })))
  assertRejected(await checkPackage(nested), 'PLUGIN_PACKAGE_INVALID', 'LAYOUT')
})

test('rejects fetch( in the entry', async () => {
  const zip = variant({ 'plugin.mjs': `${entrySource()}\nconst leak = () => fetch("https://x.example")\n` })
  assertRejected(await checkPackage(zip), 'PLUGIN_SCAN_FAILED', 'FORBIDDEN_GLOBAL_FETCH')
})

test('rejects process.env in the entry', async () => {
  const zip = variant({ 'plugin.mjs': `${entrySource()}\nconst key = () => process.env.API_KEY\n` })
  assertRejected(await checkPackage(zip), 'PLUGIN_SCAN_FAILED', 'FORBIDDEN_PROCESS_ENV')
})

test('rejects runtime imports in the entry', async () => {
  const zip = variant({ 'plugin.mjs': `import { readFileSync } from "node:fs"\n${entrySource()}` })
  const result = await checkPackage(zip)
  assertRejected(result, 'PLUGIN_SCAN_FAILED', 'FORBIDDEN_RUNTIME_IMPORT')
  assertRejected(result, 'PLUGIN_SCAN_FAILED', 'FORBIDDEN_NODE_BUILTIN')
})

test('rejects an svg icon (both as package.icon and as a stray file)', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
  const asIcon = variant({
    'manifest.json': manifestWith(m => { m.package.icon = 'assets/icon.svg' }),
    'assets/icon.png': null,
    'assets/icon.svg': svg,
  })
  assertRejected(await checkPackage(asIcon), 'PLUGIN_PACKAGE_FORBIDDEN_FILE', 'INVALID_PACKAGE_BLOCK')
  assertRejected(await checkPackage(variant({ 'assets/logo.svg': svg })), 'PLUGIN_PACKAGE_FORBIDDEN_FILE', 'FORBIDDEN_FILE_TYPE')
})

test('rejects an unreferenced image and an oversize icon', async () => {
  assertRejected(await checkPackage(variant({ 'assets/other.png': png(8, 8) })), 'PLUGIN_PACKAGE_FORBIDDEN_FILE', 'UNREFERENCED_ICON')
  assertRejected(await checkPackage(variant({ 'assets/icon.png': png(600, 4) })), 'PLUGIN_PACKAGE_TOO_LARGE', 'ICON_DIMENSIONS')
})

test('rejects bundle manifest that differs from manifest.json', async () => {
  const zip = variant({ 'manifest.json': manifestWith(m => { m.displayName = 'Renamed in manifest.json only' }) })
  const result = await checkPackage(zip)
  assertRejected(result, 'PLUGIN_MANIFEST_MISMATCH', 'PLUGIN_MANIFEST_MISMATCH')
  assert.match(result.findings.find(f => f.code === 'PLUGIN_MANIFEST_MISMATCH').message, /\$\.displayName/)
})

test('--no-import skips the bundle manifest comparison', async () => {
  const zip = variant({ 'manifest.json': manifestWith(m => { m.displayName = 'Renamed' }) })
  const result = await checkPackage(zip, { importEntry: false })
  assert.equal(result.ok, true)
  assert.equal(result.bundleChecked, false)
})

test('rejects missing entry, bad package block and reserved provider id', async () => {
  assertRejected(await checkPackage(variant({ 'plugin.mjs': null })), 'PLUGIN_PACKAGE_ENTRY_MISSING', 'ENTRY_MISSING')
  assertRejected(await checkPackage(variant({ 'manifest.json': manifestWith(m => { m.package.format = 2 }) })), 'PLUGIN_PACKAGE_INVALID', 'INVALID_PACKAGE_BLOCK')
  assertRejected(await checkPackage(variant({ 'manifest.json': manifestWith(m => { m.package.homepage = 'http://x.example' }) })), 'PLUGIN_PACKAGE_INVALID', 'INVALID_PACKAGE_BLOCK')
  assertRejected(await checkPackage(variant({ 'manifest.json': manifestWith(m => { m.package.minHostVersion = '1.0.0' }) })), 'PLUGIN_PACKAGE_INVALID', 'INVALID_PACKAGE_BLOCK')
  assertRejected(await checkPackage(variant({ 'manifest.json': manifestWith(m => { delete m.package }) })), 'PLUGIN_PACKAGE_ENTRY_MISSING', 'INVALID_PACKAGE_BLOCK')
  assertRejected(await checkPackage(variant({ 'manifest.json': manifestWith(m => { m.credential.providerId = 'openai' }) })), 'PROVIDER_ID_RESERVED', 'PROVIDER_ID_RESERVED')
})

test('rejects other forbidden file types', async () => {
  for (const path of ['extra.json', 'helper.js', 'native.node', 'mod.wasm', 'page.html', 'nested.zip']) {
    assertRejected(await checkPackage(variant({ [path]: 'x' })), 'PLUGIN_PACKAGE_FORBIDDEN_FILE', 'FORBIDDEN_FILE_TYPE')
  }
})

/* ---------------------------------------------------------------- sizes */

test('rejects a zip over 6 MiB before reading it', async () => {
  const result = await checkPackage(new Uint8Array(LIMITS.zipBytes + 1))
  assertRejected(result, 'PLUGIN_PACKAGE_TOO_LARGE', 'ZIP_TOO_LARGE')
})

test('rejects an entry bundle over 5 MiB', async () => {
  const big = new Uint8Array(LIMITS.entryBytes + 1024)
  for (let i = 0; i < big.length; i++) big[i] = 97 + ((i * 7919) % 26) // incompressible-ish text, under the ratio cap
  const zip = variant({ 'plugin.mjs': big })
  assertRejected(await checkPackage(zip), 'PLUGIN_PACKAGE_TOO_LARGE', 'FILE_TOO_LARGE')
})

test('rejects an oversize document', async () => {
  const doc = 'x'.repeat(LIMITS.docBytes + 1)
  assertRejected(await checkPackage(variant({ 'NOTES.md': doc })), 'PLUGIN_PACKAGE_TOO_LARGE', 'FILE_TOO_LARGE')
})

test('rejects more than 32 entries', async () => {
  const edits = {}
  for (let i = 0; i < 30; i++) edits[`docs/${i}.md`] = `# ${i}`
  assertRejected(await checkPackage(variant(edits)), 'PLUGIN_PACKAGE_TOO_LARGE', 'TOO_MANY_ENTRIES')
})

test('rejects a compression ratio over 100:1', async () => {
  const zeros = new Uint8Array(200 * 1024)
  const zip = variant({ 'NOTES.md': zeros }, {
    raw: f => (f.path === 'NOTES.md' ? { method: METHOD_DEFLATE, compressedData: deflateSync(zeros, { level: 9 }) } : null),
  })
  assertRejected(await checkPackage(zip), 'PLUGIN_PACKAGE_BOMB', 'COMPRESSION_RATIO')
})

test('rejects an entry that inflates past its declared size', async () => {
  const doc = text('# hello hello hello hello hello')
  const zip = variant({ 'NOTES.md': doc }, {
    raw: f => (f.path === 'NOTES.md' ? { method: METHOD_DEFLATE, compressedData: deflateSync(doc), declaredSize: 4 } : null),
  })
  assertRejected(await checkPackage(zip), 'PLUGIN_PACKAGE_BOMB', 'ZIP_DATA')
})

/* ---------------------------------------------------------------- CLI */

test('cli check exits 0 for the template zip and 1 for a rejected one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mc-pack-'))
  const good = join(dir, 'good.zip')
  const bad = join(dir, 'bad.zip')
  await writeFile(good, packed.zip)
  await writeFile(bad, variant({ 'lib/second.mjs': 'export default 1' }))
  const ok = await run(process.execPath, [CLI, 'check', good])
  assert.match(ok.stdout, /local checks: PASS/)
  assert.match(ok.stdout, new RegExp(`sha256: ${packed.check.sha256}`))
  await assert.rejects(run(process.execPath, [CLI, 'check', bad]), e => e.code === 1 && /EXTRA_MODULE/.test(e.stdout))
})
