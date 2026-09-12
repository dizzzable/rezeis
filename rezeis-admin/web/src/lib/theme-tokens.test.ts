/**
 * A colour token is a whole colour, so `hsl(var(--token))` renders as nothing.
 *
 * `index.css` stores every token as a complete `oklch(...)` value and says so
 * in as many words — "no `hsl()` wrapper, plain colour values" — because that
 * is what lets a theme pasted from ui.shadcn.com or tweakcn work without being
 * translated first. Wrap one in `hsl()` and the browser is handed
 * `hsl(oklch(0.145 0 0))`, which is invalid at computed-value time: a
 * background resolves to transparent, a border to black.
 *
 * It is the most plausible-looking mistake in this codebase. The shadcn
 * documentation shows exactly that wrapper, because the themes it documents
 * store bare HSL triplets; it type-checks, it reviews cleanly, and the only
 * symptom is a chart tooltip whose numbers sit straight on the chart. It had
 * spread to twenty-six places across five screens — dashboard, analytics,
 * payments, partners — before anyone measured what it computes to.
 *
 * For a translucent token use the project's own idiom instead:
 * `color-mix(in oklab, var(--primary) 15%, transparent)`.
 *
 * Comment lines are skipped deliberately: the one place that explains this
 * rule has to be able to quote the broken form.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Line numbers (1-based) where code — not a comment — wraps a token in `hsl()`. */
function offendingLines(text: string): number[] {
  const found: number[] = []
  text.split('\n').forEach((line, index) => {
    const code = line.trimStart()
    if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return
    if (line.includes('hsl(var(')) found.push(index + 1)
  })
  return found
}

/** Every `.ts`/`.tsx` under `src`, `src`-relative, tests excluded. */
function sources(dir: string = SRC, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, into)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      into.push(path.slice(SRC.length + 1).split(sep).join('/'))
    }
  }
  return into
}

describe('colour tokens are whole colours', () => {
  it('is never wrapped in `hsl()` anywhere in the SPA', () => {
    const offenders = sources().flatMap((file) =>
      offendingLines(readFileSync(join(SRC, file), 'utf8')).map((line) => `${file}:${line}`),
    )

    expect(
      offenders,
      'every token in `index.css` is a whole `oklch(...)` colour, so `hsl(var(--x))` computes to ' +
        'transparent (or black for a border). Use `var(--x)`, or ' +
        '`color-mix(in oklab, var(--x) N%, transparent)` for a translucent one.',
    ).toEqual([])
  })

  it('recognises the mistake, and leaves the comment that documents it alone', () => {
    // Anti-vacuous anchor: without this the case above passes just as well for
    // a scan that stopped finding anything.
    expect(offendingLines("  backgroundColor: 'hsl(var(--background))',")).toEqual([1])
    expect(offendingLines("  fill: 'hsl(var(--primary) / 0.15)',")).toEqual([1])
    expect(offendingLines(' * NOT `hsl(var(--background))`. This project stores whole values.')).toEqual([])
    expect(offendingLines("  // `hsl(var(--border))` would be black here.")).toEqual([])
    expect(offendingLines("  backgroundColor: 'var(--background)',")).toEqual([])
  })

  it('reads the whole SPA, not an empty list', () => {
    const files = sources()
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain('features/dashboard/dashboard-client-apps.tsx')
  })
})
