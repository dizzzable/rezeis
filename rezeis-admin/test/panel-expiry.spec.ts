import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import {
  PANEL_NO_END_EXPIRE_AT,
  PANEL_NO_END_FROM,
  panelExpiryToLocal,
  toPanelExpireAt,
  withLocalOpenEndKept,
} from '../src/modules/remnawave/services/panel-expiry';

/**
 * "No end date" on the Remnawave wire (`panel-expiry.ts`): what a push sends
 * for a subscription with no end, how a profile's date reads back, and the
 * guard every read-back applies to a row with no end. The paths through the
 * processor and the webhook are `remnawave-lifetime-postgres`.
 */

const HOUR = 3_600_000;

describe('the sentinel', () => {
  it('is in the year 2099 on every clock, the year Remnawave itself reads as "no end"', () => {
    const at = Date.parse(PANEL_NO_END_EXPIRE_AT);
    for (let offsetHours = -12; offsetHours <= 14; offsetHours += 1) {
      assert.equal(new Date(at + offsetHours * HOUR).getUTCFullYear(), 2099, `UTC${offsetHours >= 0 ? '+' : ''}${offsetHours}`);
    }
  });

  it('reads back as "no end": it is at or after the threshold', () => {
    assert.ok(Date.parse(PANEL_NO_END_EXPIRE_AT) >= PANEL_NO_END_FROM.getTime());
    assert.equal(panelExpiryToLocal(PANEL_NO_END_EXPIRE_AT), null);
  });

  it('the threshold is 2099 in UTC+14: the first instant that is 2099 anywhere', () => {
    assert.equal(new Date(PANEL_NO_END_FROM.getTime() + 14 * HOUR).toISOString(), '2099-01-01T00:00:00.000Z');
  });
});

describe('toPanelExpireAt', () => {
  it('sends the row’s own date, and the sentinel for none', () => {
    assert.equal(toPanelExpireAt(new Date('2026-10-01T10:00:00.000Z')), '2026-10-01T10:00:00.000Z');
    assert.equal(toPanelExpireAt(null), PANEL_NO_END_EXPIRE_AT);
  });
});

describe('panelExpiryToLocal', () => {
  it('reads a date as that date, up to the millisecond before the threshold', () => {
    const before = new Date(PANEL_NO_END_FROM.getTime() - 1);
    assert.equal(panelExpiryToLocal(before.toISOString())?.getTime(), before.getTime());
    assert.equal(panelExpiryToLocal('2026-10-01T10:00:00.000Z')?.toISOString(), '2026-10-01T10:00:00.000Z');
  });

  it('reads "no end" from the threshold on: Remnawave’s «до 2099 года», and any later date typed for "never"', () => {
    assert.equal(panelExpiryToLocal(PANEL_NO_END_FROM.toISOString()), null);
    assert.equal(panelExpiryToLocal('2099-09-24T17:05:00.000+03:00'), null);
    assert.equal(panelExpiryToLocal('9999-12-31T23:59:59.000Z'), null);
  });

  it('reads a Date as it reads a string: a test double hands over either', () => {
    assert.equal(panelExpiryToLocal(new Date('2026-10-01T10:00:00.000Z'))?.toISOString(), '2026-10-01T10:00:00.000Z');
    assert.equal(panelExpiryToLocal(new Date(PANEL_NO_END_EXPIRE_AT)), null);
  });

  it('says nothing — never "no end" — for what it cannot read', () => {
    for (const raw of ['', 'soon', null, undefined, 0, {}, new Date('invalid')]) {
      assert.equal(panelExpiryToLocal(raw), undefined, String(raw));
    }
  });
});

describe('withLocalOpenEndKept', () => {
  const DATE = new Date('2026-10-01T10:00:00.000Z');

  it('on a row with no end, drops a stated date and the EXPIRED derived from it', () => {
    assert.deepEqual(
      withLocalOpenEndKept({ expiresAt: DATE, status: SubscriptionStatus.EXPIRED, trafficLimit: 100 }, null),
      { trafficLimit: 100 },
    );
  });

  it('keeps every other status, and a stated "no end"', () => {
    assert.deepEqual(
      withLocalOpenEndKept({ expiresAt: DATE, status: SubscriptionStatus.LIMITED }, null),
      { status: SubscriptionStatus.LIMITED },
    );
    assert.deepEqual(
      withLocalOpenEndKept({ expiresAt: null, status: SubscriptionStatus.EXPIRED }, null),
      { expiresAt: null, status: SubscriptionStatus.EXPIRED },
      'no date stated: nothing to derive an EXPIRED from',
    );
    assert.deepEqual(withLocalOpenEndKept({ status: SubscriptionStatus.EXPIRED }, null), { status: SubscriptionStatus.EXPIRED });
  });

  it('changes nothing for a dated row, or one whose expiry the writer did not read', () => {
    const data = { expiresAt: DATE, status: SubscriptionStatus.EXPIRED };
    assert.deepEqual(withLocalOpenEndKept(data, new Date('2026-09-01T00:00:00.000Z')), data);
    assert.deepEqual(withLocalOpenEndKept(data, undefined), data);
  });
});
