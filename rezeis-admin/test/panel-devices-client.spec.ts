import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import * as contractPanel321 from '@remnawave/contract-panel-3.2.1';
import * as contractPanel323 from '@remnawave/contract-panel-3.2.3';
import * as contractPanel33 from '@remnawave/contract-panel-3.3';
import * as contractPanel343 from '@remnawave/contract-panel-3.4.3';
import * as contractPanel344 from '@remnawave/contract-panel-3.4.4';

import {
  PanelCommandExecutor,
  type PanelTransport,
  type PanelTransportResult,
} from '../src/modules/remnawave/services/panel-command.executor';
import { PANEL_COMMANDS } from '../src/modules/remnawave/services/panel-commands';
import {
  PanelDevicesClient,
  type PanelDropConnectionsBody,
} from '../src/modules/remnawave/services/panel-devices.client';

/**
 * The devices client, over the real executor and the real command table
 * ═════════════════════════════════════════════════════════════════════
 * The cases that matter here are not happy paths:
 *
 *   • a poll that runs out of budget answers `null` and NEVER `[]`. The
 *     concurrent-IP sharing detector reads `[]` as "this node was read and
 *     nobody was on it" and accuses subscribers on that basis, so flattening
 *     the two reports a busy node as clean — silently, and hardest on the big
 *     nodes, which are both the slowest to answer and the ones sharers use.
 *   • a read that succeeded and found nothing answers `[]`, so the distinction
 *     above carries information in both directions.
 *   • an answer whose list is missing is `unreadable`, on EVERY answer — no
 *     schema runs in front of this client any more, so its own guards are the
 *     whole guarantee.
 *   • a drop-connections body we built wrong never leaves the process. The 2.x
 *     spelling (`userUuids`) is a guaranteed 400 on every 3.x panel, and a 400
 *     on the enforcement path is filed as terminal.
 *
 * The per-user device list and both device deletes were never reached from
 * `src/` and were deleted with the tests that were their only callers.
 */
Logger.overrideLogger(false);

const NODE_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_NODE_UUID = '22222222-2222-4222-8222-222222222222';

/**
 * Answers the client from a queue and records every request.
 *
 * The LAST answer repeats, so a poll loop can be fed one "still running" reply
 * and asked to exhaust its budget against it.
 */
function stubTransport(answers: readonly PanelTransportResult[]): {
  transport: PanelTransport;
  calls: Array<{
    method: string;
    url: string;
    body?: unknown;
    query?: Readonly<Record<string, string | number | undefined>>;
  }>;
} {
  const queue = [...answers];
  const calls: Array<{
    method: string;
    url: string;
    body?: unknown;
    query?: Readonly<Record<string, string | number | undefined>>;
  }> = [];
  return {
    calls,
    transport: {
      send: async (input) => {
        calls.push({
          method: input.method,
          url: input.url,
          body: input.body,
          query: input.query,
        });
        const answer = queue.length > 1 ? queue.shift() : queue[0];
        assert.ok(answer !== undefined, 'stub transport ran out of answers');
        return answer;
      },
    },
  };
}

function ok(data: unknown): PanelTransportResult {
  return { kind: 'ok', data };
}

function clientOver(answers: readonly PanelTransportResult[]): {
  client: PanelDevicesClient;
  calls: ReturnType<typeof stubTransport>['calls'];
} {
  const { transport, calls } = stubTransport(answers);
  return { client: new PanelDevicesClient(new PanelCommandExecutor(transport)), calls };
}

/** A by-node job result carrying the given users. */
function nodeJobResult(users: ReadonlyArray<unknown>): unknown {
  return {
    response: {
      isCompleted: true,
      isFailed: false,
      result: { success: true, nodeUuid: NODE_UUID, users },
    },
  };
}

