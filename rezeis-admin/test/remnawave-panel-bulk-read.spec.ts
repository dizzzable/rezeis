/**
 * The bulk panel read is the input to a DESTRUCTIVE decision: a subscription
 * whose UUID is missing from it is written EXPIRED (stealthnet passes a
 * hardcoded ACTIVE, so a miss expires unconditionally). These tests pin the one
 * property that makes that sound — an empty or short list is only ever believed
 * when the adapter can prove it is the whole panel.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { of, throwError } from 'rxjs';

import { SubscriptionStatus } from '@prisma/client';

import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import {
  strictInvalidContract,
  strictOk,
  strictUnavailable,
} from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';
import {
  buildPanelLookup,
  panelSubscriptionState,
  reconcileMissingPanelStatus,
  resolvePanelProfile,
  type PanelAbsenceProbe,
} from '../src/modules/imports/utils/remnawave-overlay.util';
import { RemnawaveImporterService } from '../src/modules/imports/services/remnawave-importer.service';

/**
 * The absence probe for every path that must NOT need one: a bulk hit, a miss
 * on a blessed map, an unreachable panel, and a per-uuid read that found the
 * profile. Reaching it is the failure — a healthy read may not cost an extra
 * round trip, and no verdict here comes from a strict confirmation.
 */
const NEVER_CONFIRMED: PanelAbsenceProbe = {
  confirmAbsence: () => assert.fail('no absence confirmation should be needed here'),
  onUnconfirmed: (uuid, reason) => assert.fail(`unexpected degrade for ${uuid}: ${reason}`),
};

const CONFIG = {
  host: 'remnawave',
  port: 3000,
  token: 'secret',
  webhookSecret: null,
  caddyToken: null,
  cookie: null,
} as const;

function axiosError(status: number, headers: Record<string, string> = {}, data?: unknown) {
  return { isAxiosError: true, response: { status, headers, data }, message: `HTTP ${status}` };
}

/**
 * The body Remnawave sends with a 404 for a uuid it does not have
 * (USER_NOT_FOUND / `A025`, see `@remnawave/backend-contract`). The strict
 * per-uuid read only says `notFound` for a 404 that carries it — a bare 404 is
 * a proxy with no healthy backend, and reading that as "gone" expires live
 * customers on a deploy.
 */
const USER_NOT_FOUND_BODY = { errorCode: 'A025', message: 'User not found' } as const;

/** A service whose `/api/users` pages are produced by `handler`. */
function build(handler: (start: number) => unknown) {
  const requestedStarts: number[] = [];
  const service = new RemnawaveApiService(
    {
      request: (input: { url: string }) => {
        const start = Number.parseInt(
          new URL(input.url, 'http://x').searchParams.get('start') ?? '0',
          10,
        );
        requestedStarts.push(start);
        return handler(start);
      },
    } as never,
    CONFIG as never,
  );
  return { service, requestedStarts };
}

/** A well-formed panel row (2.7.4/2.8.0 wire shape). */
function row(uuid: string, over: Record<string, unknown> = {}) {
  return {
    uuid,
    username: `name-${uuid}`,
    status: 'ACTIVE',
    subscriptionUrl: `https://example.test/${uuid}`,
    telegramId: 42,
    id: 7,
    email: null,
    expireAt: '2030-01-01T00:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastTrafficResetAt: null,
    trafficLimitBytes: 0,
    hwidDeviceLimit: 3,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    description: null,
    activeInternalSquads: [],
    externalSquadUuid: null,
    ...over,
  };
}

function page(users: unknown[], total: number, version = '2.8.0') {
  return of({ data: { response: { users, total }, version } });
}

/**
 * A service backed by an in-memory panel roster.
 *
 * `/api/users` pages honour `start` and the panel's OWN page size (`pageCap`,
 * which may be smaller than the size we ask for), and `/api/users/{uuid}`
 * answers from the same roster — so a test drives the REAL bulk read and the
 * REAL per-uuid confirmation the importers wire together
 * (`resolvePanelProfile(uuid, lookup, (u) => remnawaveApiService.getPanelUser(u))`),
 * rather than a stub of either. `roster` is a thunk so a test can mutate the
 * panel between pages, which is the case offset pagination cannot survive.
 */
