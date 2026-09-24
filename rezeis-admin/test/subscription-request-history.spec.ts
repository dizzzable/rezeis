import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { of, throwError } from 'rxjs';

import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import { mapSubscriptionRequestEntry } from '../src/modules/remnawave/services/remnawave-extended-mappers';

/**
 * The subscription-request log reader, pinned to what the specs of the panels
 * rezeis serves (3.3.2 and 3.4.3) actually declare.
 *
 * This surface shipped with no test at all, which is how it came to send two
 * query parameters that exist in no spec and to map two response fields that
 * exist in none either. The wire-level assertions below are therefore
 * deliberately literal: they assert the exact path string, because the whole
 * class of defect here is a plausible-looking parameter name that the panel
 * silently ignores.
 */

/**
 * `required` of a `GET /api/subscription-request-history` record, in the
 * spec's order — identical in 3.3.2 and 3.4.3.
 */
const RECORD_REQUIRED = [
  'id',
  'userId',
  'srrResponseType',
  'srrRuleName',
  'requestIp',
  'userAgent',
  'requestAt',
] as const;

/** A record exactly as Remnawave 3.3.2 / 3.4.3 serves it: the owner is a numeric id. */
const RECORD = {
  id: 42,
  userId: 1337,
  srrResponseType: 'XRAY_BASE64',
  srrRuleName: null,
  requestIp: '203.0.113.8',
  userAgent: 'Happ/1.9.0',
  requestAt: '2026-08-06T11:59:30.000Z',
};

function makeService(
  handler: (input: { readonly url: string; readonly method: string }) => unknown,
): RemnawaveApiService {
  return new RemnawaveApiService(
    { request: handler } as never,
    {
      host: 'remnawave',
      port: 3000,
      token: 'secret',
      webhookSecret: null,
    },
  );
}

describe('mapSubscriptionRequestEntry — the owner is the panel user id', () => {
  it('reads the record the panel sends, owner into panelUserId', () => {
    assert.deepStrictEqual(Object.keys(RECORD), [...RECORD_REQUIRED]);

    assert.deepStrictEqual(mapSubscriptionRequestEntry(RECORD), {
      id: '42',
      userUuid: null,
      panelUserId: 1337,
      userAgent: 'Happ/1.9.0',
      clientType: 'Happ',
      ipAddress: '203.0.113.8',
      requestedAt: '2026-08-06T11:59:30.000Z',
    });
  });

  it('accepts an owner id that arrived as a decimal string, and nothing else', () => {
    // JSON transports that carry bigints as strings hand the number back quoted.
    assert.equal(mapSubscriptionRequestEntry({ ...RECORD, userId: '1337' }).panelUserId, 1337);
    for (const owner of ['b7f1e0c2-1111-4222-8333-444455556666', '', '13a7', null]) {
      assert.equal(mapSubscriptionRequestEntry({ ...RECORD, userId: owner }).panelUserId, null, String(owner));
    }
  });

  it('never passes an owner off as a uuid, and reads none', () => {
    // The defect this pins: folding `userId` into `userUuid` produced the
    // string "1337" in a uuid-typed field, so every consumer keyed by a uuid
    // missed silently and the admin log rendered "1337…" as though it were a
    // uuid prefix. `userUuid` stays on the wire for the SPA, and no supported
    // panel sends one — a record that still carries it (2.7.4's owner field)
    // is read by its `userId` like any other.
    assert.equal(mapSubscriptionRequestEntry(RECORD).userUuid, null);
    const legacy = mapSubscriptionRequestEntry({ ...RECORD, userUuid: 'b7f1e0c2-1111-4222-8333-444455556666' });
    assert.equal(legacy.userUuid, null);
    assert.equal(legacy.panelUserId, 1337);
  });

  it('derives the client family from the User-Agent the panel does send', () => {
    // `clientType` is in no spec. It used to be read straight off the record
    // and was therefore null for every row on every version, leaving the admin
    // table's "client" column permanently blank.
    assert.equal(mapSubscriptionRequestEntry(RECORD).clientType, 'Happ');
    assert.equal(mapSubscriptionRequestEntry({ ...RECORD, userAgent: 'v2rayNG/1.8.5' }).clientType, 'v2rayNG');
    assert.equal(mapSubscriptionRequestEntry({ ...RECORD, userAgent: null }).clientType, null);
  });

  it('does not throw on a record that is missing everything', () => {
    const entry = mapSubscriptionRequestEntry({});
    assert.equal(entry.userUuid, null);
    assert.equal(entry.panelUserId, null);
    assert.equal(entry.userAgent, null);
  });
});

