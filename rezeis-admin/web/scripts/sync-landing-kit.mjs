#!/usr/bin/env node
/**
 * Vendor the landing kit from the sibling reiwa checkout into
 * `src/features/landing-builder/live/`.
 *
 * The kit (schema, sections, renderer, background, CSS — everything in reiwa's
 * `web/src/features/landing/` except the reiwa-only `landing-page.tsx`) is the
 * SINGLE renderer for the public landing page. The admin preview renders this
 * vendored copy, so the operator looks at the exact code visitors will see —
 * the previous hand-maintained preview re-implementation drifted 12 ways from
 * production and is gone.
 *
 * The copy is tracked in git and byte-frozen by `landing-kit.manifest.json`
 * (sha256 per file + source commit). `live-kit-manifest.test.ts` fails when a
 * vendored file is hand-edited or the manifest is stale, which converts silent
 * drift into a red test. To change the renderer: edit it in reiwa, run this
 * script, commit both repos — the same paired-release flow both projects
 * already use.
 *
 * Usage:  node scripts/sync-landing-kit.mjs [--check] [--source <reiwa-root>]
 *   --check   verify only (exit 1 on drift), copy nothing
 *   --source  reiwa checkout root; defaults to ../../../reiwa relative to the
 *             rezeis repo root (the layout of this workspace), then
 *             REIWA_ROOT env var.
 */
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const webRoot = join(__dirname, '..')
const dst = join(webRoot, 'src', 'features', 'landing-builder', 'live')
const MANIFEST_NAME = 'landing-kit.manifest.json'
const manifestPath = join(dst, MANIFEST_NAME)

/** reiwa-only files that must never be vendored. */
const EXCLUDE = new Set(['landing-page.tsx'])

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const sourceFlag = args.indexOf('--source')
const reiwaRoot =
  sourceFlag !== -1
    ? args[sourceFlag + 1]
    : (process.env.REIWA_ROOT ?? join(webRoot, '..', '..', '..', 'reiwa'))
const src = join(reiwaRoot, 'web', 'src', 'features', 'landing')

async function listKitFiles(dir, base = dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listKitFiles(full, base)))
      continue
    }
    const rel = relative(base, full).split(sep).join('/')
    if (EXCLUDE.has(rel)) continue
    out.push(rel)
  }
  return out.sort()
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Canonical LF form.
 *
 * Both repos are checked out with `core.autocrlf=true` on Windows, so the same
 * committed bytes are LF in git and CRLF on disk. Hashing what happens to be on
 * disk makes the manifest machine-dependent: it would go red on the first CI
 * run and on every fresh clone, for files nobody touched. Hash — and write —
 * the canonical form instead, so the manifest describes content rather than
 * one checkout's line-ending policy.
 */
const canonical = (text) => text.replace(/\r\n/g, '\n')

function sourceCommit() {
  try {
    const head = execSync('git rev-parse HEAD', { cwd: reiwaRoot, encoding: 'utf8' }).trim()
    // A commit that does not contain the vendored bytes is worse than no
    // provenance at all: anyone re-deriving the copy from that SHA gets a
    // mismatch and no hint as to why.
    const dirty = execSync('git status --porcelain -- web/src/features/landing', {
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
    files = await listKitFiles(src)
  } catch (err) {
    console.error(`[sync-landing-kit] cannot read kit source ${src}: ${err.message}`)
    console.error('[sync-landing-kit] pass --source <reiwa-root> or set REIWA_ROOT')
    process.exit(1)
  }
  if (files.length === 0) {
    console.error(`[sync-landing-kit] kit source ${src} is empty — refusing to sync`)
    process.exit(1)
  }

  const entries = {}
  const contents = new Map()
  for (const rel of files) {
    const text = canonical(await readFile(join(src, rel), 'utf8'))
    contents.set(rel, text)
    entries[rel] = sha256(text)
  }

  if (checkOnly) {
    let stale = false
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch {
      console.error('[sync-landing-kit] manifest missing — run the sync')
      process.exit(1)
    }
    const want = manifest.files ?? {}
    const wantKeys = Object.keys(want).sort()
    if (JSON.stringify(wantKeys) !== JSON.stringify(files)) stale = true
    // Enumerate the destination too. Deriving the file list from the source
    // alone made the check blind in exactly the direction that matters: a file
    // ADDED to live/ by hand, or one left behind after an upstream delete, is
    // invisible to a source-driven loop and reported as "in lockstep".
    let vendoredFiles = []
    try {
      // The manifest itself lives in `dst` and has no counterpart in the source.
      vendoredFiles = (await listKitFiles(dst)).filter((rel) => rel !== MANIFEST_NAME)
    } catch {
      stale = true
    }
    if (JSON.stringify(vendoredFiles) !== JSON.stringify(files)) stale = true
    for (const rel of files) {
      let vendored
      try {
        vendored = canonical(await readFile(join(dst, rel), 'utf8'))
      } catch {
        stale = true
        break
      }
      if (sha256(vendored) !== entries[rel] || want[rel] !== entries[rel]) stale = true
    }
    if (stale) {
      console.error('[sync-landing-kit] vendored kit differs from reiwa source — run the sync')
      process.exit(1)
    }
    console.log(`[sync-landing-kit] check OK — ${files.length} files in lockstep`)
    return
  }

  await rm(dst, { recursive: true, force: true })
  await mkdir(dst, { recursive: true })
  for (const rel of files) {
    const target = join(dst, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents.get(rel))
  }
  const manifest = {
    comment:
      'DO NOT EDIT files in live/ by hand — they are vendored from reiwa ' +
      '(web/src/features/landing). Edit there, then: node scripts/sync-landing-kit.mjs',
    sourceRepo: 'dizzzable/reiwa',
    sourcePath: 'web/src/features/landing',
    sourceCommit: sourceCommit(),
    syncedAt: new Date().toISOString(),
    files: entries,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(
    `[sync-landing-kit] vendored ${files.length} files from ${src} @ ${manifest.sourceCommit.slice(0, 10)}`,
  )
}

main().catch((err) => {
  console.error(`[sync-landing-kit] failed: ${err.stack ?? err.message}`)
  process.exit(1)
})