function buildPanel(
  roster: () => readonly string[],
  options: {
    readonly pageCap?: number;
    readonly total?: unknown;
    readonly noTotal?: boolean;
    readonly afterPage?: () => void;
  } = {},
) {
  const cap = options.pageCap ?? 500;
  const requestedStarts: number[] = [];
  const profileReads: string[] = [];
  const service = new RemnawaveApiService(
    {
      request: (input: { url: string }) => {
        const url = new URL(input.url, 'http://x');
        const single = /^\/api\/users\/(.+)$/.exec(url.pathname);
        if (single !== null) {
          const uuid = single[1];
          profileReads.push(uuid);
          return roster().includes(uuid)
            ? of({ data: { response: row(uuid) } })
            : throwError(() => axiosError(404, {}, USER_NOT_FOUND_BODY));
        }
        const start = Number.parseInt(url.searchParams.get('start') ?? '0', 10);
        requestedStarts.push(start);
        const users = roster()
          .slice(start, start + cap)
          .map((u) => row(u));
        const body: Record<string, unknown> = { users };
        if (options.noTotal !== true) body.total = options.total ?? roster().length;
        const response = of({ data: { response: body, version: '2.8.0' } });
        options.afterPage?.();
        return response;
      },
    } as never,
    CONFIG as never,
  );
  return { service, requestedStarts, profileReads };
}

describe('strictGetAllPanelUsers — an empty list is only believed when it is proven', () => {
  it('a genuinely empty panel (no rows, total 0) is ok([])', async () => {
    const { service } = build(() => page([], 0));
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.deepEqual(outcome.value.users, []);
    assert.equal(outcome.value.total, 0);
  });

  it('rows arrived but NONE could be decoded → not ok', async () => {
    const { service } = build(() => page([row(''), row(''), row('')], 3));
    const outcome = await service.strictGetAllPanelUsers();
    assert.notEqual(outcome.kind, 'ok');
    assert.equal(outcome.kind, 'invalidContract');
    if (outcome.kind !== 'invalidContract') return;
    assert.match(outcome.details, /3 user rows and none carried a usable uuid/);
  });

  it('a single dropped row (decoded < total) → not ok', async () => {
    const { service } = build(() => page([row('a'), row(''), row('c')], 3));
    const outcome = await service.strictGetAllPanelUsers();
    assert.notEqual(outcome.kind, 'ok');
    assert.equal(outcome.kind, 'invalidContract');
    if (outcome.kind !== 'invalidContract') return;
    assert.match(outcome.details, /decoded 2 of 3 rows/);
  });

  it('a row we could not decode refuses the read even when it is also truncated', async () => {
    const { service } = build((start) =>
      page(
        Array.from({ length: 500 }, (_, i) =>
          start === 0 && i === 0 ? row('') : row(`u-${start + i}`),
        ),
        30_000,
      ),
    );
    const outcome = await service.strictGetAllPanelUsers();
    // The old arithmetic made 24 999 < 25 000 read as "under the ceiling, so
    // complete" — the shortfall was the evidence of completeness. Truncation
    // alone is now a usable read (see below), so the refusal here has to come
    // from the dropped row: a lost identity outranks a short list.
    assert.notEqual(outcome.kind, 'ok');
    assert.equal(outcome.kind, 'invalidContract');
    if (outcome.kind !== 'invalidContract') return;
    assert.match(outcome.details, /decoded 24999 of 25000 rows/);

    const lookup = await buildPanelLookup(() => Promise.resolve(outcome));
    assert.equal(lookup.reachable, false);
    assert.equal(lookup.complete, false);
  });

  it('a page that errored mid-read → not ok (never a shorter panel)', async () => {
    const { service } = build((start) =>
      start === 0
        ? page(Array.from({ length: 500 }, (_, i) => row(`u-${i}`)), 3000)
        : throwError(() => axiosError(503, { 'retry-after': '30' })),
    );
    const outcome = await service.strictGetAllPanelUsers();
    assert.notEqual(outcome.kind, 'ok');
    assert.equal(outcome.kind, 'unavailable');
    if (outcome.kind !== 'unavailable') return;
    assert.equal(outcome.retryAfterMs, 30_000);

    const lookup = await buildPanelLookup(() => Promise.resolve(outcome));
    assert.equal(lookup.reachable, false);
  });

  it('a page with no "users" array at all → not ok', async () => {
    const { service } = build(() => of({ data: { response: { total: 7 } } }));
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'invalidContract');
    if (outcome.kind !== 'invalidContract') return;
    assert.match(outcome.details, /page 0 has no "users" array/);
  });

  it('an empty read is believed only when the panel itself confirms it', async () => {
    // Zero rows carry no information on their own, so this is the ONE place
    // `total` is still mandatory: without it "the panel has no users" and "this
    // build answered with an empty page" are the same bytes, and reading the
    // second as the first mass-expires a whole customer base.
    const { service } = build(() => of({ data: { response: { users: [] } } }));
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'invalidContract');

    const contradictory = build(() => page([], 5));
    const outcome2 = await contradictory.service.strictGetAllPanelUsers();
    assert.equal(outcome2.kind, 'invalidContract');
    if (outcome2.kind !== 'invalidContract') return;
    assert.match(outcome2.details, /no user rows but reported a total of 5/);
  });

  it('pagination walks RAW rows, so a dropped row cannot shift the cursor', async () => {
    const { service, requestedStarts } = build(() =>
      page([...Array.from({ length: 499 }, (_, i) => row(`u-${i}`)), row('')], 500),
    );
    await service.strictGetAllPanelUsers();
    // Counting decoded rows (499) would leave the cursor short of the total and
    // fetch a second page that does not exist.
    assert.deepEqual(requestedStarts, [0]);
  });
});

