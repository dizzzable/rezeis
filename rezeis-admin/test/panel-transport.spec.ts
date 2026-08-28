import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { of, throwError } from 'rxjs';

import {
  AxiosPanelTransport,
  LegacyPanelRefusal,
  LEGACY_PANEL_REFUSAL_CODE,
} from '../src/modules/remnawave/services/panel-transport';
import type {
  PanelTransport,
  PanelTransportResult,
} from '../src/modules/remnawave/services/panel-command.executor';

/**
 * Bytes to the panel, and the one door that is now closed
 * ═══════════════════════════════════════════════════════
 * Support for Remnawave 2.x was removed by decision, not by accident, and the
 * alternative was named and rejected: letting 3.x-shaped requests go out and
 * collect `400`s at fourteen call sites, each of which the sync layer files as
 * terminal. A 2.x operator would have watched their subscriptions stop
 * converging with nothing anywhere saying why.
 *
 * So the refusal IS the feature, and these tests are what keep it honest —
 * including the two things it must NOT do, which are easier to get wrong than
 * the refusal itself.
 */

/** An axios-shaped rejection, as `isAxiosError` recognises it. */
function axiosRejection(input: {
  readonly status: number;
  readonly data?: unknown;
  readonly headers?: Record<string, unknown>;
}) {
  return Object.assign(new Error('Request failed'), {
    isAxiosError: true,
    response: { status: input.status, data: input.data ?? {}, headers: input.headers ?? {} },
  });
}

function buildTransport(answer: unknown | Error, capture?: { last?: unknown }) {
  const httpService = {
    request: (config: unknown) => {
      if (capture !== undefined) capture.last = config;
      return answer instanceof Error ? throwError(() => answer) : of({ data: answer });
    },
  };
  return new AxiosPanelTransport(httpService as never, {
    host: 'panel.example.test',
    port: 443,
    token: 'panel-token',
  });
}

describe('the panel this build no longer supports is turned away', () => {
  /** Counts whether the wrapped transport was reached at all. */
  function innerSpy(): { transport: PanelTransport; calls: number } {
    const state = { calls: 0 };
    return {
      get calls() {
        return state.calls;
      },
      transport: {
        send: async (): Promise<PanelTransportResult> => {
          state.calls += 1;
          return { kind: 'ok', data: {} };
        },
      },
    } as { transport: PanelTransport; calls: number };
  }

  it('refuses a proven 2.x panel without making the request', async () => {
    const inner = innerSpy();
    const gate = new LegacyPanelRefusal(inner.transport, async () => 2);

    const result = await gate.send({ method: 'patch', url: '/api/users/' });

    assert.equal(result.kind, 'rejected');
    assert.equal(result.kind === 'rejected' ? result.code : null, LEGACY_PANEL_REFUSAL_CODE);
    // The remedy has to be in the message. An operator who reads only this line
    // must know what to do; that is the entire reason the refusal exists
    // instead of fourteen accurate 400s.
    assert.match(result.kind === 'rejected' ? (result.detail ?? '') : '', /Обновите панель до 3\.x/);
    assert.equal(inner.calls, 0, 'nothing may be sent to a panel we refuse');
  });

  it('lets a proven 3.x panel through untouched', async () => {
    const inner = innerSpy();
    const gate = new LegacyPanelRefusal(inner.transport, async () => 3);

    const result = await gate.send({ method: 'get', url: '/api/users/4471' });

    assert.equal(result.kind, 'ok');
    assert.equal(inner.calls, 1);
  });

  it('does NOT refuse an unknown version — it proceeds', async () => {
    // The most important case in this file, and the one a careless reading of
    // "cut 2.x" gets backwards. Unknown means the version probe did not answer:
    // an unreachable panel, an expired token, a slow moment. Every healthy 3.x
    // panel passes through it. Refusing there fires exactly when the panel is
    // already struggling, and the sync layer reads "cannot act" as transient —
    // so the result is an endless retry with no alert, which is precisely the
    // failure the loud refusal was chosen to avoid.
    const inner = innerSpy();
    const gate = new LegacyPanelRefusal(inner.transport, async () => null);

    const result = await gate.send({ method: 'get', url: '/api/system/metadata' });

    assert.equal(result.kind, 'ok');
    assert.equal(inner.calls, 1);
  });

  it('refuses every 2.x minor, not just the one we tested against', async () => {
    for (const major of [0, 1, 2]) {
      const inner = innerSpy();
      const gate = new LegacyPanelRefusal(inner.transport, async () => major);
      const result = await gate.send({ method: 'get', url: '/api/users/' });
      assert.equal(result.kind, 'rejected', `major ${major}`);
      assert.equal(inner.calls, 0, `major ${major}`);
    }
  });
});

