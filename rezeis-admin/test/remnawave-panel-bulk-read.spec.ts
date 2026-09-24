/**
 * The bulk panel read is the input to a DESTRUCTIVE decision: a subscription
 * whose identity is missing from it is written EXPIRED (stealthnet passes a
 * hardcoded ACTIVE, so a miss expires unconditionally). These tests pin the one
 * property that makes that sound — an empty or short list is only ever believed
 * when the adapter can prove it is the whole panel.
 *
 * Every row here is a 3.x row, keyed by its numeric `id`: that is the only
 * identity the decoder reads. A row with no usable id is the "dropped row" the
 * read must refuse over.
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
 * on a blessed map, an unreachable panel, and a per-profile read that found the
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
} as const;

function axiosError(status: number, headers: Record<string, string> = {}, data?: unknown) {
  return { isAxiosError: true, response: { status, headers, data }, message: `HTTP ${status}` };
}

/**
 * The body Remnawave sends with a 404 for a profile it does not have
 * (USER_NOT_FOUND / `A025`, see `@remnawave/backend-contract`). The strict
 * per-profile read only says `notFound` for a 404 that carries it — a bare 404
 * is a proxy with no healthy backend, and reading that as "gone" expires live
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
        // Only the page walk is recorded. The panel-version probe
        // (`/api/system/...`) carries no `start`, so it would otherwise be
        // logged as a page-0 request and make every "which offsets were asked
        // for" assertion in this file read two phantom pages.
        //
        // The probe deliberately gets no version here: these tests are about
        // the OFFSET walk, and a fake that answered `3.2.1` would silently move
        // them onto the keyset path where `start` does not exist at all.
        if (!input.url.startsWith('/api/system/')) requestedStarts.push(start);
        return handler(start);
      },
    } as never,
    CONFIG as never,
  );
  return { service, requestedStarts };
}

/**
 * A well-formed 3.x panel row, keyed by the numeric id `key` names. An empty
 * `key` is a row with no usable id — the one the decoder must drop.
 */