describe('strictGetAllPanelUsers — healthy 2.7.4 / 2.8.0 reads are unchanged', () => {
  it('a single-page panel decodes every row and reports the panel version', async () => {
    const { service, requestedStarts } = build(() =>
      page([row('a'), row('b'), row('c')], 3, '2.7.4'),
    );
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.deepEqual(
      outcome.value.users.map((u) => u.uuid),
      ['a', 'b', 'c'],
    );
    assert.equal(outcome.value.total, 3);
    assert.equal(outcome.value.users[0].hwidDeviceLimit, 3);
    assert.equal(outcome.value.users[0].panelId, 7);
    assert.equal(outcome.detectedVersion, '2.7.4');
    assert.deepEqual(requestedStarts, [0]);
  });

  it('a multi-page panel paginates to exactly the reported total', async () => {
    const total = 1200;
    const { service, requestedStarts } = build((start) =>
      page(
        Array.from({ length: Math.min(500, total - start) }, (_, i) => row(`u-${start + i}`)),
        total,
      ),
    );
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users.length, total);
    assert.equal(outcome.value.total, total);
    assert.deepEqual(requestedStarts, [0, 500, 1000]);
  });

  it('an unconfigured integration is unavailable, not an empty panel', async () => {
    const service = new RemnawaveApiService(
      { request: () => of({ data: {} }) } as never,
      { ...CONFIG, token: null } as never,
    );
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'unavailable');
  });
});

describe('buildPanelLookup — only a vouched-for read may say "this profile is gone"', () => {
  it('an ok read is reachable and complete, keyed by uuid', async () => {
    const { service } = build(() => page([row('a'), row('b')], 2));
    const lookup = await buildPanelLookup(() => service.strictGetAllPanelUsers());
    assert.equal(lookup.reachable, true);
    assert.equal(lookup.complete, true);
    assert.equal(lookup.map.get('b')?.username, 'name-b');
  });

  it('every non-ok outcome is unreachable — never complete', async () => {
    for (const outcome of [
      strictInvalidContract<never>('parsed nothing'),
      strictUnavailable<never>(),
    ]) {
      const lookup = await buildPanelLookup(() => Promise.resolve(outcome as never));
      assert.equal(lookup.reachable, false, `${outcome.kind} must not be reachable`);
      assert.equal(lookup.complete, false, `${outcome.kind} must not be complete`);
      assert.equal(lookup.map.size, 0);
    }
  });

  it('a thrown bulk read is unreachable rather than an empty panel', async () => {
    const lookup = await buildPanelLookup(() => Promise.reject(new Error('boom')));
    assert.equal(lookup.reachable, false);
    assert.equal(lookup.complete, false);
  });
});

