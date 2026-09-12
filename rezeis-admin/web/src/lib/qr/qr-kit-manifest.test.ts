import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Byte-freeze for the vendored QR renderer (`kit/`).
 *
 * The operator picks a QR style on the branding page and the cabinet draws it.
 * The page's preview, its "what the cabinet would draw" fallback and its
 * contrast verdict all run this copy of the cabinet's own renderer —
 * `qr-style.ts` and the `qr-options.ts` it imports — so what the operator
 * approves is what subscribers are shown, and a colour the page calls too
 * light is one the cabinet would not draw. A copy that drifted would keep both
 * promises inside the panel and break them in production, silently.
 *
 * Same treatment as the landing and media-viewer kits:
 *
 *  1. someone edits `kit/` by hand — the copy no longer matches its manifest;
 *  2. someone edits the renderer in reiwa and forgets to run the sync — the
 *     copy no longer matches the source (checked only where the sibling reiwa
 *     checkout exists; this repo's CI has no reiwa working tree).
 *
 * Unlike those kits the source is reiwa's shared `web/src/lib/`, so the kit is
 * an allowlist of two files rather than a directory minus exclusions.
 */

const KIT_DIR = join(__dirname, 'kit')
const MANIFEST_NAME = 'qr-kit.manifest.json'
const MANIFEST_PATH = join(KIT_DIR, MANIFEST_NAME)
// Six levels up from `qr/` reaches the workspace root that holds both
// checkouts: qr → lib → src → web → rezeis-admin → rezeis → root.
const REIWA_WEB_DIR = join(__dirname, '..', '..', '..', '..', '..', '..', 'reiwa', 'web')
const REIWA_LIB_DIR = join(REIWA_WEB_DIR, 'src', 'lib')

/** The only files this kit takes from reiwa's `lib/` — keep in step with the script. */
const INCLUDE = ['qr-options.ts', 'qr-style.ts'] as const

/** Hash the canonical LF form, matching the sync script. */
const sha256 = (text: string): string =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')

const listFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== MANIFEST_NAME)
    .map((entry) => entry.name)
    .sort()

interface Manifest {
  readonly sourceCommit: string
  readonly files: Record<string, string>
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest

describe('vendored QR renderer', () => {
  it('has a manifest with content hashes and a source commit', () => {
    expect(Object.keys(manifest.files).length).toBeGreaterThan(0)
    // `-dirty` marks a sync taken from an uncommitted reiwa tree: the SHA is
    // real but does not contain the vendored bytes. Accepted so the sync works
    // mid-development, and named so nobody trusts it as provenance.
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}(-dirty)?$|^unknown$/)
  })

  it('vendors exactly the files the kit names', () => {
    expect(Object.keys(manifest.files).sort()).toEqual([...INCLUDE])
  })

  it('contains exactly the files the manifest promises', () => {
    expect(listFiles(KIT_DIR)).toEqual(Object.keys(manifest.files).sort())
  })

  it('matches the manifest byte-for-byte (kit/ is not hand-editable)', () => {
    const mismatched = Object.entries(manifest.files)
      .filter(([rel, hash]) => sha256(readFileSync(join(KIT_DIR, rel), 'utf8')) !== hash)
      .map(([rel]) => rel)
    expect(
      mismatched,
      'lib/qr/kit/ differs from its manifest — edit the renderer in reiwa and run: node scripts/sync-landing-kit.mjs --kit qr',
    ).toEqual([])
  })

  // Cross-repo half: only meaningful on a machine that has both checkouts
  // side-by-side (the actual working setup). CI of this repo skips it. Keyed
  // on the checkout, not on the two files, so a rename upstream fails here
  // instead of quietly skipping.
  const hasSibling = existsSync(REIWA_WEB_DIR)
  it.skipIf(!hasSibling)('is in lockstep with the sibling reiwa checkout', () => {
    expect(INCLUDE.filter((rel) => !existsSync(join(REIWA_LIB_DIR, rel)))).toEqual([])
    const drifted = INCLUDE.filter(
      (rel) => sha256(readFileSync(join(REIWA_LIB_DIR, rel), 'utf8')) !== manifest.files[rel],
    )
    expect(
      drifted,
      'reiwa QR renderer changed after the last sync — run: node scripts/sync-landing-kit.mjs --kit qr',
    ).toEqual([])
  })
})
