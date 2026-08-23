/**
 * The panel's idea of the RBAC catalog, against the backend's.
 * ────────────────────────────────────────────────────────────
 * `RbacAction` in `rbac-types.ts` is a hand-maintained copy of `RBAC_ACTIONS`
 * in `src/modules/rbac/rbac.resources.ts`, and it had already drifted:
 * `view_secrets` existed on the server and not in the panel, so
 * `useHasPermission('payment_gateways', 'view_secrets')` was a type error for
 * a permission the server genuinely enforces.
 *
 * Two directions, and they fail differently:
 *
 *   backend → panel   A permission the server enforces that the panel cannot
 *                     express. Recoverable: someone hits a type error and
 *                     finds this file. That was `view_secrets`.
 *
 *   panel → backend   THE DANGEROUS ONE. A gate on a permission no role can
 *                     ever hold. `hasPermission` returns false for every admin
 *                     who is not DEV, forever, and the feature is invisible
 *                     with no error anywhere. Nobody hits a type error,
 *                     because the panel's own union is what made it legal.
 *
 * The third check is the one the union cannot do on its own. Resources are
 * typed as bare `string` at every gate (`PermissionGate`'s `resource` prop,
 * `useHasPermission`'s first argument), so `payments:view_secrets` — valid
 * action, valid resource, pair that does not exist — type-checks fine and is
 * dead at runtime. That can only be caught by looking at the call sites, so
 * this file reads them out of the source.
 *
 * REACHING ACROSS THE PACKAGE BOUNDARY is deliberate and already blessed here:
 * `tsconfig.app.json` excludes tests precisely so they may do it,
 * `tsconfig.test.json` type-checks them with the whole repository around, and
 * `src/build-isolation.test.ts` pins the arrangement. Comparing against a
 * second copy of the backend list would reproduce the bug being fixed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  RBAC_ACTIONS as BACKEND_ACTIONS,
  RBAC_RESOURCES as BACKEND_RESOURCES,
} from '../../../../src/modules/rbac/rbac.resources'

import { RBAC_ACTIONS as PANEL_ACTIONS } from './rbac-types'

const SPA_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('RbacAction against the backend catalog', () => {
  it('is reading two real, distinct lists', () => {
    // The anchor. Two empty arrays satisfy every `toEqual([])` below, and an
    // import that silently resolved to the same module would make both
    // directions compare a list with itself.
    expect(BACKEND_ACTIONS.length).toBeGreaterThan(10)
    expect(PANEL_ACTIONS.length).toBeGreaterThan(10)
    expect(PANEL_ACTIONS as readonly string[]).not.toBe(BACKEND_ACTIONS as readonly string[])
    expect(Object.keys(BACKEND_RESOURCES).length).toBeGreaterThan(20)
  })

  it('can express every action the backend enforces', () => {
    const panel = new Set<string>(PANEL_ACTIONS)
    // Names, not a count: the failure has to say which action to add.
    expect(BACKEND_ACTIONS.filter((action) => !panel.has(action))).toEqual([])
  })

  it('claims no action the backend has never heard of', () => {
    // The dangerous direction. A gate on one of these is invisible rather than
    // broken: every non-DEV admin fails the check and no error is raised.
    const backend = new Set<string>(BACKEND_ACTIONS)
    expect(PANEL_ACTIONS.filter((action) => !backend.has(action))).toEqual([])
  })

  it('keeps the two lists in the same order', () => {
    // Not cosmetic. Both files are edited by hand, and a new action appended
    // to one but spliced into the middle of the other is how the next
    // divergence hides in a diff that looks like a reorder.
    expect([...PANEL_ACTIONS]).toEqual([...BACKEND_ACTIONS])
  })
})

// ── Call-site scan ──────────────────────────────────────────────────────────

/**
 * The shapes a (resource, action) pair is written in across this SPA. Each was
 * confirmed against the tree rather than guessed; `jsxProp` spans a newline
 * because `<PermissionGate>` is usually formatted one prop per line.
 */
