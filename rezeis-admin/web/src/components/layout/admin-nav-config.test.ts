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
import { describe, expect, it } from 'vitest'

import { HUB_TABS, canShowNavItem, deepLinkNavItems, navGroups } from './admin-nav-config'
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