describe('the transport reports what happened, not what it hoped', () => {
  it('returns unconfigured rather than pretending to fail', async () => {
    const transport = new AxiosPanelTransport({ request: () => of({ data: {} }) } as never, {
      host: 'panel.example.test',
      port: 443,
      token: null,
    });

    const result = await transport.send({ method: 'get', url: '/api/users/' });

    // A missing token is a setting, not an outage. Callers alert on one and
    // not the other.
    assert.equal(result.kind, 'unconfigured');
  });

  it('keeps a refusal and an unreachable panel apart', async () => {
    const rejected = await buildTransport(
      axiosRejection({ status: 404, data: { errorCode: 'A025', message: 'User not found' } }),
    ).send({ method: 'get', url: '/api/users/4471' });
    assert.equal(rejected.kind, 'rejected');
    assert.equal(rejected.kind === 'rejected' ? rejected.code : null, 'A025');
    assert.equal(rejected.kind === 'rejected' ? rejected.detail : null, 'User not found');

    const offline = await buildTransport(new Error('ECONNREFUSED')).send({
      method: 'get',
      url: '/api/users/4471',
    });
    assert.equal(offline.kind, 'network');
  });

  it('reads the error code under either spelling the panel uses', async () => {
    // The panel sends both, and they drift independently — the code this
    // replaces read both for the same reason.
    for (const data of [{ errorCode: 'A063' }, { code: 'A063' }]) {
      const result = await buildTransport(axiosRejection({ status: 404, data })).send({
        method: 'get',
        url: '/api/users/x',
      });
      assert.equal(result.kind === 'rejected' ? result.code : null, 'A063', JSON.stringify(data));
    }
  });

  it('understands Retry-After as seconds and as a date', async () => {
    const seconds = await buildTransport(
      axiosRejection({ status: 429, headers: { 'retry-after': '30' } }),
    ).send({ method: 'get', url: '/api/users/' });
    assert.equal(seconds.kind === 'rejected' ? seconds.retryAfterMs : null, 30_000);

    const past = await buildTransport(
      axiosRejection({ status: 429, headers: { 'retry-after': 'Thu, 01 Jan 1970 00:00:00 GMT' } }),
    ).send({ method: 'get', url: '/api/users/' });
    // A date already gone means "now", not a negative wait a caller would use
    // as a timer and never fire.
    assert.equal(past.kind === 'rejected' ? past.retryAfterMs : null, 0);
  });

  it('appends only the query parameters that have a value', async () => {
    const capture: { last?: unknown } = {};
    await buildTransport({ response: {} }, capture).send({
      method: 'get',
      url: '/api/users/stream',
      query: { size: 500, cursor: undefined, email: 'a b@example.test' },
    });

    const url = (capture.last as { url: string }).url;
    assert.equal(url.includes('cursor'), false, 'an absent parameter must not become "undefined"');
    assert.match(url, /size=500/);
    // Encoded, not concatenated: an address with a space or an ampersand in it
    // would otherwise forge a second parameter.
    assert.match(url, /email=a%20b%40example\.test/);
  });

  it('sends no Content-Type on a bodyless call', async () => {
    // `POST .../actions/reset-traffic` declares no request body. Announcing a
    // JSON body we are not sending is how a panel decides to look for one.
    const capture: { last?: unknown } = {};
    await buildTransport({ response: {} }, capture).send({
      method: 'post',
      url: '/api/users/4471/actions/reset-traffic',
    });

    const headers = (capture.last as { headers: Record<string, unknown> }).headers;
    assert.equal('Content-Type' in headers, false);
    assert.equal(headers.Authorization, 'Bearer panel-token');
  });
});
