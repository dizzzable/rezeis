import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  connectPageThemeSchema,
  isEmptyConnectTheme,
  isSafeConnectBackground,
} from '../src/modules/subpage-config/connect-page/connect-page.theme';

/**
 * THE APPEARANCE THE PANEL SENDS THE CABINET, CHECKED WHERE SOMEBODY CAN SEE IT.
 *
 * This is one half of a mirror. The other half is `connect-theme.ts` in reiwa,
 * which re-checks all of it before writing anything into a live `style`
 * attribute, and `web/test/connect-theme.test.ts` over there runs this same
 * table. The duplication is deliberate — two images, two release trains, and
 * the cabinet is where the value becomes CSS, so the cabinet cannot delegate
 * the check to a panel it has never met.
 *
 * What THIS side is for is the error message. A value refused here is refused
 * while the operator is still looking at the screen that produced it. The same
 * value refused in the cabinet is silent: the concept does not apply, and what
 * reaches support is "I picked a theme and nothing happened".
 *
 * That is also why this grammar must never be LOOSER than the cabinet's. A
 * value this side accepts and the cabinet drops is precisely the silent case.
 */

/** A real background from the concept generator (Midnight Coral Mesh). */
const REAL_BACKGROUND =
  'radial-gradient(circle at 12% 14%, rgba(255,107,122,0.72) 0%, transparent 42%), ' +
  'linear-gradient(145deg, #05070D 0%, #15102A 40%, #5C2038 72%, #0B0610 100%)';

const REAL_THEME = {
  presetId: 'concept-ba',
  tokens: {
    'brand-primary': '#FF6B7A',
    'brand-primary-fg': '#19070B',
    'brand-foreground': '#FFF4F6',
    'brand-muted-foreground': '#B9A1AA',
    'color-surface': '#0D0B17D1',
    'color-surface-high': '#151224D9',
    'color-border-soft': '#FF8AA83D',
    'radius-card': '22px',
    'glass-blur': '26px',
  },
  backgroundColor: '#05070D',
  backgroundImage: REAL_BACKGROUND,
  rail: '#FF6B7A',
};

describe('a concept the gallery produces', () => {
  it('is accepted whole', () => {
    const parsed = connectPageThemeSchema.safeParse(REAL_THEME);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? []));
    assert.equal(parsed.data?.tokens['brand-primary'], '#FF6B7A');
    assert.equal(parsed.data?.backgroundImage, REAL_BACKGROUND);
  });

  it('is not empty, so it is stored rather than treated as a clear', () => {
    const parsed = connectPageThemeSchema.parse(REAL_THEME);
    assert.equal(isEmptyConnectTheme(parsed), false);
  });
});

describe('what an empty theme means', () => {
  it('is the same as no theme, whichever way it arrives', () => {
    // The editor sends `null` for "как в кабинете". This is the other route to
    // the same state — and the cabinet distinguishes them, because a theme
    // reported as present with no palette in it would paint a concept
    // background under the cabinet's own text colours.
    const parsed = connectPageThemeSchema.parse({ tokens: {} });
    assert.equal(isEmptyConnectTheme(parsed), true);
  });

  it('is not reached by a theme that still carries a background', () => {
    const parsed = connectPageThemeSchema.parse({ tokens: {}, backgroundImage: REAL_BACKGROUND });
    assert.equal(isEmptyConnectTheme(parsed), false);
  });
});