describe('device stats ask once', () => {
  it('does not chase /api/hwid/stats after the real path fails', async () => {
    const { client, calls } = clientOver([
      { kind: 'rejected', status: 401, code: 'A001', detail: 'Unauthorized', retryAfterMs: null },
    ]);

    const outcome = await client.getDeviceStats();

    // One request. The old version fell through to `/api/hwid/stats` in a bare
    // `catch { continue }` — a route no 3.x panel serves — so a real failure on
    // the first path was answered by a second that could only 404, and the pair
    // returned `null` as though the panel had never been asked.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, '/api/hwid/devices/stats');
    // And the reason survives instead of being flattened into "no stats".
    assert.equal(outcome.kind, 'rejected');
  });

  it('projects byPlatform to the declared keys, because its caller copies it whole into an alert', async () => {
    const { client } = clientOver([
      ok({
        response: {
          byPlatform: [
            {
              platform: 'iOS',
              count: 3,
              undeclaredRowKey: 'must not leave the process',
              byApp: [{ app: 'Happ', count: 3, undeclaredAppKey: true }],
            },
          ],
          stats: { totalUniqueDevices: 3, totalHwidDevices: 3, averageHwidDevicesPerUser: 1.5 },
        },
      }),
    ]);

    const outcome = await client.getDeviceStats();

    assert.equal(outcome.kind, 'ok');
    // Exactly what the vendor parse used to hand the detector — keys and order.
    assert.equal(
      JSON.stringify(outcome.kind === 'ok' ? outcome.data.byPlatform : null),
      '[{"platform":"iOS","count":3,"byApp":[{"app":"Happ","count":3}]}]',
    );
    assert.equal(outcome.kind === 'ok' ? outcome.data.stats.averageHwidDevicesPerUser : null, 1.5);
  });

  it('refuses a stats answer with no response object instead of guessing', async () => {
    const { client } = clientOver([ok('<html>502</html>')]);
    assert.equal((await client.getDeviceStats()).kind, 'unreadable');
  });
});

describe('top users are walked, not sampled', () => {
  it('sends the page size the panel caps at 100 rather than taking the default 5', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      username: `rz_sub_${index + 1}`,
      devicesCount: 9,
    }));
    const secondPage = Array.from({ length: 20 }, (_, index) => ({
      id: index + 101,
      username: `rz_sub_${index + 101}`,
      devicesCount: 3,
    }));
    const { client, calls } = clientOver([
      ok({ response: { users: firstPage, total: 120 } }),
      ok({ response: { users: secondPage, total: 120 } }),
    ]);

    const outcome = await client.listTopUsersByDeviceCount();

    // Omitting `size` never meant "everything": the panel defaults it to 5, so
    // the device-overage detector was judging a five-row sample and calling
    // every other subscriber clean.
    assert.deepStrictEqual(calls[0]?.query, { start: 0, size: 100 });
    assert.deepStrictEqual(calls[1]?.query, { start: 100, size: 100 });
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.kind === 'ok' ? outcome.data.users.length : null, 120);
    assert.equal(outcome.kind === 'ok' ? outcome.data.complete : null, true);
  });

  it('says so when the row budget stops a walk the panel could have continued', async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      username: `rz_sub_${index + 1}`,
      devicesCount: 9,
    }));
    const { client } = clientOver([ok({ response: { users: page, total: 500 } })]);

    const outcome = await client.listTopUsersByDeviceCount(100);

    // A silently truncated list reads exactly like a clean panel.
    assert.equal(outcome.kind === 'ok' ? outcome.data.complete : null, false);
    assert.equal(outcome.kind === 'ok' ? outcome.data.total : null, 500);
  });

  it('returns a failed page as the failure, not as an empty list', async () => {
    const { client } = clientOver([{ kind: 'network', detail: 'ECONNRESET' }]);

    const outcome = await client.listTopUsersByDeviceCount();

    // `[]` in the overage detector means "nobody is over their limit" — the
    // same value a healthy panel produces.
    assert.equal(outcome.kind, 'network');
  });

  it('reports a page whose users list is missing as unreadable, not as a thrown walk', async () => {
    // With a schema in front, this body would have been flagged before the
    // walk touched it; without one, the walk's own guard is what stands
    // between it and `push(...undefined)`.
    const { client } = clientOver([ok({ response: { total: 12 } })]);

    const outcome = await client.listTopUsersByDeviceCount();

    assert.equal(outcome.kind, 'unreadable');
  });
});

