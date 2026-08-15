/**
 * The production frontend build must be buildable from `web/` alone.
 *
 * WHY THIS EXISTS. The Dockerfile's frontend stage is:
 *
 *     COPY web/package.json web/package-lock.json web/.npmrc ./
 *     RUN npm ci
 *     COPY web/ .
 *     RUN npm run build
 *
 * `web/` and nothing else. On a developer's machine the whole repository is
 * around, so a file under `web/src` can reach `../../../../src/...` into the
 * NestJS backend and every local check stays green — `tsc -b`, `vite build`,
 * the full vitest suite. The image is the only place the isolation is real,
 * so the first thing that noticed was a failed build on a release tag.
 *
 * That happened. One test file gained two backend imports, six local
 * verifications passed, and `npm run build` died inside the image with
 * TS2307 on a directory the stage never copied.
 *
 * WHAT IS ALLOWED. Reaching across the boundary from a TEST is legitimate and
 * deliberate: `branding-preset-slot-preservation.test.tsx` drives the
 * backend's real `mergeBrandingSettings`/`readBrandingSettings` so that
 * "storage kept both renderings" is proved by storage rather than by a
 * re-implementation of it. Tests are excluded from `tsconfig.app.json` and
 * type-checked by `tsconfig.test.json` instead, where the repository exists.
 *
 * So the invariant is not "nobody reaches out". It is: **nothing the
 * production project compiles reaches out.** That is what this file asserts,
 * by reading the same include/exclude the build reads rather than a copy of
 * them — a copy would drift the moment someone edits the tsconfig.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `tsconfig.app.json` carries comments, so it is JSONC and `JSON.parse`
 * rejects it. Strip line comments only — that is all the file uses, and a
 * general JSONC parser would be a dependency for one read.
 */
function readJsonc(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n')
  return JSON.parse(text) as Record<string, unknown>
}

/** Every `.ts`/`.tsx` under a directory, repo-relative to `web/`. */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectSources(full, out)
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** The tsconfig `exclude` globs this project actually uses, as predicates. */
function matchesGlob(pattern: string, webRelative: string): boolean {
  const expression = pattern
    .split('/')
    .map((segment) =>
      segment === '**' ? '.*' : segment.replace(/\*/g, '[^/]*').replace(/\./g, '\\.'),
    )
    .join('/')
    .replace(/\.\*\//g, '(?:.*/)?')
  return new RegExp(`^${expression}$`).test(webRelative)
}

/** Relative specifiers only — `@/…` and bare package names cannot escape. */
const RELATIVE_IMPORT = /(?:^|[\s;])(?:import|export)[\s\S]*?from\s+['"](\.[^'"]*)['"]/g
const RELATIVE_TYPE_IMPORT = /import\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g

function escapingImports(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const escaping: string[] = []
  for (const pattern of [RELATIVE_IMPORT, RELATIVE_TYPE_IMPORT]) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const specifier = match[1]!
      const resolved = resolve(dirname(file), specifier)
      if (relative(WEB_ROOT, resolved).startsWith('..')) {
        escaping.push(specifier)
      }
    }
  }
  return escaping
}

describe('the production frontend project builds from web/ alone', () => {
  const appConfig = readJsonc(join(WEB_ROOT, 'tsconfig.app.json'))
  const excludes = (appConfig['exclude'] as string[] | undefined) ?? []

  it('excludes tests, which are the only files allowed across the boundary', () => {
    // If this list is emptied, the test below still catches the consequence —
    // but this says the arrangement out loud, so an "unnecessary exclude"
    // cleanup fails here with the reason rather than there with a puzzle.
    expect(
      excludes,
      'tsconfig.app.json no longer excludes tests — `npm run build` will type-check them, and the Docker frontend stage does not carry the backend they import',
    ).toContain('src/**/*.test.tsx')
  })

  it('compiles nothing that imports from outside web/', () => {
    const compiled = collectSources(join(WEB_ROOT, 'src')).filter((file) => {
      const webRelative = relative(WEB_ROOT, file).split(sep).join('/')
      return !excludes.some((pattern) => matchesGlob(pattern, webRelative))
    })

    // The anchor. Without it a broken glob that excludes everything would
    // leave nothing to inspect and this test would pass on an empty set —
    // the failure shape this whole repository has been hunting.
    expect(
      compiled.length,
      'the exclude globs matched every source file — nothing was inspected',
    ).toBeGreaterThan(100)

    const offenders = compiled
      .map((file) => ({
        file: relative(WEB_ROOT, file).split(sep).join('/'),
        specifiers: escapingImports(file),
      }))
      .filter((entry) => entry.specifiers.length > 0)

    expect(
      offenders,
      'a file compiled by the production build imports from outside web/. The Docker frontend stage copies web/ and nothing else, so this builds locally and fails in the image. Move it into web/, or make the importer a test (tests are excluded here and type-checked by tsconfig.test.json)',
    ).toEqual([])
  })

  it('still sees the one deliberate crossing, so the detector is not blind', () => {
    // `branding-preset-slot-preservation.test.tsx` reaches into the backend on
    // purpose. If this stops finding it, either the test changed or
    // `escapingImports` stopped working — and in the second case the guard
    // above would be quietly passing on everything.
    const crossing = escapingImports(
      join(WEB_ROOT, 'src/features/branding/branding-preset-slot-preservation.test.tsx'),
    )
    expect(
      crossing.length,
      'the known cross-boundary import is gone — if that was deliberate, delete this test; if not, the detector is broken',
    ).toBeGreaterThan(0)
  })
})
