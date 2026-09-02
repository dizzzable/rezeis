/**
 * The per-UUID confirmation is the branch that decides whether a paying
 * customer's subscription is written EXPIRED.
 *
 * A panel above the adapter's page ceiling reads as `ok` but INCOMPLETE, so the
 * overlay map is only a PREFIX and every miss has to be settled with a targeted
 * read. That read used to be `getPanelUser`, which is `try { … } catch { return
 * null }`: outage, expired token, 401, 5xx, timeout and "integration not
 * configured" all arrive as the same `null` as "the panel does not have this
 * profile". `resolvePanelProfile` read that `null` as a verdict, and
 * `reconcileMissingPanelStatus` turned the verdict into EXPIRED — unconditionally
 * for STEALTHNET, which hands it a hardcoded ACTIVE.
 *
 * These tests pin the property that makes the branch safe: only a panel that
 * PROVES the profile is gone may expire it — and the proof is the PANEL's own
 * 404 (USER_NOT_FOUND / `A025` → strict `notFound`), not the status code alone.
 * A bare 404 is what a reverse proxy answers while it has no healthy backend,
 * so it belongs with the other non-answers below. Every other answer, and every
 * non-answer, keeps the backup value and says so out loud.
 *
 * Nothing here stubs `resolvePanelProfile`'s seams with a hand-made outcome
 * where it matters: the reads are the REAL `RemnawaveApiService` methods the
 * importers wire in, answering real HTTP failures.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { of, throwError } from 'rxjs';

import { SubscriptionStatus } from '@prisma/client';

import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { AltshopImporterService } from '../src/modules/imports/services/altshop-importer.service';
import { RemnashopImporterService } from '../src/modules/imports/services/remnashop-importer.service';
import { StealthnetImporterService } from '../src/modules/imports/services/stealthnet-importer.service';
import {
  buildPanelLookup,
  reconcileMissingPanelStatus,
  resolvePanelProfile,
  type PanelLookup,
} from '../src/modules/imports/utils/remnawave-overlay.util';

const CONFIG = {
  host: 'remnawave',
  port: 3000,
  token: 'secret',
  webhookSecret: null,
} as const;

/** The uuid every test asks about: a live customer the prefix does not cover. */
const MISSING_UUID = '11111111-1111-4111-8111-111111111111';

/**
 * 25 001 rows: one more than the adapter's 50 × 500 page budget, so the walk
 * stops at the ceiling and the read comes back `ok` with `complete: false`.
 * That is the state a large production panel is in on EVERY import.
 */
const OVER_CEILING = Array.from({ length: 25_001 }, (_, i) => `u-${i}`);

/** A well-formed panel row (2.7.4 / 2.8.0 wire shape). */
function row(uuid: string) {
  return {
    uuid,
    username: `name-${uuid}`,
    status: 'ACTIVE',
    subscriptionUrl: `https://example.test/${uuid}`,
    telegramId: 123,
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
  };
}

function axiosError(status: number, data?: unknown) {
  return {
    isAxiosError: true,
    response: { status, headers: {}, data },
    message: `HTTP ${status}`,
  };
}

/** How `/api/users/{uuid}` behaves for the uuid under test. */
type SingleRead =
  | { readonly kind: 'status'; readonly status: number; readonly data?: unknown }
  | { readonly kind: 'network' }
  | { readonly kind: 'found' };

/**
 * What the PANEL answers for a uuid it does not have: 404 carrying Remnawave's
 * own USER_NOT_FOUND envelope (`A025` — see `@remnawave/backend-contract`).
 *
 * A BARE 404 is a different event with the same status code: a reverse proxy
 * mid-deploy, a wrong host, an upstream with no healthy backend. During one of
 * those EVERY uuid 404s, so collapsing the two into one verdict expires a whole
 * customer base on a deploy. Every fixture below that means "the panel proves
 * this profile is gone" therefore carries the envelope the panel really sends;
 * the bare one is exercised alongside the other transient answers.
 */
const PANEL_SAYS_GONE: SingleRead = {
  kind: 'status',
  status: 404,
  data: { errorCode: 'A025', message: 'User not found' },
};