describe('the whole device inventory is walked', () => {
  /** `count` rows starting at `from`, each bound to its own owner. */
  const inventoryPage = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      hwid: `hwid-${from + index}`,
      userId: from + index,
      platform: 'ios',
      osVersion: '18.0',
      deviceModel: 'iPhone15,2',
      userAgent: null,
      requestIp: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }));

  it('pages at the panel ceiling rather than taking the default 25', async () => {
    // The panel defaults `size` to 25. Omitting it would walk a fleet 25 rows
    // at a time — and the caller is looking for one hwid bound to two owners,
    // which is only visible when BOTH of its rows are in hand.
    const { client, calls } = clientOver([
      ok({ response: { devices: inventoryPage(1, 1000), total: 1500 } }),
      ok({ response: { devices: inventoryPage(1001, 500), total: 1500 } }),
    ]);

    const outcome = await client.listAllDevices();

    assert.deepStrictEqual(calls[0]?.query, { start: 0, size: 1000 });
    assert.deepStrictEqual(calls[1]?.query, { start: 1000, size: 1000 });
    assert.equal(calls[0]?.url, '/api/hwid/devices');
    assert.equal(outcome.kind === 'ok' ? outcome.data.devices.length : null, 1500);
    assert.equal(outcome.kind === 'ok' ? outcome.data.complete : null, true);
  });

  it('sends no filters, because the panel says they cost its own database', async () => {
    const { client, calls } = clientOver([ok({ response: { devices: [], total: 0 } })]);

    await client.listAllDevices();

    assert.deepStrictEqual(Object.keys(calls[0]?.query ?? {}).sort(), ['size', 'start']);
  });

  it('projects each row to the nine declared keys, so an undeclared lastSeenAt never reaches the export', async () => {
    // The export reads `lastSeenAt ?? updatedAt`, and no 3.x release declares
    // `lastSeenAt`. The vendor parse stripped it from every healthy answer, so
    // the export column has always come from `updatedAt`.
    const row = { ...inventoryPage(1, 1)[0], lastSeenAt: '2030-01-01T00:00:00.000Z', extra: 1 };
    const { client } = clientOver([ok({ response: { devices: [row], total: 1 } })]);

    const outcome = await client.listAllDevices();

    const device = outcome.kind === 'ok' ? outcome.data.devices[0] : null;
    assert.deepStrictEqual(Object.keys(device ?? {}), [
      'hwid',
      'userId',
      'platform',
      'osVersion',
      'deviceModel',
      'userAgent',
      'requestIp',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('says so when the row budget stops a walk the panel could have continued', async () => {
    const { client } = clientOver([
      ok({ response: { devices: inventoryPage(1, 1000), total: 90_000 } }),
    ]);

    const outcome = await client.listAllDevices(1000);

    // A silently truncated inventory reads exactly like a panel on which no
    // device is shared.
    assert.equal(outcome.kind === 'ok' ? outcome.data.complete : null, false);
    assert.equal(outcome.kind === 'ok' ? outcome.data.total : null, 90_000);
  });

  it('returns a failed page as the failure, not as the rows gathered so far', async () => {
    const { client } = clientOver([{ kind: 'network', detail: 'ECONNRESET' }]);

    const outcome = await client.listAllDevices();

    assert.equal(outcome.kind, 'network');
  });

  it('does not call a walk complete on a row count it never read', async () => {
    // `total` starts at 0 and is only assigned when the field is a number, so a
    // panel that renamed or dropped it left the counter at zero — and the very
    // first full page then satisfied "we hold at least as many as the panel
    // reports". The walk returned one page of a fifteen-thousand-row fleet
    // flagged complete, at full confidence, with nothing logged.
    const page = inventoryPage(1, 1000);
    const { client, calls } = clientOver([ok({ response: { devices: page } })]);

    const outcome = await client.listAllDevices();

    assert.equal(outcome.kind === 'ok' ? outcome.data.complete : null, false);
    // And it kept walking rather than stopping on the invented count.
    assert.ok(calls.length > 1);
  });

  it('reports an inventory whose device list is missing as unreadable, not empty', async () => {
    // `[]` here would mean "no device is bound to two accounts".
    const { client } = clientOver([ok({ response: { total: 4 } })]);

    const outcome = await client.listAllDevices();

    assert.equal(outcome.kind, 'unreadable');
  });
});

describe('a connections job that could not be read is never reported as empty', () => {
  it('answers null when the attempt budget runs out', async () => {
    const { client, calls } = clientOver([
      ok({ response: { jobId: 'job-1' } }),
      ok({ response: { isCompleted: false, isFailed: false, result: null } }),
    ]);

    const rows = await client.fetchNodeConnections(NODE_UUID, { attempts: 3, intervalMs: 0 });

    // THE test. `[]` here is the sharing detector's word for "read it, nobody
    // was on it"; a node the panel never finished collecting must not borrow it.
    assert.equal(rows, null);
    assert.notDeepStrictEqual(rows, []);
    // One start plus the whole budget: the poll really did run out rather than
    // giving up on the first look.
    assert.equal(calls.length, 4);
  });

  it('answers [] when the node was read and nobody was online', async () => {
    const { client } = clientOver([ok({ response: { jobId: 'job-1' } }), ok(nodeJobResult([]))]);

    const rows = await client.fetchNodeConnections(NODE_UUID, { attempts: 3, intervalMs: 0 });

    assert.deepStrictEqual(rows, []);
    assert.notEqual(rows, null);
  });

  it('answers null when the panel reports the job as failed', async () => {
    const { client } = clientOver([
      ok({ response: { jobId: 'job-1' } }),
      ok({ response: { isCompleted: false, isFailed: true, result: null } }),
    ]);

    assert.equal(await client.fetchNodeConnections(NODE_UUID, { attempts: 2, intervalMs: 0 }), null);
  });

  it('answers null when the job completes carrying no result', async () => {
    const { client } = clientOver([
      ok({ response: { jobId: 'job-1' } }),
      ok({ response: { isCompleted: true, isFailed: false, result: null } }),
    ]);

    // The leak in the hand-rolled version: it guarded `result.success === false`
    // but let `result: null` fall through to an extractor that answered `[]`
    // for a missing list.
    assert.equal(await client.fetchNodeConnections(NODE_UUID, { attempts: 2, intervalMs: 0 }), null);
  });

  it('answers null when the collection ran and reported success: false', async () => {
    const { client } = clientOver([
      ok({ response: { jobId: 'job-1' } }),
      ok({
        response: {
          isCompleted: true,
          isFailed: false,
          result: { success: false, nodeUuid: NODE_UUID, users: [] },
        },
      }),
    ]);

    assert.equal(await client.fetchNodeConnections(NODE_UUID, { attempts: 2, intervalMs: 0 }), null);
  });

  it('answers null when the start request never produced a job', async () => {
    const { client } = clientOver([
      { kind: 'rejected', status: 404, code: null, detail: 'Not found', retryAfterMs: null },
    ]);

    assert.equal(await client.fetchNodeConnections(NODE_UUID, { attempts: 2, intervalMs: 0 }), null);
  });

  it('answers null when the start answer carries no job id it can poll', async () => {
    // A job id that is not a string is refused by the result route's own
    // params rule before a poll is ever sent.
    const { client, calls } = clientOver([ok({ response: { jobId: 7 } })]);

    assert.equal(await client.fetchNodeConnections(NODE_UUID, { attempts: 2, intervalMs: 0 }), null);
    assert.equal(calls.length, 1);
  });

  it('decodes a well-formed lastSeen into the Date its readers render', async () => {
    const { client } = clientOver([
      ok({ response: { jobId: 'job-1' } }),
      ok(
        nodeJobResult([
          {
            userId: 4471,
            ips: [
              { ip: '203.0.113.7', lastSeen: '2026-08-28T10:00:00Z' },
              { ip: '203.0.113.8', lastSeen: 'yesterday-ish' },
            ],
          },
        ]),
      ),
    ]);

    const rows = await client.fetchNodeConnections(NODE_UUID, { attempts: 2, intervalMs: 0 });

    assert.equal(rows?.length, 1);
    assert.equal(rows?.[0]?.userId, 4471);
    const [good, bad] = rows?.[0]?.ips ?? [];
    // The same `new Date(value)` the vendor parse produced: the sharing
    // detector persists `toISOString()` of it in signal metadata.
    assert.ok(good?.lastSeen instanceof Date);
    assert.equal((good?.lastSeen as Date).toISOString(), '2026-08-28T10:00:00.000Z');
    // Anything else is handed on as sent, for the detector's "undated" count.
    assert.equal(bad?.lastSeen, 'yesterday-ish');
  });
});

describe('connections routes come from the table and only from /api/connections', () => {
  it('starts and polls the by-node job on the panel’s paths', async () => {
    const { client, calls } = clientOver([
      ok({ response: { jobId: 'job-7' } }),
      ok(nodeJobResult([])),
    ]);

    await client.fetchNodeConnections(OTHER_NODE_UUID, { attempts: 2, intervalMs: 0 });

    assert.equal(calls[0]?.method, 'post');
    assert.equal(calls[0]?.url, `/api/connections/by-node/${OTHER_NODE_UUID}`);
    assert.deepStrictEqual(calls[0]?.body, {});
    assert.equal(calls[1]?.method, 'get');
    assert.equal(calls[1]?.url, '/api/connections/by-node/job-7');
    // The 2.x family is gone from every 3.x panel; nothing here may reach for it.
    assert.equal(
      calls.some((call) => call.url.includes('ip-control')),
      false,
    );
  });

  it('starts and polls the by-user job, keeping the user id and the job id apart', async () => {
    const { client, calls } = clientOver([
      ok({ response: { jobId: 'job-9' } }),
      ok({
        response: {
          isCompleted: true,
          isFailed: false,
          progress: { total: 1, completed: 1, percent: 100 },
          result: { success: true, userId: 4471, nodes: [] },
        },
      }),
    ]);

    const rows = await client.fetchUserConnections(4471, { attempts: 2, intervalMs: 0 });

    // Both routes build `/api/connections/by-user/{…}`: the POST takes a USER id
    // and the GET takes a JOB id, so swapping them produces a well-formed URL
    // and a nonsense request.
    assert.equal(calls[0]?.url, '/api/connections/by-user/4471');
    assert.equal(calls[1]?.url, '/api/connections/by-user/job-9');
    assert.deepStrictEqual(rows, []);
  });

  it('refuses a node id that is not the uuid the panel requires', async () => {
    const { client, calls } = clientOver([ok({ response: { jobId: 'job-1' } })]);

    const rows = await client.fetchNodeConnections('node-3', { attempts: 2, intervalMs: 0 });

    assert.equal(rows, null);
    assert.deepStrictEqual(calls, []);
  });

  it('refuses to invent an empty node out of a body it cannot read', async () => {
    // `users` is not there at all.
    const { client } = clientOver([
      ok({ response: { jobId: 'job-1' } }),
      ok({ response: { isCompleted: true, isFailed: false, result: { success: true } } }),
    ]);

    assert.equal(await client.fetchNodeConnections(NODE_UUID, { attempts: 2, intervalMs: 0 }), null);
  });
});

describe('the explicit decoders reproduce what each era’s contract parse produced', () => {
  // The consumer audit found three device reads whose callers depended on the
  // vendor parse. These hold the replacement to the parse itself, per era: on
  // a body the contract accepts, the client must hand over the same values.
  const ERAS = [
    ['3.2.0', contractPanel321],
    ['3.2.3', contractPanel323],
    ['3.4.2', contractPanel33],
    ['3.4.13', contractPanel343],
    ['3.4.15', contractPanel344],
  ] as const;

  interface Parsed {
    success: boolean;
    data?: { response: Record<string, unknown> };
  }
  function vendorParse(contract: unknown, command: string, body: unknown): Parsed {
    const schema = (contract as Record<string, { ResponseSchema: { safeParse(v: unknown): Parsed } }>)[
      command
    ]?.ResponseSchema;
    assert.ok(schema !== undefined, `${command} has no ResponseSchema`);
    return schema.safeParse(body);
  }

  it('byPlatform: the same keys in the same order', async () => {
    const body = {
      response: {
        byPlatform: [
          { platform: 'iOS', count: 3, extra: 'x', byApp: [{ app: 'Happ', count: 2, extra: 1 }, { app: 'v2', count: 1 }] },
          { platform: 'Android', count: 1, byApp: [] },
        ],
        stats: { totalUniqueDevices: 4, totalHwidDevices: 4, averageHwidDevicesPerUser: 2 },
      },
    };
    const { client } = clientOver([ok(JSON.parse(JSON.stringify(body)))]);
    const outcome = await client.getDeviceStats();
    const ours = JSON.stringify(outcome.kind === 'ok' ? outcome.data.byPlatform : null);
    for (const [version, contract] of ERAS) {
      const parsed = vendorParse(contract, 'GetHwidDevicesStatsCommand', body);
      assert.equal(parsed.success, true, `contract ${version} refuses the stats body`);
      assert.equal(ours, JSON.stringify(parsed.data?.response['byPlatform']), `contract ${version}`);
    }
  });

  it('device rows: the same keys in the same order', async () => {
    const row = {
      hwid: 'HWID-A',
      userId: 4471,
      platform: 'iOS',
      osVersion: '18.2',
      deviceModel: 'iPhone',
      userAgent: 'Happ',
      requestIp: '203.0.113.7',
      createdAt: '2026-08-28T10:00:00.000Z',
      updatedAt: '2026-08-28T11:00:00.000Z',
      lastSeenAt: '2026-08-29T00:00:00.000Z',
    };
    const body = { response: { devices: [row], total: 1 } };
    const { client } = clientOver([ok(JSON.parse(JSON.stringify(body)))]);
    const outcome = await client.listAllDevices();
    const ours = Object.keys(outcome.kind === 'ok' ? outcome.data.devices[0] ?? {} : {});
    for (const [version, contract] of ERAS) {
      const parsed = vendorParse(contract, 'GetHwidDevicesCommand', body);
      assert.equal(parsed.success, true, `contract ${version} refuses the inventory body`);
      const devices = parsed.data?.response['devices'] as ReadonlyArray<Record<string, unknown>>;
      assert.deepStrictEqual(ours, Object.keys(devices[0] ?? {}), `contract ${version}`);
    }
  });

  it('lastSeen: the same instant as the same Date', async () => {
    const body = {
      response: {
        isCompleted: true,
        isFailed: false,
        result: {
          success: true,
          nodeUuid: NODE_UUID,
          users: [
            {
              userId: 4471,
              ips: [
                { ip: '203.0.113.7', lastSeen: '2026-08-28T10:00:00.123456Z' },
                { ip: '203.0.113.8', lastSeen: '2026-08-28T13:00:00+03:00' },
                { ip: '203.0.113.9', lastSeen: '2026-08-28T10:00:00' },
              ],
            },
          ],
        },
      },
    };
    const { client } = clientOver([ok({ response: { jobId: 'job-1' } }), ok(JSON.parse(JSON.stringify(body)))]);
    const rows = await client.fetchNodeConnections(NODE_UUID, { attempts: 1, intervalMs: 0 });
    const ours = (rows?.[0]?.ips ?? []).map((sample) => (sample.lastSeen as Date).toISOString());
    assert.equal(ours.length, 3);
    for (const [version, contract] of ERAS) {
      const parsed = vendorParse(contract, 'ConnectionsByNodeResultCommand', body);
      assert.equal(parsed.success, true, `contract ${version} refuses the job body`);
      const result = parsed.data?.response['result'] as {
        users: ReadonlyArray<{ ips: ReadonlyArray<{ lastSeen: Date }> }>;
      };
      assert.deepStrictEqual(
        ours,
        (result.users[0]?.ips ?? []).map((sample) => sample.lastSeen.toISOString()),
        `contract ${version}`,
      );
    }
  });

  it('lastSeen on the by-user job: the same instant as the same Date', async () => {
    const body = {
      response: {
        isCompleted: true,
        isFailed: false,
        progress: { total: 1, completed: 1, percent: 100 },
        result: {
          success: true,
          userId: 4471,
          nodes: [
            {
              nodeUuid: NODE_UUID,
              nodeName: 'de-1',
              countryCode: 'DE',
              ips: [{ ip: '203.0.113.7', lastSeen: '2026-08-28T10:00:00.1Z' }],
            },
          ],
        },
      },
    };
    const { client } = clientOver([ok({ response: { jobId: 'job-2' } }), ok(JSON.parse(JSON.stringify(body)))]);
    const nodes = await client.fetchUserConnections(4471, { attempts: 1, intervalMs: 0 });
    const ours = (nodes?.[0]?.ips ?? []).map((sample) => (sample.lastSeen as Date).toISOString());
    assert.deepStrictEqual(ours, ['2026-08-28T10:00:00.100Z']);
    for (const [version, contract] of ERAS) {
      const parsed = vendorParse(contract, 'ConnectionsByUserResultCommand', body);
      assert.equal(parsed.success, true, `contract ${version} refuses the job body`);
      const result = parsed.data?.response['result'] as {
        nodes: ReadonlyArray<{ ips: ReadonlyArray<{ lastSeen: Date }> }>;
      };
      assert.deepStrictEqual(
        ours,
        (result.nodes[0]?.ips ?? []).map((sample) => sample.lastSeen.toISOString()),
        `contract ${version}`,
      );
    }
  });
});

describe('dropping connections builds the body the table declares', () => {
  it('sends the 3.x { dropBy, targetNodes } pair unchanged', async () => {
    const { client, calls } = clientOver([ok('')]);
    const body: PanelDropConnectionsBody = {
      dropBy: { by: 'userIds', userIds: [4471, 4472] },
      targetNodes: { target: 'specificNodes', nodeUuids: [NODE_UUID] },
    };

    const outcome = await client.dropConnections(body);

    assert.equal(outcome.kind, 'ok');
    assert.equal(calls[0]?.method, 'post');
    assert.equal(calls[0]?.url, '/api/connections/drop');
    assert.deepStrictEqual(calls[0]?.body, body);
    // The table agrees with what was sent — the same rule the executor checked.
    assert.equal(PANEL_COMMANDS.DropConnectionsCommand.body.safeParse(calls[0]?.body).success, true);
  });

  it('refuses the 2.x userUuids arm before the request leaves', async () => {
    const { client, calls } = clientOver([ok('')]);
    const legacy = {
      dropBy: { by: 'userUuids', userUuids: ['11111111-1111-4111-8111-111111111111'] },
      targetNodes: { target: 'allNodes' },
    } as unknown as PanelDropConnectionsBody;

    const outcome = await client.dropConnections(legacy);

    assert.equal(outcome.kind, 'invalid-request');
    assert.match(
      outcome.kind === 'invalid-request' ? outcome.detail : '',
      /Invalid discriminator value/,
    );
    // Nothing sent. A 400 on the enforcement path is filed as terminal.
    assert.deepStrictEqual(calls, []);
  });

  it('refuses a fleet-wide drop that names nobody', async () => {
    const { client, calls } = clientOver([ok('')]);

    const outcome = await client.dropConnections({
      dropBy: { by: 'userIds', userIds: [] },
      targetNodes: { target: 'allNodes' },
    });

    // Refused in words an operator can act on, before the table's own
    // `min(1)` gets to say it more tersely.
    assert.equal(outcome.kind, 'invalid-request');
    assert.match(outcome.kind === 'invalid-request' ? outcome.detail : '', /target nobody/);
    assert.deepStrictEqual(calls, []);
  });
});
