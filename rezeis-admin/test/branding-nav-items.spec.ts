import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readBrandingSettings } from '../src/modules/settings/utils/branding-settings.util';
import {
  DEFAULT_BRANDING,
  NAV_DESTINATIONS,
  NAV_ESSENTIAL_DESTINATIONS,
  NAV_MAX_VISIBLE,
  type NavItemSetting,
} from '../src/modules/settings/interfaces/branding-settings.interface';

/**
 * The rule the cabinet actually draws, restated as an oracle.
 *
 * `normalizeNavItems` (`reiwa/web/src/components/layout/nav-config.ts`) shows
 * both essentials unconditionally and keeps the first THREE visible optional
 * destinations (`.slice(0, 3)`), hiding the rest. Two plus three is
 * `NAV_MAX_VISIBLE` — the cabinet and the panel constant have always named the
 * same number of tabs; only the panel's arithmetic disagreed.
 *
 * Written from the two panel constants rather than the literal 3 so a third
 * essential moves the oracle and the reader together. The absolute numbers are
 * pinned separately below, because those belong to the cabinet, not here.
 */
function cabinetVisible(
  operatorOrder: readonly NavItemSetting[],
): readonly string[] {
  const essentials = new Set<string>(NAV_ESSENTIAL_DESTINATIONS);
  const budget = NAV_MAX_VISIBLE - NAV_ESSENTIAL_DESTINATIONS.length;
  const optional = new Set(
    operatorOrder
      .filter((item) => item.visible && !essentials.has(item.id))
      .slice(0, budget)
      .map((item) => item.id),
  );
  return operatorOrder
    .filter((item) => essentials.has(item.id) || optional.has(item.id))
    .map((item) => item.id);
}

/** Every destination, in the given order, all switched on. */
function allEnabled(
  order: readonly string[] = NAV_DESTINATIONS,
): NavItemSetting[] {
  return order.map((id) => ({ id, visible: true }) as NavItemSetting);
}

function visibleIds(navItems: readonly NavItemSetting[]): readonly string[] {
  return navItems.filter((item) => item.visible).map((item) => item.id);
}