describe('per-caller treatment: the panel importer REFUSES, it does not degrade', () => {
  /**
   * `RemnawaveImporterService` writes for every row it is handed: it creates
   * users, rebinds `Subscription.userId`, and records `createdUserIds` as the
   * rollback set. A shortened list would make that rollback set describe a run
   * that never happened — so it must never reach the loop at all.
   */
  function importer(outcome: unknown) {
    return new RemnawaveImporterService(
      {
        user: {
          findUnique: async () => assert.fail('the importer must not touch the DB'),
        },
        importRecord: { create: async () => assert.fail('no import record on a refused run') },
      } as never,
      { strictGetAllPanelUsers: async () => outcome } as never,
    );
  }

  const RUN = { mode: 'import' as const, createdBy: null };

  it('refuses a read whose rows could not be decoded', async () => {
    await assert.rejects(
      () => importer(strictInvalidContract('4 user rows and none carried a usable uuid')).run(RUN),
      /REMNAWAVE_INTEGRATION_UNAVAILABLE/,
    );
  });

  it('refuses a read cut short by a transport failure', async () => {
    await assert.rejects(
      () => importer(strictUnavailable()).run(RUN),
      /REMNAWAVE_INTEGRATION_UNAVAILABLE/,
    );
  });

  it('refuses a read that stopped at the page ceiling — a PREFIX is not a smaller panel', async () => {
    // The one refusal `kind` cannot express: these rows are REAL, so the read is
    // `ok` and only `complete: false` says the list ends where the page budget
    // did. Consumed as-is, a 30 000-user panel imports 25 000, finishes
    // COMMITTED with `errors: []` — green in the SPA — while 5 000 paying
    // customers have no account and `rollback.createdUserIds` describes only the
    // prefix. The overlay consumers survive a prefix because they confirm every
    // miss per-uuid; this importer has no second signal and never looks for one.
    await assert.rejects(
      () => importer(strictOk({ users: [row('u-1')], total: 30_000, complete: false })).run(RUN),
      /REMNAWAVE_INTEGRATION_UNAVAILABLE/,
    );
  });

  it('proceeds on a read the adapter vouches for as the WHOLE panel', async () => {
    // The other half of the guard: `complete: true` is the healthy 2.7.4/2.8.0
    // read, and it must still import. A refusal that fires on every panel is not
    // a safer importer, it is a broken one.
    const users: string[] = [];
    const service = new RemnawaveImporterService(
      {
        user: {
          findUnique: async () => {
            users.push('looked-up');
            return null;
          },
        },
        subscription: { findFirst: async () => null },
        importRecord: { create: async () => ({ id: 'import-1' }) },
      } as never,
      {
        strictGetAllPanelUsers: async () =>
          strictOk({ users: [row('u-1'), row('u-2')], total: 2, complete: true }),
      } as never,
    );
    const summary = await service.run({ mode: 'sync', createdBy: null });
    assert.equal(summary.fetched, 2);
    assert.deepEqual(summary.errors, []);
    assert.equal(users.length > 0, true, 'a vouched-for read must reach the row loop');
  });

  it('refuses when the bulk read throws outright', async () => {
    const service = new RemnawaveImporterService(
      { user: { findUnique: async () => assert.fail('unreachable') } } as never,
      {
        strictGetAllPanelUsers: async () => {
          throw new Error('socket hang up');
        },
      } as never,
    );
    await assert.rejects(() => service.run(RUN), /REMNAWAVE_INTEGRATION_UNAVAILABLE/);
  });
});

