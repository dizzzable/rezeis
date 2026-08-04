import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Byte-freeze for the vendored landing kit (`live/`).
 *
 * The kit is the production renderer, copied verbatim from reiwa by
 * `scripts/sync-landing-kit.mjs`. These tests turn the two silent failure
 * modes of vendoring into red builds:
 *
 *  1. someone edits `live/` by hand — the copy no longer matches its manifest;
 *  2. someone edits the kit in reiwa and forgets to run the sync — the copy no
 *     longer matches the source (checked only when the sibling reiwa checkout
 *     exists; CI for this repo has no reiwa working tree).
 *
 * The old preview was a hand-maintained re-implementation and drifted from
 * production in 12 documented ways. This manifest is what makes that class of
 * bug structurally impossible to reintroduce quietly.
 */

const LIVE_DIR = join(__dirname, 'live')
const MANIFEST_PATH = join(LIVE_DIR, 'landing-kit.manifest.json')
const REIWA_KIT_DIR = join(__dirname, '..', '..', '..', '..', '..', '..', 'reiwa', 'web', 'src', 'features', 'landing')

/** reiwa-only files the sync never vendors — keep in step with the script. */
const EXCLUDE = new Set(['landing-page.tsx'])

/**
 * Hash the canonical LF form, matching `sync-landing-kit.mjs`.
 *
 * Both repos are checked out with `core.autocrlf=true` here, so identical
 * committed content is LF in git and CRLF on disk. Hashing raw bytes would make
 * every assertion below depend on the checkout's line-ending policy: green on
 * the machine that ran the sync, red on CI and on every fresh clone.
 */
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

describe('vendored landing kit', () => {
  it('has a manifest with content hashes and a source commit', () => {
    expect(Object.keys(manifest.files).length).toBeGreaterThan(0)
    // `-dirty` marks a sync taken from an uncommitted reiwa tree: the SHA is
    // real but does not contain the vendored bytes. Accepted so the sync works
    // mid-development, and named so nobody trusts it as provenance.
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}(-dirty)?$|^unknown$/)
  })

  it('contains exactly the files the manifest promises', () => {
    const onDisk = listFiles(LIVE_DIR).filter((f) => f !== 'landing-kit.manifest.json')
    expect(onDisk).toEqual(Object.keys(manifest.files).sort())
  })

  it('matches the manifest byte-for-byte (live/ is not hand-editable)', () => {
    const mismatched = Object.entries(manifest.files)
      // Hash the canonical LF form, exactly as the sync script does. Hashing
      // raw bytes would make this assertion depend on the checkout's line-ending
      // policy rather than on the file's content.
      .filter(([rel, hash]) => sha256(readFileSync(join(LIVE_DIR, rel), 'utf8')) !== hash)
      .map(([rel]) => rel)
    expect(
      mismatched,
      'live/ differs from its manifest — edit the kit in reiwa and run scripts/sync-landing-kit.mjs',
    ).toEqual([])
  })

  it('never vendors reiwa-only host files', () => {
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
