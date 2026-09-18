import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { of, throwError, type Observable } from 'rxjs';

import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

/**
 * The two panel reads the metrics collector builds the online card on, through
 * the real `RemnawaveApiService` with only the HTTP transport replaced.
 *
 * NODE LIST. `getAllNodes()` answers `[]` for every failure, and the collector
 * stored that `[]` — so an outage of `/api/nodes` (or a fleet whose list outgrew
 * the 1 MiB response cap, permanently) read on the dashboard as "no enabled
 * nodes". `readAllNodes()` keeps the failure a `null`. `getAllNodes()` must keep
 * answering exactly as before: several other callers are built on its `[]`.
 *
 * SYSTEM STATS. A 2xx body without the online counts — a proxy's `{}`, an HTML
 * page served as 200 — was normalised into zeros: a green «Сейчас 0» on the card
 * for two minutes, and a stored sample of nobody online. It is a failure now.
 */

const CONFIG = { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null };

/** A panel that answers every GET with `body` (or fails), recording the paths it was asked for. */
function panel(answer: () => Observable<{ data: unknown }>) {
  const paths: string[] = [];
  const service = new RemnawaveApiService(
    {
      request: (input: { readonly url: string }) => {
        paths.push(input.url);
        return answer();
      },
    } as never,
    CONFIG,
  );
  return { service, paths };
}

const answering = (data: unknown) => () => of({ data });
const failing = (error: unknown) => () => throwError(() => error);

const NODE = {
  uuid: '11111111-1111-4111-8111-111111111111',
  name: 'Frankfurt',
  address: '203.0.113.7',
  isConnected: true,
  isDisabled: false,
  usersOnline: 42,
  countryCode: 'DE',
};

describe('the node list for the online card', () => {
  it('reads the bare 3.x array and the older `{ total, nodes }` wrapper alike', async () => {
    const bare = panel(answering({ response: [NODE] }));
    const wrapped = panel(answering({ response: { total: 1, nodes: [NODE] } }));

    for (const { service, paths } of [bare, wrapped]) {
      const nodes = await service.readAllNodes();
      assert.deepStrictEqual(
        nodes?.map((node) => [node.uuid, node.usersOnline, node.countryCode]),
        [[NODE.uuid, 42, 'DE']],
      );
      assert.deepStrictEqual(paths, ['/api/nodes']);
    }
  });

  it('answers `[]` only for a panel that answered with no nodes', async () => {
    assert.deepStrictEqual(await panel(answering({ response: [] })).service.readAllNodes(), []);
    assert.deepStrictEqual(await panel(answering({ response: { total: 0, nodes: [] } })).service.readAllNodes(), []);
  });

  it('answers `null` — never `[]` — when the list could not be read', async () => {
    const cases: ReadonlyArray<readonly [string, () => Observable<{ data: unknown }>]> = [
      ['an unreachable panel', failing(new Error('connect ECONNREFUSED'))],
      // What axios raises for a body over `maxContentLength` (1 MiB here): a big
      // fleet's list fails like this on every read, for as long as it is big.
      ['a list over the response cap', failing({ isAxiosError: true, message: 'maxContentLength size of 1048576 exceeded' })],
      ['a 2xx body of no known shape', answering({ response: { total: 3 } })],
      ['an HTML page served as 200', answering('<!doctype html><title>Bad gateway</title>')],
    ];
    for (const [label, answer] of cases) {
      assert.equal(await panel(answer).service.readAllNodes(), null, label);
    }
  });

  it('leaves `getAllNodes()` answering exactly as before, for the callers built on it', async () => {
    assert.deepStrictEqual(await panel(failing(new Error('connect ECONNREFUSED'))).service.getAllNodes(), []);
    assert.deepStrictEqual(await panel(answering({ response: { total: 3 } })).service.getAllNodes(), []);
    assert.deepStrictEqual(await panel(answering({ response: [] })).service.getAllNodes(), []);
    assert.deepStrictEqual(
      (await panel(answering({ response: { total: 1, nodes: [NODE] } })).service.getAllNodes()).map((node) => node.name),
      ['Frankfurt'],
    );
  });
});

describe('Remnawave stats for the online card', () => {
  const MODERN = {
    users: { totalUsers: 76, statusCounts: { ACTIVE: 74 } },
    onlineStats: { onlineNow: 21, lastDay: 61, lastWeek: 69, neverOnline: 0 },
    nodes: { totalOnline: 19, totalBytesLifetime: '14916994270769' },
    cpu: { cores: 2 },
    memory: { total: 4, free: 2, used: 2 },
    uptime: 1,
    timestamp: 1,
  };

  it('reads a real answer', async () => {
    const stats = await panel(answering({ response: MODERN })).service.getSystemStats();
    assert.deepStrictEqual(stats?.users.onlineStats, { onlineNow: 21, lastDay: 61, lastWeek: 69, neverOnline: 0 });
  });

  it('treats a 2xx answer without the online counts as no answer — not as «0 online»', async () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['an empty object', { response: {} }],
      ['an HTML page', '<!doctype html><title>Bad gateway</title>'],
      ['another service’s JSON', { status: 'ok', uptime: 12 }],
      ['online counts that are not numbers', { response: { ...MODERN, onlineStats: { onlineNow: 'n/a', lastDay: 1, lastWeek: 2 } } }],
      ['the unique counts missing', { response: { ...MODERN, onlineStats: { onlineNow: 21 } } }],
    ];
    for (const [label, body] of cases) {
      assert.equal(await panel(answering(body)).service.getSystemStats(), null, label);
    }
  });
});
