import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  PanelCommandExecutor,
  type PanelTransport,
  type PanelTransportResult,
} from '../src/modules/remnawave/services/panel-command.executor';
import { PanelUsersClient } from '../src/modules/remnawave/services/panel-users.client';

/**
 * The users client, over the real executor and the real command table
 * ═══════════════════════════════════════════════════════════════════
 * No hand-built command objects anywhere below: the client reaches into
 * `panel-commands.ts` for its routes, verbs and request rules, and
 * `panel-command-conformance.spec.ts` holds that table to every era's contract.
 * What is worth proving here is that those definitions produce the requests we
 * expect, and that the ones they refuse never leave the process.
 *
 * WHAT IS DELIBERATELY NOT TESTED: that `getUserById` calls `GET`, that
 * `createUser` calls `POST`. The conformance spec pins every route and verb.
 * The cases here are the decisions — the ones a future edit could reverse
 * without any type failing.
 *
 * Only the seven methods production calls exist. The bulk actions, the keyset
 * stream, revoke / enable / disable / extend, the short-uuid lookup, the
 * per-user request history and the tag list were never reached from `src/`;
 * they were deleted together with the tests that were their only callers.
 */

/** A captured live-panel answer, not a hand-written object. */
const CAPTURED_USER = JSON.parse(
  readFileSync('test/fixtures/remnawave/3.3.2/user.json', 'utf8'),
) as { response: Record<string, unknown> };

/** Records what the transport was asked to do, and answers as instructed. */
function stubTransport(
  answer: PanelTransportResult = { kind: 'ok', data: CAPTURED_USER },
): {
  transport: PanelTransport;
  calls: Array<{
    method: string;
    url: string;
    body?: unknown;
    query?: Readonly<Record<string, string | number | undefined>>;
  }>;
} {
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
        calls.push({ method: input.method, url: input.url, body: input.body, query: input.query });
        return answer;
      },
    },
  };
}

function clientOver(answer?: PanelTransportResult): {
  client: PanelUsersClient;
  calls: ReturnType<typeof stubTransport>['calls'];
} {
  const { transport, calls } = stubTransport(answer);
  return { client: new PanelUsersClient(new PanelCommandExecutor(transport)), calls };
}

describe('a request the table refuses never reaches the transport', () => {
  it('stops the { uuid } update key that 3.x has no field for', async () => {
    const { client, calls } = clientOver();

    const outcome = await client.updateUser({
      uuid: '11111111-1111-4111-8111-111111111111',
    } as never);

    assert.equal(outcome.kind, 'invalid-request');
    assert.match(
      outcome.kind === 'invalid-request' ? outcome.detail : '',
      /At least one of username, id must be provided/,
    );
    // A 400 here is filed as terminal by the sync layer, and the subscription
    // stops converging with nothing anywhere saying why.
    assert.deepStrictEqual(calls, []);
  });

  it('stops an explicit trafficLimitStrategy: null on create', async () => {
    const { client, calls } = clientOver();

    // The field is optional and NEVER nullable upstream, so "no opinion" has
    // to be an ABSENT key — every 3x-ui import reads as null and would
    // otherwise spend a round-trip earning a 400.
    const outcome = await client.createUser({
      username: 'rz_sub_1',
      expireAt: '2027-01-01T00:00:00.000Z',
      trafficLimitStrategy: null as never,
    });

    assert.equal(outcome.kind, 'invalid-request');
    assert.deepStrictEqual(calls, []);
  });

  it('stops a resolve selector carrying two identities', async () => {
    const { client, calls } = clientOver();

    const outcome = await client.resolveUser({ id: 7, username: 'rz_sub_332' });

    assert.equal(outcome.kind, 'invalid-request');
    assert.match(
      outcome.kind === 'invalid-request' ? outcome.detail : '',
      /Exactly one of id, shortUuid, or username must be provided/,
    );
    assert.deepStrictEqual(calls, []);
  });

  it('never repeats customer data into the refusal detail', async () => {
    const { client } = clientOver();

    const outcome = await client.updateUser({
      email: 'not-an-email',
      telegramId: 813364774,
    } as never);

    // A zod issue can carry `received`, and on this integration that is the
    // customer's own address. The detail names the field and the rule.
    const detail = outcome.kind === 'invalid-request' ? outcome.detail : '';
    assert.notEqual(detail, '');
    assert.equal(detail.includes('not-an-email'), false);
    assert.equal(detail.includes('813364774'), false);
  });
});

