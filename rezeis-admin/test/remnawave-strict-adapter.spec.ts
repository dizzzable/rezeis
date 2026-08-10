import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { of, throwError } from 'rxjs';

import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

function fixture(rel: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'remnawave', rel), 'utf8'));
}

const CONFIG = {
  host: 'remnawave',
  port: 3000,
  token: 'secret',
  webhookSecret: null,
  caddyToken: null,
  cookie: null,
} as const;

function axiosError(status: number, headers: Record<string, string> = {}, data?: unknown) {
  return { isAxiosError: true, response: { status, headers, data }, message: `HTTP ${status}` };
}

/** Builds a service whose httpService.request resolves/rejects per call. */
function build(handler: (input: { method: string; url: string; data?: unknown }) => unknown) {
  const captured: Array<{ method: string; url: string; data?: unknown }> = [];
  const service = new RemnawaveApiService(
    {
      request: (input: { method: string; url: string; data?: unknown }) => {
        captured.push({ method: input.method, url: input.url, data: input.data });
        return handler(input);
      },
    } as never,
    CONFIG as never,
  );
  return { service, captured };
}

describe('RemnawaveApiService strict adapter (T-010)', () => {
  it('strictGetPanelUser decodes a 2.7.4 finite user and reports the version', async () => {
    const { service } = build(() => of({ data: fixture('2.7.4/user.json') }));
    const outcome = await service.strictGetPanelUser('11111111-1111-4111-8111-111111111111');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.trafficLimitBytes, 107374182400n);
    assert.equal(outcome.value.hwidDeviceLimit, 3);
    assert.equal(outcome.value.status, 'ACTIVE');
    assert.equal(outcome.value.createdAt, '2024-03-31T10:15:00.000Z');
    assert.equal(outcome.detectedVersion, '2.7.4');
  });

  it('strictGetPanelUser decodes 2.8.0 upstream zeros to canonical unlimited (null)', async () => {
    const { service } = build(() => of({ data: fixture('2.8.0/user.json') }));
    const outcome = await service.strictGetPanelUser('22222222-2222-4222-8222-222222222222');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.trafficLimitBytes, null);
    assert.equal(outcome.value.hwidDeviceLimit, null);
    assert.equal(outcome.detectedVersion, '2.8.0');
  });

  it('strictGetPanelUser accepts a schema-valid nullable hwidDeviceLimit from 2.7.4', async () => {
    const { service } = build(() => of({ data: fixture('2.7.4/nullable-user.json') }));
    const outcome = await service.strictGetPanelUser('11111111-1111-4111-8111-111111111111');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.hwidDeviceLimit, null);
  });

  it('strictGetPanelUser reads the complete writable identity projection', async () => {
    const { service } = build(() => of({ data: fixture('2.8.0/user.json') }));
    const outcome = await service.strictGetPanelUser('22222222-2222-4222-8222-222222222222');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.tag, null);
    assert.equal(outcome.value.trafficLimitStrategy, 'NO_RESET');
    assert.deepEqual(outcome.value.activeInternalSquads, []);
    assert.equal(outcome.value.externalSquadUuid, null);
  });

  it('strictGetPanelUser maps 404 to notFound', async () => {
    // Deliberately NOT envelope-guarded, unlike `strictGetPanelUserExpiry`
    // below: the only consumer of this `notFound` (the profile-sync read-back)
    // already fails closed, and softening the 404 into `unavailable` would turn
    // a terminal job into a retrying one.
    const { service } = build(() => throwError(() => axiosError(404)));
    const outcome = await service.strictGetPanelUser('missing');
    assert.equal(outcome.kind, 'notFound');
  });

  it('strictGetPanelUser maps 503 + Retry-After to unavailable with parsed backoff', async () => {
    const { service } = build(() => throwError(() => axiosError(503, { 'retry-after': '30' })));
    const outcome = await service.strictGetPanelUser('u');
    assert.equal(outcome.kind, 'unavailable');
    if (outcome.kind !== 'unavailable') return;
    assert.equal(outcome.retryAfterMs, 30000);
  });

  it('strictGetPanelUser maps a network/timeout error to unavailable', async () => {
    const { service } = build(() => throwError(() => new Error('ETIMEDOUT')));
    const outcome = await service.strictGetPanelUser('u');
    assert.equal(outcome.kind, 'unavailable');
  });

  it('strictGetPanelUser rejects a malformed 2xx payload as invalidContract', async () => {
    const { service } = build(() => of({ data: { response: { status: 'ACTIVE', trafficLimitBytes: 1, hwidDeviceLimit: 1 } } }));
    const outcome = await service.strictGetPanelUser('u');
    assert.equal(outcome.kind, 'invalidContract');
  });

  it('strictSetUserLimits PATCHes absolute limits with the numeric id in the body and null→0 encoding', async () => {
    const { service, captured } = build(() => of({ data: fixture('2.8.0/user.json') }));
    const outcome = await service.strictSetUserLimits(222, {
      trafficLimitBytes: null,
      hwidDeviceLimit: null,
    });
    assert.equal(outcome.kind, 'ok');
    const call = captured[0]!;
    assert.equal(call.method, 'patch');
    assert.equal(call.url, '/api/users');
    assert.deepEqual(call.data, {
      id: 222,
      trafficLimitBytes: 0,
      hwidDeviceLimit: 0,
    });
  });

  it('strictSetUserLimits propagates the deferred full plan identity when supplied', async () => {
    const { service, captured } = build(() => of({ data: fixture('2.8.0/user.json') }));

    const outcome = await service.strictSetUserLimits(222, {
      trafficLimitBytes: 20n * 1024n ** 3n,
      hwidDeviceLimit: 4,
      tag: 'DEFERRED_PREMIUM',
      trafficLimitStrategy: 'MONTH_ROLLING',
      activeInternalSquads: ['33333333-3333-4333-8333-333333333333'],
      externalSquadUuid: '44444444-4444-4444-8444-444444444444',
    });

    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(captured[0]!.data, {
      id: 222,
      trafficLimitBytes: 20 * 1024 ** 3,
      hwidDeviceLimit: 4,
      tag: 'DEFERRED_PREMIUM',
      trafficLimitStrategy: 'MONTH_ROLLING',
      activeInternalSquads: ['33333333-3333-4333-8333-333333333333'],
      externalSquadUuid: '44444444-4444-4444-8444-444444444444',
    });
  });

  it('strictSetUserLimits rejects non-upstream-compatible tag and squad values before HTTP', async () => {
    let httpCalls = 0;
    const { service } = build(() => {
      httpCalls += 1;
      return of({ data: fixture('2.8.0/user.json') });
    });

    const outcome = await service.strictSetUserLimits('22222222-2222-4222-8222-222222222222', {
      trafficLimitBytes: 1n,
      hwidDeviceLimit: null,
      tag: 'lowercase-not-upstream-compatible',
      activeInternalSquads: ['not-a-uuid'],
      externalSquadUuid: 'also-not-a-uuid',
    });

    assert.equal(outcome.kind, 'invalidContract');
    assert.equal(httpCalls, 0);
  });

  it('strictListUserDevices validates the 2.7.4 list (unique hwids, total==rows)', async () => {
    const { service } = build(() => of({ data: fixture('2.7.4/devices.json') }));
    const outcome = await service.strictListUserDevices('11111111-1111-4111-8111-111111111111');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.total, 2);
    assert.deepEqual(outcome.value.devices.map((d) => d.hwid), ['hwid-older', 'hwid-newer']);
  });

  it('strictListUserDevices accepts the 2.8.0 shape', async () => {
    const { service } = build(() => of({ data: fixture('2.8.0/devices.json') }));
    const outcome = await service.strictListUserDevices('22222222-2222-4222-8222-222222222222');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.total, 1);
    assert.equal(outcome.value.devices[0]!.hwid, 'hwid-2800');
  });

  it('strictListUserDevices rejects a total that disagrees with the row count', async () => {
    const { service } = build(() => of({ data: { response: { total: 5, devices: [{ hwid: 'a', createdAt: '2026-01-01T00:00:00Z' }] } } }));
    const outcome = await service.strictListUserDevices('u');
    assert.equal(outcome.kind, 'invalidContract');
  });

  it('strictListUserDevices rejects a duplicate hwid', async () => {
    const { service } = build(() => of({ data: { response: { total: 2, devices: [
      { hwid: 'dup', createdAt: '2026-01-01T00:00:00Z' },
      { hwid: 'dup', createdAt: '2026-02-01T00:00:00Z' },
    ] } } }));
    const outcome = await service.strictListUserDevices('u');
    assert.equal(outcome.kind, 'invalidContract');
  });

  it('strictListUserDevices rejects an empty hwid', async () => {
    const { service } = build(() => of({ data: { response: { total: 1, devices: [{ hwid: '', createdAt: '2026-01-01T00:00:00Z' }] } } }));
    const outcome = await service.strictListUserDevices('u');
    assert.equal(outcome.kind, 'invalidContract');
  });

  it('strictDeleteUserDevice sends a stable {userId,hwid} body and returns the remaining total', async () => {
    const { service, captured } = build(() => of({ data: { response: { total: 1 } } }));
    const outcome = await service.strictDeleteUserDevice(222, 'hwid-x');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.total, 1);
    const call = captured[0]!;
    assert.equal(call.method, 'post');
    assert.equal(call.url, '/api/hwid/devices/delete');
    assert.deepEqual(call.data, { userId: 222, hwid: 'hwid-x' });
  });

  it('strictDeleteUserDevice maps 404 to notFound (idempotent-absent)', async () => {
    // Also deliberately unguarded: a device 404 is not USER_NOT_FOUND, so
    // demanding that envelope here would stop an already-absent HWID delete
    // from being idempotent on a healthy 2.7.4/2.8.0 panel.
    const { service } = build(() => throwError(() => axiosError(404)));
    const outcome = await service.strictDeleteUserDevice('user-uuid', 'gone');
    assert.equal(outcome.kind, 'notFound');
  });
});