describe('token names', () => {
  it('refuses a name the cabinet never reads', () => {
    // Not harmless: it is a property nothing renders, so the operator sees
    // their choice do nothing and cannot tell that from a broken feature.
    const parsed = connectPageThemeSchema.safeParse({
      tokens: { 'brand-primary': '#FF6B7A', 'sidebar-accent': '#000000' },
    });
    assert.equal(parsed.success, false);
  });

  it('refuses a colour in a length slot and a length in a colour slot', () => {
    assert.equal(
      connectPageThemeSchema.safeParse({ tokens: { 'radius-card': '#FF6B7A' } }).success,
      false,
    );
    assert.equal(
      connectPageThemeSchema.safeParse({ tokens: { 'brand-primary': '22px' } }).success,
      false,
    );
  });

  it('keeps every colour form the generator writes', () => {
    for (const colour of [
      '#fff',
      '#ffff',
      '#FF6B7A',
      '#151224D9',
      'rgb(1,2,3)',
      'rgba(1,2,3,0.5)',
      'hsl(210 40% 50%)',
      'transparent',
    ]) {
      const parsed = connectPageThemeSchema.safeParse({ tokens: { 'brand-primary': colour } });
      assert.equal(parsed.success, true, colour);
    }
  });

  it('refuses anything else in a colour slot', () => {
    for (const bad of ['red', '#gggggg', 'rgb(1,2,3);color:red', 'var(--x)', '', ' ']) {
      const parsed = connectPageThemeSchema.safeParse({ tokens: { 'brand-primary': bad } });
      assert.equal(parsed.success, false, bad);
    }
  });

  it('accepts px and rem and refuses the rest', () => {
    assert.equal(connectPageThemeSchema.safeParse({ tokens: { 'radius-card': '22px' } }).success, true);
    assert.equal(connectPageThemeSchema.safeParse({ tokens: { 'glass-blur': '1.5rem' } }).success, true);
    for (const bad of ['22', '22pt', 'calc(1px + 1px)', '-4px', '22px;x:y']) {
      assert.equal(
        connectPageThemeSchema.safeParse({ tokens: { 'radius-card': bad } }).success,
        false,
        bad,
      );
    }
  });
});

describe('backgrounds that must never reach a customer', () => {
  const hostile: readonly (readonly [string, string])[] = [
    ['a network fetch that leaks the viewer', 'url(https://tracker.example/p.png)'],
    ['the same, upper-cased', 'URL(https://tracker.example/p.png)'],
    ['a property this whitelist never approved', 'var(--admin-token)'],
    ['a comment hiding the rest', 'linear-gradient(0deg,#000 0%,#fff 100%)/*'],
    ['an escape', 'linear-gradient(0deg,#000 0%,#fff 100%)\\75 rl(a)'],
    ['a second declaration', 'linear-gradient(0deg,#000,#fff);background:url(a)'],
    ['an unbalanced call the browser would repair', 'linear-gradient(0deg,#000,#fff'],
    ['a closing paren that ends the function early', 'linear-gradient(0deg,#000),url(a.png'],
    ['no gradient at all', '#ff0000'],
    ['an element reference', 'element(#admin)'],

    // ── Only the function whitelist refuses these ────────────────────────────
    //
    // Everything above is caught by the character check first, which left that
    // whitelist as code no test had ever executed. A RELATIVE url is the shape
    // that gets through it: no colon, no slash, nothing the character check
    // objects to, and a real gradient beside it so the "must be a gradient"
    // rule is satisfied too. It still reaches the network, and it still tells
    // whoever serves it which customer opened the screen.
    ['a relative url layered on a real gradient', 'linear-gradient(0deg,#000,#fff), url(a.png)'],
    ['an image set layered on a real gradient', 'linear-gradient(0deg,#000,#fff), image-set(a.png 1x)'],
    ['a paint worklet layered on a real gradient', 'linear-gradient(0deg,#000,#fff), paint(w)'],
    ['an env lookup layered on a real gradient', 'linear-gradient(0deg,#000,#fff), env(x)'],
  ];

  for (const [what, value] of hostile) {
    it(`refuses ${what}`, () => {
      assert.equal(isSafeConnectBackground(value), false, value);
      assert.equal(
        connectPageThemeSchema.safeParse({ ...REAL_THEME, backgroundImage: value }).success,
        false,
        value,
      );
    });
  }

  it('refuses a background too large to be one', () => {
    const huge = `linear-gradient(0deg, ${'#000000 0%, '.repeat(400)}#ffffff 100%)`;
    assert.ok(huge.length > 4_000);
    assert.equal(isSafeConnectBackground(huge), false);
  });

  it('accepts every gradient form the generator emits', () => {
    for (const value of [
      'linear-gradient(145deg, #05070D 0%, #0B0610 100%)',
      'radial-gradient(circle at 12% 14%, rgba(255,107,122,0.72) 0%, transparent 42%)',
      'conic-gradient(from 90deg, #000 0%, #fff 100%)',
      'repeating-linear-gradient(45deg, #000 0px, #000 2px, #fff 2px, #fff 4px)',
      REAL_BACKGROUND,
    ]) {
      assert.equal(isSafeConnectBackground(value), true, value);
    }
  });
});