function row(key: string, over: Record<string, unknown> = {}) {
  return {
    id: key === '' ? null : Number(key),
    username: `name-${key}`,
    status: 'ACTIVE',
    subscriptionUrl: `https://example.test/${key}`,
    telegramId: 42,
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

/**
 * An ALREADY-DECODED panel user, for the cases that hand a list straight to the
 * overlay or the importer rather than through the adapter. Its `uuid` is the
 * identity string the lookup is keyed by.
 */
function decodedUser(identity: string) {
  return {
    ...row(''),
    uuid: identity,
    panelId: /^\d+$/.test(identity) ? Number(identity) : null,
    username: `name-${identity}`,
  } as never;
}

function page(users: unknown[], total: number, version = '3.3.2') {
  return of({ data: { response: { users, total }, version } });
}

/** `count` decimal identities, `1…count`, as the panel would number them. */
function ids(count: number, from = 1): string[] {
  return Array.from({ length: count }, (_, i) => String(from + i));
}

/**
 * A service backed by an in-memory panel roster.
 *
 * `/api/users` pages honour `start` and the panel's OWN page size (`pageCap`,
 * which may be smaller than the size we ask for), and `/api/users/{id}`
 * answers from the same roster — so a test drives the REAL bulk read and the
 * REAL per-profile confirmation the importers wire together
 * (`resolvePanelProfile(id, lookup, (u) => remnawaveApiService.getPanelUser(u))`),
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
        // The panel-version probe, answered with no version on purpose. These
        // tests are about the OFFSET walk; letting the probe report a 3.x would
        // move them onto the keyset path, where `start` does not exist and
        // every assertion below would be measuring a walk that never ran.
        if (url.pathname.startsWith('/api/system/')) {
          return of({ data: { response: {} } });
        }
        const single = /^\/api\/users\/(.+)$/.exec(url.pathname);
        if (single !== null) {
          const id = single[1];
          profileReads.push(id);
          return roster().includes(id)
            ? of({ data: { response: row(id) } })
            : throwError(() => axiosError(404, {}, USER_NOT_FOUND_BODY));
        }
        const start = Number.parseInt(url.searchParams.get('start') ?? '0', 10);
        requestedStarts.push(start);
        const users = roster()
          .slice(start, start + cap)
          .map((u) => row(u));
        const body: Record<string, unknown> = { users };
        if (options.noTotal !== true) body.total = options.total ?? roster().length;
        const response = of({ data: { response: body, version: '3.3.2' } });
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
    assert.match(outcome.details, /3 user rows and none carried a usable numeric id/);
  });

  it('a row carrying only a uuid is a dropped row, not a keyed one', async () => {
    // What a 2.x panel sent. Keyed by the uuid, it would match a stored 2.x
    // link and hide the fact that the list is not a 3.x list at all.
    const { service } = build(() =>
      page([row('1'), row('', { uuid: '11111111-1111-4111-8111-111111111111' })], 2),
    );
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'invalidContract');
    if (outcome.kind !== 'invalidContract') return;
    assert.match(outcome.details, /decoded 1 of 2 rows/);
  });

  it('a single dropped row (decoded < total) → not ok', async () => {
    const { service } = build(() => page([row('1'), row(''), row('3')], 3));
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
          start === 0 && i === 0 ? row('') : row(String(start + i + 1)),
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
        ? page(ids(500).map((id) => row(id)), 3000)
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
      page([...ids(499).map((id) => row(id)), row('')], 500),
    );
    await service.strictGetAllPanelUsers();
    // Counting decoded rows (499) would leave the cursor short of the total and
    // fetch a second page that does not exist.
    assert.deepEqual(requestedStarts, [0]);
  });
});

describe('strictGetAllPanelUsers — healthy offset reads', () => {
  it('a single-page panel decodes every row and reports the panel version', async () => {
    const { service, requestedStarts } = build(() =>
      page([row('1'), row('2'), row('3')], 3, '3.2.1'),
    );
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.deepEqual(
      outcome.value.users.map((u) => u.uuid),
      ['1', '2', '3'],
    );
    assert.equal(outcome.value.total, 3);
    assert.equal(outcome.value.users[0].hwidDeviceLimit, 3);
    assert.equal(outcome.value.users[0].panelId, 1);
    assert.equal(outcome.detectedVersion, '3.2.1');
    assert.deepEqual(requestedStarts, [0]);
  });

  it('a multi-page panel paginates to exactly the reported total', async () => {
    const total = 1200;
    const { service, requestedStarts } = build((start) =>
      page(
        ids(Math.min(500, total - start), start + 1).map((id) => row(id)),
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
  it('an ok read is reachable and complete, keyed by the numeric id', async () => {
    const { service } = build(() => page([row('1'), row('2')], 2));
    const lookup = await buildPanelLookup(() => service.strictGetAllPanelUsers());
    assert.equal(lookup.reachable, true);
    assert.equal(lookup.complete, true);
    assert.equal(lookup.keyKind, 'id');
    assert.equal(lookup.map.get('2')?.username, 'name-2');
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
      () => importer(strictInvalidContract('4 user rows and none carried a usable numeric id')).run(RUN),
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
    // miss per profile; this importer has no second signal and never looks for one.
    await assert.rejects(
      () => importer(strictOk({ users: [decodedUser('1')], total: 30_000, complete: false })).run(RUN),
      /REMNAWAVE_INTEGRATION_UNAVAILABLE/,
    );
  });

  it('proceeds on a read the adapter vouches for as the WHOLE panel', async () => {
    // The other half of the guard: `complete: true` is the healthy read, and it
    // must still import. A refusal that fires on every panel is not a safer
    // importer, it is a broken one.
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
          strictOk({ users: [decodedUser('1'), decodedUser('2')], total: 2, complete: true }),
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
      '4471',
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
    const { service } = build(() => page([row('1')], 1));
    const lookup = await buildPanelLookup(() => service.strictGetAllPanelUsers());
    const { known } = await resolvePanelProfile(
      '2',
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
  const BIG = ids(30_000);

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
      '11',
      lookup,
      (id) => service.getPanelUser(id),
      NEVER_CONFIRMED,
    );
    assert.equal(hit.known, true);
    assert.equal(hit.panel?.uuid, '11');
    assert.deepEqual(profileReads, [], 'a hit must not cost a per-profile round trip');
  });

  it('confirms a user living PAST the ceiling per profile instead of expiring them', async () => {
    const { service, profileReads } = buildPanel(() => BIG);
    const lookup = await buildPanelLookup(() => service.strictGetAllPanelUsers());
    const { panel, known } = await resolvePanelProfile(
      '30000',
      lookup,
      (id) => service.getPanelUser(id),
      // A profile that comes back needs no absence confirmation — the panel
      // served it. `NEVER_CONFIRMED` is the assertion that it costs no second
      // round trip on the common miss (a user living past the ceiling).
      NEVER_CONFIRMED,
    );
    assert.deepEqual(profileReads, ['30000'], 'the fetchOne confirmation path must be reached');
    assert.equal(known, true);
    if (panel === null) return assert.fail('the panel does have this profile');
    assert.equal(panel.uuid, '30000');
    // The customer's subscription is refreshed from the panel, not expired and
    // not left on a stale backup value.
    assert.equal(panelSubscriptionState(panel).status, SubscriptionStatus.ACTIVE);
  });

  it('still expires an id the panel really does not have, after confirming it', async () => {
    const { service, profileReads } = buildPanel(() => BIG);
    const lookup = await buildPanelLookup(() => service.strictGetAllPanelUsers());
    const unconfirmed: string[] = [];
    const { panel, known } = await resolvePanelProfile(
      '99999999',
      lookup,
      (id) => service.getPanelUser(id),
      {
        // The REAL strict read of the same panel: it answers 404 → `notFound`,
        // which is the only outcome allowed to mean "this profile is gone".
        confirmAbsence: (id) => service.strictGetPanelUserExpiry(id),
        onUnconfirmed: (id, reason) => unconfirmed.push(`${id}: ${reason}`),
      },
    );
    // Two reads of the same id: the best-effort one that returned nothing,
    // and the strict one that proved the nothing.
    assert.deepEqual(profileReads, ['99999999', '99999999']);
    assert.deepEqual(unconfirmed, [], 'a proven 404 is not a degrade');
    assert.equal(panel, null);
    assert.equal(known, true);
    assert.equal(
      reconcileMissingPanelStatus(known, SubscriptionStatus.ACTIVE),
      SubscriptionStatus.EXPIRED,
    );
  });

  it('is REFUSED by the native importer, which cannot confirm a miss per profile', async () => {
    // Not a mocked outcome: the REAL adapter walks the REAL 30 000-row panel and
    // the REAL importer decides what to do with what comes out.
    //
    // This asserted the opposite until now — `fetched: 25_000`, `errors: []`,
    // status COMMITTED — on the reasoning that refusing would switch the overlay
    // off for the biggest panels. That reasoning belongs to the OVERLAY
    // consumers (stealthnet/remnashop/altshop), which keep the prefix precisely
    // because they settle every miss with a per-profile read. This importer is
    // not one of them: it WRITES for every row it is handed, creates users,
    // rebinds `Subscription.userId`, and reports `rollback.createdUserIds` as
    // the undo set. Handing it a prefix does not import less of the panel — it
    // produces a run whose success report and whose rollback set both describe
    // something that never happened, while 5 000 paying customers silently
    // have no account. Its own contract, unchanged since it was written:
    // "anything short of a vouched-for read refuses."
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

describe('`total` is read defensively — a build divergence must not switch the overlay off', () => {
  const PANEL = ids(1200);

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
    const { service } = buildPanel(() => ['1', '2'], { total: '2' });
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.deepEqual(
      outcome.value.users.map((u) => u.uuid),
      ['1', '2'],
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
      '1200',
      lookup,
      (id) => service.getPanelUser(id),
      NEVER_CONFIRMED,
    );
    assert.equal(known, true);
    assert.deepEqual(profileReads, [], 'a clamped page is not a reason to re-read every profile');
    if (panel === null) return assert.fail('1200 lives past the clamp but is on the panel');
    assert.equal(panel.uuid, '1200');
    assert.equal(panelSubscriptionState(panel).status, SubscriptionStatus.ACTIVE);
  });

  it('a clamping panel that ALSO reports no total is still walked to the end', async () => {
    const SMALL = ids(600);
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
    let live: readonly string[] = ids(1200);
    let served = 0;
    const { service } = buildPanel(() => live, {
      afterPage: () => {
        // 101 — already served on page 0 — is deleted before page 1 is asked
        // for. Every later row shifts one place left.
        served += 1;
        if (served === 1) live = live.filter((u) => u !== '101');
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
    assert.equal(lookup.map.has('101'), true);
    // 501 is ALIVE on the panel and simply shifted across the page boundary
    // before we asked for it. The count cannot notice: the panel's own total
    // fell by exactly the one row we really did lose.
    assert.equal(lookup.map.has('501'), false);
    assert.equal(live.includes('501'), true);

    const { panel, known } = await resolvePanelProfile(
      '501',
      lookup,
      (id) => service.getPanelUser(id),
      // A blessed map answers on its own: the per-profile seam is never
      // reached, so there is nothing for a confirmation to correct.
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
    // profile — is available and disagrees with the miss. Wiring it into the
    // complete-map path is deliberately left out of this change.
    const confirmation = await service.getPanelUser('501');
    assert.equal(confirmation?.uuid, '501');
  });
});

describe('a panel keyed differently from what we stored — the upgrade-day trap', () => {
  /**
   * After a 2.x → 3.x upgrade the panel's rows decode to their numeric id while
   * `Subscription.remnawaveId` still holds the 2.x uuid it was created with.
   * Every lookup then misses, and a COMPLETE list used to turn that into "the
   * panel proves this profile is gone" — for the entire customer base at once,
   * on the first import after the upgrade, writing EXPIRED over live paying
   * subscriptions. A namespace mismatch is not evidence of absence.
   */
  function idKeyedPanel() {
    return buildPanelLookup(async () =>
      strictOk({
        users: [decodedUser('4821'), decodedUser('4822')],
        total: 2,
        complete: true,
      }),
    );
  }

  it('refuses to read a miss as "gone" when the list is keyed by numeric id', async () => {
    const lookup = await idKeyedPanel();
    assert.equal(lookup.keyKind, 'id');

    const degrades: string[] = [];
    const resolved = await resolvePanelProfile(
      '330f2b38-1362-46ab-b5c0-dea32167eff9',
      lookup,
      async () => assert.fail('a namespace mismatch must not cost a per-profile read'),
      {
        confirmAbsence: async () => assert.fail('nothing may be confirmed absent here'),
        onUnconfirmed: (_uuid, reason) => degrades.push(reason),
      },
    );

    assert.deepEqual(resolved, { panel: null, known: false });
    assert.equal(degrades.length, 1, 'the gap must be visible, not silent');
    assert.match(degrades[0], /keyed by id/);
  });

  it('still resolves an identifier that IS in the list namespace', async () => {
    const lookup = await idKeyedPanel();
    const resolved = await resolvePanelProfile('4821', lookup, async () => null, NEVER_CONFIRMED);
    assert.equal(resolved.known, true);
    assert.equal(resolved.panel?.uuid, '4821');
  });

  it('a hand-built uuid-keyed list still proves absence for a uuid — the overlay rule is symmetric', async () => {
    // No adapter read produces such a list any more (a row is keyed by its
    // numeric id or dropped); this pins the overlay's own rule, which does not
    // depend on where the list came from.
    const lookup = await buildPanelLookup(async () =>
      strictOk({
        users: [decodedUser('11111111-1111-4111-8111-111111111111')],
        total: 1,
        complete: true,
      }),
    );
    assert.equal(lookup.keyKind, 'uuid');
    const resolved = await resolvePanelProfile('22222222-2222-4222-8222-222222222222', lookup, async () => null, NEVER_CONFIRMED);
    assert.deepEqual(resolved, { panel: null, known: true });
  });
});
