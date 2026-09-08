import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_CONNECT_PAGE_CONFIG } from '../src/modules/subpage-config/connect-page/connect-page.default';
import {
  auditConnectPageConfig,
  connectPageConfigSchema,
  encodingFor,
  normalizeConnectPageConfig,
} from '../src/modules/subpage-config/connect-page/connect-page.schema';
import { sanitizeIconMarkup } from '../src/modules/subpage-config/connect-page/svg-sanitizer.util';

/**
 * The catalog every operator sees before they touch anything.
 *
 * A default is the one config that ships without anyone reviewing it, so it is
 * the one that has to be checked by machine. Everything an operator's own save
 * is checked against, this is checked against too — otherwise the strictest
 * validation in the product would have an exemption for the only config most
 * installs ever run.
 */

describe('the default catalog', () => {
  it('parses against the schema it will be saved through', () => {
    const result = connectPageConfigSchema.safeParse(DEFAULT_CONNECT_PAGE_CONFIG);

    assert.equal(result.success, true, JSON.stringify(result.error?.issues.slice(0, 3)));
  });

  it('has nothing the audit would refuse', () => {
    assert.deepEqual(auditConnectPageConfig(DEFAULT_CONNECT_PAGE_CONFIG), []);
  });

  it('offers a way to connect on every platform, deep link or not', () => {
    for (const platform of DEFAULT_CONNECT_PAGE_CONFIG.platforms) {
      for (const app of platform.apps) {
        const canHandOver = app.steps.some((step) =>
          step.buttons.some((button) => button.kind === 'copyLink'),
        );
        assert.ok(canHandOver, `${platform.id}/${app.name} has no fallback for a scheme that does not fire`);
      }
    }
  });

  it('exercises BOTH substitution rules', () => {
    // A default that only ever puts the placeholder in a path would let a
    // renderer ship with one rule and look perfectly fine until the first
    // operator adds Clash.
    const encodings = new Set<string>();
    for (const platform of DEFAULT_CONNECT_PAGE_CONFIG.platforms) {
      for (const app of platform.apps) {
        for (const step of app.steps) {
          for (const button of step.buttons) {
            if (button.kind === 'deepLink') encodings.add(encodingFor(button.template));
          }
        }
      }
    }

    assert.deepEqual([...encodings].sort(), ['component', 'raw']);
  });

  it('ships icons that survive the sanitizer they will be re-saved through', () => {
    // The default bypasses the save path today, so nothing else proves its
    // icons are the kind of markup the panel would accept from an operator.
    for (const [key, markup] of Object.entries(DEFAULT_CONNECT_PAGE_CONFIG.icons)) {
      const { markup: clean, removed } = sanitizeIconMarkup(markup);
      assert.deepEqual(removed, [], `icon "${key}" carries something a saved icon may not`);
      assert.ok(clean.length > 0);
    }
  });

  it('carries both languages everywhere a person reads', () => {
    // A half-translated catalog is a legal state to SAVE — an operator writes
    // one language first. It is not a legal state to SHIP.
    const missing: string[] = [];
    const check = (where: string, text: Record<string, string> | null | undefined): void => {
      if (text === null || text === undefined) return;
      for (const locale of ['ru', 'en']) {
        if ((text[locale] ?? '').trim().length === 0) missing.push(`${where}:${locale}`);
      }
    };

    for (const platform of DEFAULT_CONNECT_PAGE_CONFIG.platforms) {
      check(platform.id, platform.title);
      for (const app of platform.apps) {
        for (const [si, step] of app.steps.entries()) {
          check(`${platform.id}/${app.id}/step${si}`, step.title);
          check(`${platform.id}/${app.id}/step${si}.body`, step.body);
          for (const button of step.buttons) check(`${platform.id}/${app.id}/step${si}.button`, button.label);
        }
      }
    }

    assert.deepEqual(missing, []);
  });

  it('normalizes to itself once the derived fields are stamped', () => {
    // The default is written by hand and never passes through the save path, so
    // this is the only thing that keeps it honest about `encode`.
    const stamped = normalizeConnectPageConfig(DEFAULT_CONNECT_PAGE_CONFIG);

    for (const platform of stamped.platforms) {
      for (const app of platform.apps) {
        for (const step of app.steps) {
          for (const button of step.buttons) {
            if (button.kind !== 'deepLink') continue;
            assert.equal(button.encode, encodingFor(button.template), button.template);
          }
        }
      }
    }
  });

  // ── Two kinds of icon, and the difference is load-bearing ──────────────────
  //
  // The library used to hold five hand-drawn glyphs and nothing else, guarded by
  // a test that named all five, because redistributing a vendor's mark in our
  // default is a trademark question. The owner supplied the marks and asked for
  // them (08.09.2026), so that guard is gone — but the rule that replaced it is
  // the one the concepts actually depend on.
  //
  // A STEP or PLATFORM glyph is drawn on `currentColor`: it takes the accent of
  // whatever concept the screen is wearing, which is why the same catalog looks
  // right on all 104 of them. An APPLICATION MARK carries its own colours,
  // because a brand mark that changes colour is not that brand's mark.
  //
  // Get it the wrong way round and nothing throws: a `currentColor` app mark
  // turns into a flat silhouette, and a fixed-colour step glyph stays one colour
  // while every other accent on the screen moves.

  const STEP_AND_PLATFORM_ICONS = [
    'download',
    'link',
    'rocket',
    'phone',
    'monitor',
    'apple',
    'android',
    'windows',
    'macos',
    'linux',
    'check',
    'cloud-download',
    'external-link',
    'star',
  ];

  it('draws every step and platform glyph on currentColor', () => {
    for (const key of STEP_AND_PLATFORM_ICONS) {
      const markup = DEFAULT_CONNECT_PAGE_CONFIG.icons[key];
      assert.ok(markup !== undefined, `${key} is missing from the library`);
      assert.match(markup, /currentColor/i, `${key} would not take the concept accent`);
    }
  });

  it('leaves every application mark its own colours', () => {
    const marks = Object.keys(DEFAULT_CONNECT_PAGE_CONFIG.icons).filter(
      (key) => !STEP_AND_PLATFORM_ICONS.includes(key),
    );
    // Guards the guard: an empty list would make the loop below watch nothing.
    assert.ok(marks.length > 10, `only ${marks.length} application marks`);
    for (const key of marks) {
      assert.doesNotMatch(
        DEFAULT_CONNECT_PAGE_CONFIG.icons[key],
        /currentColor/i,
        `${key} is an app mark drawn on currentColor; it would render as a silhouette`,
      );
    }
  });

  it('references only icons it actually ships', () => {
    // An `iconKey` with nothing behind it renders the fallback glyph and looks
    // like a bug in the app rather than a gap in the catalog.
    const missing: string[] = [];
    const check = (key: string | null | undefined, where: string): void => {
      if (key && DEFAULT_CONNECT_PAGE_CONFIG.icons[key] === undefined) {
        missing.push(`${where} -> ${key}`);
      }
    };
    for (const platform of DEFAULT_CONNECT_PAGE_CONFIG.platforms) {
      check(platform.iconKey, platform.id);
      for (const app of platform.apps) {
        check(app.iconKey, `${platform.id}/${app.id}`);
        for (const [index, step] of app.steps.entries()) {
          check(step.iconKey, `${platform.id}/${app.id}/step${index}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it('gives an app a mark whenever one exists for it', () => {
    // `iconKey` is nullable and stays that way: an operator adding their own app
    // usually has no logo for it, and the cabinet draws the app's initial on the
    // same plate rather than an empty square. So this is not "every app must
    // have one" — it is "we did not forget one we ship".
    //
    // Nekoray is the deliberate exception: there is no mark for it in the
    // library, and inventing one or fetching a vendor's from the web are both
    // worse answers than the initial.
    const bare: string[] = [];
    for (const platform of DEFAULT_CONNECT_PAGE_CONFIG.platforms) {
      for (const app of platform.apps) {
        if (!app.iconKey) bare.push(`${platform.id}/${app.id}`);
      }
    }
    assert.deepEqual(bare, ['linux/nekoray']);
  });
});
