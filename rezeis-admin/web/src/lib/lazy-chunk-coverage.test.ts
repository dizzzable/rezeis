/**
 * Every lazily loaded piece of the panel must survive a deploy.
 *
 * `React.lazy` on its own does not: after a deploy the hashed file an open tab
 * asks for is gone, the import 404s, and the operator gets the crash screen.
 * `lazyWithChunkRecovery` reloads the document once and the page opens as if
 * nothing had happened.
 *
 * The recovery used to live inside `app/router.tsx`, so ROUTE chunks had it and
 * everything loaded from inside a page did not — which is where it broke in
 * production on 16.09.2026 (a customer's card on «Пользователи»). A guard that
 * only restated the fix would not have caught that, so this one asks the
 * question the other way round: which files call `lazy(` at all, and do they
 * all take it from the helper?
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'src')

/**
 * Files that may call React's own `lazy`, with the reason each is exempt.
 * Paths are relative to `src/`; the last test fails if one stops existing, so
 * the list cannot rot into a silent exemption of something that moved.
 */
const EXEMPT = new Map<string, string>([
  ['lib/lazy-chunk.ts', 'the helper itself'],
  [
    'app/providers.tsx',
    "React Query devtools, mounted only under import.meta.env.DEV — a chunk that never ships cannot go stale",
  ],
])

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
    found.push(full)
  }
  return found
}

/** The file with comments and strings removed, so prose about `lazy()` is not a call. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
}

const CALLS_LAZY = /(?<![\w.$])lazy\s*\(/
const IMPORTS_REACT_LAZY = /import\s*\{[^}]*\blazy\b[^}]*\}\s*from\s*['"]react['"]/
const IMPORTS_HELPER = /import\s*\{[^}]*\blazyWithChunkRecovery\b[^}]*\}\s*from\s*['"]@\/lib\/lazy-chunk['"]/

describe('stale-chunk recovery covers every lazy import', () => {
  const files = sourceFiles(SRC).map((file) => ({
    path: relative(SRC, file).split(sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }))

  it('finds the lazy call sites it is meant to guard', () => {
    // ANTI-VACUITY: a scanner that matched nothing would pass every assertion
    // below. The panel splits its pages, its tabs and its visual effects.
    const callers = files.filter((file) => CALLS_LAZY.test(code(file.text))).map((file) => file.path)
    expect(callers.length).toBeGreaterThan(10)
    expect(callers).toContain('app/router.tsx')
    expect(callers).toContain('features/users/users-page.tsx')
  })

  it('lets nobody but the exempt files call React.lazy directly', () => {
    const offenders = files
      .filter((file) => IMPORTS_REACT_LAZY.test(file.text) && !EXEMPT.has(file.path))
      .map((file) => file.path)

    expect(
      offenders,
      'import { lazyWithChunkRecovery as lazy } from "@/lib/lazy-chunk" instead — see that file',
    ).toEqual([])
  })

  it('has every lazy caller take it from the helper', () => {
    const missing = files
      .filter((file) => CALLS_LAZY.test(code(file.text)) && !EXEMPT.has(file.path))
      .filter((file) => !IMPORTS_HELPER.test(file.text))
      .map((file) => file.path)

    expect(missing).toEqual([])
  })

  it('keeps the exemption list honest', () => {
    for (const [path, reason] of EXEMPT) {
      expect(
        files.some((file) => file.path === path),
        `${path} is exempt (${reason}) but no longer exists`,
      ).toBe(true)
    }
  })
})
