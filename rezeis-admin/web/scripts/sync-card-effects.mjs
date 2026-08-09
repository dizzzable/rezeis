#!/usr/bin/env node
/**
 * Copy the shared card-effect components from THIS tree into the sibling reiwa
 * checkout, and record their hashes in `card-effects.manifest.json`.
 *
 * ── Why the direction is panel → cabinet, opposite to sync-originkit.mjs ─────
 * `scripts/sync-originkit.mjs` runs reiwa → panel, and that is right for the
 * effects it covers: they were vendored into reiwa from an external kit, and
 * reiwa is where they are edited.
 *
 * These are not those. Every component this script copies is exercised by a
 * test suite that exists ONLY in this repository — `gl-stub.ts`,
 * `render-scale.test.ts`, `reactbits-canvas-ownership.test.ts`,
 * `reactbits-repaired-lifecycle.test.tsx`, `reactbits-layout-sized-canvas.test.tsx`.
 * reiwa's `web/` has no test runner of its own: the repo's vitest config lives
 * at its root and collects `web/test/**` only, with no jsdom WebGL stub behind
 * it. A change authored in reiwa is therefore a change nothing can execute
 * until somebody copies it here; a change authored here is covered by the
 * lifecycle suite on the next run. The source of truth is the tree that can
 * prove the component still mounts, still releases its context, and still
 * honours the device-pixel budget — and that is this one.
 *
 * ── What is deliberately NOT copied ─────────────────────────────────────────
 * `paper.tsx` exists in both trees and is deliberately not byte-identical: it
 * is a hand-written adapter around @paper-design/shaders-react, and each repo
 * writes it in its own house style (semicolons and double quotes in reiwa, and
 * neither here). Its own header says so. Freezing it would turn a documented
 * decision into a red test on the first run — the two copies already differ
 * today — so it is excluded here and listed as excluded rather than silently
 * skipped, which is the failure mode this whole file exists to prevent.
 *
 * Usage:  node scripts/sync-card-effects.mjs [--check] [--target <reiwa-root>]
 *   --check    verify only (exit 1 on drift), copy nothing
 *   --target   reiwa checkout root; defaults to ../../../reiwa relative to the
 *              rezeis repo root, then REIWA_ROOT.
 */
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const webRoot = join(__dirname, '..')
const RELATIVE_PATH = 'web/src/components/reactbits'
const src = join(webRoot, 'src', 'components', 'reactbits')
const MANIFEST_NAME = 'card-effects.manifest.json'
const manifestPath = join(src, MANIFEST_NAME)

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const targetFlag = args.indexOf('--target')
const reiwaRoot =
  targetFlag !== -1
    ? args[targetFlag + 1]
    : (process.env.REIWA_ROOT ?? join(webRoot, '..', '..', '..', 'reiwa'))
const dst = join(reiwaRoot, 'web', 'src', 'components', 'reactbits')

/**
 * Not byte-frozen, and each for its own reason. Stated as a list rather than
 * left out of a glob so that adding a file to it has to be a decision.
 */
const EXCLUDED = new Map([
  ['paper.tsx', 'hand-written per repo in each repo\'s house style; see its header'],
  [
    'Aurora.tsx',
    'the two apps draw this effect from DIFFERENT files: the cabinet renders ' +
      'components/ui/aurora, eagerly, because aurora is the default card and ' +
      'splitting it would put a round trip in front of the commonest card in ' +
      'the product. Copying this file over that one would replace a deliberate ' +
      'eager component with a lazy one. The divergence predates this script and ' +
      'is named here so it is a decision rather than a gap.',
  ],
])

/**
 * The panel's `reactbits/` holds far more than the shared card effects — text
 * effects, cursors, panel-only backgrounds, the test harness itself. Listing
 * the frozen set explicitly is the point: a glob would sweep `gl-stub.ts` and
 * every `*.test.tsx` into reiwa, and a "copy everything that looks like a
 * component" rule is exactly how a panel-only file ends up shipped to a
 * subscriber.
 */
const FROZEN = [
  // Shared card effects that predate this script.
  'Balatro.tsx',
  'Beams.tsx',
  'Dither.tsx',
  'Galaxy.tsx',
  'Grainient.tsx',
  'Iridescence.tsx',
  'LineWaves.tsx',
  'LiquidChrome.tsx',
  'Particles.tsx',
  'Plasma.tsx',
  'Radar.tsx',
  'RippleGrid.tsx',
  'Silk.tsx',
  'SoftAurora.tsx',
  'Threads.tsx',
  'Waves.tsx',
  // Repaired reactbits, added to the card catalog alongside this script.
  'Antigravity.tsx',
  'ColorBends.tsx',
  'EvilEye.tsx',
  'FaultyTerminal.tsx',
  'LaserFlow.tsx',
  'LetterGlitch.tsx',
  'LightPillar.tsx',
  'MagicRings.tsx',
  'PixelBlast.tsx',
  'PlasmaWave.tsx',
  'PrismaticBurst.tsx',
  'ShapeGrid.tsx',
  // Not effects, but every effect above imports one of them for its
  // device-pixel budget. Identical component bytes over a drifted budget is
  // the same lie in a place nobody would think to look.
  'fiber-render-scale.tsx',
  'render-scale.ts',
].sort()

