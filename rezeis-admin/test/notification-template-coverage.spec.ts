import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_NOTIFICATION_TEMPLATES } from '../src/modules/notifications/catalog/default-templates.catalog';

/**
 * A notification type nobody can edit is a notification type nobody receives
 * ═════════════════════════════════════════════════════════════════════════
 *
 * `fanout` gates EVERY push channel on a rendered template — Telegram at one
 * branch, web-push at the next, the operator mirror at the third — and
 * `rendered` is `null` when the catalogue has no row for the type. Not
 * "delivered without a title": not delivered, on any channel.
 *
 * Three advertising decisions lived in that state since the module shipped.
 * `advertising.request_countered`, `_rejected` and `_activated` were emitted,
 * had no catalogue row, and produced nothing at all — a partner whose
 * placement was countered, refused or launched heard about it from no channel,
 * and the feed row carried no text either.
 *
 * The gap was also undiscoverable from the panel. The Seed button inserts the
 * catalogue and nothing lists types that HAVE no catalogue entry, so the
 * screen looked complete.
 *
 * These two lists are what an operator actually sees, and they must agree:
 * the tick-box list on the notifications page, and the shipped catalogue.
 */

const NOTIFICATIONS_PAGE = join(
  __dirname,
  '..',
  'web',
  'src',
  'features',
  'notifications',
  'notifications-page.tsx',
);

/** The `USER_NOTIFICATION_KEYS` array the operator's screen renders. */
function readOperatorKeys(): readonly string[] {
  const source = readFileSync(NOTIFICATIONS_PAGE, 'utf8');
  const start = source.indexOf('const USER_NOTIFICATION_KEYS = [');
  assert.notEqual(start, -1, 'USER_NOTIFICATION_KEYS is gone from the notifications page');
  const end = source.indexOf('] as const', start);
  assert.notEqual(end, -1, 'USER_NOTIFICATION_KEYS is not closed with `] as const`');
  const keys = Array.from(source.slice(start, end).matchAll(/'([^']+)'/g), (m) => m[1]);
  // NON-VACUITY: a parser that quietly matched nothing would agree with an
  // empty catalogue forever.
  assert.ok(keys.length > 10, `read only ${keys.length} operator keys — the parser broke`);
  return keys;
}

const catalogueTypes = new Set(DEFAULT_NOTIFICATION_TEMPLATES.map((template) => template.type));

describe('every notification the operator can tick, they can also edit', () => {
  it('ships a template for every key on the notifications page', () => {
    const missing = readOperatorKeys().filter((key) => !catalogueTypes.has(key));
    assert.deepEqual(
      missing,
      [],
      `these types are offered on the operator screen with no shipped template — ` +
        `every push channel is gated on one, so they deliver nothing at all: ${missing.join(', ')}`,
    );
  });

  it('names the three advertising decisions', () => {
    // Spelled out because they are the ones this rule was written for. If a
    // later change drops them from the page's key list, the assertion above
    // stops covering them and this one still does.
    for (const type of [
      'advertising.request_countered',
      'advertising.request_rejected',
      'advertising.request_activated',
    ]) {
      assert.ok(catalogueTypes.has(type), `${type} has no shipped template`);
    }
  });

  it('declares each type exactly once', () => {
    // `seedDefaults` upserts by `type`; a duplicate means one of the two rows
    // is dead copy that an operator can never reach, and which one wins
    // depends on array order.
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const template of DEFAULT_NOTIFICATION_TEMPLATES) {
      if (seen.has(template.type)) duplicates.push(template.type);
      seen.add(template.type);
    }
    assert.deepEqual(duplicates, []);
  });

  it('gives every template both a title and a body', () => {
    const empty = DEFAULT_NOTIFICATION_TEMPLATES.filter(
      (template) => template.title.trim().length === 0 || template.body.trim().length === 0,
    ).map((template) => template.type);
    assert.deepEqual(empty, []);
  });
});