/**
 * Drops the panel-version probe (`/api/system/...`) that any user-scoped call
 * makes before it can build a path. Filtering it keeps these assertions about
 * routing rather than about how many round-trips addressing happens to cost.
 */
function userPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => !path.startsWith('/api/system/'));
}

describe('getSubscriptionRequestHistory — routing and parameter names', () => {
  it('asks the PER-USER endpoint when a profile is given', async () => {
    // The whole-log endpoint accepts no user filter, so a per-user question
    // has to go to the per-user path or it is answered with the whole panel's
    // log.
    const paths: string[] = [];
    const service = makeService((input) => {
      paths.push(input.url);
      return of({ data: { response: { records: [RECORD], total: 1 } } });
    });

    const entries = await service.getSubscriptionRequestHistory({ user: '1337' });

    // Addressing a profile costs a version probe first; it is not part of what
    // this test is about, so it is filtered rather than asserted around.
    assert.deepEqual(userPaths(paths), ['/api/users/1337/subscription-request-history']);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].panelUserId, 1337);
  });

  it('sends the page bound as "size" — the name the spec declares — not "limit"', async () => {
    const paths: string[] = [];
    const service = makeService((input) => {
      paths.push(input.url);
      return of({ data: { response: { records: [], total: 0 } } });
    });

    await service.getSubscriptionRequestHistory({ limit: 20 });

    assert.deepEqual(paths, ['/api/subscription-request-history?size=20']);
    // `limit` does not exist in any spec; a panel served it would ignore it
    // and return its own default page.
    assert.ok(!paths[0].includes('limit'), paths[0]);
  });

  it('never puts the profile in the whole-log query string', async () => {
    const paths: string[] = [];
    const service = makeService((input) => {
      paths.push(input.url);
      return of({ data: { response: { records: [], total: 0 } } });
    });

    await service.getSubscriptionRequestHistory({ user: '1337', limit: 5 });

    const [requested] = userPaths(paths);
    assert.ok(requested !== undefined, 'expected a user-scoped request');
    assert.ok(!requested.includes('?'), `expected no query string, got ${requested}`);
  });
});

describe('strictGetSubscriptionRequestHistory — a clean log must differ from an unreadable one', () => {
  it('returns ok with the panel total and the requested size', async () => {
    const paths: string[] = [];
    const service = makeService((input) => {
      paths.push(input.url);
      return of({ data: { response: { records: [RECORD], total: 9001 }, version: '3.3.2' } });
    });

    const outcome = await service.strictGetSubscriptionRequestHistory(500);

    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(paths, ['/api/subscription-request-history?start=0&size=500']);
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.total, 9001);
    assert.equal(outcome.value.requestedSize, 500);
    assert.equal(outcome.value.records.length, 1);
    assert.equal(outcome.value.records[0].panelUserId, 1337);
    assert.equal(outcome.detectedVersion, '3.3.2');
  });

  it('reports a 2xx body without a records array as invalidContract, NOT as an empty log', async () => {
    // A panel that changed the log's shape must not read as a panel where
    // nothing happened.
    const service = makeService(() => of({ data: { response: { somethingElse: [] } } }));

    const outcome = await service.strictGetSubscriptionRequestHistory(500);

    assert.equal(outcome.kind, 'invalidContract');
  });

  it('reports a transport failure as unavailable rather than as no records', async () => {
    const service = makeService(() => throwError(() => new Error('socket hang up')));

    const outcome = await service.strictGetSubscriptionRequestHistory(500);

    assert.equal(outcome.kind, 'unavailable');
  });

  it('falls back to the decoded row count when the panel omits a usable total', async () => {
    const service = makeService(() =>
      of({ data: { response: { records: [RECORD, { ...RECORD, id: 43 }], total: 'lots' } } }),
    );

    const outcome = await service.strictGetSubscriptionRequestHistory(500);

    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.total, 2);
  });
});