describe('the destruction path: a lossy read must not expire a live subscription', () => {
  it('keeps ACTIVE when every row of the panel read was dropped', async () => {
    const { service } = build(() => page([row(''), row('')], 2));
    const lookup = await buildPanelLookup(() => service.strictGetAllPanelUsers());
    const { panel, known } = await resolvePanelProfile(
      'live-uuid',
      lookup,
      async () => null,
      NEVER_CONFIRMED,
    );
    assert.equal(panel, null);
    assert.equal(known, false, 'a miss on an unvouched-for map is NOT a verdict');
    // stealthnet-importer.service.ts passes a hardcoded ACTIVE here, so
    // `known === true` would expire the subscription unconditionally.
    assert.equal(
      reconcileMissingPanelStatus(known, SubscriptionStatus.ACTIVE),
      SubscriptionStatus.ACTIVE,
    );
  });

  it('still expires a live backup row when the panel read IS vouched for', async () => {
    const { service } = build(() => page([row('someone-else')], 1));
    const lookup = await buildPanelLookup(() => service.strictGetAllPanelUsers());
    const { known } = await resolvePanelProfile(
      'gone-uuid',
      lookup,
      async () => null,
      NEVER_CONFIRMED,
    );
    assert.equal(known, true);
    assert.equal(
      reconcileMissingPanelStatus(known, SubscriptionStatus.ACTIVE),
      SubscriptionStatus.EXPIRED,
    );
  });
});

describe('a panel past the page ceiling is TRUNCATED, not invalid', () => {
  /** 30 000 users: five thousand of them live past the 50 × 500 page budget. */
  const BIG = Array.from({ length: 30_000 }, (_, i) => `u-${i}`);

  it('reads as ok, and says out loud that the list is incomplete', async () => {
    const { service, requestedStarts } = buildPanel(() => BIG);
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users.length, 25_000);
    assert.equal(outcome.value.total, 30_000, "the panel's own count, not what we managed to read");
    assert.equal(outcome.value.complete, false);
    assert.equal(requestedStarts.length, 50);
    assert.equal(requestedStarts[49], 24_500);
  });

  it('leaves the overlay ON: reachable, and only its misses are unresolved', async () => {
    const { service, profileReads } = buildPanel(() => BIG);
    const lookup = await buildPanelLookup(() => service.strictGetAllPanelUsers());
    assert.equal(lookup.reachable, true, 'refusing a truncated read switches the whole overlay off');
    assert.equal(lookup.complete, false);
    assert.equal(lookup.map.size, 25_000);

    // A hit inside the prefix still overlays live state with zero extra calls.
    const hit = await resolvePanelProfile(
      'u-10',
      lookup,
      (uuid) => service.getPanelUser(uuid),
      NEVER_CONFIRMED,
    );
    assert.equal(hit.known, true);
    assert.equal(hit.panel?.uuid, 'u-10');
    assert.deepEqual(profileReads, [], 'a hit must not cost a per-uuid round trip');
  });

  it('confirms a user living PAST the ceiling per-uuid instead of expiring them', async () => {
    const { service, profileReads } = buildPanel(() => BIG);
    const lookup = await buildPanelLookup(() => service.strictGetAllPanelUsers());
    const { panel, known } = await resolvePanelProfile(
      'u-29999',
      lookup,
      (uuid) => service.getPanelUser(uuid),
      // A profile that comes back needs no absence confirmation — the panel
      // served it. `NEVER_CONFIRMED` is the assertion that it costs no second
      // round trip on the common miss (a user living past the ceiling).
      NEVER_CONFIRMED,
    );
    assert.deepEqual(profileReads, ['u-29999'], 'the fetchOne confirmation path must be reached');
    assert.equal(known, true);
    if (panel === null) return assert.fail('the panel does have this profile');
    assert.equal(panel.uuid, 'u-29999');
    // The customer's subscription is refreshed from the panel, not expired and
    // not left on a stale backup value.
    assert.equal(panelSubscriptionState(panel).status, SubscriptionStatus.ACTIVE);
  });

  it('still expires a uuid the panel really does not have, after confirming it', async () => {
    const { service, profileReads } = buildPanel(() => BIG);
    const lookup = await buildPanelLookup(() => service.strictGetAllPanelUsers());
    const unconfirmed: string[] = [];
    const { panel, known } = await resolvePanelProfile(
      'gone-uuid',
      lookup,
      (uuid) => service.getPanelUser(uuid),
      {
        // The REAL strict read of the same panel: it answers 404 → `notFound`,
        // which is the only outcome allowed to mean "this profile is gone".
        confirmAbsence: (uuid) => service.strictGetPanelUserExpiry(uuid),
        onUnconfirmed: (uuid, reason) => unconfirmed.push(`${uuid}: ${reason}`),
      },
    );
    // Two reads of the same uuid: the best-effort one that returned nothing,
    // and the strict one that proved the nothing.
    assert.deepEqual(profileReads, ['gone-uuid', 'gone-uuid']);
    assert.deepEqual(unconfirmed, [], 'a proven 404 is not a degrade');
    assert.equal(panel, null);
    assert.equal(known, true);
    assert.equal(
      reconcileMissingPanelStatus(known, SubscriptionStatus.ACTIVE),
      SubscriptionStatus.EXPIRED,
    );
  });

  it('is REFUSED by the native importer, which cannot confirm a miss per-uuid', async () => {
    // Not a mocked outcome: the REAL adapter walks the REAL 30 000-row panel and
    // the REAL importer decides what to do with what comes out.
    //
    // This asserted the opposite until now — `fetched: 25_000`, `errors: []`,
    // status COMMITTED — on the reasoning that refusing would switch the overlay
    // off for the biggest panels. That reasoning belongs to the OVERLAY
    // consumers (stealthnet/remnashop/altshop), which keep the prefix precisely
    // because they settle every miss with a per-uuid read. This importer is not
    // one of them: it WRITES for every row it is handed, creates users, rebinds
    // `Subscription.userId`, and reports `rollback.createdUserIds` as the undo
    // set. Handing it a prefix does not import less of the panel — it produces a
    // run whose success report and whose rollback set both describe something
    // that never happened, while 5 000 paying customers silently have no
    // account. Its own contract, unchanged since it was written: "anything short
    // of a vouched-for read refuses."
    const { service } = buildPanel(() => BIG);
    const touched: string[] = [];
    const importer = new RemnawaveImporterService(
      {
        user: {
          findUnique: async () => {
            touched.push('user.findUnique');
            return null;
          },
        },
        subscription: { findFirst: async () => null },
        importRecord: {
          create: async () => {
            touched.push('importRecord.create');
            return { id: 'import-1' };
          },
        },
      } as never,
      service as never,
    );

    await assert.rejects(
      () => importer.run({ mode: 'sync', createdBy: null }),
      /REMNAWAVE_INTEGRATION_UNAVAILABLE/,
    );
    // The blast radius, spelled out: without the refusal this run reached the
    // row loop 25 000 times and then wrote a COMMITTED record over it.
    assert.deepEqual(touched, [], 'a prefix must reach neither the row loop nor the import record');
  });
});