function singleReadResponse(read: SingleRead, uuid: string) {
  switch (read.kind) {
    case 'found':
      return of({ data: { response: row(uuid) } });
    case 'network':
      return throwError(() => new Error('socket hang up'));
    case 'status':
      return throwError(() => axiosError(read.status, read.data));
  }
}

/**
 * A real `RemnawaveApiService` over an in-memory panel.
 *
 * `/api/users?start=…` pages the roster (so `strictGetAllPanelUsers` is the
 * real walk, not a stub outcome) and `/api/users/{uuid}` answers with `single`
 * — so `getPanelUser` and `strictGetPanelUserExpiry` are the REAL reads, seeing
 * the REAL HTTP failure, and it is the production mapping from that failure to
 * `null` / a strict outcome that is under test.
 */
function buildPanel(
  roster: readonly string[],
  single: SingleRead,
  options: { readonly token?: string | null } = {},
) {
  const singleReads: string[] = [];
  const service = new RemnawaveApiService(
    {
      request: (input: { url: string }) => {
        const url = new URL(input.url, 'http://x');
        const one = /^\/api\/users\/(.+)$/.exec(url.pathname);
        if (one !== null) {
          singleReads.push(one[1]);
          return singleReadResponse(single, one[1]);
        }
        const start = Number.parseInt(url.searchParams.get('start') ?? '0', 10);
        const users = roster.slice(start, start + 500).map((u) => row(u));
        return of({ data: { response: { users, total: roster.length }, version: '2.8.0' } });
      },
    } as never,
    { ...CONFIG, token: options.token === undefined ? CONFIG.token : options.token } as never,
  );
  return { service, singleReads };
}

/** The truncated lookup a large panel produces — built by the real adapter. */
async function truncatedLookup(service: RemnawaveApiService): Promise<PanelLookup> {
  const lookup = await buildPanelLookup(() => service.strictGetAllPanelUsers());
  assert.equal(lookup.reachable, true, 'a truncated read is still a usable read');
  assert.equal(lookup.complete, false, 'this is the state that drives per-uuid confirmation');
  assert.equal(lookup.map.has(MISSING_UUID), false, 'the uuid under test must MISS the prefix');
  return lookup;
}

/** Drives the seam exactly as all three importers wire it. */
async function resolveThroughService(service: RemnawaveApiService, lookup: PanelLookup) {
  const unconfirmed: Array<{ uuid: string; reason: string }> = [];
  const resolved = await resolvePanelProfile(
    MISSING_UUID,
    lookup,
    (uuid) => service.getPanelUser(uuid),
    {
      confirmAbsence: (uuid) => service.strictGetPanelUserExpiry(uuid),
      onUnconfirmed: (uuid, reason) => unconfirmed.push({ uuid, reason }),
    },
  );
  return { ...resolved, unconfirmed };
}

