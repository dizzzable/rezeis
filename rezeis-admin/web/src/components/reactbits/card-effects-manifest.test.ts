import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CARD_EFFECT_COMPONENTS } from '@/features/branding/card-effect-registry'

/**
 * Byte-freeze for the card-effect components that exist in both repositories.
 *
 * Both apps draw the same subscription card: the cabinet shows it to the
 * subscriber, the configurator shows it to the operator. An operator tuning an
 * effect against a preview that has drifted from production is being lied to,
 * quietly, and the drift only ever surfaces as "it looked different in the
 * panel". Thirty files were kept in step by hand and NOTHING enforced it —
 * `originkit-manifest.test.ts` covers only the vendored Originkit set, and the
 * landing kit covers only itself. Everything under this directory that both
 * apps draw was on trust.
 *
 * The trust was already misplaced when this file was written, which is the
 * whole argument for it: `paper.tsx` had diverged in both directions (prose,
 * quoting, semicolons) with nothing to say so. That one is DELIBERATELY not
 * frozen — see `EXCLUDED` in the sync script and the header of `paper.tsx`
 * itself — and it is named there rather than dropped from a glob, so the
 * exclusion is a decision somebody made and not a hole somebody left.
 *
 * ── Direction of truth: this repo is the source, reiwa is the copy ──────────
 * The opposite of `sync-originkit.mjs`, and deliberately. The Originkit
 * components were vendored into reiwa from an external kit and are edited
 * there. These are edited HERE, because this is the only tree that can run
 * them: `gl-stub.ts`, `reactbits-repaired-lifecycle.test.tsx`,
 * `reactbits-canvas-ownership.test.ts` and `render-scale.test.ts` all live in
 * this repository, and reiwa's `web/` has no test runner at all — its vitest
 * config sits at the repo root and collects `web/test/**`, with no jsdom WebGL
 * stub behind it. A component edited in reiwa first is a component nothing can
 * execute until somebody copies it here.
 *
 * ── What this cannot catch ──────────────────────────────────────────────────
 * Identical bytes, not identical BEHAVIOUR. The two builds resolve `react`,
 * `three` and `ogl` from their own lockfiles at their own versions, compile
 * with their own tsconfig and bundle with their own Vite config; identical
 * source can still paint differently on either side of that. It also says
 * nothing about the props each app passes — that is the catalog's job, and
 * reiwa's `card-effect-catalog-parity.test.ts` is what compares those. And the
 * cross-repo half below is skipped wherever the sibling checkout is absent, so
 * on this repo's CI the only thing proven is that the copies here match their
 * own manifest.
 */

const COMPONENT_DIR = __dirname
const MANIFEST_NAME = 'card-effects.manifest.json'
const MANIFEST_PATH = join(COMPONENT_DIR, MANIFEST_NAME)
// Six levels up from `reactbits/` reaches the workspace root that holds both
// checkouts: reactbits → components → src → web → rezeis-admin → rezeis → root.
const REIWA_COMPONENT_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'reiwa',
  'web',
  'src',
  'components',
  'reactbits',
)

/**
 * Hash the canonical LF form, matching the sync script.
 *
 * Both repos are checked out with `core.autocrlf=true` here, so identical
 * committed content is LF in git and CRLF on disk. Hashing raw bytes would make
 * every assertion below depend on the checkout's line-ending policy: green on
 * the machine that ran the sync, red on CI and on every fresh clone.
 */
const sha256 = (text: string): string =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')

interface Manifest {
  readonly sourceCommit: string
  readonly excluded: Record<string, string>
  readonly files: Record<string, string>
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
const frozen = Object.keys(manifest.files).sort()

describe('frozen card-effect components', () => {
  it('has a manifest with content hashes and a source commit', () => {
    // Twenty-eight components plus the two render-scale modules they all import.
    expect(frozen.length).toBeGreaterThanOrEqual(30)
    // `-dirty` marks a sync taken from an uncommitted tree: the SHA is real but
    // does not contain the copied bytes. Accepted so the sync works
    // mid-development, and named so nobody trusts it as provenance.
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}(-dirty)?$|^unknown$/)
  })

  it('matches the manifest byte-for-byte in this tree', () => {
    const mismatched = frozen.filter(
      (name) => sha256(readFileSync(join(COMPONENT_DIR, name), 'utf8')) !== manifest.files[name],
    )
    expect(
      mismatched,
      'a frozen component changed without the manifest — run scripts/sync-card-effects.mjs',
    ).toEqual([])
  })