/**
 * `strictGetPanelUserExpiry` is the read that answers "is this profile still on
 * the panel?", and EVERY caller acts on `notFound` by destroying state: the
 * expired-profile sweep deletes the subscription outright (entitlements
 * terminated, terms closed, `status = DELETED`, panel DELETE enqueued), and the
 * three backup importers write EXPIRED over a live row.
 *
 * So the status code alone is not the signal. Remnawave answers a uuid it does
 * not have with its own USER_NOT_FOUND envelope (`A025`); a reverse proxy
 * mid-deploy answers EVERY request with a bare 404. Reading the second as the
 * first retires a whole batch of live subscriptions per sweep, for the length of
 * the outage.
 */
describe('strictGetPanelUserExpiry — only the PANEL may say a profile is gone', () => {
  const GONE_BODIES: ReadonlyArray<readonly [string, unknown]> = [
    ['the documented errorCode envelope', { errorCode: 'A025', message: 'User not found' }],
    ['a build that names the field `code`', { code: 'A025' }],
    ['an envelope with only the message', { message: 'User not found' }],
  ];

  for (const [label, data] of GONE_BODIES) {
    it(`maps a 404 carrying ${label} to notFound`, async () => {
      const { service } = build(() => throwError(() => axiosError(404, {}, data)));
      const outcome = await service.strictGetPanelUserExpiry('missing');
      assert.equal(outcome.kind, 'notFound');
    });
  }

  const PROXY_BODIES: ReadonlyArray<readonly [string, unknown]> = [
    ['an nginx HTML error page', '<html><head><title>404 Not Found</title></head></html>'],
    ['an empty body', ''],
    ['no body at all', undefined],
    ['a gateway JSON body with no panel error code', { message: '404 page not found' }],
  ];

  for (const [label, data] of PROXY_BODIES) {
    it(`maps a bare 404 (${label}) to unavailable, never notFound`, async () => {
      const { service } = build(() => throwError(() => axiosError(404, {}, data)));
      const outcome = await service.strictGetPanelUserExpiry('live-profile');
      assert.notEqual(outcome.kind, 'notFound');
      assert.equal(outcome.kind, 'unavailable');
    });
  }

  it('carries a Retry-After through the bare-404 remapping', async () => {
    const { service } = build(() =>
      throwError(() => axiosError(404, { 'retry-after': '30' }, 'gateway')),
    );
    const outcome = await service.strictGetPanelUserExpiry('u');
    assert.equal(outcome.kind, 'unavailable');
    if (outcome.kind !== 'unavailable') return;
    assert.equal(outcome.retryAfterMs, 30_000);
  });

  it('reads a healthy panel expiry unchanged', async () => {
    const { service } = build(() =>
      of({
        data: {
          response: { expireAt: '2030-01-01T00:00:00.000Z', subscriptionUrl: 'https://p/sub/1' },
          version: '2.8.0',
        },
      }),
    );
    const outcome = await service.strictGetPanelUserExpiry('u');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.expireAtMs, Date.parse('2030-01-01T00:00:00.000Z'));
    assert.equal(outcome.value.subscriptionUrl, 'https://p/sub/1');
    assert.equal(outcome.detectedVersion, '2.8.0');
  });

  it('keeps every other status on its existing class', async () => {
    for (const [status, expected] of [
      [503, 'unavailable'],
      [500, 'unavailable'],
      [429, 'unavailable'],
      [405, 'unsupported'],
      [401, 'invalidContract'],
      [400, 'invalidContract'],
    ] as const) {
      const { service } = build(() => throwError(() => axiosError(status)));
      const outcome = await service.strictGetPanelUserExpiry('u');
      assert.equal(outcome.kind, expected, `HTTP ${status} must stay ${expected}`);
    }
  });
});