describe('per-uuid confirmation: a panel that did not answer never expires anybody', () => {
  /**
   * Every one of these is a `null` out of `getPanelUser` — indistinguishable
   * from "gone" at that seam, which is precisely why the confirmation exists.
   */
  const TRANSIENT: ReadonlyArray<{ name: string; single: SingleRead; token?: string | null }> = [
    { name: 'a 502 from a panel behind a reverse proxy', single: { kind: 'status', status: 502 } },
    { name: 'a 503 during a panel restart', single: { kind: 'status', status: 503 } },
    { name: 'a 429 rate limit mid-import', single: { kind: 'status', status: 429 } },
    { name: 'a token that expired mid-run (401)', single: { kind: 'status', status: 401 } },
    { name: 'a 500 from the panel', single: { kind: 'status', status: 500 } },
    {
      // The status the panel uses for "gone", sent by something that is not the
      // panel. Traefik/nginx answer every request this way while they have no
      // healthy backend, so on a deploy this arrives for EVERY uuid at once.
      name: 'a bare 404 from a reverse proxy with no healthy backend',
      single: { kind: 'status', status: 404 },
    },
    { name: 'a socket hang up / timeout', single: { kind: 'network' } },
    {
      name: 'an integration that is not configured at all',
      single: { kind: 'network' },
      token: null,
    },
  ];

  for (const { name, single, token } of TRANSIENT) {
    it(`${name} leaves the subscription unknown, not expired`, async () => {
      const { service } = buildPanel(OVER_CEILING, single);
      const lookup = await truncatedLookup(service);

      // The per-uuid reads run against the failing panel (a separate instance
      // so the bulk walk above is not the thing that fails).
      const failing = buildPanel(OVER_CEILING, single, { token });
      const { panel, known, unconfirmed } = await resolveThroughService(failing.service, lookup);

      assert.equal(panel, null);
      assert.equal(known, false, 'a panel that did not answer has not proven anything');
      // STEALTHNET hands `reconcileMissingPanelStatus` a hardcoded ACTIVE, so
      // `known === true` here writes EXPIRED onto a live paying customer.
      assert.equal(
        reconcileMissingPanelStatus(known, SubscriptionStatus.ACTIVE),
        SubscriptionStatus.ACTIVE,
      );
      // …and the degrade is never silent.
      assert.equal(unconfirmed.length, 1);
      assert.equal(unconfirmed[0].uuid, MISSING_UUID);
      assert.match(unconfirmed[0].reason, /unconfirmed/);
    });
  }

  it('a genuine 404 still expires a stale backup row — unchanged', async () => {
    const { service, singleReads } = buildPanel(OVER_CEILING, PANEL_SAYS_GONE);
    const lookup = await truncatedLookup(service);
    const { panel, known, unconfirmed } = await resolveThroughService(service, lookup);

    assert.equal(panel, null);
    assert.equal(known, true, "the panel's own 404 is the answer that proves the profile is gone");
    assert.equal(
      reconcileMissingPanelStatus(known, SubscriptionStatus.ACTIVE),
      SubscriptionStatus.EXPIRED,
    );
    assert.deepEqual(unconfirmed, [], 'a proven absence is not a degrade');
    // The best-effort read that returned nothing, then the strict one that
    // proved the nothing.
    assert.deepEqual(singleReads, [MISSING_UUID, MISSING_UUID]);
  });

  it('a live profile past the ceiling is overlaid on ONE read, as before', async () => {
    const { service, singleReads } = buildPanel(OVER_CEILING, { kind: 'found' });
    const lookup = await truncatedLookup(service);
    const { panel, known, unconfirmed } = await resolveThroughService(service, lookup);

    assert.equal(known, true);
    assert.equal(panel?.uuid, MISSING_UUID);
    assert.deepEqual(unconfirmed, []);
    // Healthy 2.7.4 / 2.8.0 behaviour is unchanged: no confirmation round trip
    // is spent on the common miss (a user who simply lives past the ceiling).
    assert.deepEqual(singleReads, [MISSING_UUID]);
  });

  it('a profile the strict read CAN see but the overlay read cannot is left alone', async () => {
    // `getPanelUser` returned nothing while the panel still has the profile —
    // so there is no fresh state to overlay AND no absence to act on. The only
    // sound move is to keep the backup value and report it.
    const { service } = buildPanel(OVER_CEILING, { kind: 'found' });
    const lookup = await truncatedLookup(service);
    const { panel, known, unconfirmed } = await resolvePanelProfileWithSplitReads(lookup, service);

    assert.equal(panel, null);
    assert.equal(known, false);
    assert.equal(
      reconcileMissingPanelStatus(known, SubscriptionStatus.ACTIVE),
      SubscriptionStatus.ACTIVE,
    );
    assert.equal(unconfirmed.length, 1);
    assert.match(unconfirmed[0].reason, /still HAS this profile/);
  });
});

/** `fetchOne` blanks out while the strict read succeeds — a flaky first call. */
async function resolvePanelProfileWithSplitReads(
  lookup: PanelLookup,
  service: RemnawaveApiService,
) {
  const unconfirmed: Array<{ uuid: string; reason: string }> = [];
  const resolved = await resolvePanelProfile(
    MISSING_UUID,
    lookup,
    async () => null,
    {
      confirmAbsence: (uuid) => service.strictGetPanelUserExpiry(uuid),
      onUnconfirmed: (uuid, reason) => unconfirmed.push({ uuid, reason }),
    },
  );
  return { ...resolved, unconfirmed };
}

