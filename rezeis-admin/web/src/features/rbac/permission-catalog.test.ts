/**
 * The role editor's words for the RBAC catalog, held against the backend's.
 * ─────────────────────────────────────────────────────────────────────────
 * The matrix names every resource and action in plain words and explains
 * what each permission unlocks (`rolesPage.resources` / `rolesPage.actions`
 * in the lazy `i18n/features/rbac.*` bundle), arranges them into areas
 * (`PERMISSION_GROUPS`) and flags the dangerous ones (`DANGEROUS_PERMISSIONS`).
 * None of that is the server's; all of it is about the server's catalog, and a
 * catalog changes. Both directions fail here:
 *
 *   backend → panel   A resource or action the server gained with no group, no
 *                     name, no description, or no line for one of its actions.
 *                     The matrix would still draw it — under its raw key and
 *                     with an empty (i) — which is exactly the page the owner
 *                     asked to have explained.
 *
 *   panel → backend   An entry naming a resource or action the server no longer
 *                     has. Dead copy, and for a danger flag or a group a lie
 *                     about what the catalog contains.
 *
 * And one direction no dictionary check can see: a sentence that says a
 * permission does nothing stays true only while nothing checks it. The last
 * block scans the backend and this SPA for every use of those permissions.
 *
 * It reaches across the package boundary for `rbac.resources.ts`, as
 * `rbac-catalog-parity.test.ts` next to it does and for the same reason: a
 * second copy of the backend list would reproduce the drift being guarded.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  RBAC_ACTIONS as BACKEND_ACTIONS,
  RBAC_RESOURCES as BACKEND_RESOURCES,
  SYSTEM_ROLES as BACKEND_SYSTEM_ROLES,
} from '../../../../src/modules/rbac/rbac.resources'

import { en as coreEn } from '@/i18n/en'
import { en as rbacEn } from '@/i18n/features/rbac.en'
import { ru as rbacRu } from '@/i18n/features/rbac.ru'
import { ru as coreRu } from '@/i18n/ru'

import {
  DANGEROUS_PERMISSIONS,
  INERT_PERMISSIONS,
  OTHER_GROUP_ID,
  PERMISSION_GROUPS,
  groupCatalog,
  isDangerousPermission,
} from './permission-catalog'
import { SYSTEM_ROLE_SEEDS } from './system-roles'

type Tree = { readonly [key: string]: unknown }

const LANGUAGES = [
  {
    name: 'en',
    rolesPage: rbacEn.rolesPage as unknown as Tree,
    systemRoles: coreEn.rolesPage.systemRoles as unknown as Tree,
    inertMarker: 'Has no effect yet',
  },
  {
    name: 'ru',
    rolesPage: rbacRu.rolesPage as unknown as Tree,
    systemRoles: coreRu.rolesPage.systemRoles as unknown as Tree,
    inertMarker: 'Пока ни на что не влияет',
  },
] as const

function branch(tree: Tree, key: string): Tree {
  const value = Object.hasOwn(tree, key) ? tree[key] : undefined
  return typeof value === 'object' && value !== null ? (value as Tree) : {}
}

function isText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

const backendResources = Object.keys(BACKEND_RESOURCES)

function offered(resource: string): readonly string[] {
  return BACKEND_RESOURCES[resource] as readonly string[]
}

function pairs(map: Readonly<Record<string, readonly string[]>>): string[] {
  return Object.entries(map)
    .flatMap(([resource, actions]) => actions.map((action) => `${resource}:${action}`))
    .sort()
}

describe('the role editor catalog against the backend', () => {
  it('is reading real, non-empty catalogs', () => {
    // Anchors. Every `toEqual([])` below passes on empty inputs.
    expect(backendResources.length).toBeGreaterThan(40)
    expect(BACKEND_ACTIONS.length).toBeGreaterThan(15)
    expect(PERMISSION_GROUPS.length).toBeGreaterThan(5)
    expect(Object.keys(DANGEROUS_PERMISSIONS).length).toBeGreaterThan(5)
    expect(BACKEND_SYSTEM_ROLES.length).toBeGreaterThan(2)
    for (const { rolesPage } of LANGUAGES) {
      expect(Object.keys(branch(rolesPage, 'resources')).length).toBe(backendResources.length)
    }
  })

  it('puts every backend resource in exactly one group', () => {
    const placements = new Map<string, string[]>()
    for (const group of PERMISSION_GROUPS) {
      for (const resource of group.resources) {
        placements.set(resource, [...(placements.get(resource) ?? []), group.id])
      }
    }
    const ungrouped = backendResources.filter((resource) => !placements.has(resource))
    const twice = [...placements.entries()]
      .filter(([, groups]) => groups.length > 1)
      .map(([resource, groups]) => `${resource} (${groups.join(', ')})`)
    expect(ungrouped).toEqual([])
    expect(twice).toEqual([])
  })

  it('groups no resource the backend does not have', () => {
    const stale = PERMISSION_GROUPS.flatMap((group) =>
      (group.resources as readonly string[])
        .filter((resource) => !Object.hasOwn(BACKEND_RESOURCES, resource))
        .map((resource) => `${group.id}: ${resource}`),
    )
    expect(stale).toEqual([])
  })

  it.each(LANGUAGES)('titles every group in $name', ({ rolesPage }) => {
    const groups = branch(rolesPage, 'groups')
    const ids = [...PERMISSION_GROUPS.map((group) => group.id), OTHER_GROUP_ID]
    expect(ids.filter((id) => !isText(groups[id]))).toEqual([])
    expect(Object.keys(groups).filter((id) => !(ids as string[]).includes(id))).toEqual([])
  })

  it.each(LANGUAGES)(
    'gives every backend resource a name, a description and a line per action in $name',
    ({ rolesPage }) => {
      const resources = branch(rolesPage, 'resources')
      const missing: string[] = []
      for (const resource of backendResources) {
        const entry = branch(resources, resource)
        if (!isText(entry.name)) missing.push(`${resource}.name`)
        if (!isText(entry.description)) missing.push(`${resource}.description`)
        const lines = branch(entry, 'actions')
        for (const action of offered(resource)) {
          if (!isText(lines[action])) missing.push(`${resource}.actions.${action}`)
        }
      }
      // Paths, not a count: the failure has to say what to write.
      expect(missing).toEqual([])
    },
  )

  it.each(LANGUAGES)('describes no resource or action the backend does not have in $name', ({ rolesPage }) => {
    const resources = branch(rolesPage, 'resources')
    const stale: string[] = []
    for (const [resource, value] of Object.entries(resources)) {
      if (!Object.hasOwn(BACKEND_RESOURCES, resource)) {
        stale.push(resource)
        continue
      }
      const entry = value as Tree
      for (const key of Object.keys(entry)) {
        if (!['name', 'description', 'actions', 'danger'].includes(key)) stale.push(`${resource}.${key}`)
      }
      for (const action of Object.keys(branch(entry, 'actions'))) {
        if (!offered(resource).includes(action)) stale.push(`${resource}.actions.${action}`)
      }
    }
    expect(stale).toEqual([])
  })

  it.each(LANGUAGES)('names and explains every backend action, and no other, in $name', ({ rolesPage }) => {
    const actions = branch(rolesPage, 'actions')
    const missing = (BACKEND_ACTIONS as readonly string[]).flatMap((action) => {
      const entry = branch(actions, action)
      return [
        ...(isText(entry.name) ? [] : [`${action}.name`]),
        ...(isText(entry.description) ? [] : [`${action}.description`]),
      ]
    })
    const stale = Object.keys(actions).filter((action) => !(BACKEND_ACTIONS as readonly string[]).includes(action))
    expect(missing).toEqual([])
    expect(stale).toEqual([])
  })

  it('flags only permissions the backend really offers', () => {
    const stale = Object.entries(DANGEROUS_PERMISSIONS).flatMap(([resource, actions]) =>
      actions
        .filter((action) => !Object.hasOwn(BACKEND_RESOURCES, resource) || !offered(resource).includes(action))
        .map((action) => `${resource}:${action}`),
    )
    expect(stale).toEqual([])
  })

  it.each(LANGUAGES)('says why for every dangerous permission, and only for those, in $name', ({ rolesPage }) => {
    const resources = branch(rolesPage, 'resources')
    const missing: string[] = []
    const unflagged: string[] = []
    for (const resource of backendResources) {
      const reasons = branch(branch(resources, resource), 'danger')
      for (const action of offered(resource)) {
        if (isDangerousPermission(resource, action) && !isText(reasons[action])) {
          missing.push(`${resource}:${action}`)
        }
      }
      for (const action of Object.keys(reasons)) {
        if (!isDangerousPermission(resource, action)) unflagged.push(`${resource}:${action}`)
      }
    }
    expect(missing).toEqual([])
    expect(unflagged).toEqual([])
  })

  it('applies the danger rule to the whole catalogue, pinned', () => {
    // The rule is written above `DANGEROUS_PERMISSIONS`: MONEY, LOSS, ACCESS,
    // SECRETS, and what deliberately does not count. This list is that rule
    // applied to every one of the catalogue's pairs; a change to it is a
    // decision, made here, not a side effect.
    expect(pairs(DANGEROUS_PERMISSIONS)).toEqual(
      [
        // MONEY
        'add_on_entitlements:enforce',
        'partners:edit',
        'payment_gateways:edit',
        'payments:refund',
        'withdrawals:resolve',
        // LOSS
        'backups:delete',
        'backups:run',
        'imports:run',
        'subscriptions:delete',
        'users:delete',
        'users:merge',
        // ACCESS
        'admins:create',
        'admins:delete',
        'admins:edit',
        'api_tokens:delete',
        'auth_providers:edit',
        'automations:run',
        'blocked_ips:create',
        'config_portability:import',
        'external_auth:edit',
        'rbac_roles:create',
        'rbac_roles:edit',
        'remnawave:edit',
        'settings:edit',
        // SECRETS
        'api_tokens:create',
        'automations:create',
        'automations:edit',
        'backups:create',
        'backups:export',
        'config_portability:export',
        'email:edit',
        'partners:view',
        'payment_gateways:view_secrets',
        'users:export',
        'users:export_registration',
        'webhooks:create',
        'webhooks:edit',
        'wheel:view_secrets',
      ].sort(),
    )
  })
})

describe('system roles against the backend seed', () => {
  it('knows the seed text of every system role, exactly', () => {
    // A drift here turns an untouched system role into an "edited" one: it
    // would be shown in the seed's mixed English/Russian again.
    const backend = Object.fromEntries(
      BACKEND_SYSTEM_ROLES.map((role) => [role.name, { displayName: role.displayName, description: role.description }]),
    )
    expect(SYSTEM_ROLE_SEEDS).toEqual(backend)
  })

  it.each(LANGUAGES)('names and describes every system role in the core $name dictionary', ({ systemRoles }) => {
    const missing = BACKEND_SYSTEM_ROLES.flatMap((role) => {
      const entry = branch(systemRoles, role.name)
      return [
        ...(isText(entry.name) ? [] : [`${role.name}.name`]),
        ...(isText(entry.description) ? [] : [`${role.name}.description`]),
      ]
    })
    expect(missing).toEqual([])
    expect(Object.keys(systemRoles).filter((name) => !BACKEND_SYSTEM_ROLES.some((role) => role.name === name))).toEqual(
      [],
    )
  })

  it('keeps nothing of the roles page in the core dictionaries but the system roles', () => {
    // The rest is the lazy bundle's; a copy left behind in core would be
    // shipped before sign-in and silently shadowed.
    expect(Object.keys(coreEn.rolesPage)).toEqual(['systemRoles'])
    expect(Object.keys(coreRu.rolesPage)).toEqual(['systemRoles'])
  })
})

/**
 * The parity test compares key paths, never values, so a Russian leaf pasted
 * from English passes it. These are the leaves that are the same on purpose.
 */