describe('a numeric id is checked before it becomes a path segment', () => {
  it('refuses NaN — what Number() yields for a 2.x uuid still in the column', async () => {
    const { client, calls } = clientOver();

    const outcome = await client.getUserById(Number('11111111-1111-4111-8111-111111111111'));

    assert.equal(outcome.kind, 'invalid-request');
    assert.equal(
      outcome.kind === 'invalid-request' ? outcome.command : '',
      'GET /api/users/:userId (Get user by ID)',
    );
    // `/api/users/NaN` is a request the panel can only answer with a 400.
    assert.deepStrictEqual(calls, []);
  });

  it('refuses ids the table rejects and ids String() would mangle', async () => {
    for (const userId of [0, -7, 1e21, 4471.5]) {
      const { client, calls } = clientOver();
      const outcome = await client.deleteUser(userId);
      assert.equal(outcome.kind, 'invalid-request', String(userId));
      // 1e21 renders as '1e+21' and 4471.5 as '4471.5'; both pass the panel's
      // own `positive()` and both address a route that cannot exist. A DELETE
      // is the wrong operation to discover that on.
      assert.deepStrictEqual(calls, [], String(userId));
    }
  });

  it('lets a real id through, on the table’s own path builder', async () => {
    const cases: Array<[(client: PanelUsersClient) => Promise<unknown>, string, string]> = [
      [(c) => c.getUserById(4471), 'get', '/api/users/4471'],
      [(c) => c.deleteUser(4471), 'delete', '/api/users/4471'],
      [(c) => c.resetTraffic(4471), 'post', '/api/users/4471/actions/reset-traffic'],
    ];

    for (const [run, method, url] of cases) {
      const { client, calls } = clientOver();
      await run(client);
      assert.equal(calls[0]?.method, method);
      assert.equal(calls[0]?.url, url);
      // No body on any of the three: an absent body also drops the JSON
      // content type, which is what these routes have always received.
      assert.equal(calls[0]?.body, undefined);
    }
  });
});

describe('a lookup key is encoded before it becomes a path segment', () => {
  it('encodes what the builder interpolates raw', async () => {
    const { client, calls } = clientOver();

    // The builder, like the vendor's, is a bare template literal. Unencoded,
    // the slash addresses a different route and the `?` turns the rest of the
    // name into a query string.
    await client.getUserByUsername('rz/sub?x=1');

    assert.deepStrictEqual(
      calls.map((call) => call.url),
      ['/api/users/by-username/rz%2Fsub%3Fx%3D1'],
    );
  });

  it('refuses an empty key, which would address the collection route', async () => {
    const { client, calls } = clientOver();

    const outcome = await client.getUserByUsername('');

    assert.equal(outcome.kind, 'invalid-request');
    assert.deepStrictEqual(calls, []);
  });
});

describe('"the panel said no" and "we could not reach it" stay apart', () => {
  it('keeps a rejection, a network failure and a missing setting distinct', async () => {
    const rejected = clientOver({
      kind: 'rejected',
      status: 404,
      code: 'A025',
      detail: 'User not found',
      retryAfterMs: null,
    });
    const offline = clientOver({ kind: 'network', detail: 'ETIMEDOUT' });
    const unset = clientOver({ kind: 'unconfigured' });

    const [a, b, c] = await Promise.all([
      rejected.client.getUserById(4471),
      offline.client.getUserById(4471),
      unset.client.getUserById(4471),
    ]);

    // `sharing-detectors.ts` records what collapsing these costs: a detector
    // whose read had failed reported a clean panel forever, because "nobody is
    // over their limit" and "we could not look" arrived as the same value.
    assert.deepStrictEqual([a.kind, b.kind, c.kind], ['rejected', 'network', 'unconfigured']);
  });

  it('hands the 404 back with its envelope code instead of ruling on it', async () => {
    const withEnvelope = clientOver({
      kind: 'rejected',
      status: 404,
      code: 'A025',
      detail: 'User not found',
      retryAfterMs: null,
    });
    const bare = clientOver({
      kind: 'rejected',
      status: 404,
      code: null,
      detail: null,
      retryAfterMs: null,
    });

    const named = await withEnvelope.client.deleteUser(4471);
    const gateway = await bare.client.deleteUser(4471);

    // Only the first means "the profile is gone". The second is what a reverse
    // proxy answers to everything while it has no healthy backend, and the
    // caller acts on a delete-success by clearing the profile link — so
    // reading the second as the first detaches live subscriptions. Both arrive
    // intact; the client does not decide.
    assert.equal(named.kind === 'rejected' ? named.code : 'wrong', 'A025');
    assert.equal(gateway.kind === 'rejected' ? gateway.code : 'wrong', null);
  });

  it('does not turn a refusal we caused into one the panel sent', async () => {
    const { client, calls } = clientOver({
      kind: 'rejected',
      status: 400,
      code: 'A019',
      detail: 'Bad request',
      retryAfterMs: null,
    });

    const ours = await client.resolveUser({});

    // `invalid-request` is retry-proof by construction — nothing was sent, so
    // nothing about the panel can change the answer. A caller that retried it
    // as if it were the panel's 400 would loop forever.
    assert.equal(ours.kind, 'invalid-request');
    assert.deepStrictEqual(calls, []);
  });
});

describe('a captured 3.3.2 answer arrives as the panel sent it', () => {
  it('hands the envelope back untouched — no transform, no stripping', async () => {
    const { client } = clientOver({ kind: 'ok', data: CAPTURED_USER });

    const outcome = await client.getUserById(7);

    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.data, CAPTURED_USER);
    assert.equal(outcome.data.response.id, 7);
    assert.equal(outcome.data.response.username, 'rz_sub_332');
    // The wire string, not a `Date`: every reader of this field goes through a
    // helper that accepts both (`panelTimestamp`, `readInstantMs`).
    assert.equal(typeof outcome.data.response.expireAt, 'string');
    // A 3.x row has no `uuid`, and nothing here invents one.
    assert.equal('uuid' in (outcome.data.response as Record<string, unknown>), false);
  });
});