describe('readBrandingSettings — navItems', () => {
  it('returns the default nav when absent', () => {
    const branding = readBrandingSettings({});
    assert.deepStrictEqual(branding.navItems, DEFAULT_BRANDING.navItems);
  });

  it('always lists every destination exactly once (appends missing, hidden)', () => {
    const branding = readBrandingSettings({ navItems: [{ id: 'plans', visible: true }] });
    const ids = branding.navItems.map((i) => i.id);
    assert.deepStrictEqual([...ids].sort(), [...NAV_DESTINATIONS].sort());
    // No duplicates.
    assert.equal(new Set(ids).size, ids.length);
  });

  it('forces essentials (subscriptions, settings) visible even if set hidden', () => {
    const branding = readBrandingSettings({
      navItems: [
        { id: 'subscriptions', visible: false },
        { id: 'settings', visible: false },
      ],
    });
    const byId = Object.fromEntries(branding.navItems.map((i) => [i.id, i.visible]));
    assert.equal(byId['subscriptions'], true);
    assert.equal(byId['settings'], true);
  });

  it('dedupes repeated ids (first wins) and preserves order', () => {
    const branding = readBrandingSettings({
      navItems: [
        { id: 'plans', visible: true },
        { id: 'plans', visible: false },
        { id: 'devices', visible: true },
      ],
    });
    const order = branding.navItems.map((i) => i.id);
    assert.equal(order[0], 'plans');
    assert.equal(order[1], 'devices');
    const plans = branding.navItems.find((i) => i.id === 'plans');
    assert.equal(plans?.visible, true);
  });

  /**
   * These are about a PERSISTED payload, not about the panel's picker. The
   * picker (`web/src/features/branding/nav-config-section.tsx`) disables the
   * fourth optional switch, so an operator with a mouse cannot build one of
   * these. An API client, a legacy row, a restored backup, a seed or a
   * migration can, and the reader is the only thing between them and the
   * cabinet.
   *
   * This block used to assert `visible.length <= 6` — true of the defect and
   * true of the fix, so it accepted both. Six visible tabs is exactly what the
   * cabinet refuses to draw.
   */
  it('leaves the cabinet nothing to hide: same visible set, all nine enabled', () => {
    const navItems = allEnabled();
    const visible = visibleIds(readBrandingSettings({ navItems }).navItems);

    assert.deepStrictEqual(visible, cabinetVisible(navItems));
    // Pinned absolutely as well as derived: two essentials + three optional is
    // the cabinet's `.slice(0, 3)` plus its two unconditional tabs. Cross-repo
    // guard: `reiwa/test/web/branding-vocabulary-panel-parity.test.ts`.
    assert.equal(visible.length, 5);
    assert.equal(
      visible.filter(
        (id) => !(NAV_ESSENTIAL_DESTINATIONS as readonly string[]).includes(id),
      ).length,
      3,
    );
    assert.ok(visible.includes('subscriptions'));
    assert.ok(visible.includes('settings'));
  });

  it('spends the budget in operator order — the first three optional survive', () => {
    const navItems = allEnabled([
      'faq',
      'subscriptions',
      'promo',
      'support',
      'settings',
      'plans',
      'devices',
      'referrals',
      'activity',
    ]);
    const visible = visibleIds(readBrandingSettings({ navItems }).navItems);
    assert.deepStrictEqual(visible, cabinetVisible(navItems));
    assert.deepStrictEqual(visible, [
      'faq',
      'subscriptions',
      'promo',
      'support',
      'settings',
    ]);
  });

  it('gives the same answer wherever the essentials sit in the order', () => {
    // The defect was order-dependent: the essentials both consumed a slot and
    // were exempt from the cap, so `subscriptions` first / `settings` last left
    // room for a FOURTH optional destination, while essentials in the middle
    // left room for three. Same operator intent, two different cabinets.
    const optionalOrder = [
      'plans',
      'referrals',
      'devices',
      'activity',
      'promo',
      'support',
      'faq',
    ];
    const answers = [
      ['subscriptions', ...optionalOrder, 'settings'],
      ['subscriptions', 'settings', ...optionalOrder],
      [...optionalOrder, 'subscriptions', 'settings'],
      ['plans', 'referrals', 'subscriptions', 'settings', 'devices', 'activity', 'promo', 'support', 'faq'],
    ].map((order) => {
      const navItems = allEnabled(order);
      const visible = visibleIds(readBrandingSettings({ navItems }).navItems);
      assert.deepStrictEqual(visible, cabinetVisible(navItems));
      return visible.filter(
        (id) => !(NAV_ESSENTIAL_DESTINATIONS as readonly string[]).includes(id),
      );
    });
    for (const optional of answers) {
      assert.deepStrictEqual(optional, ['plans', 'referrals', 'devices']);
    }
  });

  it('hides the overflow instead of dropping it from the list', () => {
    // The operator's choice is preserved as a hidden row, so the panel still
    // shows every destination and the demoted one can be re-ordered up.
    const branding = readBrandingSettings({ navItems: allEnabled() });
    assert.deepStrictEqual(
      [...branding.navItems.map((i) => i.id)].sort(),
      [...NAV_DESTINATIONS].sort(),
    );
    assert.equal(branding.navItems.filter((i) => !i.visible).length, 4);
  });

  it('ignores unknown destination ids', () => {
    const branding = readBrandingSettings({
      navItems: [{ id: 'hack', visible: true }, { id: 'plans', visible: true }],
    });
    assert.ok(!branding.navItems.some((i) => (i.id as string) === 'hack'));
    assert.ok(branding.navItems.some((i) => i.id === 'plans'));
  });
});

describe('readBrandingSettings — navGap', () => {
  it('defaults to 2 when absent or invalid', () => {
    assert.equal(readBrandingSettings({}).navGap, 2);
    assert.equal(readBrandingSettings({ navGap: 'x' }).navGap, 2);
    assert.equal(readBrandingSettings({ navGap: Number.NaN }).navGap, 2);
  });

  it('clamps to 0–24 and floors to an integer', () => {
    assert.equal(readBrandingSettings({ navGap: 10 }).navGap, 10);
    assert.equal(readBrandingSettings({ navGap: -5 }).navGap, 0);
    assert.equal(readBrandingSettings({ navGap: 99 }).navGap, 24);
    assert.equal(readBrandingSettings({ navGap: 7.9 }).navGap, 7);
  });
});