const SAME_IN_BOTH_LANGUAGES: ReadonlySet<string> = new Set([
  'createDialog.stableNamePlaceholder', // an identifier: Latin by rule
  'resources.faq.name', // what the sidebar calls it in both languages
  'resources.remnawave.name', // a product name
])

function leaves(tree: Tree, prefix = ''): Array<readonly [string, string]> {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') return [[path, value] as const]
    if (typeof value === 'object' && value !== null) return leaves(value as Tree, path)
    return []
  })
}

describe('the Russian roles page', () => {
  it('leaves nothing in English by accident', () => {
    const english = new Map([
      ...leaves(rbacEn.rolesPage as unknown as Tree),
      ...leaves(coreEn.rolesPage as unknown as Tree),
    ])
    const same = [...leaves(rbacRu.rolesPage as unknown as Tree), ...leaves(coreRu.rolesPage as unknown as Tree)]
      .filter(([path, value]) => english.get(path) === value && !SAME_IN_BOTH_LANGUAGES.has(path))
      .map(([path]) => path)
    expect(same).toEqual([])
    // Anti-vacuity: the allowlist is live, and the walk reached the leaves.
    for (const path of SAME_IN_BOTH_LANGUAGES) expect(english.has(path)).toBe(true)
    expect(english.size).toBeGreaterThan(300)
  })
})

