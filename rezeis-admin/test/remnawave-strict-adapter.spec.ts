import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { of, throwError } from 'rxjs';

import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

function fixture(rel: string): { version?: string; response: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'remnawave', rel), 'utf8'));
}

/**
 * A 3.x user row: the 3.3.2 OpenAPI-derived fixture with the fields a case is
 * about overridden. Built from the specification's row rather than written out
 * by hand, so no case here can be about a shape the panel does not send.
 */
const ROW_332 = fixture('3.3.2/user.json').response;
function userBody(over: Record<string, unknown> = {}, version = '3.3.2') {
  return { version, response: { ...ROW_332, ...over } };
}

/** A decimal identity: what a 3.x link stores. */
const ID = '4471';

const CONFIG = {
  host: 'remnawave',
  port: 3000,
  token: 'secret',
  webhookSecret: null,
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

/**
 * Drops any panel-version read (`/api/system/...`), so these assertions stay
 * about the request being made rather than about how many round-trips a path
 * happens to cost.
 */
function panelCalls(
  captured: ReadonlyArray<{ method: string; url: string; data?: unknown }>,
): Array<{ method: string; url: string; data?: unknown }> {
  return captured.filter((call) => !call.url.startsWith('/api/system/'));
}

describe('RemnawaveApiService strict adapter (T-010)', () => {
  it('strictGetPanelUser decodes a finite 3.x user and reports the version', async () => {
    const { service, captured } = build(() =>
      of({
        data: userBody({
          id: 4471,
          trafficLimitBytes: 107374182400,
          hwidDeviceLimit: 3,
          status: 'ACTIVE',
          createdAt: '2024-03-31T10:15:00.000Z',
        }),
      }),
    );
    const outcome = await service.strictGetPanelUser(ID);
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.uuid, '4471');
    assert.equal(outcome.value.panelId, 4471);
    assert.equal(outcome.value.trafficLimitBytes, 107374182400n);
    assert.equal(outcome.value.hwidDeviceLimit, 3);
    assert.equal(outcome.value.status, 'ACTIVE');
    assert.equal(outcome.value.createdAt, '2024-03-31T10:15:00.000Z');
    assert.equal(outcome.detectedVersion, '3.3.2');
    assert.deepEqual(
      panelCalls(captured).map((c) => c.url),
      ['/api/users/4471'],
    );
  });

  it('strictGetPanelUser decodes upstream zeros to canonical unlimited (null)', async () => {
    const { service } = build(() => of({ data: userBody({ id: 4471, trafficLimitBytes: 0, hwidDeviceLimit: 0 }) }));
    const outcome = await service.strictGetPanelUser(ID);
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.trafficLimitBytes, null);
    assert.equal(outcome.value.hwidDeviceLimit, null);
  });

  it('strictGetPanelUser accepts a schema-valid nullable hwidDeviceLimit', async () => {
    const { service } = build(() => of({ data: userBody({ id: 4471, hwidDeviceLimit: null }) }));
    const outcome = await service.strictGetPanelUser(ID);
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.hwidDeviceLimit, null);
  });

  it('strictGetPanelUser reads the complete writable identity projection', async () => {
    const { service } = build(() => of({ data: userBody({ id: 4471 }) }));
    const outcome = await service.strictGetPanelUser(ID);
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.tag, null);
    assert.equal(outcome.value.trafficLimitStrategy, 'NO_RESET');
    assert.deepEqual(outcome.value.activeInternalSquads, []);
    assert.equal(outcome.value.externalSquadUuid, null);
  });

  it('strictGetPanelUser refuses a row without a numeric id, whatever uuid it carries', async () => {
    const { service } = build(() =>
      of({ data: userBody({ id: null, uuid: '11111111-1111-4111-8111-111111111111' }) }),
    );
    const outcome = await service.strictGetPanelUser(ID);
    assert.equal(outcome.kind, 'invalidContract');
  });

  it('strictGetPanelUser cannot name a bare 2.x uuid: unavailable, and nothing is sent', async () => {
    // Nothing else was recorded (no numeric id, no short uuid, no name), so the
    // address chain has nowhere to go. `unavailable`, not `notFound`: the
    // profile may be perfectly alive; we just cannot say which one it is.
    const { service, captured } = build(() => of({ data: userBody() }));
    const outcome = await service.strictGetPanelUser('11111111-1111-4111-8111-111111111111');
    assert.equal(outcome.kind, 'unavailable');
    assert.deepEqual(panelCalls(captured), []);
  });

  it('strictGetPanelUser maps 404 to notFound', async () => {
    // Deliberately NOT envelope-guarded, unlike `strictGetPanelUserExpiry`
    // below: the only consumer of this `notFound` (the profile-sync read-back)
    // already fails closed, and softening the 404 into `unavailable` would turn
    // a terminal job into a retrying one.
    const { service } = build(() => throwError(() => axiosError(404)));
    const outcome = await service.strictGetPanelUser(ID);
    assert.equal(outcome.kind, 'notFound');
  });

  it('strictGetPanelUser maps 503 + Retry-After to unavailable with parsed backoff', async () => {
    const { service } = build(() => throwError(() => axiosError(503, { 'retry-after': '30' })));
    const outcome = await service.strictGetPanelUser(ID);
    assert.equal(outcome.kind, 'unavailable');
    if (outcome.kind !== 'unavailable') return;
    assert.equal(outcome.retryAfterMs, 30000);
  });

  it('strictGetPanelUser maps a network/timeout error to unavailable', async () => {
    const { service } = build(() => throwError(() => new Error('ETIMEDOUT')));
    const outcome = await service.strictGetPanelUser(ID);
    assert.equal(outcome.kind, 'unavailable');
  });

  it('strictGetPanelUser rejects a malformed 2xx payload as invalidContract', async () => {
    const { service } = build(() => of({ data: { response: { status: 'ACTIVE', trafficLimitBytes: 1, hwidDeviceLimit: 1 } } }));
    const outcome = await service.strictGetPanelUser(ID);
    assert.equal(outcome.kind, 'invalidContract');
  });

  it('strictSetUserLimits PATCHes absolute limits with the numeric id in the body and null→0 encoding', async () => {
    const { service, captured } = build(() => of({ data: userBody({ id: 4471 }) }));
    const outcome = await service.strictSetUserLimits(ID, {
      trafficLimitBytes: null,
      hwidDeviceLimit: null,
    });
    assert.equal(outcome.kind, 'ok');
    const call = panelCalls(captured)[0]!;
    assert.equal(call.method, 'patch');
    assert.equal(call.url, '/api/users');
    assert.deepEqual(call.data, {
      id: 4471,
      trafficLimitBytes: 0,
      hwidDeviceLimit: 0,
    });
  });

  it('strictSetUserLimits propagates the deferred full plan identity when supplied', async () => {
    const { service, captured } = build(() => of({ data: userBody({ id: 4471 }) }));

    const outcome = await service.strictSetUserLimits(ID, {
      trafficLimitBytes: 20n * 1024n ** 3n,
      hwidDeviceLimit: 4,
      tag: 'DEFERRED_PREMIUM',
      trafficLimitStrategy: 'MONTH_ROLLING',
      activeInternalSquads: ['33333333-3333-4333-8333-333333333333'],
      externalSquadUuid: '44444444-4444-4444-8444-444444444444',
    });

    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(panelCalls(captured)[0]!.data, {
      id: 4471,
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
      return of({ data: userBody({ id: 4471 }) });
    });

    const outcome = await service.strictSetUserLimits(ID, {
      trafficLimitBytes: 1n,
      hwidDeviceLimit: null,
      tag: 'lowercase-not-upstream-compatible',
      activeInternalSquads: ['not-a-uuid'],
      externalSquadUuid: 'also-not-a-uuid',
    });

    assert.equal(outcome.kind, 'invalidContract');
    assert.equal(httpCalls, 0);
  });

  it('strictListUserDevices validates the 3.x list (unique hwids, total==rows)', async () => {
    const { service, captured } = build(() => of({ data: fixture('3.2.1/devices.json') }));
    const outcome = await service.strictListUserDevices('2');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.total, 2);
    assert.deepEqual(outcome.value.devices.map((d) => d.hwid), ['hwid-321-older', 'hwid-321-newer']);
    // Last activity is read off `updatedAt`, which is what 3.x names it.
    assert.equal(outcome.value.devices[0]!.lastSeenAt, '2026-08-10T13:01:17.530Z');
    assert.deepEqual(
      panelCalls(captured).map((c) => c.url),
      ['/api/hwid/devices/2'],
    );
  });

  it('strictListUserDevices rejects a total that disagrees with the row count', async () => {
    const { service } = build(() => of({ data: { response: { total: 5, devices: [{ hwid: 'a', createdAt: '2026-01-01T00:00:00Z' }] } } }));
    const outcome = await service.strictListUserDevices(ID);
    assert.equal(outcome.kind, 'invalidContract');
  });

  it('strictListUserDevices rejects a duplicate hwid', async () => {
    const { service } = build(() => of({ data: { response: { total: 2, devices: [
      { hwid: 'dup', createdAt: '2026-01-01T00:00:00Z' },
      { hwid: 'dup', createdAt: '2026-02-01T00:00:00Z' },
    ] } } }));
    const outcome = await service.strictListUserDevices(ID);
    assert.equal(outcome.kind, 'invalidContract');
  });

  it('strictListUserDevices rejects an empty hwid', async () => {
    const { service } = build(() => of({ data: { response: { total: 1, devices: [{ hwid: '', createdAt: '2026-01-01T00:00:00Z' }] } } }));
    const outcome = await service.strictListUserDevices(ID);
    assert.equal(outcome.kind, 'invalidContract');
  });

  it('strictDeleteUserDevice sends a stable {userId,hwid} body and returns the remaining total', async () => {
    const { service, captured } = build(() => of({ data: { response: { total: 1 } } }));
    const outcome = await service.strictDeleteUserDevice(ID, 'hwid-x');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.total, 1);
    const call = captured.find((c) => c.url === '/api/hwid/devices/delete');
    assert.ok(call !== undefined, 'the delete request was never issued');
    assert.equal(call.method, 'post');
    assert.deepEqual(call.data, { userId: 4471, hwid: 'hwid-x' });
  });

  it('strictDeleteUserDevice takes no version reading: the owner key follows the id alone', async () => {
    // It used to take the caller's "era" and build the key from it. There is
    // one key now — the number — so there is nothing for a reading to decide,
    // and none is taken.
    const { service, captured } = build(() => of({ data: { response: { total: 0 } } }));

    const outcome = await service.strictDeleteUserDevice('4711', 'hwid-x');

    assert.equal(outcome.kind, 'ok');
    const call = captured.find((c) => c.url === '/api/hwid/devices/delete');
    assert.deepEqual(call?.data, { userId: 4711, hwid: 'hwid-x' }, 'the 3.x owner key');
    assert.deepEqual(
      captured.filter((c) => c.url.startsWith('/api/system/')),
      [],
      'and NOT ONE version probe',
    );
  });

  it('strictDeleteUserDevice refuses a stored 2.x uuid before anything is sent', async () => {
    // The fallback chain could resolve such a row to whatever profile is live
    // at its recorded name — and unbind a device from somebody else.
    const { service, captured } = build(() => of({ data: { response: { total: 0 } } }));

    const outcome = await service.strictDeleteUserDevice(
      { remnawaveId: '11111111-1111-4111-8111-111111111111', panelId: 4711, panelUsername: 'rz_a' },
      'hwid-x',
    );

    assert.equal(outcome.kind, 'invalidContract');
    assert.deepEqual(captured, []);
  });

  it('strictListUserDevices addresses the read by the id and takes no version reading', async () => {
    const { service, captured } = build(() =>
      of({ data: { response: { total: 0, devices: [] } } }),
    );

    const outcome = await service.strictListUserDevices('4711');

    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(
      captured.map((c) => c.url),
      ['/api/hwid/devices/4711'],
      'the id addressed the path and no probe was taken',
    );
  });

  it('strictDeleteUserDevice maps 404 to notFound (idempotent-absent)', async () => {
    // Also deliberately unguarded: a device 404 is not USER_NOT_FOUND, so
    // demanding that envelope here would stop an already-absent HWID delete
    // from being idempotent on a healthy panel.
    const { service } = build(() => throwError(() => axiosError(404)));
    const outcome = await service.strictDeleteUserDevice(ID, 'gone');
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
 * So the status code alone is not the signal. Remnawave answers an id it does
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
      const outcome = await service.strictGetPanelUserExpiry(ID);
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
      const outcome = await service.strictGetPanelUserExpiry(ID);
      assert.notEqual(outcome.kind, 'notFound');
      assert.equal(outcome.kind, 'unavailable');
    });
  }

  it('carries a Retry-After through the bare-404 remapping', async () => {
    const { service } = build(() =>
      throwError(() => axiosError(404, { 'retry-after': '30' }, 'gateway')),
    );
    const outcome = await service.strictGetPanelUserExpiry(ID);
    assert.equal(outcome.kind, 'unavailable');
    if (outcome.kind !== 'unavailable') return;
    assert.equal(outcome.retryAfterMs, 30_000);
  });

  it('reads a healthy panel expiry unchanged', async () => {
    const { service } = build(() =>
      of({
        data: {
          response: { expireAt: '2030-01-01T00:00:00.000Z', subscriptionUrl: 'https://p/sub/1' },
          version: '3.3.2',
        },
      }),
    );
    const outcome = await service.strictGetPanelUserExpiry(ID);
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.expireAtMs, Date.parse('2030-01-01T00:00:00.000Z'));
    assert.equal(outcome.value.subscriptionUrl, 'https://p/sub/1');
    assert.equal(outcome.detectedVersion, '3.3.2');
  });

  it('an identity it cannot name is unavailable — never notFound', async () => {
    // The sweep deletes on `notFound`. A stored 2.x uuid with nothing else
    // recorded names nobody we can ask about, which is not the same as gone.
    const { service, captured } = build(() => throwError(() => axiosError(404, {}, { errorCode: 'A025' })));
    const outcome = await service.strictGetPanelUserExpiry('11111111-1111-4111-8111-111111111111');
    assert.equal(outcome.kind, 'unavailable');
    assert.deepEqual(panelCalls(captured), []);
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
      const outcome = await service.strictGetPanelUserExpiry(ID);
      assert.equal(outcome.kind, expected, `HTTP ${status} must stay ${expected}`);
    }
  });
});