const CALL_SITE_PATTERNS: ReadonlyArray<{ readonly kind: string; readonly pattern: RegExp }> = [
  { kind: 'useHasPermission', pattern: /useHasPermission\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'/g },
  { kind: 'routePermission', pattern: /routePermission\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'/g },
  {
    kind: 'objectLiteral',
    pattern: /resource:\s*'([a-z_]+)'\s*,\s*action:\s*'([a-z_]+)'/g,
  },
  { kind: 'jsxProp', pattern: /resource="([a-z_]+)"\s*action="([a-z_]+)"/g },
]

interface CallSite {
  readonly kind: string
  readonly resource: string
  readonly action: string
  readonly where: string
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

function collectCallSites(): CallSite[] {
  const sites: CallSite[] = []
  for (const file of sourceFiles(SPA_SRC)) {
    const text = readFileSync(file, 'utf8')
    const where = file.slice(SPA_SRC.length + 1).replace(/\\/g, '/')
    for (const { kind, pattern } of CALL_SITE_PATTERNS) {
      // `lastIndex` is shared state on a module-level RegExp with /g.
      const scoped = new RegExp(pattern.source, pattern.flags)
      let match = scoped.exec(text)
      while (match !== null) {
        sites.push({ kind, resource: match[1], action: match[2], where })
        match = scoped.exec(text)
      }
    }
  }
  return sites
}

describe('every permission the panel gates on exists on the server', () => {
  const sites = collectCallSites()
  const distinct = [...new Set(sites.map((site) => `${site.resource}:${site.action}`))].sort()

  it('found the call sites at all', () => {
    // Without this the three `toEqual([])` below pass on an empty scan — a
    // renamed helper or a changed formatter would silently end the coverage.
    // 40 is comfortably under the 53 pairs present when this was written and
    // comfortably over anything a broken scan would return.
    expect(distinct.length).toBeGreaterThan(40)
    // And the scan must reach past this feature directory.
    expect(new Set(sites.map((site) => site.where.split('/')[0])).size).toBeGreaterThan(1)
  })

  it('still matches with every one of its patterns', () => {
    // A single total is not enough, and this is not hypothetical: breaking the
    // `useHasPermission` pattern on purpose lost all 30 of its sites and this
    // suite stayed GREEN, because `objectLiteral` alone still cleared the
    // total above. One dead pattern hiding behind the others is precisely the
    // silent loss of coverage this file exists to prevent, so each is anchored
    // on its own.
    //
    // A pattern that legitimately falls out of use should be DELETED from
    // `CALL_SITE_PATTERNS`, not left here matching nothing.
    const counts = new Map(CALL_SITE_PATTERNS.map(({ kind }) => [kind, 0]))
    for (const site of sites) counts.set(site.kind, (counts.get(site.kind) ?? 0) + 1)
    const dead = [...counts.entries()].filter(([, count]) => count === 0).map(([kind]) => kind)
    expect(dead).toEqual([])
  })

  it('names no action outside the catalog', () => {
    const actions = new Set<string>(BACKEND_ACTIONS)
    const offenders = sites
      .filter((site) => !actions.has(site.action))
      .map((site) => `${site.resource}:${site.action} (${site.where})`)
    expect([...new Set(offenders)].sort()).toEqual([])
  })

  it('names no resource outside the catalog', () => {
    const offenders = sites
      .filter((site) => !(site.resource in BACKEND_RESOURCES))
      .map((site) => `${site.resource}:${site.action} (${site.where})`)
    expect([...new Set(offenders)].sort()).toEqual([])
  })

  it('names no pair the catalog does not offer', () => {
    // Valid resource, valid action, combination that does not exist — e.g.
    // `payments:view_secrets`. Type-checks, and is dead at runtime because no
    // role can be granted it.
    const offenders = sites
      .filter((site) => {
        const offered = BACKEND_RESOURCES[site.resource as keyof typeof BACKEND_RESOURCES] as
          | readonly string[]
          | undefined
        return offered !== undefined && !offered.includes(site.action)
      })
      .map(
        (site) =>
          `${site.resource}:${site.action} (${site.where}) — catalog offers [${(
            BACKEND_RESOURCES[site.resource as keyof typeof BACKEND_RESOURCES] as readonly string[]
          ).join(', ')}]`,
      )
    expect([...new Set(offenders)].sort()).toEqual([])
  })
})
