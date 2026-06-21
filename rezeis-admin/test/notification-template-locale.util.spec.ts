import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as fc from 'fast-check';

import {
  coerceNotificationLocale,
  isStoredNotificationButton,
  readStoredButtons,
  resolveTemplateButtons,
  resolveTemplateLocale,
  validateStoredButton,
} from '../src/modules/notifications/utils/notification-template-locale.util';

describe('notification-template-locale.util', () => {
  describe('coerceNotificationLocale', () => {
    it('treats RU (any case) as ru and everything else as en', () => {
      assert.equal(coerceNotificationLocale('RU'), 'ru');
      assert.equal(coerceNotificationLocale('ru'), 'ru');
      assert.equal(coerceNotificationLocale(null), 'ru');
      assert.equal(coerceNotificationLocale(undefined), 'ru');
      assert.equal(coerceNotificationLocale('EN'), 'en');
      assert.equal(coerceNotificationLocale('de'), 'en');
    });
  });

  describe('resolveTemplateLocale', () => {
    it('returns the RU column for ru locale unconditionally', () => {
      const out = resolveTemplateLocale(
        { title: 'RU title', body: 'RU body', titleEn: 'EN title', bodyEn: 'EN body' },
        'ru',
      );
      assert.deepStrictEqual(out, { title: 'RU title', body: 'RU body' });
    });

    it('returns EN copy when both EN columns are non-empty', () => {
      const out = resolveTemplateLocale(
        { title: 'RU title', body: 'RU body', titleEn: 'EN title', bodyEn: 'EN body' },
        'en',
      );
      assert.deepStrictEqual(out, { title: 'EN title', body: 'EN body' });
    });

    it('falls back per-field to RU when only one EN column is authored', () => {
      const out = resolveTemplateLocale(
        { title: 'RU title', body: 'RU body', titleEn: null, bodyEn: 'EN body' },
        'en',
      );
      assert.deepStrictEqual(out, { title: 'RU title', body: 'EN body' });
    });

    it('treats whitespace-only EN copy as missing', () => {
      const out = resolveTemplateLocale(
        { title: 'RU title', body: 'RU body', titleEn: '   ', bodyEn: '\n' },
        'en',
      );
      assert.deepStrictEqual(out, { title: 'RU title', body: 'RU body' });
    });

    it('property — fallback is total: result is always non-empty for non-empty RU template', () => {
      fc.assert(
        fc.property(
          fc.record({
            title: fc.string({ minLength: 1, maxLength: 200 }).map((s) => s.padEnd(1, 't')),
            body: fc.string({ minLength: 1, maxLength: 200 }).map((s) => s.padEnd(1, 'b')),
            titleEn: fc.option(fc.string({ maxLength: 200 }), { nil: null }),
            bodyEn: fc.option(fc.string({ maxLength: 200 }), { nil: null }),
          }),
          fc.constantFrom('ru' as const, 'en' as const),
          (template, locale) => {
            const out = resolveTemplateLocale(template, locale);
            // Title and body must be non-empty whenever the RU column is non-empty.
            return out.title.length > 0 && out.body.length > 0;
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe('isStoredNotificationButton + readStoredButtons', () => {
    it('accepts the canonical shape and rejects everything else', () => {
      assert.equal(
        isStoredNotificationButton({ labelRu: 'L', kind: 'webApp', target: '/renew' }),
        true,
      );
      assert.equal(
        isStoredNotificationButton({ labelRu: 'L', kind: 'invalid', target: 'x' }),
        false,
      );
      assert.equal(isStoredNotificationButton(null), false);
      assert.equal(isStoredNotificationButton([]), false);
      assert.equal(isStoredNotificationButton({}), false);
    });

    it('readStoredButtons drops malformed rows but preserves order', () => {
      const out = readStoredButtons([
        { labelRu: 'A', kind: 'webApp', target: '/renew' },
        { labelRu: 'B', kind: 'BAD', target: 'x' },
        { labelRu: 'C', labelEn: 'CC', kind: 'callback', target: 'menu:main' },
      ]);
      assert.deepStrictEqual(
        out.map((b) => b.labelRu),
        ['A', 'C'],
      );
    });

    it('readStoredButtons returns [] for non-array input', () => {
      assert.deepStrictEqual(readStoredButtons(null), []);
      assert.deepStrictEqual(readStoredButtons('nope'), []);
      assert.deepStrictEqual(readStoredButtons({ buttons: [] }), []);
    });
  });

  describe('validateStoredButton', () => {
    it('webApp/callback require non-empty target', () => {
      assert.equal(
        validateStoredButton({ labelRu: 'L', kind: 'webApp', target: '/renew' }),
        true,
      );
      assert.equal(
        validateStoredButton({ labelRu: 'L', kind: 'webApp', target: '' }),
        false,
      );
      assert.equal(
        validateStoredButton({ labelRu: 'L', kind: 'callback', target: 'menu:main' }),
        true,
      );
      assert.equal(
        validateStoredButton({ labelRu: 'L', kind: 'callback', target: '' }),
        false,
      );
    });

    it('url enforces HTTPS and rejects localhost', () => {
      assert.equal(
        validateStoredButton({ labelRu: 'L', kind: 'url', target: 'https://example.com' }),
        true,
      );
      assert.equal(
        validateStoredButton({ labelRu: 'L', kind: 'url', target: 'http://example.com' }),
        false,
      );
      assert.equal(
        validateStoredButton({ labelRu: 'L', kind: 'url', target: 'https://localhost:3000' }),
        false,
      );
    });

    it('property — validity is monotone over row removal', () => {
      const buttonArb = fc.record({
        labelRu: fc.string({ minLength: 1, maxLength: 32 }),
        kind: fc.constantFrom('webApp' as const, 'url' as const, 'callback' as const),
        target: fc.oneof(
          fc.constant(''),
          fc.constant('/renew'),
          fc.constant('https://example.com'),
          fc.constant('http://nope'),
          fc.constant('menu:main'),
        ),
      });
      fc.assert(
        fc.property(fc.array(buttonArb, { minLength: 0, maxLength: 8 }), (buttons) => {
          const validCount = buttons.filter(validateStoredButton).length;
          // Remove each row in turn; count never increases by more than 0
          // (i.e. removing a row never adds a valid row).
          for (let i = 0; i < buttons.length; i += 1) {
            const without = buttons.slice(0, i).concat(buttons.slice(i + 1));
            const validAfter = without.filter(validateStoredButton).length;
            if (validAfter > validCount) return false;
            if (validCount - validAfter > 1) return false;
          }
          return true;
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('resolveTemplateButtons', () => {
    it('maps stored rows to NotifyButton kinds and picks per-locale label', () => {
      const buttons = resolveTemplateButtons(
        {
          buttons: [
            { labelRu: 'Продлить', labelEn: 'Renew', kind: 'webApp', target: '/renew' },
            { labelRu: 'Открыть', kind: 'url', target: 'https://example.com' },
            { labelRu: 'Меню', labelEn: 'Menu', kind: 'callback', target: 'menu:main' },
          ],
        },
        'en',
      );
      assert.deepStrictEqual(buttons, [
        { text: 'Renew', webAppPath: '/renew' },
        { text: 'Открыть', url: 'https://example.com' },
        { text: 'Menu', callbackData: 'menu:main' },
      ]);
    });

    it('drops invalid rows while keeping the order', () => {
      const buttons = resolveTemplateButtons(
        {
          buttons: [
            { labelRu: 'A', kind: 'webApp', target: '' },
            { labelRu: 'B', kind: 'webApp', target: '/renew' },
            { labelRu: 'C', kind: 'url', target: 'http://nope' },
            { labelRu: 'D', kind: 'callback', target: 'menu:main' },
          ],
        },
        'ru',
      );
      assert.deepStrictEqual(
        buttons.map((b) => b.text),
        ['B', 'D'],
      );
    });

    it('returns an empty array for missing/malformed JSON', () => {
      assert.deepStrictEqual(resolveTemplateButtons({ buttons: null }, 'ru'), []);
      assert.deepStrictEqual(resolveTemplateButtons({ buttons: '[]' }, 'ru'), []);
    });
  });
});
