#!/usr/bin/env node
/**
 * Vendor the Originkit card-effect components from the sibling reiwa checkout
 * into `src/components/reactbits/originkit/`.
 *
 * Both apps draw the same card. The cabinet shows it to the subscriber and the
 * configurator shows it to the operator, and an operator who tunes an effect
 * against a preview that differs from production is being lied to. Every effect
 * component therefore exists twice, byte-identical, and this script is what
 * makes "identical" a fact rather than an intention: thirty-odd files kept in
 * step by hand is thirty-odd chances to fix a bug in one copy only.
 *
 * The copy is tracked in git and byte-frozen by `originkit.manifest.json`
 * (sha256 per file plus the source commit). `originkit-manifest.test.ts` turns a
 * hand-edited copy or a stale manifest into a red test. To change an effect:
 * edit it in reiwa, run this script, commit both repos — the paired-release flow
 * both projects already use, and the same arrangement as the landing kit.
 *
 * Usage:  node scripts/sync-originkit.mjs [--check] [--source <reiwa-root>]
 *   --check   verify only (exit 1 on drift), copy nothing
 *   --source  reiwa checkout root; defaults to ../../../reiwa relative to the
 *             rezeis repo root (the layout of this workspace), then REIWA_ROOT.
 */
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const webRoot = join(__dirname, '..')
const RELATIVE_PATH = 'web/src/components/reactbits/originkit'
const dst = join(webRoot, 'src', 'components', 'reactbits', 'originkit')
const MANIFEST_NAME = 'originkit.manifest.json'
const manifestPath = join(dst, MANIFEST_NAME)

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const sourceFlag = args.indexOf('--source')
const reiwaRoot =
  sourceFlag !== -1
    ? args[sourceFlag + 1]
    : (process.env.REIWA_ROOT ?? join(webRoot, '..', '..', '..', 'reiwa'))
const src = join(reiwaRoot, 'web', 'src', 'components', 'reactbits', 'originkit')

/** Flat directory of components — no nesting, and nothing reiwa-only to exclude. */
async function listComponents(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name !== MANIFEST_NAME)
    .map((entry) => entry.name)
    .sort()
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Canonical LF form.
 *
 * Both repos are checked out with `core.autocrlf=true` on Windows, so the same
 * committed bytes are LF in git and CRLF on disk. Hashing what happens to be on
 * disk would make the manifest machine-dependent — green for whoever ran the
 * sync, red on CI and on every fresh clone, for files nobody touched.
 */
const canonical = (text) => text.replace(/\r\n/g, '\n')

function sourceCommit() {
  try {
    const head = execSync('git rev-parse HEAD', { cwd: reiwaRoot, encoding: 'utf8' }).trim()
    // A commit that does not contain the vendored bytes is worse than no
    // provenance at all: anyone re-deriving the copy from that SHA gets a
    // mismatch and no hint as to why.
    const dirty = execSync(`git status --porcelain -- ${RELATIVE_PATH}`, {
      cwd: reiwaRoot,
      encoding: 'utf8',
    }).trim()
    return dirty === '' ? head : `${head}-dirty`
  } catch {
    return 'unknown'
  }
}

async function main() {
  let files
  try {
    files = await listComponents(src)
  } catch (err) {
    console.error(`[sync-originkit] cannot read component source ${src}: ${err.message}`)
    console.error('[sync-originkit] pass --source <reiwa-root> or set REIWA_ROOT')
    process.exit(1)
  }
  if (files.length === 0) {
    console.error(`[sync-originkit] component source ${src} is empty — refusing to sync`)
    process.exit(1)
  }

  const entries = {}
  const contents = new Map()
  for (const name of files) {
    const text = canonical(await readFile(join(src, name), 'utf8'))
    contents.set(name, text)
    entries[name] = sha256(text)
  }

  if (checkOnly) {
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch {
      console.error('[sync-originkit] manifest missing — run the sync')
      process.exit(1)
    }
    let stale = JSON.stringify(Object.keys(manifest.files ?? {}).sort()) !== JSON.stringify(files)
    // Enumerate the destination as well. Deriving the list from the source alone
    // is blind in the direction that matters most: a file ADDED to the copy by
    // hand, or left behind after an upstream delete, never appears in a
    // source-driven loop and would be reported as "in lockstep".
    try {
      const vendored = await listComponents(dst)
      if (JSON.stringify(vendored) !== JSON.stringify(files)) stale = true
      for (const name of files) {
        const text = canonical(await readFile(join(dst, name), 'utf8'))
        if (sha256(text) !== entries[name] || manifest.files?.[name] !== entries[name]) stale = true
      }
    } catch {
      stale = true
    }
    if (stale) {
      console.error('[sync-originkit] vendored components differ from reiwa source — run the sync')
      process.exit(1)
    }
    console.log(`[sync-originkit] check OK — ${files.length} components in lockstep`)
    return
  }

  await rm(dst, { recursive: true, force: true })
  await mkdir(dst, { recursive: true })
  for (const name of files) {
    await writeFile(join(dst, name), contents.get(name))
  }
  const manifest = {
    comment:
      'DO NOT EDIT files in originkit/ by hand — they are vendored from reiwa ' +
      `(${RELATIVE_PATH}). Edit there, then: node scripts/sync-originkit.mjs`,
    sourceRepo: 'dizzzable/reiwa',
    sourcePath: RELATIVE_PATH,
    sourceCommit: sourceCommit(),
    syncedAt: new Date().toISOString(),
    files: entries,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(
    `[sync-originkit] vendored ${files.length} components from ${src} @ ${manifest.sourceCommit.slice(0, 10)}`,
  )
}

main().catch((err) => {
  console.error(`[sync-originkit] failed: ${err.stack ?? err.message}`)
  process.exit(1)
})
