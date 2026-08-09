import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CARD_EFFECT_CATALOG } from '@/features/branding/card-effect-catalog'

/**
 * Byte-freeze for the vendored Originkit effect components.
 *
 * Both apps draw the same subscription card: the cabinet shows it to the
 * subscriber, the configurator shows it to the operator. An operator tuning an
 * effect against a preview that has drifted from production is being lied to,
 * quietly, and the drift only surfaces as "it looked different in the panel".
 * So every component exists twice, byte-identical, vendored from reiwa by
 * `scripts/sync-originkit.mjs`.
 *
 * These tests turn the two silent failure modes of vendoring into red builds:
 *
 *  1. someone edits a copy here by hand — it no longer matches its manifest;
 *  2. someone edits the component in reiwa and forgets to run the sync — the
 *     copy no longer matches the source (checked only where the sibling reiwa
 *     checkout exists; this repo's CI has no reiwa working tree).
 *
 * Same arrangement, and the same reasoning, as the vendored landing kit.
 */

const ORIGINKIT_DIR = join(__dirname, 'originkit')
const MANIFEST_NAME = 'originkit.manifest.json'
const MANIFEST_PATH = join(ORIGINKIT_DIR, MANIFEST_NAME)
// Six levels up from `reactbits/` reaches the workspace root that holds both
// checkouts: reactbits → components → src → web → rezeis-admin → rezeis → root.
const REIWA_ORIGINKIT_DIR = join(
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
  'originkit',
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

const listComponents = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== MANIFEST_NAME)
    .map((entry) => entry.name)
    .sort()

interface Manifest {
  readonly sourceCommit: string
  readonly files: Record<string, string>
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest

describe('vendored Originkit components', () => {
  it('has a manifest with content hashes and a source commit', () => {
    expect(Object.keys(manifest.files).length).toBeGreaterThan(0)
    // `-dirty` marks a sync taken from an uncommitted reiwa tree: the SHA is
    // real but does not contain the vendored bytes. Accepted so the sync works
    // mid-development, and named so nobody trusts it as provenance.
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}(-dirty)?$|^unknown$/)
  })

  it('contains exactly the components the manifest promises', () => {
    expect(listComponents(ORIGINKIT_DIR)).toEqual(Object.keys(manifest.files).sort())
  })

  it('matches the manifest byte-for-byte (originkit/ is not hand-editable)', () => {
    const mismatched = Object.entries(manifest.files)
      .filter(([name, hash]) => sha256(readFileSync(join(ORIGINKIT_DIR, name), 'utf8')) !== hash)
      .map(([name]) => name)
    expect(
      mismatched,
      'originkit/ differs from its manifest — edit the component in reiwa and run scripts/sync-originkit.mjs',
    ).toEqual([])
  })

  const declaredComponents = (): readonly (readonly [string, string])[] =>
    Object.entries(CARD_EFFECT_CATALOG)
      .map(([id, entry]) => [id, (entry as { componentFile?: string }).componentFile] as const)
      .filter((pair): pair is readonly [string, string] => pair[1] !== undefined)

  it('vendors a component for every Originkit effect the catalog offers', () => {
    // The catalog is what the panel puts in front of an operator. An entry whose
    // component was never vendored is a tile that renders nothing, and it would
    // otherwise only be noticed by someone clicking all thirty of them.
    const declared = declaredComponents()

    // Anchors the check: without it, the moment `componentFile` stopped being
    // written this would compare an empty list to an empty list and pass while
    // guarding nothing.
    expect(declared.length).toBeGreaterThan(0)

    const vendored = new Set(listComponents(ORIGINKIT_DIR))
    expect(declared.filter(([, file]) => !vendored.has(file)).map(([id]) => id)).toEqual([])
  })

  it('offers an effect for every vendored component (nothing rides along unused)', () => {
    // The reverse direction, and it does not follow from the one above. The sync
    // script copies whatever sits in reiwa's `originkit/`, wholesale — it has no
    // notion of which effects this panel offers. So a component added there and
    // never given a catalog entry arrives here fully vendored and fully
    // manifested, passes every other assertion in this file, and ships: bytes in
    // the bundle no operator can ever select, and a card the cabinet may already
    // be drawing while the panel cannot configure it. Nothing else notices,
    // because every other check in this file reads from the manifest, and the
    // manifest agrees with the file that should not be here.
    const declared = new Set(declaredComponents().map(([, file]) => file))
    expect(declared.size).toBeGreaterThan(0)

    const vendored = listComponents(ORIGINKIT_DIR)
    expect(vendored.length).toBeGreaterThan(0)

    expect(
      vendored.filter((file) => !declared.has(file)),
      'vendored components no catalog entry offers — give each one an entry in card-effect-catalog.ts, or delete it from reiwa and re-run scripts/sync-originkit.mjs',
    ).toEqual([])
  })

  // Cross-repo half: only meaningful on a machine that has both checkouts
  // side-by-side (the actual working setup). CI of this repo skips it.
  const hasSibling = existsSync(REIWA_ORIGINKIT_DIR)
  it.skipIf(!hasSibling)('is in lockstep with the sibling reiwa checkout', () => {
    const sourceFiles = listComponents(REIWA_ORIGINKIT_DIR)
    expect(sourceFiles).toEqual(Object.keys(manifest.files).sort())
    const drifted = sourceFiles.filter(
      (name) => sha256(readFileSync(join(REIWA_ORIGINKIT_DIR, name), 'utf8')) !== manifest.files[name],
    )
    expect(
      drifted,
      'reiwa components changed after the last sync — run scripts/sync-originkit.mjs',
    ).toEqual([])
  })
})