describe('groupCatalog', () => {
  it('keeps the group order, skips what the server lacks, and never drops a resource it does not know', () => {
    const grouped = groupCatalog({
      backups: ['view'],
      mystery_resource: ['view'],
      users: ['view', 'edit'],
      dashboard: ['view'],
    })
    expect(grouped.map((group) => group.id)).toEqual(['overview', 'customers', 'system', OTHER_GROUP_ID])
    expect(grouped.map((group) => group.resources.map(([resource]) => resource))).toEqual([
      ['dashboard'],
      ['users'],
      ['backups'],
      ['mystery_resource'],
    ])
  })
})

// ── "Has no effect yet" has to stay true ────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const SPA_SRC = resolve(HERE, '..', '..')
const BACKEND_SRC = resolve(HERE, '..', '..', '..', '..', 'src')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Comments name permissions all the time; only code can check one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

interface Use {
  readonly kind: string
  readonly token: string
  readonly where: string
}

/**
 * Every shape a (resource, action) pair is CHECKED in. Each was taken from
 * the tree, and each must keep matching something (see the liveness case), so
 * a pattern that stops matching fails instead of quietly guarding nothing.
 */
const BACKEND_SHAPES: ReadonlyArray<{ readonly kind: string; readonly pattern: RegExp }> = [
  { kind: 'decorator', pattern: /RequirePermission\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\)/g },
  { kind: 'decoratorAll', pattern: /\[\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\]/g },
  { kind: 'handlerCheck', pattern: /hasPermission\(\s*[^()]*?,\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*,?\s*\)/g },
  { kind: 'objectLiteral', pattern: /resource:\s*'([a-z_]+)'\s*,\s*action:\s*'([a-z_]+)'/g },
  { kind: 'token', pattern: /['"`]([a-z_]+):([a-z_]+)['"`]/g },
]

const SPA_SHAPES: ReadonlyArray<{ readonly kind: string; readonly pattern: RegExp }> = [
  { kind: 'useHasPermission', pattern: /useHasPermission\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'/g },
  { kind: 'storeCheck', pattern: /hasPermission\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'/g },
  { kind: 'routePermission', pattern: /routePermission\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'/g },
  { kind: 'objectLiteral', pattern: /resource:\s*'([a-z_]+)'\s*,\s*action:\s*'([a-z_]+)'/g },
  { kind: 'jsxProp', pattern: /resource="([a-z_]+)"\s*action="([a-z_]+)"/g },
]

/**
 * Files whose pairs are grants or descriptions, not checks: the catalogue and
 * its seed roles, and this feature's own lists.
 */
const NOT_A_CHECK = [/rbac[\\/]rbac\.resources\.ts$/, /features[\\/]rbac[\\/]permission-catalog\.ts$/]

function uses(root: string, shapes: typeof BACKEND_SHAPES): Use[] {
  const found: Use[] = []
  for (const file of sourceFiles(root)) {
    if (NOT_A_CHECK.some((pattern) => pattern.test(file))) continue
    const text = code(readFileSync(file, 'utf8'))
    const where = file.slice(root.length + 1).replace(/\\/g, '/')
    for (const { kind, pattern } of shapes) {
      const scoped = new RegExp(pattern.source, pattern.flags)
      for (let match = scoped.exec(text); match !== null; match = scoped.exec(text)) {
        found.push({ kind, token: `${match[1]}:${match[2]}`, where })
      }
    }
  }
  return found
}

describe('a permission described as having no effect has none', () => {
  const backend = uses(BACKEND_SRC, BACKEND_SHAPES)
  const spa = uses(SPA_SRC, SPA_SHAPES)
  const inert = new Set(pairs(INERT_PERMISSIONS))

  it('scans real code with every one of its shapes', () => {
    // A single total can hide a dead pattern behind the others, so each is
    // anchored on its own — and on a use it must see.
    for (const { kind } of BACKEND_SHAPES) {
      expect(backend.some((use) => use.kind === kind), `backend shape "${kind}" matched nothing`).toBe(true)
    }
    for (const { kind } of SPA_SHAPES) {
      expect(spa.some((use) => use.kind === kind), `SPA shape "${kind}" matched nothing`).toBe(true)
    }
    const backendTokens = new Set(backend.map((use) => use.token))
    for (const token of ['audit:export', 'users:export_registration', 'withdrawals:view', 'rbac_roles:edit']) {
      expect(backendTokens.has(token), `the backend scan lost ${token}`).toBe(true)
    }
    expect(backendTokens.size).toBeGreaterThan(100)
  })

  it('lists only permissions the backend offers', () => {
    expect([...inert].filter((token) => {
      const [resource, action] = token.split(':')
      return !Object.hasOwn(BACKEND_RESOURCES, resource) || !offered(resource).includes(action)
    })).toEqual([])
  })

  it('finds no check of them anywhere in the backend', () => {
    const offenders = backend.filter((use) => inert.has(use.token)).map((use) => `${use.token} (${use.where})`)
    // A name here means the dictionary line "has no effect yet" is now false:
    // describe what the check does, and take the pair off INERT_PERMISSIONS.
    expect([...new Set(offenders)].sort()).toEqual([])
  })

  it('finds no gate on them anywhere in the panel', () => {
    const offenders = spa.filter((use) => inert.has(use.token)).map((use) => `${use.token} (${use.where})`)
    expect([...new Set(offenders)].sort()).toEqual([])
  })

  it.each(LANGUAGES)('says "no effect" in $name for exactly those permissions', ({ rolesPage, inertMarker }) => {
    const resources = branch(rolesPage, 'resources')
    const saysInert = Object.entries(resources)
      .flatMap(([resource, entry]) =>
        Object.entries(branch(entry as Tree, 'actions'))
          .filter(([, line]) => typeof line === 'string' && line.startsWith(inertMarker))
          .map(([action]) => `${resource}:${action}`),
      )
      .sort()
    expect(saysInert).toEqual([...inert].sort())
  })
})
