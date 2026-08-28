import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import {
  DeleteAllUserHwidDevicesCommand,
  DeleteUserHwidDeviceCommand,
  DropConnectionsCommand,
  GetUserHwidDevicesCommand,
} from '@remnawave/contract-v34';

import {
  PanelCommandExecutor,
  type PanelTransport,
  type PanelTransportResult,
} from '../src/modules/remnawave/services/panel-command.executor';
import {
  PanelDevicesClient,
  type PanelDropConnectionsBody,
} from '../src/modules/remnawave/services/panel-devices.client';

/**
 * The devices client, driven by the REAL contract
 * ═══════════════════════════════════════════════
 * Every command below is imported from `@remnawave/contract-v34` and handed to
 * the executor unchanged. Hand-built fakes would prove only that the client
 * agrees with itself; the value of taking routes, verbs and schemas from the
 * vendor is that they are the vendor's, so the tests have to use the vendor's.
 *
 * The cases that matter here are not happy paths:
 *
 *   • a poll that runs out of budget answers `null` and NEVER `[]`. The
 *     concurrent-IP sharing detector reads `[]` as "this node was read and
 *     nobody was on it" and accuses subscribers on that basis, so flattening
 *     the two reports a busy node as clean — silently, and hardest on the big
 *     nodes, which are both the slowest to answer and the ones sharers use.
 *   • a read that succeeded and found nothing answers `[]`, so the distinction
 *     above carries information in both directions.
 *   • a drop-connections body we built wrong never leaves the process. The 2.x
 *     spelling (`userUuids`) is a guaranteed 400 on panel 3.3.2, and a 400 on
 *     the enforcement path is filed as terminal.
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

/** A by-node job result the contract accepts, carrying the given users. */
function nodeJobResult(users: ReadonlyArray<unknown>): unknown {
  return {
    response: {
      isCompleted: true,
      isFailed: false,
      result: { success: true, nodeUuid: NODE_UUID, users },
    },
  };
}

describe('HWID reads address the user the way 3.3.2 does', () => {
  it('takes GET and the numeric path from the contract, and reports an empty panel as empty', async () => {
    const { client, calls } = clientOver([ok({ response: { total: 0, devices: [] } })]);

    const outcome = await client.listUserDevices(4471);

    assert.equal(calls[0]?.method, 'get');
    // Not a template literal written here — the vendor's own url builder made it.
    assert.equal(calls[0]?.url, '/api/hwid/devices/4471');
    assert.equal(outcome.kind, 'ok');
    // An answer, not an absence: the panel said this profile has no devices.
    assert.deepStrictEqual(outcome.kind === 'ok' ? outcome.data.devices : null, []);
    assert.equal(outcome.kind === 'ok' ? outcome.data.total : null, 0);
  });

  it('refuses a user id the route cannot carry instead of asking for /NaN', async () => {
    const { client, calls } = clientOver([ok({ response: { total: 0, devices: [] } })]);

    const outcome = await client.listUserDevices(Number.NaN);

    assert.equal(outcome.kind, 'invalid-request');
    // The panel would have answered "Validation failed (numeric string is
    // expected)", which reads like a rejected user rather than our bad call.
    assert.deepStrictEqual(calls, []);
  });

  it('keys the delete bodies on userId, the only owner key 3.3.2 declares', async () => {
    const { client, calls } = clientOver([ok({ response: { total: 1, devices: [] } })]);

    await client.deleteUserDevice(4471, 'HWID-A');
    await client.deleteAllUserDevices(4471);

    assert.equal(calls[0]?.url, '/api/hwid/devices/delete');
    assert.equal(calls[0]?.method, 'post');
    assert.deepStrictEqual(calls[0]?.body, { userId: 4471, hwid: 'HWID-A' });
    assert.equal(calls[1]?.url, '/api/hwid/devices/delete-all');
    assert.deepStrictEqual(calls[1]?.body, { userId: 4471 });
  });

  it('shows why the old userUuid body was a guaranteed 400', async () => {
    // Not a claim about our code — a claim about the vendor's schema, which is
    // what the executor now checks bodies against. The hand-rolled client sent
    // this shape whenever the addressing era was not positively known to be
    // 3.x, and every one of those requests was rejected.
    const refused = DeleteUserHwidDeviceCommand.RequestBodySchema.safeParse({
      userUuid: '11111111-1111-4111-8111-111111111111',
      hwid: 'HWID-A',
    });
    assert.equal(refused.success, false);
  });

  it('pins the three device commands to one payload, since one type serves all three', async () => {
    // `PanelHwidDeviceList` is derived from the LIST command and returned by
    // the deletes too. If a later contract splits them this fails here rather
    // than mistyping the deletes in silence.
    const payload = {
      response: {
        total: 1,
        devices: [
          {
            hwid: 'HWID-A',
            userId: 4471,
            platform: 'iOS',
            osVersion: '18.2',
            deviceModel: 'iPhone',
            userAgent: 'Happ',
            requestIp: '203.0.113.7',
            createdAt: '2026-08-28T10:00:00.000Z',
            updatedAt: '2026-08-28T11:00:00.000Z',
          },
        ],
      },
    };
    for (const command of [
      GetUserHwidDevicesCommand,
      DeleteUserHwidDeviceCommand,
      DeleteAllUserHwidDevicesCommand,
    ]) {
      assert.equal(command.ResponseSchema.safeParse(payload).success, true);
    }
  });
});

