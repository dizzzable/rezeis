#!/usr/bin/env node
/**
 * Vendor shared kits from the sibling reiwa checkout.
 *
 * The name is historical: this started as the landing kit alone and now carries
 * a table of them. Renaming the file would ripple through the manifest, the
 * drift test and half a dozen source comments for no behavioural gain, so the
 * table moved in instead.
 *
 * ── The landing kit → `src/features/landing-builder/live/` ────────────────
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
 * ── The media-viewer kit → `src/components/media/kit/` ───────────────────
 *
 * The rules the full-screen viewer runs on: what a drag means, where a pinch
 * anchors, how far a magnified image may travel, which attachments are worth
 * showing. Pure functions with no UI in them. The COMPONENT is written once per
 * app — the cabinet and the panel do not share a design system — but a viewer
 * whose paging or pan limits differ between the two would be two viewers, and
 * this workspace has already paid for that kind of drift more than once.
 *
 * Usage:  node scripts/sync-landing-kit.mjs [--check] [--kit <name>]
 *                                           [--source <reiwa-root>]
 *   --check   verify only (exit 1 on drift), copy nothing
 *   --kit     sync one kit by name instead of all of them
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

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const sourceFlag = args.indexOf('--source')
const kitFlag = args.indexOf('--kit')
const onlyKit = kitFlag !== -1 ? args[kitFlag + 1] : null
const reiwaRoot =
  sourceFlag !== -1
    ? args[sourceFlag + 1]
    : (process.env.REIWA_ROOT ?? join(webRoot, '..', '..', '..', 'reiwa'))

/**
 * Every kit vendored from reiwa.
 *
 * `exclude` lists files that live beside the kit in reiwa but belong only to
 * reiwa — the page that mounts the landing renderer, the React components that
 * render the viewer. They are the reason this is a file list and not a whole
 * directory: the shared part is the part with no app in it.
 */
const KITS = [
  {
    name: 'landing',
    sourcePath: 'web/src/features/landing',
    dst: join(webRoot, 'src', 'features', 'landing-builder', 'live'),
    manifest: 'landing-kit.manifest.json',
    exclude: new Set(['landing-page.tsx']),
    note: 'DO NOT EDIT files in live/ by hand — they are vendored from reiwa',
  },
  {
    name: 'media-viewer',
    sourcePath: 'web/src/features/media-viewer',
    dst: join(webRoot, 'src', 'components', 'media', 'kit'),
    manifest: 'media-viewer-kit.manifest.json',
    // The two viewer components and the hook that opens them: same rules, two
    // design systems, so each app writes its own and shares the arithmetic.
    exclude: new Set(['media-viewer.tsx', 'use-media-viewer.tsx']),
    note: 'DO NOT EDIT files in kit/ by hand — they are vendored from reiwa',
  },
]

async function listKitFiles(dir, exclude, base = dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listKitFiles(full, exclude, base)))
      continue
    }
    const rel = relative(base, full).split(sep).join('/')
    if (exclude.has(rel)) continue
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

function sourceCommit(sourcePath) {
  try {
    const head = execSync('git rev-parse HEAD', { cwd: reiwaRoot, encoding: 'utf8' }).trim()
    // A commit that does not contain the vendored bytes is worse than no
    // provenance at all: anyone re-deriving the copy from that SHA gets a
    // mismatch and no hint as to why.
    const dirty = execSync(`git status --porcelain -- ${sourcePath}`, {
      cwd: reiwaRoot,
      encoding: 'utf8',
    }).trim()
    return dirty === '' ? head : `${head}-dirty`
  } catch {
    return 'unknown'
  }
}

async function syncKit(kit) {
  const tag = `[sync-kit ${kit.name}]`
  const src = join(reiwaRoot, ...kit.sourcePath.split('/'))
  const dst = kit.dst
  const manifestPath = join(dst, kit.manifest)
  const MANIFEST_NAME = kit.manifest

  let files
  try {
    files = await listKitFiles(src, kit.exclude)
  } catch (err) {
    console.error(`${tag} cannot read kit source ${src}: ${err.message}`)
    console.error(`${tag} pass --source <reiwa-root> or set REIWA_ROOT`)
    process.exit(1)
  }
  if (files.length === 0) {
    console.error(`${tag} kit source ${src} is empty — refusing to sync`)
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
      console.error(`${tag} manifest missing — run the sync`)
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
      vendoredFiles = (await listKitFiles(dst, kit.exclude)).filter((rel) => rel !== MANIFEST_NAME)
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
      console.error(`${tag} vendored kit differs from reiwa source — run the sync`)
      process.exit(1)
    }
    console.log(`${tag} check OK — ${files.length} files in lockstep`)
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
      `${kit.note} (${kit.sourcePath}). ` +
      'Edit there, then: node scripts/sync-landing-kit.mjs',
    sourceRepo: 'dizzzable/reiwa',
    sourcePath: kit.sourcePath,
    sourceCommit: sourceCommit(kit.sourcePath),
    syncedAt: new Date().toISOString(),
    files: entries,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(
    `${tag} vendored ${files.length} files from ${src} @ ${manifest.sourceCommit.slice(0, 10)}`,
  )
}

async function main() {
  const selected = onlyKit ? KITS.filter((kit) => kit.name === onlyKit) : KITS
  if (selected.length === 0) {
    console.error(`[sync-kit] no kit named ${onlyKit} — known: ${KITS.map((k) => k.name).join(', ')}`)
    process.exit(1)
  }
  for (const kit of selected) await syncKit(kit)
}

main().catch((err) => {
  console.error(`[sync-kit] failed: ${err.stack ?? err.message}`)
  process.exit(1)
})