describe('StealthnetImporterService — the importer that expires unconditionally', () => {
  /**
   * The whole run, through the real service: the real truncated bulk walk, the
   * real per-uuid reads, the real overlay. `subscription.update` is the only
   * output that matters — it is the row a live customer pays for.
   */
  function runImport(single: SingleRead) {
    const updates: Array<{ data: Record<string, unknown> }> = [];
    const { service, singleReads } = buildPanel(OVER_CEILING, single);
    const importer = new StealthnetImporterService(
      {
        user: {
          findUnique: async (input: { where: Record<string, unknown> }) =>
            'telegramId' in input.where
              ? { id: 'user-1' }
              : { createdAt: new Date('2020-01-01T00:00:00.000Z') },
          update: async () => undefined,
          updateMany: async () => ({ count: 0 }),
        },
        subscription: {
          findFirst: async () => ({ id: 'sub-1', userId: 'user-1' }),
          update: async (input: { data: Record<string, unknown> }) => updates.push(input),
        },
        importRecord: { create: async () => ({ id: 'import-1' }) },
      } as never,
      service as never,
      {
        syncImport: async () => ({
          mappings: [],
          created: 0,
          existing: 0,
          skipped: 0,
          creditsCreated: 0,
          creditsExisting: 0,
          creditsSkipped: 0,
        }),
      } as never,
      new PointsWalletService(),
    );
    const run = importer.run({
      mode: 'import',
      createdBy: 'admin-1',
      clients: [
        {
          id: 'client-1',
          email: null,
          password_hash: null,
          role: 'user',
          remnawave_uuid: null,
          referral_code: null,
          referrer_id: null,
          balance: 0,
          preferred_lang: 'ru',
          preferred_currency: 'RUB',
          telegram_id: '123',
          telegram_username: null,
          is_blocked: false,
          block_reason: null,
          trial_used: false,
          current_tariff_id: null,
          bot_id: null,
          created_at: '2025-01-01T00:00:00.000Z',
          updated_at: '2025-01-01T00:00:00.000Z',
        },
      ],
      subscriptions: [
        {
          id: 'source-sub-1',
          owner_id: 'client-1',
          remnawave_uuid: MISSING_UUID,
          subscription_index: 1,
          tariff_id: null,
          gift_status: null,
          gifted_to_client_id: null,
          created_at: '2025-01-01T00:00:00.000Z',
          updated_at: '2025-01-01T00:00:00.000Z',
          expire_at: '2030-01-01T00:00:00.000Z',
          extra_devices: 0,
          extra_devices_monthly_price: 0,
        },
      ],
      tariffs: [],
      tariffCategories: [],
      tariffPriceOptions: [],
      payments: [],
      referralCredits: [],
    });
    return { run, updates, singleReads };
  }

  it('does NOT expire a live customer when the confirmation read fails (502)', async () => {
    const { run, updates, singleReads } = runImport({ kind: 'status', status: 502 });
    await run;
    assert.equal(updates.length, 1);
    assert.equal(
      updates[0].data.status,
      SubscriptionStatus.ACTIVE,
      'a panel that could not answer must not cost a paying customer their subscription',
    );
    assert.deepEqual(singleReads, [MISSING_UUID, MISSING_UUID]);
  });

  it('still expires a profile the panel proves is gone (404)', async () => {
    const { run, updates } = runImport(PANEL_SAYS_GONE);
    await run;
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.status, SubscriptionStatus.EXPIRED);
  });

  it('overlays the live profile when the panel does answer', async () => {
    const { run, updates } = runImport({ kind: 'found' });
    await run;
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.status, SubscriptionStatus.ACTIVE);
    assert.equal(updates[0].data.configUrl, `https://example.test/${MISSING_UUID}`);
  });
});

