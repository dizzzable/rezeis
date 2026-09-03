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

  it('ships no third-party logo in the icon library', () => {
    // Redistributing a vendor's mark in our default is a trademark question
    // nobody asked. `iconKey` is nullable and an operator can paste one.
    assert.deepEqual(Object.keys(DEFAULT_CONNECT_PAGE_CONFIG.icons).sort(), [
      'download',
      'link',
      'monitor',
      'phone',
      'rocket',
    ]);
  });
});
