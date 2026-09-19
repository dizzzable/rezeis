/**
 * Invariants for the Cmd+K page index — specifically `deepLinkNavItems`, the
 * eleven routable surfaces that have no sidebar entry because they were folded
 * into a tab of another page.
 *
 * These are checked as data, in a pure module, because every way this feature
 * breaks is a data mistake rather than a logic one: an anchor that no page
 * accepts, a key with no translation, a row offered to a role that cannot open
 * what it points at. None of those throw. They all render a plausible-looking
 * row that does the wrong thing, which is worse than no row at all — an
 * operator who clicks "Backups" and lands on theme settings stops trusting the
 * search box.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { RBAC_RESOURCES, SYSTEM_ROLES } from '../../../../src/modules/rbac/rbac.resources'

import { HUB_TABS, canShowNavItem, deepLinkNavItems, navGroups, type NavItem } from './admin-nav-config'
import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'

/**
 * The single entry deliberately shipped without `requiredPermission`. Named
 * here so that dropping a permission from any OTHER entry fails loudly instead
 * of quietly widening who sees the row.
 */
const INTENTIONALLY_UNGATED = new Set(['twoFactor'])

const navItemLabels = en.adminNav.items as Record<string, string | undefined>
const navItemLabelsRu = ru.adminNav.items as Record<string, string | undefined>
const navGroupLabels = en.adminNav.groups as Record<string, string | undefined>
const navGroupLabelsRu = ru.adminNav.groups as Record<string, string | undefined>
const hubTabs = HUB_TABS as Record<string, readonly string[] | undefined>

describe('deepLinkNavItems anchors', () => {
  /**
   * The load-bearing one. `/settings/panel#backups` is only a deep link if
   * `panel-settings-hub` actually accepts `backups`; before this change it did
   * not — `Tabs` was uncontrolled, so that URL and the `/backup` redirect both
   * landed on Appearance with no signal that anything had been ignored.
   */
  it('points every hash at a tab its target page accepts', () => {
    const hashed = deepLinkNavItems.filter((item) => item.path.includes('#'))
    expect(hashed.length).toBeGreaterThan(0)

    for (const item of hashed) {
      const [pathname, anchor] = item.path.split('#')
      const allowed = hubTabs[pathname]
      expect(allowed, `${item.key}: no HUB_TABS entry for "${pathname}"`).toBeDefined()
      expect(
        allowed,
        `${item.key}: "${pathname}" does not accept "#${anchor}" — the row would land on that ` +
          `page's default tab. Accepted: ${JSON.stringify(allowed)}`,
      ).toContain(anchor)
    }
  })

  /** A pathless or malformed entry navigates nowhere useful. */
  it('gives every entry an absolute path', () => {
    for (const item of deepLinkNavItems) {
      expect(item.path.startsWith('/'), `${item.key}: "${item.path}" is not absolute`).toBe(true)
    }
  })
})

describe('deepLinkNavItems permissions', () => {
  /**
   * A search result is acted on immediately, unlike a sidebar rail an operator
   * learns once and then ignores. Offering a row for a surface the role cannot
   * open turns "I cannot find it" into "the panel is broken".
   */
  it('gates every entry except the documented exception', () => {
    for (const item of deepLinkNavItems) {
      if (INTENTIONALLY_UNGATED.has(item.key)) {
        expect(
          item.requiredPermission,
          `${item.key} is listed as intentionally ungated but declares a permission`,
        ).toBeUndefined()
        continue
      }
      expect(
        item.requiredPermission,
        `${item.key} has no requiredPermission: every admin would see a row for a surface ` +
          'their role may not be able to open',
      ).toBeDefined()
    }
  })

  /**
   * The gate has to be the SAME mechanism the sidebar uses, not a parallel one.
   * `canShowNavItem` is that mechanism, so it is exercised directly here rather
   * than re-implemented in the assertion.
   */
  it('hides a gated entry from an admin who lacks its permission', () => {
    const gated = deepLinkNavItems.find((item) => item.key === 'webhooks')
    expect(gated).toBeDefined()
    if (!gated) return

    expect(canShowNavItem(gated, true, () => false)).toBe(false)
    expect(canShowNavItem(gated, true, () => true)).toBe(true)
  })

  /**
   * Documents an inherited behaviour rather than asserting a preference: while
   * permissions are still loading `canShowNavItem` shows everything. If that
   * ever changes, these rows change with the sidebar instead of drifting apart.
   */
  it('shows entries while permissions are still loading, as the sidebar does', () => {
    for (const item of deepLinkNavItems) {
      expect(canShowNavItem(item, false, () => false)).toBe(true)
    }
  })
})

describe('deepLinkNavItems labelling', () => {
  it('has a label in both locales for every entry and group', () => {
    for (const item of deepLinkNavItems) {
      expect(navItemLabels[item.key], `en: adminNav.items.${item.key} is missing`).toBeTruthy()
      expect(navItemLabelsRu[item.key], `ru: adminNav.items.${item.key} is missing`).toBeTruthy()
      expect(
        navGroupLabels[item.groupKey],
        `en: adminNav.groups.${item.groupKey} is missing`,
      ).toBeTruthy()
      expect(
        navGroupLabelsRu[item.groupKey],
        `ru: adminNav.groups.${item.groupKey} is missing`,
      ).toBeTruthy()
    }
  })
})

