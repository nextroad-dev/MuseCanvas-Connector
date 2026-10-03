import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { writeZip } from './zip.mjs'
import { checkPackage, isIgnoredPackagePath } from './check-package.mjs'

/*
 * Build a plugin directory into a single self-contained ESM bundle and a
 * deterministic zip package (wiki/plugin-package-spec.md sections 2-3).
 *
 * Plugin directory convention:
 *   manifest.json          single source of the manifest (+ `package` block)
 *   src/index.ts           build entry (or src/index.js / src/index.mjs; override with --src)
 *   README.md, CHANGELOG.md, LICENSE / LICENSE.md / LICENSE.txt   optional, copied when present
 *   <package.icon>         optional
 *
 * Only these files go into the zip; nothing is globbed, so stray files never ship.
 */

const SOURCE_CANDIDATES = ['src/index.ts', 'src/index.mts', 'src/index.js', 'src/index.mjs']
const OPTIONAL_DOCS = ['README.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt']

export async function readPluginManifest(pluginDir) {
  const path = join(pluginDir, 'manifest.json')
  if (!existsSync(path)) throw new Error(`${path} not found`)
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  const entry = manifest?.package?.entry
  if (typeof entry !== 'string' || !entry.endsWith('.mjs')) throw new Error('manifest.json: package.entry must name the .mjs bundle (spec section 3)')
  return manifest
}

/**
 * Bundle the plugin with esbuild: ESM, platform neutral, everything inlined, no
 * externals, no comments (a forbidden token inside a comment still fails the scan).
 * @returns {Promise<{ code: string, bytes: Uint8Array }>}
 */
export async function buildBundle(pluginDir, options = {}) {
  const dir = resolve(pluginDir)
  const src = options.src ? resolve(dir, options.src) : SOURCE_CANDIDATES.map(candidate => join(dir, candidate)).find(existsSync)
  if (!src || !existsSync(src)) throw new Error(`no build entry found in ${dir} (looked for ${SOURCE_CANDIDATES.join(', ')})`)
  const out = await build({
    entryPoints: [src],
    absWorkingDir: dir,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    external: [],
    write: false,
    outfile: join(dir, 'dist', 'bundle.mjs'),
    legalComments: 'none',
    sourcemap: false,
    minify: false,
    charset: 'utf8',
    treeShaking: true,
    logLevel: 'silent',
    metafile: true,
  })
  const file = out.outputFiles.find(output => output.path.endsWith('.mjs'))
  const imports = Object.values(out.metafile.outputs).flatMap(output => output.imports || [])
  if (imports.length) {
    throw new Error(`bundle still imports ${imports.map(i => i.path).join(', ')}; every dependency must be inlined`)
  }
  const code = rewriteDefaultExport(file.text)
  return { code, bytes: new TextEncoder().encode(code) }
}

/**
 * esbuild ends an ESM bundle with one clause like `export { a, x as default };`.
 * scanPluginSource only recognizes the literal `export default` and would warn
 * NO_DEFAULT_EXPORT, so split the default out:
 *   export { a };
 *   export default x;
 * Semantics are identical (x is a module-level binding). Left untouched when the
 * clause is not in the expected shape.
 */
export function rewriteDefaultExport(code) {
  const match = /\nexport \{([^}]*)\};\s*$/.exec(code)
  if (!match) return code
  const specifiers = match[1].split(',').map(s => s.trim()).filter(Boolean)
  const defaults = specifiers.filter(s => /^[A-Za-z_$][\w$]* as default$/.test(s))
  if (defaults.length !== 1) return code
  const local = defaults[0].split(/\s+/)[0]
  const rest = specifiers.filter(s => s !== defaults[0])
  const head = code.slice(0, match.index)
  const named = rest.length ? `\nexport {\n  ${rest.join(',\n  ')}\n};` : ''
  return `${head}${named}\nexport default ${local};\n`
}

/**
 * Build + collect + zip + check. Throws on build errors; returns the check result
 * (which may contain error findings — the caller decides whether to write the zip).
 */
export async function packPlugin(pluginDir, options = {}) {
  const dir = resolve(pluginDir)
  const manifest = await readPluginManifest(dir)
  const pkg = manifest.package
  const bundle = await buildBundle(dir, options)

  const files = [
    { path: 'manifest.json', data: await readFile(join(dir, 'manifest.json')) },
    { path: pkg.entry, data: bundle.bytes },
  ]
  const docs = new Set(OPTIONAL_DOCS)
  if (typeof pkg.readme === 'string') docs.add(pkg.readme)
  for (const doc of docs) {
    if (existsSync(join(dir, doc))) files.push({ path: doc, data: await readFile(join(dir, doc)) })
  }
  if (typeof pkg.icon === 'string') {
    if (!existsSync(join(dir, pkg.icon))) throw new Error(`package.icon '${pkg.icon}' not found in ${dir}`)
    files.push({ path: pkg.icon, data: await readFile(join(dir, pkg.icon)) })
  }

  // The packer never emits macOS metadata (the host would silently drop it).
  for (const file of files) {
    if (isIgnoredPackagePath(file.path)) throw new Error(`refusing to pack '${file.path}': __MACOSX/ and .DS_Store paths are ignored by the host`)
  }

  // Deterministic order: manifest first, then the rest by byte-wise path.
  const [first, ...rest] = files
  rest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const zip = writeZip([first, ...rest].map(file => ({ path: file.path, data: new Uint8Array(file.data) })))

  const check = await checkPackage(zip, { importEntry: options.importEntry !== false })
  return { zip, bundle, check, manifest, defaultName: `${manifest.id}-${manifest.version}.zip` }
}