describe('RemnashopImporterService — the backup status is kept, not overwritten', () => {
  function runImport(single: SingleRead, backupStatus = 'ACTIVE') {
    const updates: Array<{ data: Record<string, unknown> }> = [];
    const { service } = buildPanel(OVER_CEILING, single);
    const importer = new RemnashopImporterService(
      {
        user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
        subscription: {
          findFirst: async () => ({ id: 'sub-1', userId: 'user-1', planSnapshot: null }),
          update: async (input: { data: Record<string, unknown> }) => updates.push(input),
        },
        referral: { findUnique: async () => null },
        partnerReferral: { findFirst: async () => null },
        referralReward: { findUnique: async () => null },
        transaction: { findUnique: async () => null },
        importRecord: { create: async () => ({ id: 'import-1' }) },
      } as never,
      service as never,
    );
    const run = importer.run({
      mode: 'import',
      createdBy: 'admin-1',
      users: [
        {
          id: 1,
          telegram_id: 123,
          username: null,
          referral_code: null,
          name: 'Example user',
          role: 1,
          language: 'RU',
          personal_discount: 0,
          purchase_discount: 0,
          points: 0,
          is_blocked: false,
          is_bot_blocked: false,
          is_rules_accepted: true,
          is_trial_available: true,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      subscriptions: [
        {
          id: 1,
          user_remna_id: MISSING_UUID,
          user_telegram_id: 123,
          status: backupStatus,
          is_trial: false,
          traffic_limit: 0,
          device_limit: 1,
          traffic_limit_strategy: 'NO_RESET',
          tag: null,
          internal_squads: [],
          external_squad: null,
          expire_at: null,
          url: null,
          plan_snapshot: null,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    return { run, updates };
  }

  it('keeps the backup ACTIVE when the confirmation read fails (503)', async () => {
    const { run, updates } = runImport({ kind: 'status', status: 503 });
    await run;
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.status, SubscriptionStatus.ACTIVE);
  });

  it('still expires a stale ACTIVE backup row when the panel proves a 404', async () => {
    const { run, updates } = runImport(PANEL_SAYS_GONE);
    await run;
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.status, SubscriptionStatus.EXPIRED);
  });
});

describe('AltshopImporterService — the third caller of the same seam', () => {
  function runImport(single: SingleRead) {
    const updates: Array<{ data: Record<string, unknown> }> = [];
    const { service } = buildPanel(OVER_CEILING, single);
    const importer = new AltshopImporterService(
      {
        user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
        subscription: {
          findFirst: async () => ({ id: 'sub-1', userId: 'user-1', planSnapshot: {} }),
          update: async (input: { data: Record<string, unknown> }) => updates.push(input),
        },
        importRecord: { create: async () => ({ id: 'import-1' }) },
      } as never,
      service as never,
      new PointsWalletService(),
    );
    const run = importer.run({
      mode: 'import',
      createdBy: null,
      users: [
        {
          id: 123,
          telegram_id: 123,
          username: null,
          referral_code: null,
          name: 'Example',
          role: 1,
          language: 'RU',
          personal_discount: 0,
          purchase_discount: 0,
          points: 0,
          is_blocked: false,
          is_bot_blocked: false,
          is_rules_accepted: true,
          is_trial_available: true,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      subscriptions: [
        {
          id: 1,
          user_remna_id: MISSING_UUID,
          user_telegram_id: 123,
          status: 'ACTIVE',
          is_trial: false,
          traffic_limit: 0,
          device_limit: 1,
          traffic_limit_strategy: null,
          tag: null,
          internal_squads: [],
          external_squad: null,
          expire_at: null,
          url: null,
          plan_snapshot: null,
          device_type: null,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    } as never);
    return { run, updates };
  }

  it('keeps the backup ACTIVE when the confirmation read fails (500)', async () => {
    const { run, updates } = runImport({ kind: 'status', status: 500 });
    await run;
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.status, SubscriptionStatus.ACTIVE);
  });

  it('still expires a stale ACTIVE backup row when the panel proves a 404', async () => {
    const { run, updates } = runImport(PANEL_SAYS_GONE);
    await run;
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.status, SubscriptionStatus.EXPIRED);
  });
});