  it('states why anything shared is left unfrozen', () => {
    // An exclusion with no reason is indistinguishable from an oversight, and
    // `paper.tsx` is the file that proves the distinction matters: the two
    // copies really do differ, on purpose. `Aurora.tsx` is the other kind of
    // exclusion — not a differing copy but a different FILE on each side.
    expect(Object.keys(manifest.excluded).sort()).toEqual(['Aurora.tsx', 'paper.tsx'])
    for (const [name, reason] of Object.entries(manifest.excluded)) {
      expect(existsSync(join(COMPONENT_DIR, name)), `${name} is excluded but gone`).toBe(true)
      expect(reason.trim().length, `${name} has no reason`).toBeGreaterThan(20)
    }
  })

  it('freezes a component for every card effect this file can name', () => {
    // The catalog is what the panel puts in front of an operator. An effect
    // whose component is outside the freeze is an effect that can drift between
    // the preview and the card, and nothing else here would say so.
    //
    // Read off the registry's own import specifiers rather than a second list:
    // a list would be one more thing to keep in step, which is the failure this
    // whole file is about. Only the effects living directly under `reactbits/`
    // are in scope — `originkit/` has its own manifest, `paper` is excluded by
    // name, and `Aurora` is panel-only.
    const registrySource = readFileSync(join(COMPONENT_DIR, '..', '..', 'features', 'branding', 'card-effect-registry.ts'), 'utf8')
    const referenced = [
      ...registrySource.matchAll(/import\('@\/components\/reactbits\/([A-Za-z0-9_-]+)'\)/g),
    ].map((match) => `${match[1]}.tsx`)

    // Anchors the check: without it a change to the registry's import style
    // would leave this comparing an empty list to an empty list.
    expect(referenced.length).toBeGreaterThan(15)

    const unfrozen = [...new Set(referenced)].filter(
      (file) => !frozen.includes(file) && !(file in manifest.excluded),
    )
    expect(
      unfrozen,
      'card effects whose component is not frozen — add them to FROZEN in scripts/sync-card-effects.mjs',
    ).toEqual([])
  })

  it('offers a card effect for every frozen component (nothing rides along unused)', () => {
    // The reverse direction, and it does not follow from the one above. A file
    // added to FROZEN and never given a catalog entry gets copied into reiwa,
    // manifested, and shipped: bytes in a subscriber's bundle that no operator
    // can ever select. The two `render-scale` modules are the deliberate
    // exception — they are imported BY the effects rather than being effects.
    const SUPPORT = new Set(['render-scale.ts', 'fiber-render-scale.tsx'])
    const offered = new Set(
      Object.keys(CARD_EFFECT_COMPONENTS).map((id) => id.toLowerCase()),
    )
    // `paperMesh` and friends come out of `paper.tsx`, which is not frozen, so
    // matching by file stem is enough here.
    const orphans = frozen
      .filter((file) => !SUPPORT.has(file))
      .filter((file) => !offered.has(file.replace(/\.tsx$/, '').toLowerCase()))
    expect(
      orphans,
      'frozen components no card effect offers — give each an entry in card-effect-catalog.ts, or drop it from FROZEN',
    ).toEqual([])
  })

  // Cross-repo half: only meaningful on a machine that has both checkouts
  // side-by-side (the actual working setup). CI of this repo skips it.
  const hasSibling = existsSync(REIWA_COMPONENT_DIR)
  it.skipIf(!hasSibling)('is in lockstep with the sibling reiwa checkout', () => {
    const missing = frozen.filter((name) => !existsSync(join(REIWA_COMPONENT_DIR, name)))
    expect(missing, 'frozen components absent from reiwa — run scripts/sync-card-effects.mjs').toEqual([])

    const drifted = frozen.filter(
      (name) =>
        existsSync(join(REIWA_COMPONENT_DIR, name)) &&
        sha256(readFileSync(join(REIWA_COMPONENT_DIR, name), 'utf8')) !== manifest.files[name],
    )
    expect(
      drifted,
      'the reiwa copies differ from this tree — edit the component here and run scripts/sync-card-effects.mjs',
    ).toEqual([])
  })
})
