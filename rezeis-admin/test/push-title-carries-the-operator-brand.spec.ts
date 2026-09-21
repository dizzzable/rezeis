import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * NOBODY MAY HEAD A NOTIFICATION WITH THE STOCK PRODUCT NAME.
 *
 * `WebPushService` has read the operator's `brandingSettings.brandName` since
 * 2026-08-24 — but only to fill a title the sender left EMPTY. A sender that
 * writes its own title wins, and three of them wrote the literal `Reiwa`,
 * which is the fallback for an install that configured nothing:
 *
 *   • the operator's own message to one subscriber (push banner);
 *   • every `preRenderedText` send — support, hints, operator sends — where
 *     that same literal became the push title, the E-MAIL SUBJECT and the row
 *     in the cabinet's own feed;
 *   • the panel's "send a test push" button.
 *
 * So an operator whose cabinet is called «Winger VPN» wrote to a customer and
 * the customer was told `Reiwa` had written. Reported from production
 * 2026-09-21 with a screenshot of the Android shade: the site row read the
 * operator's name and the notification title read ours.
 *
 * This is a SOURCE scan rather than a behaviour test on purpose. The defect is
 * not that one function returns the wrong string — it is that a title can be
 * invented at any one of a dozen call sites, and the next one added would be
 * invented the same way. The one legitimate home for the literal is the
 * last-resort default, and `DEFAULT_PUSH_BRAND_NAME` / `DEFAULT_BRANDING` are
 * where it lives.
 */

const SRC = join(__dirname, '..', 'src');

/** The stock name. Not the operator's — that one is only ever read at runtime. */
const STOCK_BRAND = 'Reiwa';

/**
 * `title: 'Reiwa'` in any spacing or quoting. Anchored on the KEY so this
 * cannot be satisfied by deleting the word from a comment, and so a constant
 * that legitimately holds the default is not caught by it.
 */
const STOCK_TITLE = new RegExp(`\\btitle\\s*:\\s*['"\`]${STOCK_BRAND}['"\`]`);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path);
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) yield path;
  }
}

describe('a notification is headed by the operator brand, never by the stock name', () => {
  it('has no sender that writes the stock name as a title', () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (STOCK_TITLE.test(line)) {
          offenders.push(`${path.slice(SRC.length + 1)}:${index + 1}`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `These senders head a notification with the stock product name instead of the operator's brand. ` +
        `Send an EMPTY title (a push payload is filled from the brand by WebPushService) or read the ` +
        `brand with WebPushService.resolveBrandName() where the title also becomes an e-mail subject ` +
        `or a feed row:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('still keeps the last-resort default, so a settings read that fails costs nothing', () => {
    // ANTI-VACUITY. A rule of "the word must not appear in src" would pass by
    // deleting the fallback, and a branding read that throws would then head
    // the notification with an empty string.
    const service = readFileSync(
      join(SRC, 'modules', 'push', 'services', 'web-push.service.ts'),
      'utf8',
    );
    assert.match(service, new RegExp(`DEFAULT_PUSH_BRAND_NAME\\s*=\\s*'${STOCK_BRAND}'`));
    assert.match(
      service,
      /return\s*\{\s*brandName:\s*DEFAULT_PUSH_BRAND_NAME/,
      'the catch branch must still answer with the default rather than an empty title',
    );
  });

  it('exposes the brand to senders whose title is not only a push', () => {
    // The `preRenderedText` title is ALSO the e-mail subject and the cabinet
    // feed row, and neither passes through a push payload — so "send an empty
    // title" does not cover it and a reader has to exist.
    const service = readFileSync(
      join(SRC, 'modules', 'push', 'services', 'web-push.service.ts'),
      'utf8',
    );
    assert.match(service, /public async resolveBrandName\(\): Promise<string>/);
  });
});
