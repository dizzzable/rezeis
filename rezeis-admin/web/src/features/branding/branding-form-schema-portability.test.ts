import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * The panel modules the cabinet loads BY PATH must not use the `@/` alias.
 *
 * reiwa's round-trip tests (`reiwa/test/web/*-round-trip.test.ts`, through
 * `reiwa/test/web/panel-modules.ts`) import the panel's form schema, its DTO
 * and its settings reader straight off this checkout, inside the CABINET's
 * vitest — where `@` resolves to `reiwa/web/src`. One `@/` import that
 * survives to run time anywhere in what those three pull in fails every round
 * trip at import.
 *
 * Nothing in this repository would notice: here `@` means this app's own
 * `src`, so the panel builds, type-checks and tests green. And the cabinet's
 * CI has no panel checkout, so there the round trips SKIP. The only run that
 * would catch it is a local one with both repositories side by side. This is
 * that check, from the side that can make the mistake.
 *
 * WHAT COUNTS is what survives the TypeScript transform, because that is what
 * a loader resolves: `import type`, and an import whose bindings are used only
 * as types, are erased first and never looked up. `card-effect-catalog.ts`
 * carries exactly such an `import type { ControlDef } from '@/features/…'` —
 * the path does not exist in reiwa, and the round trips pass all the same.
 * Scanning the source would flag it; scanning the transform's output does not.
 *
 * The whole relative import closure is walked, not only the three entries: the
 * QR renderer the schema imports is two files deep, and a helper that grows a
 * runtime `@/` import three hops away breaks the cabinet just as surely. Bare
 * specifiers (`zod`, `qrcode`, `class-validator`) are fine — they resolve from
 * the importing file's own `node_modules`, wherever it is loaded from.
 */

// branding → features → src → web → rezeis-admin.
const REPO = resolve(__dirname, '..', '..', '..', '..')

/** What `reiwa/test/web/panel-modules.ts` loads by path. */
const LOADED_BY_PATH = [
  'web/src/features/branding/branding-form-schema.ts',
  'src/modules/settings/dto/update-branding-settings.dto.ts',
  'src/modules/settings/utils/branding-settings.util.ts',
] as const

const toRepoPath = (file: string): string => relative(REPO, file).split(sep).join('/')

/** Specifiers that survive the TypeScript transform — the ones a loader resolves. */
function runtimeSpecifiersOf(file: string): string[] {
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      isolatedModules: true,
      verbatimModuleSyntax: false,
      // The backend DTO is decorated; metadata can keep an import alive as a
      // value, so emit it and count what it keeps.
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  })
  return ts.preProcessFile(outputText, true, true).importedFiles.map((entry) => entry.fileName)
}

function resolveRelative(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier)
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    base,
  ]) {
    if (/\.(?:[cm]?[jt]sx?|json)$/.test(candidate) && existsSync(candidate)) return candidate
  }
  return null
}

function walk(): { readonly visited: readonly string[]; readonly offending: readonly string[] } {
  const queue = LOADED_BY_PATH.map((entry) => join(REPO, entry))
  const seen = new Set<string>()
  const offending: string[] = []
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    if (file.endsWith('.json')) continue
    for (const specifier of runtimeSpecifiersOf(file)) {
      if (specifier.startsWith('@/')) {
        offending.push(`${toRepoPath(file)} imports '${specifier}'`)
        continue
      }
      if (!specifier.startsWith('.')) continue
      const target = resolveRelative(file, specifier)
      if (target === null) {
        offending.push(`${toRepoPath(file)} imports '${specifier}', which resolves to nothing`)
        continue
      }
      queue.push(target)
    }
  }
  return { visited: [...seen].map(toRepoPath).sort(), offending }
}

describe('panel modules the cabinet loads by path', () => {
  const { visited, offending } = walk()

  it('reaches the files it is meant to vouch for', () => {
    // Anchors the walk: a resolver that silently followed nothing would pass
    // the check below over an empty closure.
    for (const entry of LOADED_BY_PATH) expect(visited).toContain(entry)
    expect(visited).toContain('web/src/lib/qr/kit/qr-style.ts')
    expect(visited).toContain('web/src/lib/qr/kit/qr-options.ts')
  })

  it('keeps every run-time import in them relative — no `@/`', () => {
    expect(
      offending,
      'reiwa round-trip tests load these files by path, where `@` is the cabinet src — use a relative import',
    ).toEqual([])
  })

  it('does not mistake a type-only `@/` import for one that runs', () => {
    // The distinction the check rests on, pinned so a refactor of the scan
    // cannot quietly start flagging erased imports — or stop flagging live ones.
    const probe = (source: string): string[] =>
      ts.preProcessFile(
        ts.transpileModule(source, {
          fileName: 'probe.ts',
          compilerOptions: { module: ts.ModuleKind.ESNext, isolatedModules: true },
        }).outputText,
        true,
        true,
      ).importedFiles.map((entry) => entry.fileName)
    expect(probe("import type { A } from '@/x'\nexport const a = 1 as unknown as A")).toEqual([])
    expect(probe("import { b } from '@/x'\nexport const a = b")).toEqual(['@/x'])
  })
})
