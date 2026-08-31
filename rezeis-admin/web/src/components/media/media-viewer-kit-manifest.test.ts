import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Byte-freeze for the vendored media-viewer kit (`kit/`).
 *
 * The kit is the arithmetic the full-screen viewer runs on — what a drag means,
 * where a pinch anchors, how far a magnified image may travel, which
 * attachments are worth showing — copied verbatim from reiwa by
 * `scripts/sync-landing-kit.mjs`. The COMPONENT is written once per app,
 * because the cabinet and the panel do not share a design system; the rules are
 * not, because a viewer whose paging differed between the two would be two
 * viewers wearing the same name.
 *
 * Same two silent failure modes as the landing kit, same treatment:
 *
 *  1. someone edits `kit/` by hand — the copy no longer matches its manifest;
 *  2. someone edits the kit in reiwa and forgets to run the sync — the copy no
 *     longer matches the source (checked only when the sibling reiwa checkout
 *     exists; CI for this repo has no reiwa working tree).
 */

const KIT_DIR = join(__dirname, 'kit')
const MANIFEST_NAME = 'media-viewer-kit.manifest.json'
const MANIFEST_PATH = join(KIT_DIR, MANIFEST_NAME)
const REIWA_KIT_DIR = join(
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
  'features',
  'media-viewer',
)

/** reiwa-only files the sync never vendors — keep in step with the script. */
const EXCLUDE = new Set(['media-viewer.tsx', 'use-media-viewer.tsx'])

/** Hash the canonical LF form, matching the sync script. */
const sha256 = (text: string): string =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')

function listFiles(dir: string, base: string = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listFiles(full, base))
      continue
    }
    out.push(relative(base, full).split(sep).join('/'))
  }
  return out.sort()
}

interface Manifest {
  readonly sourceCommit: string
  readonly files: Record<string, string>
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest

describe('vendored media-viewer kit', () => {
  it('has a manifest with content hashes and a source commit', () => {
    expect(Object.keys(manifest.files).length).toBeGreaterThan(0)
    // `-dirty` marks a sync taken from an uncommitted reiwa tree: the SHA is
    // real but does not contain the vendored bytes. Accepted so the sync works
    // mid-development, and named so nobody trusts it as provenance.
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}(-dirty)?$|^unknown$/)
  })

  it('contains exactly the files the manifest promises', () => {
    const onDisk = listFiles(KIT_DIR).filter((f) => f !== MANIFEST_NAME)
    expect(onDisk).toEqual(Object.keys(manifest.files).sort())
  })

  it('matches the manifest byte-for-byte (kit/ is not hand-editable)', () => {
    const mismatched = Object.entries(manifest.files)
      .filter(([rel, hash]) => sha256(readFileSync(join(KIT_DIR, rel), 'utf8')) !== hash)
      .map(([rel]) => rel)
    expect(
      mismatched,
      'kit/ differs from its manifest — edit the kit in reiwa and run scripts/sync-landing-kit.mjs',
    ).toEqual([])
  })

  it('never vendors the app-specific viewer components', () => {
    for (const excluded of EXCLUDE) {
      expect(manifest.files[excluded]).toBeUndefined()
    }
  })

  // Cross-repo half: only meaningful on a machine that has both checkouts
  // side-by-side (the actual working setup). CI of this repo skips it.
  const hasSibling = existsSync(REIWA_KIT_DIR)
  it.skipIf(!hasSibling)('is in lockstep with the sibling reiwa checkout', () => {
    const sourceFiles = listFiles(REIWA_KIT_DIR).filter((f) => !EXCLUDE.has(f))
    expect(sourceFiles).toEqual(Object.keys(manifest.files).sort())
    const drifted = sourceFiles.filter(
      (rel) => sha256(readFileSync(join(REIWA_KIT_DIR, rel), 'utf8')) !== manifest.files[rel],
    )
    expect(
      drifted,
      'reiwa kit changed after the last sync — run scripts/sync-landing-kit.mjs',
    ).toEqual([])
  })
})