/**
 * Canonical LF form.
 *
 * Both repos are checked out with `core.autocrlf=true` on Windows, so the same
 * committed bytes are LF in git and CRLF on disk. Hashing what happens to be on
 * disk would make the manifest machine-dependent — green for whoever ran the
 * sync, red on CI and on every fresh clone, for files nobody touched.
 */
const canonical = (text) => text.replace(/\r\n/g, '\n')
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

function sourceCommit() {
  try {
    const repoRoot = join(webRoot, '..', '..')
    const head = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim()
    // A commit that does not contain the copied bytes is worse than no
    // provenance at all: anyone re-deriving the copy from that SHA gets a
    // mismatch and no hint as to why.
    const dirty = execSync(`git status --porcelain -- rezeis-admin/${RELATIVE_PATH}`, {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
    return dirty === '' ? head : `${head}-dirty`
  } catch {
    return 'unknown'
  }
}

async function main() {
  // Read the SOURCE first and fail loudly on a missing file. A frozen list that
  // silently shrank when someone renamed a component would keep the manifest
  // internally consistent while quietly dropping a file from the freeze.
  const contents = new Map()
  const entries = {}
  for (const name of FROZEN) {
    let text
    try {
      text = canonical(await readFile(join(src, name), 'utf8'))
    } catch (err) {
      console.error(`[sync-card-effects] frozen component ${name} is missing from ${src}`)
      console.error('[sync-card-effects] rename it in FROZEN, or restore the file')
      process.exit(1)
    }
    contents.set(name, text)
    entries[name] = sha256(text)
  }

  // Nothing on the excluded list may quietly stop existing either: an exclusion
  // that outlives its file is a reason nobody can check.
  for (const name of EXCLUDED.keys()) {
    try {
      await readFile(join(src, name), 'utf8')
    } catch {
      console.error(`[sync-card-effects] ${name} is on the exclusion list but no longer exists`)
      process.exit(1)
    }
  }

  let targetFiles
  try {
    targetFiles = new Set(
      (await readdir(dst, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name),
    )
  } catch (err) {
    console.error(`[sync-card-effects] cannot read the reiwa component tree ${dst}: ${err.message}`)
    console.error('[sync-card-effects] pass --target <reiwa-root> or set REIWA_ROOT')
    process.exit(1)
  }

  if (checkOnly) {
    const drifted = []
    const missing = []
    for (const name of FROZEN) {
      if (!targetFiles.has(name)) {
        missing.push(name)
        continue
      }
      const there = canonical(await readFile(join(dst, name), 'utf8'))
      if (sha256(there) !== entries[name]) drifted.push(name)
    }
    let manifest
    let targetManifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      targetManifest = JSON.parse(await readFile(join(dst, MANIFEST_NAME), 'utf8'))
    } catch {
      console.error('[sync-card-effects] manifest missing on one side — run the sync')
      process.exit(1)
    }
    const stale =
      JSON.stringify(Object.keys(manifest.files ?? {}).sort()) !== JSON.stringify(FROZEN) ||
      FROZEN.some((name) => manifest.files[name] !== entries[name]) ||
      // The copy carries its own manifest so that reiwa's CI — which has no
      // sibling panel checkout — can still prove its own files were not
      // hand-edited. Two manifests that disagree is the same drift one level up.
      JSON.stringify(targetManifest.files ?? {}) !== JSON.stringify(manifest.files)

    if (missing.length || drifted.length || stale) {
      if (missing.length) console.error(`[sync-card-effects] missing in reiwa: ${missing.join(', ')}`)
      if (drifted.length) console.error(`[sync-card-effects] drifted: ${drifted.join(', ')}`)
      if (stale) console.error('[sync-card-effects] manifest does not describe this tree')
      console.error('[sync-card-effects] run: node scripts/sync-card-effects.mjs')
      process.exit(1)
    }
    console.log(`[sync-card-effects] check OK — ${FROZEN.length} components in lockstep`)
    return
  }

  for (const name of FROZEN) {
    await writeFile(join(dst, name), contents.get(name))
  }
  const manifest = {
    comment:
      'DO NOT edit the reiwa copies by hand — they are copied from the rezeis panel ' +
      `(rezeis-admin/${RELATIVE_PATH}), which is the only tree that can run them. ` +
      'Edit there, then: node scripts/sync-card-effects.mjs',
    sourceRepo: 'dizzzable/rezeis',
    sourcePath: `rezeis-admin/${RELATIVE_PATH}`,
    targetRepo: 'dizzzable/reiwa',
    targetPath: RELATIVE_PATH,
    sourceCommit: sourceCommit(),
    syncedAt: new Date().toISOString(),
    excluded: Object.fromEntries(EXCLUDED),
    files: entries,
  }
  const serialised = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(manifestPath, serialised)
  // The same manifest lands in reiwa, byte for byte. Without it reiwa's CI has
  // nothing to check its own copies against: this repo is not on that machine,
  // so a hand-edit there would sail through every test it runs.
  await writeFile(join(dst, MANIFEST_NAME), serialised)
  console.log(
    `[sync-card-effects] copied ${FROZEN.length} components to ${dst} @ ${manifest.sourceCommit.slice(0, 10)}`,
  )
}

main().catch((err) => {
  console.error(`[sync-card-effects] failed: ${err.stack ?? err.message}`)
  process.exit(1)
})