describe('`total` is read defensively — a 2.7.4/2.8.0 divergence must not switch the overlay off', () => {
  const PANEL = Array.from({ length: 1200 }, (_, i) => `u-${i}`);

  it('a build that reports no total at all is still read to the end', async () => {
    const { service, requestedStarts } = buildPanel(() => PANEL, { noTotal: true });
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users.length, 1200);
    assert.equal(outcome.value.total, 1200, 'falls back to the decoded count, like the device readers');
    assert.equal(outcome.value.complete, true);
    // A page shorter than the panel's own page size is the end-of-list signal
    // that survives when there is no total to consult.
    assert.deepEqual(requestedStarts, [0, 500, 1000]);
  });

  it('a total that is not a number does not throw away rows that all arrived', async () => {
    const { service } = buildPanel(() => ['a', 'b'], { total: '2' });
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.deepEqual(
      outcome.value.users.map((u) => u.uuid),
      ['a', 'b'],
    );
    assert.equal(outcome.value.total, 2);
    assert.equal(outcome.value.complete, true);
  });

  it('a panel that clamps `size` server-side is walked to the end, not cut at the clamp', async () => {
    const { service, requestedStarts } = buildPanel(() => PANEL, { pageCap: 250 });
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users.length, 1200, 'every clamped page must be picked up');
    assert.equal(outcome.value.total, 1200);
    assert.equal(outcome.value.complete, true);
    // The cursor advances by rows RECEIVED (250), never by the size we asked
    // for (500) — otherwise every other 250 users would be skipped.
    assert.deepEqual(requestedStarts, [0, 250, 500, 750, 1000]);
  });

  it('a clamped panel does not expire the users that live past the clamp', async () => {
    const { service, profileReads } = buildPanel(() => PANEL, { pageCap: 100 });
    const lookup = await buildPanelLookup(() => service.strictGetAllPanelUsers());
    assert.equal(lookup.reachable, true);
    assert.equal(lookup.map.size, 1200);
    const { panel, known } = await resolvePanelProfile(
      'u-1199',
      lookup,
      (uuid) => service.getPanelUser(uuid),
      NEVER_CONFIRMED,
    );
    assert.equal(known, true);
    assert.deepEqual(profileReads, [], 'a clamped page is not a reason to re-read every uuid');
    if (panel === null) return assert.fail('u-1199 lives past the clamp but is on the panel');
    assert.equal(panel.uuid, 'u-1199');
    assert.equal(panelSubscriptionState(panel).status, SubscriptionStatus.ACTIVE);
  });

  it('a clamping panel that ALSO reports no total is still walked to the end', async () => {
    const SMALL = Array.from({ length: 600 }, (_, i) => `u-${i}`);
    const { service, requestedStarts } = buildPanel(() => SMALL, { pageCap: 100, noTotal: true });
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users.length, 600);
    assert.equal(outcome.value.complete, true);
    // Six clamped pages plus the empty one that proves the list ended: with no
    // total, "shorter than the size we asked for" would have stopped at 100.
    assert.deepEqual(requestedStarts, [0, 100, 200, 300, 400, 500, 600]);
  });
});