describe('device stats ask once', () => {
  it('does not chase /api/hwid/stats after the real path fails', async () => {
    const { client, calls } = clientOver([
      { kind: 'rejected', status: 401, code: 'A001', detail: 'Unauthorized', retryAfterMs: null },
    ]);

    const outcome = await client.getDeviceStats();

    // One request. The old version fell through to `/api/hwid/stats` in a bare
    // `catch { continue }` — a route 3.3.2 does not serve — so a real failure
    // on the first path was answered by a second that could only 404, and the
    // pair returned `null` as though the panel had never been asked.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, '/api/hwid/devices/stats');
    // And the reason survives instead of being flattened into "no stats".
    assert.equal(outcome.kind, 'rejected');
  });
});

describe('top users are walked, not sampled', () => {
  it('sends the page size the contract caps at 100 rather than taking the default 5', async () => {
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

    // Omitting `size` never meant "everything": the contract defaults it to 5,
    // so the device-overage detector was judging a five-row sample and calling
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

  it('pages at the contract ceiling rather than taking the default 25', async () => {
    // The contract defaults `size` to 25. Omitting it would walk a fleet 25
    // rows at a time — and the caller is looking for one hwid bound to two
    // owners, which is only visible when BOTH of its rows are in hand.
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
    // The contract's endpoint description warns the filters "rely on expensive
    // operators such as LIKE under the hood" and may hurt "the performance of
    // your database" — the operator's production one.
    const { client, calls } = clientOver([ok({ response: { devices: [], total: 0 } })]);

    await client.listAllDevices();

    assert.deepStrictEqual(Object.keys(calls[0]?.query ?? {}).sort(), ['size', 'start']);
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

  it('reports an inventory whose device list is missing as unreadable, not empty', async () => {
    // The drift path: the panel answered 2xx with a body the row list is not
    // findable in. `[]` here would mean "no device is bound to two accounts".
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

  it('hands back the rows the contract declares, dates and all', async () => {
    const { client } = clientOver([
      ok({ response: { jobId: 'job-1' } }),
      ok(
        nodeJobResult([
          { userId: 4471, ips: [{ ip: '203.0.113.7', lastSeen: '2026-08-28T10:00:00.000Z' }] },
        ]),
      ),
    ]);

    const rows = await client.fetchNodeConnections(NODE_UUID, { attempts: 2, intervalMs: 0 });

    assert.equal(rows?.length, 1);
    assert.equal(rows?.[0]?.userId, 4471);
    // The contract's own transform ran, which is the point of validating
    // through the vendor's schema rather than casting the body.
    assert.ok(rows?.[0]?.ips[0]?.lastSeen instanceof Date);
  });
});

describe('connections routes come from the contract and only from /api/connections', () => {
  it('starts and polls the by-node job on the vendor’s paths', async () => {
    const { client, calls } = clientOver([
      ok({ response: { jobId: 'job-7' } }),
      ok(nodeJobResult([])),
    ]);

    await client.fetchNodeConnections(OTHER_NODE_UUID, { attempts: 2, intervalMs: 0 });

    assert.equal(calls[0]?.method, 'post');
    assert.equal(calls[0]?.url, `/api/connections/by-node/${OTHER_NODE_UUID}`);
    assert.equal(calls[1]?.method, 'get');
    assert.equal(calls[1]?.url, '/api/connections/by-node/job-7');
    // The 2.x family is gone from 3.3.2 entirely; nothing here may reach for it.
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

    // Both commands build `/api/connections/by-user/{…}`: the POST takes a USER
    // id and the GET takes a JOB id, so swapping them produces a well-formed
    // URL and a nonsense request.
    assert.equal(calls[0]?.url, '/api/connections/by-user/4471');
    assert.equal(calls[1]?.url, '/api/connections/by-user/job-9');
    assert.deepStrictEqual(rows, []);
  });

  it('refuses a node id that is not the uuid the contract requires', async () => {
    const { client, calls } = clientOver([ok({ response: { jobId: 'job-1' } })]);

    const rows = await client.fetchNodeConnections('node-3', { attempts: 2, intervalMs: 0 });

    assert.equal(rows, null);
    assert.deepStrictEqual(calls, []);
  });

  it('refuses to invent an empty node out of a body it cannot read', async () => {
    // A drifted answer: the executor hands back raw bytes when the pinned
    // schema rejects a response, so `users` may not be there at all.
    const { client } = clientOver([
      ok({ response: { jobId: 'job-1' } }),
      ok({ response: { isCompleted: true, isFailed: false, result: { success: true } } }),
    ]);

    assert.equal(await client.fetchNodeConnections(NODE_UUID, { attempts: 2, intervalMs: 0 }), null);
  });
});

describe('dropping connections builds the body the contract declares', () => {
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
    // The contract agrees with what was sent — the same schema the executor
    // checked it against.
    assert.equal(DropConnectionsCommand.RequestBodySchema.safeParse(calls[0]?.body).success, true);
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

    // The contract permits an empty array, so this is a well-formed request
    // asking a fleet-wide endpoint to act on nobody. Not worth betting a
    // panel's interpretation on.
    assert.equal(outcome.kind, 'invalid-request');
    assert.deepStrictEqual(calls, []);
  });
});
