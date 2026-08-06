import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { of, throwError } from 'rxjs';

import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import { mapSubscriptionRequestEntry } from '../src/modules/remnawave/services/remnawave-extended-mappers';

/**
 * The subscription-request log reader, pinned to what the 2.7.4 and 2.8.0
 * OpenAPI specs actually declare.
 *
 * This surface shipped with no test at all, which is how it came to send two
 * query parameters that exist in neither spec and to map two response fields
 * that exist in neither either. The wire-level assertions below are therefore
 * deliberately literal: they assert the exact path string, because the whole
 * class of defect here is a plausible-looking parameter name that the panel
 * silently ignores.
 */

/** Records exactly as Remnawave 2.7.4 serves them: owner is a uuid. */
const RECORD_274 = {
  id: 41,
  userUuid: 'b7f1e0c2-1111-2222-3333-444455556666',
  requestIp: '203.0.113.7',
  userAgent: 'v2rayNG/1.8.5',
  requestAt: '2026-08-06T11:59:00.000Z',
};

/** Records exactly as Remnawave 2.8.0 serves them: owner is a numeric id. */
const RECORD_280 = {
  id: 42,
  userId: 1337,
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
      caddyToken: null,
      cookie: null,
    },
  );
}

describe('mapSubscriptionRequestEntry — the owner field is version-dependent', () => {
  it('reads the 2.7.4 record shape, keeping the uuid as a uuid', () => {
    const entry = mapSubscriptionRequestEntry(RECORD_274);
    assert.equal(entry.id, '41');
    assert.equal(entry.userUuid, 'b7f1e0c2-1111-2222-3333-444455556666');
    assert.equal(entry.panelUserId, null);
    assert.equal(entry.ipAddress, '203.0.113.7');
    assert.equal(entry.requestedAt, '2026-08-06T11:59:00.000Z');
    assert.equal(entry.userAgent, 'v2rayNG/1.8.5');
  });

  it('reads the 2.8.0 record shape WITHOUT passing the numeric id off as a uuid', () => {
    // The defect this pins: folding `userId` into `userUuid` produced the
    // string "1337" in a uuid-typed field, so every consumer keyed by
    // subscription uuid missed silently on 2.8.0 and the admin log rendered
    // "1337…" as though it were a uuid prefix.
    const entry = mapSubscriptionRequestEntry(RECORD_280);
    assert.equal(entry.userUuid, null);
    assert.equal(entry.panelUserId, 1337);
    assert.equal(entry.ipAddress, '203.0.113.8');
    assert.equal(entry.requestedAt, '2026-08-06T11:59:30.000Z');
  });

  it('refuses a numeric value arriving under the uuid key', () => {
    const entry = mapSubscriptionRequestEntry({ ...RECORD_274, userUuid: 1337 });
    assert.equal(entry.userUuid, null);
  });

  it('derives the client family from the User-Agent the panel does send', () => {
    // `clientType` is in neither spec. It used to be read straight off the
    // record and was therefore null for every row on every version, leaving
    // the admin table's "client" column permanently blank.
    assert.equal(mapSubscriptionRequestEntry(RECORD_274).clientType, 'v2rayNG');
    assert.equal(mapSubscriptionRequestEntry({ ...RECORD_274, userAgent: null }).clientType, null);
  });

  it('does not throw on a record that is missing everything', () => {
    const entry = mapSubscriptionRequestEntry({});
    assert.equal(entry.userUuid, null);
    assert.equal(entry.panelUserId, null);
    assert.equal(entry.userAgent, null);
  });
});

describe('getSubscriptionRequestHistory — routing and parameter names', () => {
  it('asks the PER-USER endpoint when a uuid is given', async () => {
    // The whole-log endpoint accepts no user filter on either version, so a
    // per-user question has to go to the per-user path or it is answered with
    // the whole panel's log.
    const paths: string[] = [];
    const service = makeService((input) => {
      paths.push(input.url);
      return of({ data: { response: { records: [RECORD_274], total: 1 } } });
    });

    const entries = await service.getSubscriptionRequestHistory({ userUuid: 'user-uuid-1' });

    assert.deepEqual(paths, ['/api/users/user-uuid-1/subscription-request-history']);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].userUuid, 'b7f1e0c2-1111-2222-3333-444455556666');
  });

  it('sends the page bound as "size" — the name the spec declares — not "limit"', async () => {
    const paths: string[] = [];
    const service = makeService((input) => {
      paths.push(input.url);
      return of({ data: { response: { records: [], total: 0 } } });
    });

    await service.getSubscriptionRequestHistory({ limit: 20 });

    assert.deepEqual(paths, ['/api/subscription-request-history?size=20']);
    // `limit` does not exist on either version; a panel served it would ignore
    // it and return its own default page.
    assert.ok(!paths[0].includes('limit'), paths[0]);
  });

  it('never puts a userUuid in the whole-log query string', async () => {
    const paths: string[] = [];
    const service = makeService((input) => {
      paths.push(input.url);
      return of({ data: { response: { records: [], total: 0 } } });
    });

    await service.getSubscriptionRequestHistory({ userUuid: 'u-1', limit: 5 });

    assert.ok(!paths[0].includes('?'), `expected no query string, got ${paths[0]}`);
  });
});

describe('strictGetSubscriptionRequestHistory — a clean log must differ from an unreadable one', () => {
  it('returns ok with the panel total and the requested size', async () => {
    const paths: string[] = [];
    const service = makeService((input) => {
      paths.push(input.url);
      return of({ data: { response: { records: [RECORD_280], total: 9001 }, version: '2.8.0' } });
    });

    const outcome = await service.strictGetSubscriptionRequestHistory(500);

    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(paths, ['/api/subscription-request-history?start=0&size=500']);
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.total, 9001);
    assert.equal(outcome.value.requestedSize, 500);
    assert.equal(outcome.value.records.length, 1);
    assert.equal(outcome.value.records[0].panelUserId, 1337);
    assert.equal(outcome.detectedVersion, '2.8.0');
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
      of({ data: { response: { records: [RECORD_274, RECORD_280], total: 'lots' } } }),
    );

    const outcome = await service.strictGetSubscriptionRequestHistory(500);

    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.total, 2);
  });
});