describe('what a MISS in a blessed list actually proves', () => {
  /**
   * CHARACTERIZATION, not a guard: this pins the limitation the doc comment now
   * states, and it behaves the same before and after this change — the count
   * check has never been able to see it.
   */
  it('a delete between pages hides a LIVE user, and the arithmetic still reconciles', async () => {
    let live: readonly string[] = Array.from({ length: 1200 }, (_, i) => `u-${i}`);
    let served = 0;
    const { service } = buildPanel(() => live, {
      afterPage: () => {
        // u-100 — already served on page 0 — is deleted before page 1 is asked
        // for. Every later row shifts one place left.
        served += 1;
        if (served === 1) live = live.filter((u) => u !== 'u-100');
      },
    });

    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users.length, 1199);
    assert.equal(outcome.value.total, 1199);
    assert.equal(outcome.value.complete, true, 'decoded === total, so the read is blessed');

    const lookup = await buildPanelLookup(() => Promise.resolve(outcome));
    // The deleted user is still IN the map — we read his row before he went.
    // That one is harmless: it overlays a slightly stale but real profile.
    assert.equal(lookup.map.has('u-100'), true);
    // u-500 is ALIVE on the panel and simply shifted across the page boundary
    // before we asked for it. The count cannot notice: the panel's own total
    // fell by exactly the one row we really did lose.
    assert.equal(lookup.map.has('u-500'), false);
    assert.equal(live.includes('u-500'), true);

    const { panel, known } = await resolvePanelProfile(
      'u-500',
      lookup,
      (uuid) => service.getPanelUser(uuid),
      // A blessed map answers on its own: the per-uuid seam is never reached,
      // so there is nothing for a confirmation to correct.
      NEVER_CONFIRMED,
    );
    assert.equal(panel, null);
    assert.equal(known, true);
    // …and stealthnet passes a hardcoded ACTIVE here, so a paying customer
    // whose profile is fine is written EXPIRED. A miss is EVIDENCE, not proof.
    assert.equal(
      reconcileMissingPanelStatus(known, SubscriptionStatus.ACTIVE),
      SubscriptionStatus.EXPIRED,
    );
    // The second signal that WOULD settle it — a targeted read of that one
    // uuid — is available and disagrees with the miss. Wiring it into the
    // complete-map path is deliberately left out of this change.
    const confirmation = await service.getPanelUser('u-500');
    assert.equal(confirmation?.uuid, 'u-500');
  });
});
