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
 * The users client, driven by the REAL contract
 * ═════════════════════════════════════════════
 * No hand-built command objects anywhere below. The client reaches into
 * `@remnawave/contract-v34` for its routes, verbs and schemas, so a spec that
 * fed it fakes would prove only that the client agrees with the fakes — which
 * is precisely the thing that was never in doubt. What IS worth proving is
 * that the vendor's own definitions produce the requests we expect, and that
 * the ones they refuse never leave the process.
 *
 * WHAT IS DELIBERATELY NOT TESTED: that `getUserById` calls `GET`, that
 * `createUser` calls `POST`. Those are one line each and the executor's own
 * spec already pins the mechanism. The cases here are the decisions — the ones
 * a future edit could reverse without any type failing.
 */

/**
 * A captured live-panel answer, not a hand-written object. It is also the
 * DEFAULT answer below: every user-returning route shares one
 * `UserResponseSchema`, so a stub that answers `{}` makes the executor log
 * drift on each of them and buries the one test that is actually about drift
 * under a dozen identical warnings.
 */
const CAPTURED_USER = JSON.parse(
  readFileSync('test/fixtures/remnawave/3.3.2/user.json', 'utf8'),
) as unknown;

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

const IDS_250 = Array.from({ length: 250 }, (_, index) => index + 1);

describe('a bulk operation is ONE request for N users', () => {
  it('sends a single request carrying every id, on every bulk route', async () => {
    // The reason these routes exist. A loop over the single-user actions can
    // stop halfway and leave the batch in two different states with no record
    // of where the line fell; the panel applies the whole set at once.
    const cases: Array<[string, (client: PanelUsersClient) => Promise<unknown>, string]> = [
      ['reset-traffic', (c) => c.bulkResetTraffic(IDS_250), '/api/users/bulk/reset-traffic'],
      ['delete', (c) => c.bulkDelete(IDS_250), '/api/users/bulk/delete'],
      ['update', (c) => c.bulkUpdate(IDS_250, { status: 'DISABLED' }), '/api/users/bulk/update'],
      [
        'update-squads',
        (c) => c.bulkUpdateSquads(IDS_250, ['11111111-1111-4111-8111-111111111111']),
        '/api/users/bulk/update-squads',
      ],
      [
        'revoke-subscription',
        (c) => c.bulkRevokeSubscription(IDS_250),
        '/api/users/bulk/revoke-subscription',
      ],
      [
        'extend-expiration-date',
        (c) => c.bulkExtendExpirationDate(IDS_250, 30),
        '/api/users/bulk/extend-expiration-date',
      ],
    ];

    for (const [name, run, url] of cases) {
      const { client, calls } = clientOver();
      await run(client);

      assert.equal(calls.length, 1, `${name} issued ${calls.length} requests for 250 users`);
      assert.equal(calls[0]?.method, 'post', name);
      // The vendor's path, not a literal written in this file.
      assert.equal(calls[0]?.url, url, name);
      const body = calls[0]?.body as { userIds?: unknown };
      assert.deepStrictEqual(body.userIds, IDS_250, name);
    }
  });

  it('refuses a batch over the contract’s 500 rather than quietly splitting it', async () => {
    const { client, calls } = clientOver();

    const outcome = await client.bulkDelete(Array.from({ length: 501 }, (_, i) => i + 1));

    assert.equal(outcome.kind, 'invalid-request');
    assert.match(
      outcome.kind === 'invalid-request' ? outcome.detail : '',
      /userIds: Too big: expected array to have <=500 items/,
    );
    // NOT two requests of 500 and 1. Chunking behind a signature that promises
    // one request gives back a single outcome that cannot say which half
    // landed — the exact failure the bulk routes exist to avoid.
    assert.deepStrictEqual(calls, []);
  });

  it('refuses an empty batch instead of asking the panel what it means', async () => {
    const { client, calls } = clientOver();

    const outcome = await client.bulkResetTraffic([]);

    assert.equal(outcome.kind, 'invalid-request');
    assert.deepStrictEqual(calls, []);
  });
});

describe('a request the contract refuses never reaches the transport', () => {
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
    // `/api/users/NaN` is a request the panel can only answer with a 400.
    assert.deepStrictEqual(calls, []);
  });

  it('refuses ids the contract rejects and ids String() would mangle', async () => {
    for (const userId of [0, -7, 1e21, 4471.5]) {
      const { client, calls } = clientOver();
      const outcome = await client.deleteUser(userId);
      assert.equal(outcome.kind, 'invalid-request', String(userId));
      // 1e21 renders as '1e+21' and 4471.5 as '4471.5'; both pass the vendor's
      // own `positive()` and both address a route that cannot exist. A DELETE
      // is the wrong operation to discover that on.
      assert.deepStrictEqual(calls, [], String(userId));
    }
  });

  it('lets a real id through, on the vendor’s own path builder', async () => {
    // Not a template literal written here — every path below came out of the
    // contract's own url builder, which is the whole reason the route table
    // this replaces could be deleted.
    const cases: Array<[(client: PanelUsersClient) => Promise<unknown>, string, unknown]> = [
      [(c) => c.getUserById(4471), '/api/users/4471', CAPTURED_USER],
      [(c) => c.resetTraffic(4471), '/api/users/4471/actions/reset-traffic', CAPTURED_USER],
      [(c) => c.enableUser(4471), '/api/users/4471/actions/enable', CAPTURED_USER],
      [(c) => c.disableUser(4471), '/api/users/4471/actions/disable', CAPTURED_USER],
      [(c) => c.extendUser(4471, 30), '/api/users/4471/actions/extend', CAPTURED_USER],
      [
        (c) => c.getSubscriptionRequestHistory(4471),
        '/api/users/4471/subscription-request-history',
        { response: { total: 0, records: [] } },
      ],
    ];

    for (const [run, url, answer] of cases) {
      const { client, calls } = clientOver({ kind: 'ok', data: answer });
      await run(client);
      assert.equal(calls[0]?.url, url);
    }
  });
});

