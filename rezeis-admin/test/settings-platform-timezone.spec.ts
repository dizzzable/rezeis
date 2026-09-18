import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type ArgumentsHost, BadRequestException } from '@nestjs/common';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import {
  checkPlatformTimezone,
  describePlatformTimezoneRefusal,
  resolvePlatformTimezone,
} from '../src/modules/settings/utils/platform-timezone.util';

/**
 * «Часовой пояс» of Settings → «Платформа»: what the save lets into
 * `Settings.platformPolicy.timezone`. The `Intl` half is pure and runs here;
 * the PostgreSQL half runs against a live database in
 * `analytics-reports-postgres.spec.ts`, next to the reports that read it.
 */
describe('what «Часовой пояс» may store', () => {
  it('stores nothing for an empty value or for UTC under any of its names', () => {
    for (const value of [null, undefined, '', '   ', 'UTC', 'utc', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Zulu']) {
      assert.deepEqual(checkPlatformTimezone(value), { kind: 'unset' }, JSON.stringify(value));
    }
  });

  it('takes a proper IANA zone name, for PostgreSQL to spell', () => {
    assert.deepEqual(checkPlatformTimezone(' Europe/Moscow '), { kind: 'zone', name: 'Europe/Moscow' });
    assert.deepEqual(checkPlatformTimezone('america/argentina/buenos_aires'), { kind: 'zone', name: 'america/argentina/buenos_aires' });
  });

  it('refuses an offset, a name nobody knows, and an abbreviation or alias — naming the zone meant when there is one', () => {
    const refusal = (value: string) => {
      const check = checkPlatformTimezone(value);
      return check.kind === 'refused' ? check.refusal : check.kind;
    };
    assert.deepEqual(
      ['+03:00', '-0500', 'UTC+3', 'GMT-3'].map(refusal),
      ['OFFSET', 'OFFSET', 'OFFSET', 'OFFSET'],
    );
    assert.deepEqual(['MSK', 'Mars/Olympus_Mons', "Europe/Moscow'; DROP TABLE users; --"].map(refusal), ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
    assert.deepEqual(['CET', 'EST5EDT', 'Japan'].map(refusal), ['NOT_A_ZONE_NAME', 'NOT_A_ZONE_NAME', 'NOT_A_ZONE_NAME']);
    const cet = checkPlatformTimezone('CET');
    assert.ok(cet.kind === 'refused' && (cet.suggestion === null || cet.suggestion.includes('/')), JSON.stringify(cet));
  });

  it('stores the database’s spelling, and refuses a zone its tz data does not list', async () => {
    const spelled = (name: string | null) => ({ $queryRaw: async () => (name === null ? [] : [{ name }]) }) as never;
    assert.deepEqual(await resolvePlatformTimezone(spelled('Europe/Moscow'), 'europe/moscow'), { ok: true, timezone: 'Europe/Moscow' });
    assert.deepEqual(await resolvePlatformTimezone(spelled(null), 'Europe/Kyiv'), {
      ok: false,
      refusal: 'NOT_IN_DATABASE',
      value: 'Europe/Kyiv',
      suggestion: null,
    });
    // Never asked for a value the Intl half settles.
    const unasked = { $queryRaw: async () => assert.fail('PostgreSQL asked about a value Intl settles') } as never;
    assert.deepEqual(await resolvePlatformTimezone(unasked, 'GMT'), { ok: true, timezone: null });
    assert.equal((await resolvePlatformTimezone(unasked, '+03:00')).ok, false);
  });

  it('answers a refusal with a 400 whose message names the problem, as the operator receives it', () => {
    const captured: { statusCode?: number; body?: Record<string, unknown> } = {};
    const response = {
      status(statusCode: number) {
        captured.statusCode = statusCode;
        return response;
      },
      json(body: Record<string, unknown>) {
        captured.body = body;
        return response;
      },
    };
    const host = {
      switchToHttp: () => ({ getRequest: () => ({ originalUrl: '/api/admin/settings/platform', headers: {} }), getResponse: () => response }),
    } as unknown as ArgumentsHost;
    const sentence = describePlatformTimezoneRefusal({ ok: false, refusal: 'OFFSET', value: '+03:00', suggestion: null });
    new AdminSafeExceptionFilter().catch(new BadRequestException(sentence), host);
    assert.equal(captured.statusCode, 400);
    assert.equal(captured.body?.['message'], sentence);
    assert.match(sentence, /^PLATFORM_TIMEZONE_OFFSET: platformBranding\.timezone "\+03:00" is an offset from UTC, not a time zone/);
  });
});
