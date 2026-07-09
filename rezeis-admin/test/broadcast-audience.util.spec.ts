import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastAudience } from '@prisma/client';

import {
  buildAudienceWhere,
  normalizeAudienceFilter,
} from '../src/modules/broadcast/utils/broadcast-audience.util';

describe('normalizeAudienceFilter', () => {
  it('drops unknown values and returns a clean filter', () => {
    const filter = normalizeAudienceFilter({
      subscription: ['ACTIVE', 'bogus', 'TRIAL'],
      planIds: ['plan-1', ''],
      inactiveDays: 30.7,
      platforms: ['web', 'nope'],
      contact: ['hasEmail', 'invalid'],
      extra: 'ignored',
    });
    assert.deepStrictEqual(filter, {
      subscription: ['ACTIVE', 'TRIAL'],
      planIds: ['plan-1'],
      inactiveDays: 30,
      platforms: ['web'],
      contact: ['hasEmail'],
    });
  });

  it('returns null for empty / non-object / all-unknown input', () => {
    assert.equal(normalizeAudienceFilter(null), null);
    assert.equal(normalizeAudienceFilter('x'), null);
    assert.equal(normalizeAudienceFilter([]), null);
    assert.equal(normalizeAudienceFilter({}), null);
    assert.equal(normalizeAudienceFilter({ subscription: ['bogus'], inactiveDays: 0 }), null);
  });
});

describe('buildAudienceWhere — legacy enum presets (unified base)', () => {
  it('ALL → only the not-blocked base (no telegram-only restriction)', () => {
    assert.deepStrictEqual(buildAudienceWhere(BroadcastAudience.ALL, null), {
      isBlocked: false,
    });
  });

  it('ACTIVE_SUBSCRIBERS', () => {
    assert.deepStrictEqual(buildAudienceWhere(BroadcastAudience.ACTIVE_SUBSCRIBERS, null), {
      isBlocked: false,
      subscriptions: { some: { status: 'ACTIVE' } },
    });
  });

  it('EXPIRED excludes users who also hold an active sub', () => {
    assert.deepStrictEqual(buildAudienceWhere(BroadcastAudience.EXPIRED, null), {
      isBlocked: false,
      subscriptions: { some: { status: 'EXPIRED' } },
      NOT: { subscriptions: { some: { status: 'ACTIVE' } } },
    });
  });

  it('TRIAL / UNSUBSCRIBED', () => {
    assert.deepStrictEqual(buildAudienceWhere(BroadcastAudience.TRIAL, null), {
      isBlocked: false,
      subscriptions: { some: { isTrial: true, status: 'ACTIVE' } },
    });
    assert.deepStrictEqual(buildAudienceWhere(BroadcastAudience.UNSUBSCRIBED, null), {
      isBlocked: false,
      subscriptions: { none: {} },
    });
  });
});

describe('buildAudienceWhere — structured filter supersedes the enum', () => {
  it('combines categories with AND (OR within each)', () => {
    const now = new Date('2026-07-09T00:00:00.000Z');
    const filter = normalizeAudienceFilter({
      subscription: ['ACTIVE', 'TRIAL'],
      planIds: ['plan-1'],
      inactiveDays: 30,
      platforms: ['web'],
      contact: ['hasEmail'],
    });
    // Enum is ALL but the filter must take precedence.
    const where = buildAudienceWhere(BroadcastAudience.ALL, filter, now);
    assert.deepStrictEqual(where, {
      isBlocked: false,
      AND: [
        {
          OR: [
            { subscriptions: { some: { status: 'ACTIVE' } } },
            { subscriptions: { some: { isTrial: true, status: 'ACTIVE' } } },
          ],
        },
        {
          subscriptions: {
            some: { OR: [{ planSnapshot: { path: ['id'], equals: 'plan-1' } }] },
          },
        },
        { lastSeenAt: { lt: new Date('2026-06-09T00:00:00.000Z') } },
        { OR: [{ lastSurface: { in: ['pwa', 'browser'] } }] },
        { OR: [{ email: { not: null } }] },
      ],
    });
  });

  it('platform + contact map to the right fields', () => {
    const where = buildAudienceWhere(
      BroadcastAudience.ALL,
      normalizeAudienceFilter({ platforms: ['telegram', 'miniapp'], contact: ['hasTelegram', 'hasWebPush'] }),
    );
    assert.deepStrictEqual(where, {
      isBlocked: false,
      AND: [
        { OR: [{ telegramId: { not: null } }, { lastSurface: 'tma' }] },
        { OR: [{ telegramId: { not: null } }, { webPushSubscriptions: { some: {} } }] },
      ],
    });
  });
});