describe('a lookup key is encoded before it becomes a path segment', () => {
  it('encodes what the vendor’s builder interpolates raw', async () => {
    const { client, calls } = clientOver();

    // `USERS_ROUTES.GET_BY.USERNAME` is a bare template literal. Unencoded,
    // the slash addresses a different route and the `?` turns the rest of the
    // name into a query string — and this method is the operator search box.
    await client.getUserByUsername('rz/sub?x=1');
    await client.getUserByShortUuid('Kq3WmZ8t/R1v');

    assert.deepStrictEqual(
      calls.map((call) => call.url),
      ['/api/users/by-username/rz%2Fsub%3Fx%3D1', '/api/users/by-short-uuid/Kq3WmZ8t%2FR1v'],
    );
  });

  it('refuses an empty key, which would address the collection route', async () => {
    const { client, calls } = clientOver();

    const outcome = await client.getUserByUsername('');

    assert.equal(outcome.kind, 'invalid-request');
    assert.deepStrictEqual(calls, []);
  });
});

describe('the keyset walk carries the panel’s own cursor back', () => {
  const emptyPage: PanelTransportResult = {
    kind: 'ok',
    data: { response: { users: [], nextCursor: null, hasMore: false } },
  };

  it('applies the contract’s size default and sends no cursor on the first page', async () => {
    const { client, calls } = clientOver(emptyPage);

    await client.streamUsers();

    assert.equal(calls[0]?.url, '/api/users/stream');
    assert.deepStrictEqual(calls[0]?.query, { size: 250 });
  });

  it('accepts nextCursor as the string the panel sends it as', async () => {
    const { client, calls } = clientOver(emptyPage);

    // The response declares `nextCursor` as a nullable STRING while the query
    // declares `cursor` as a coerced NUMBER. Feeding the panel's own answer
    // straight back is the intended use, so the coercion has to happen.
    await client.streamUsers({ cursor: '4471', size: 500 });

    assert.deepStrictEqual(calls[0]?.query, { cursor: 4471, size: 500 });
  });

  it('refuses a size the panel would silently clamp', async () => {
    const { client, calls } = clientOver();

    const outcome = await client.streamUsers({ size: 5000 });

    // A server-side clamp returns fewer rows than were asked for with nothing
    // saying so, and a walk that advances by the size it REQUESTED skips every
    // row the panel chose not to send. Those users then miss in the caller's
    // overlay map and are written EXPIRED.
    assert.equal(outcome.kind, 'invalid-request');
    assert.match(
      outcome.kind === 'invalid-request' ? outcome.detail : '',
      /size: Too big: expected number to be <=1000/,
    );
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
    const { client } = clientOver({
      kind: 'rejected',
      status: 400,
      code: 'A019',
      detail: 'Bad request',
      retryAfterMs: null,
    });

    const ours = await client.bulkDelete([]);

    // `invalid-request` is retry-proof by construction — nothing was sent, so
    // nothing about the panel can change the answer. A caller that retried it
    // as if it were the panel's 400 would loop forever.
    assert.equal(ours.kind, 'invalid-request');
  });
});

describe('a captured 3.3.2 answer decodes through the contract', () => {
  it('validates cleanly and applies the contract’s own transforms', async () => {
    const { client } = clientOver({ kind: 'ok', data: CAPTURED_USER });

    const outcome = await client.getUserById(7);

    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    // Guards the guard: if every response were reported as drift the flag
    // would carry no information and the log would be noise.
    assert.equal(outcome.drifted, false);
    assert.equal(outcome.data.response.id, 7);
    assert.equal(outcome.data.response.username, 'rz_sub_332');
    // Proof the contract's schema actually ran rather than the body being
    // waved through: the wire carries an ISO string and the declared type is a
    // Date, so this only holds if the transform executed.
    assert.ok(outcome.data.response.expireAt instanceof Date);
    // A 3.x row has no `uuid`, and nothing here invents one.
    assert.equal('uuid' in (outcome.data.response as Record<string, unknown>), false);
  });

  it('marks an answer the pinned contract does not declare as drift, not failure', async () => {
    const drifts: string[] = [];
    const { transport } = stubTransport({ kind: 'ok', data: { response: { id: 7 } } });
    const client = new PanelUsersClient(
      new PanelCommandExecutor(transport, (report) => drifts.push(report.url)),
    );

    const outcome = await client.getUserById(7);

    // The contract is pinned to one panel minor while the fleet runs several.
    // A required field added in a later minor must not take a feature down on
    // an older panel — but leniency is not silence.
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.kind === 'ok' ? outcome.drifted : null, true);
    assert.deepStrictEqual(drifts, ['/api/users/7']);
  });
});

describe('the single-user revoke keeps its narrower form reachable', () => {
  it('sends an empty body by default and passes revokeOnlyPasswords through', async () => {
    const { client, calls } = clientOver();

    await client.revokeSubscription(4471);
    await client.revokeSubscription(4471, { revokeOnlyPasswords: true });

    assert.equal(calls[0]?.url, '/api/users/4471/actions/revoke');
    // The client hands over `{}` rather than omitting the body — an absent
    // body also drops the JSON content type. What reaches the wire is the
    // contract's own default filled in, because the executor sends what it
    // validated rather than what it was given. Identical to the panel either
    // way; the difference is that the request now says what it means.
    assert.deepStrictEqual(calls[0]?.body, { revokeOnlyPasswords: false });
    assert.deepStrictEqual(calls[1]?.body, { revokeOnlyPasswords: true });
  });
});