describe('deepLinkNavItems vs the sidebar', () => {
  /**
   * `navGroups` is the sidebar. Anything appearing in both lists produces two
   * Cmd+K rows for one destination — and the `botConfig` route is the live
   * example of why this is checked: it redirects to `/bot-map`, which the
   * sidebar already carries as `botMap`, so it is deliberately absent below.
   */
  it('duplicates no sidebar key or destination', () => {
    const sidebarKeys = new Set(navGroups.flatMap((g) => g.items.map((i) => i.key)))
    const sidebarPaths = new Set(navGroups.flatMap((g) => g.items.map((i) => i.path)))

    for (const item of deepLinkNavItems) {
      expect(sidebarKeys.has(item.key), `${item.key} is already a sidebar item`).toBe(false)
      expect(
        sidebarPaths.has(item.path),
        `${item.key} points at "${item.path}", which a sidebar item already covers`,
      ).toBe(false)
    }
  })

  /** Two deep links to the same place would be the same duplicate bug. */
  it('lists every key and destination once', () => {
    const keys = deepLinkNavItems.map((i) => i.key)
    const paths = deepLinkNavItems.map((i) => i.path)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(paths).size).toBe(paths.length)
  })
})

/**
 * The side menu is where the dashboard's quick actions take their gates from
 * (`dashboard-quick-actions.tsx`), so an ungated item here was an ungated
 * button there too. «Пользователи», «Рассылки» and «Платформа» carried no
 * permission although every read their pages make is guarded: a role without
 * it saw the item and the button, and the page answered with 403s.
 */
describe('sidebar gates of «Пользователи», «Рассылки» and «Платформа»', () => {
  const MODULES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'src', 'modules')
  const source = (relative: string): string => readFileSync(resolve(MODULES, relative), 'utf8')
  const item = (key: string): NavItem => {
    const found = navGroups.flatMap((group) => group.items).find((entry) => entry.key === key)
    if (found === undefined) throw new Error(`no sidebar item "${key}"`)
    return found
  }
  const holding = (tokens: readonly string[]) => (resource: string, action: string): boolean => tokens.includes(`${resource}:${action}`)

  /**
   * What each page reads, and the permission the SERVER puts on that read —
   * each one checked against the controller below, so the menu follows the
   * server and not a second list. «Пользователи» is three tabs, and each works
   * on its own: the list, «Массовые операции» (it only posts ids), and the
   * blocklist.
   */
  const PAGE_READS = {
    users: [
      { permission: 'users:view', controller: 'users/controllers/admin-users.controller.ts', guard: /@Get\(\)\s*@RequirePermission\('users', 'view'\)\s*public async listUsers/ },
      { permission: 'users:bulk_operations', controller: 'users/controllers/admin-bulk-users.controller.ts', guard: /@RequirePermission\('users', 'bulk_operations'\)\s*@ApiOperation\(\{ summary: 'Executes a bulk action/ },
      { permission: 'blocked_identities:view', controller: 'blocked-identities/controllers/admin-blocked-identities.controller.ts', guard: /@Get\(\)\s*@RequirePermission\('blocked_identities', 'view'\)/ },
    ],
    broadcast: [
      { permission: 'broadcasts:view', controller: 'broadcast/controllers/admin-broadcast.controller.ts', guard: /@RequirePermission\('broadcasts', 'view'\)\s*@Controller\('admin\/broadcast'\)/ },
    ],
    platform: [
      { permission: 'settings:view', controller: 'settings/controllers/settings.controller.ts', guard: /@RequirePermission\('settings', 'view'\)\s*export class SettingsController/ },
    ],
  } as const
  const PAGES = ['users', 'broadcast', 'platform'] as const

  it('reads each page’s gate off the server’s own controller', () => {
    for (const page of PAGES) {
      for (const read of PAGE_READS[page]) {
        expect(source(read.controller), `${page}: ${read.controller} no longer guards the read with ${read.permission}`).toMatch(read.guard)
      }
    }
  })

  it('shows each item to a role holding any permission its page can be worked with — and to no other', () => {
    for (const page of PAGES) {
      expect(canShowNavItem(item(page), true, holding(['dashboard:view'])), `${page} without any of its permissions`).toBe(false)
      for (const read of PAGE_READS[page]) {
        expect(canShowNavItem(item(page), true, holding([read.permission])), `${page} with only ${read.permission}`).toBe(true)
      }
    }
  })

  it('takes no item from a system role that can open its page, and shows none to a role that cannot', () => {
    const everyPermission = Object.entries(RBAC_RESOURCES).flatMap(([resource, actions]) =>
      (actions as readonly string[]).map((action) => `${resource}:${action}`),
    )
    const table = SYSTEM_ROLES.map((role) => {
      // The superadmin's list is filled at start-up from the whole catalog.
      const tokens = role.name === 'superadmin' ? everyPermission : role.permissions.map((p) => `${p.resource}:${p.action}`)
      const canOpen = PAGES.map((page) => PAGE_READS[page].some((read) => tokens.includes(read.permission)))
      const shown = PAGES.map((page) => canShowNavItem(item(page), true, holding(tokens)))
      expect(shown, `${role.name}: the menu disagrees with what the role can load`).toEqual(canOpen)
      return [role.name, ...shown]
    })
    expect(table).toEqual([
      ['superadmin', true, true, true],
      // The operator's role holds no `settings:view`: «Платформа» answered it with a 403.
      ['operator', true, true, false],
      ['support', true, false, false],
      ['finance', false, false, false],
    ])
  })
})
