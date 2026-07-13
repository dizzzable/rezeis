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

function axiosError(status: number, headers: Record<string, string> = {}) {
  return { isAxiosError: true, response: { status, headers }, message: `HTTP ${status}` };
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

  it('strictGetPanelUser maps 404 to notFound', async () => {
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

  it('strictSetUserLimits PATCHes absolute limits with the uuid in the body and null→0 encoding', async () => {
    const { service, captured } = build(() => of({ data: fixture('2.8.0/user.json') }));
    const outcome = await service.strictSetUserLimits('22222222-2222-4222-8222-222222222222', {
      trafficLimitBytes: null,
      hwidDeviceLimit: null,
    });
    assert.equal(outcome.kind, 'ok');
    const call = captured[0]!;
    assert.equal(call.method, 'patch');
    assert.equal(call.url, '/api/users');
    assert.deepEqual(call.data, {
      uuid: '22222222-2222-4222-8222-222222222222',
      trafficLimitBytes: 0,
      hwidDeviceLimit: 0,
    });
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

  it('strictDeleteUserDevice sends a stable {userUuid,hwid} body and returns the remaining total', async () => {
    const { service, captured } = build(() => of({ data: { response: { total: 1 } } }));
    const outcome = await service.strictDeleteUserDevice('user-uuid', 'hwid-x');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.total, 1);
    const call = captured[0]!;
    assert.equal(call.method, 'post');
    assert.equal(call.url, '/api/hwid/devices/delete');
    assert.deepEqual(call.data, { userUuid: 'user-uuid', hwid: 'hwid-x' });
  });

  it('strictDeleteUserDevice maps 404 to notFound (idempotent-absent)', async () => {
    const { service } = build(() => throwError(() => axiosError(404)));
    const outcome = await service.strictDeleteUserDevice('user-uuid', 'gone');
    assert.equal(outcome.kind, 'notFound');
  });
});
