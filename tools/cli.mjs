#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { buildBundle, packPlugin, readPluginManifest } from './lib/pack.mjs'
import { checkPackage } from './lib/check-package.mjs'

/*
 * MuseCanvas plugin package CLI.
 *
 *   node tools/cli.mjs build <plugin-dir> [--src file]          bundle only -> <dir>/dist/<package.entry>
 *                                                               (+ dist/manifest.legacy.json for the legacy upload form)
 *   node tools/cli.mjs pack  <plugin-dir> [--out file.zip] [--src file] [--no-import]
 *   node tools/cli.mjs check <file.zip> [--no-import] [--json]
 *
 * The checks are a convenience copy of the MuseCanvas upload rules
 * (packages/providers/src/core/plugin-scan.ts + plugin-package.ts). MuseCanvas is
 * the authority: passing here does not guarantee the server accepts the package.
 */

const USAGE = `usage:
  node tools/cli.mjs build <plugin-dir> [--src <file>]
  node tools/cli.mjs pack  <plugin-dir> [--out <file.zip>] [--src <file>] [--no-import]
  node tools/cli.mjs check <file.zip> [--no-import] [--json]

  --no-import  skip importing the bundle (no bundle.manifest comparison); use for untrusted zips
`

function parseArgs(argv) {
  const [command, target, ...rest] = argv
  const flags = { importEntry: true, json: false }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--out') flags.out = rest[++i]
    else if (arg === '--src') flags.src = rest[++i]
    else if (arg === '--no-import') flags.importEntry = false
    else if (arg === '--json') flags.json = true
    else throw new Error(`unknown option ${arg}`)
  }
  return { command, target, flags }
}

function printFindings(findings) {
  for (const f of findings) {
    const where = [f.path, f.line ? `${f.line}:${f.column}` : null].filter(Boolean).join(':')
    const tag = f.severity === 'error' ? 'error' : 'warn '
    console.log(`  [${tag}] ${f.code}/${f.rule}${where ? ` ${where}` : ''} - ${f.message}`)
  }
}

function printSummary(check) {
  if (check.files) {
    console.log('files:')
    for (const file of check.files) console.log(`  ${file.sha256}  ${String(file.sizeBytes).padStart(8)}  ${file.path}`)
  }
  if (check.findings.length) {
    console.log('findings:')
    printFindings(check.findings)
  }
  if (!check.bundleChecked && check.ok) console.log('note: bundle.manifest comparison skipped (--no-import)')
  console.log(check.ok ? 'local checks: PASS' : 'local checks: FAIL')
  console.log('(local copy of the MuseCanvas upload rules; the server decides)')
}

/**
 * Transition aid: the live server still takes the legacy upload (a `manifest` text
 * field + a single .mjs). manifest.json minus `package` is exactly that field.
 */
async function writeLegacyManifest(target, manifest) {
  const { package: _package, ...legacy } = manifest
  const out = join(resolve(target), 'dist', 'manifest.legacy.json')
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(legacy, null, 2)}
`)
  return out
}

async function main() {
  const { command, target, flags } = parseArgs(process.argv.slice(2))
  if (!command || !target || !['build', 'pack', 'check'].includes(command)) {
    process.stderr.write(USAGE)
    return 2
  }

  if (command === 'build') {
    const manifest = await readPluginManifest(target)
    const bundle = await buildBundle(target, flags)
    const out = join(resolve(target), 'dist', manifest.package.entry)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, bundle.bytes)
    console.log(`bundle: ${relative(process.cwd(), out)} (${bundle.bytes.length} bytes)`)
    console.log(`legacy manifest: ${relative(process.cwd(), await writeLegacyManifest(target, manifest))}`)
    return 0
  }

  if (command === 'pack') {
    const { zip, bundle, check, manifest, defaultName } = await packPlugin(target, flags)
    console.log(`plugin: ${manifest.id}@${manifest.version}`)
    console.log(`bundle: ${manifest.package.entry} (${bundle.bytes.length} bytes)`)
    printSummary(check)
    if (!check.ok) {
      console.log('zip not written')
      return 1
    }
    const out = resolve(flags.out || join(resolve(target), 'dist', defaultName))
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, zip)
    // Also leave the bundle next to the sources for inspection (not used by upload).
    const bundleOut = join(resolve(target), 'dist', manifest.package.entry)
    await mkdir(dirname(bundleOut), { recursive: true })
    await writeFile(bundleOut, bundle.bytes)
    await writeLegacyManifest(target, manifest)
    console.log(`zip: ${relative(process.cwd(), out) || out} (${zip.length} bytes)`)
    console.log(`sha256: ${check.sha256}`)
    return 0
  }

  const bytes = new Uint8Array(await readFile(target))
  const check = await checkPackage(bytes, { importEntry: flags.importEntry })
  if (flags.json) {
    console.log(JSON.stringify(check, null, 2))
  } else {
    console.log(`zip: ${target} (${bytes.length} bytes)`)
    console.log(`sha256: ${check.sha256}`)
    if (check.manifest?.id) console.log(`plugin: ${check.manifest.id}@${check.manifest.version}`)
    printSummary(check)
  }
  return check.ok ? 0 : 1
}

main().then(
  code => { process.exitCode = code },
  error => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  },
)
