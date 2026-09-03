import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { RemnashopImporterService } from '../src/modules/imports/services/remnashop-importer.service';
import type {
  RemnashopSubscription,
  RemnashopUser,
} from '../src/modules/imports/services/remnashop-importer.service';
import { AltshopImporterService } from '../src/modules/imports/services/altshop-importer.service';
import type { AltshopSubscription } from '../src/modules/imports/services/altshop-importer.service';
import { StealthnetImporterService } from '../src/modules/imports/services/stealthnet-importer.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type {
  RemnawaveApiService,
  RemnawavePanelUser,
} from '../src/modules/remnawave/services/remnawave-api.service';
import type { StealthnetReferralSyncService } from '../src/modules/imports/services/stealthnet-referral-sync.service';

/**
 * The other three importers, on a panel that never issued their identifiers.
 *
 * All four share the same overlay and therefore shared the same defect: a
 * reachable panel whose complete list has none of the backup's profiles reads
 * as proof they were deleted, so every live subscription in the file is written
 * EXPIRED — on a run that reports success. STEALTHNET is the extreme case,
 * because it hands the overlay a hardcoded ACTIVE: without the run-level
 * verdict there is not one subscription it would leave alive.
 *
 * One assertion per importer, on what ended up in the ROW. The decision is easy
 * to keep and easy to stop acting on.
 */

const COUNT = 6;
const ids = Array.from({ length: COUNT }, (_, i) => i + 1);

/** A uuid the way the older donors carry it — nothing else could mint it. */
const uuidOf = (n: number): string =>
  `2b1e0c${String(n).padStart(2, '0')}-0000-4000-8000-000000000000`;

/** A profile on THIS panel, belonging to somebody who is not in the backup. */
function strangerProfile(n: number): RemnawavePanelUser {
  return {
    uuid: `ffffffff-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
    username: `native-${n}`,
    status: 'ACTIVE',
    subscriptionUrl: 'https://this-panel.example/sub/native',
    telegramId: 900_000 + n,
    panelId: n,
    email: null,
    expireAt: '2027-06-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    lastTrafficResetAt: null,
    trafficLimitBytes: 0,
    hwidDeviceLimit: 5,
    trafficLimitStrategy: null,
    tag: null,
    description: null,
    activeInternalSquads: [{ uuid: 'squad-on-this-panel', name: 'This panel' }],
    externalSquadUuid: null,
  };
}

/** The backup's own profile, as THIS panel would serve it if it had it. */
function backupProfile(n: number): RemnawavePanelUser {
  return {
    ...strangerProfile(n),
    uuid: uuidOf(n),
    username: `migrated-${n}`,
    telegramId: 1_000 + n,
    subscriptionUrl: `https://this-panel.example/sub/${uuidOf(n)}`,
  };
}

type Row = Record<string, unknown>;

interface Fakes {
  readonly prisma: PrismaService;
  readonly remnawave: RemnawaveApiService;
  readonly created: Row[];
  readonly updated: Row[];
}

interface FakeOptions {
  /** Serve the backup's OWN profiles too — i.e. this is the same panel. */
  readonly holdsTheBackup?: boolean;
  /** Donor row ids a previous run of this import already wrote here. */
  readonly alreadyHere?: readonly number[];
}

/**
 * A panel that is reachable, complete, and holds only its own customers — the
 * exact shape that used to expire an entire migrated customer base.
 */
function fakes(options: FakeOptions = {}): Fakes {
  const created: Row[] = [];
  const updated: Row[] = [];
  let seq = 0;

  const subscription = {
    // The importers ask two different questions depending on the verdict: by
    // panel identity on the same panel, by their own import stamp on a foreign
    // one. Only the second is answered from `alreadyHere`.
    findFirst: ({ where }: { where: Record<string, unknown> }) => {
      const snapshot = where['planSnapshot'] as { equals?: unknown } | undefined;
      if (snapshot === undefined) return Promise.resolve(null);
      const match = (options.alreadyHere ?? []).find((row) => row === snapshot.equals);
      return Promise.resolve(
        match === undefined
          ? null
          : {
              id: `existing-${String(match)}`,
              // Echoed, not invented: the foreign-panel lookup filters by
              // `userId`, so a row it returns belongs to that user by
              // construction — a double that says otherwise makes the
              // importer's own owner check refuse its own rows.
              userId: where['userId'],
              planSnapshot: {},
              remnawaveId: null,
            },
      );
    },
    create: ({ data }: { data: Row }) => {
      created.push(data);
      return Promise.resolve({ id: `sub-${(seq += 1)}` });
    },
    update: ({ data }: { data: Row }) => {
      updated.push(data);
      return Promise.resolve({});
    },
  };

  const prisma: Record<string, unknown> = {
    user: {
      findUnique: ({ select }: { select?: Record<string, boolean> }) => {
        if (select?.createdAt === true) return Promise.resolve({ createdAt: new Date() });
        if (select?.currentSubscriptionId === true) {
          return Promise.resolve({ currentSubscriptionId: null });
        }
        return Promise.resolve(null);
      },
      create: () => Promise.resolve({ id: `user-${(seq += 1)}` }),
      update: () => Promise.resolve({}),
      updateMany: () => Promise.resolve({ count: 0 }),
      upsert: () => Promise.resolve({ id: 'user-1' }),
    },
    subscription,
    transaction: { findUnique: () => Promise.resolve(null), create: () => Promise.resolve({}) },
    plan: { findMany: () => Promise.resolve([]) },
    addOn: { findMany: () => Promise.resolve([]), createMany: () => Promise.resolve({ count: 0 }) },
    importRecord: {
      create: () => Promise.resolve({ id: 'record-1' }),
      update: () => Promise.resolve({ id: 'record-1' }),
    },
  };
  // Every model the four importers touch, answered the same inert way. A named
  // list would go stale the moment one of them reads a table it did not before,
  // and the failure would look like "created 0 subscriptions" rather than like
  // a missing double.
  for (const model of [
    'webAccount',
    'referral',
    'referralReward',
    'partner',
    'partnerReferral',
    'partnerTransaction',
    'trialClaim',
  ]) {
    prisma[model] = {
      findUnique: () => Promise.resolve(null),
      findFirst: () => Promise.resolve(null),
      findMany: () => Promise.resolve([]),
      create: () => Promise.resolve({ id: `${model}-1` }),
      update: () => Promise.resolve({}),
      updateMany: () => Promise.resolve({ count: 0 }),
      upsert: () => Promise.resolve({ id: `${model}-1` }),
    };
  }
  // The transaction client is the same object: a fake that hands back a subset
  // makes "this code path runs inside a transaction" the reason a test fails.
  prisma.$transaction = (fn: (client: unknown) => Promise<unknown>) => fn(prisma);
  prisma.$executeRaw = () => Promise.resolve(0);

  const natives = [
    ...ids.map(strangerProfile),
    ...(options.holdsTheBackup ? ids.map(backupProfile) : []),
  ];
  const byId = new Map(natives.map((p) => [p.uuid, p]));
  const remnawave = {
    strictGetAllPanelUsers: () =>
      Promise.resolve({
        kind: 'ok' as const,
        value: { users: natives, total: natives.length, complete: true },
      }),
    getPanelUser: (id: string) => Promise.resolve(byId.get(id) ?? null),
    strictGetPanelUserExpiry: (id: string) =>
      Promise.resolve(
        byId.has(id) ? { kind: 'ok' as const, value: null } : { kind: 'notFound' as const },
      ),
  };

  return {
    prisma: prisma as unknown as PrismaService,
    remnawave: remnawave as unknown as RemnawaveApiService,
    created,
    updated,
  };
}

/** Every migrated row is live and unlinked, with no dead squad or link on it. */
function assertMigratedFresh(created: readonly Row[]): void {
  assert.equal(created.length, COUNT);
  for (const row of created) {
    assert.equal(row.status, SubscriptionStatus.ACTIVE, 'a live subscription must stay live');
    assert.equal(row.remnawaveId, null, 'an empty link is what makes the sync CREATE');
    assert.deepEqual(row.internalSquads, [], 'the old panel’s squads name nothing here');
    assert.equal(row.configUrl, null, 'and its connection link is a dead address');
  }
}

// ── Remnashop ────────────────────────────────────────────────────────────────

function remnashopUser(id: number): RemnashopUser {
  return {
    id,
    telegram_id: 1_000 + id,
    username: `user${id}`,
    referral_code: null,
    name: null,
    role: 1,
    language: 'RU',
    personal_discount: 0,
    purchase_discount: 0,
    points: 0,
    is_blocked: false,
    is_bot_blocked: false,
    is_rules_accepted: true,
    is_trial_available: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function remnashopSubscription(id: number): RemnashopSubscription {
  return {
    id,
    user_remna_id: uuidOf(id),
    user_telegram_id: 1_000 + id,
    status: 'ACTIVE',
    is_trial: false,
    traffic_limit: 100,
    device_limit: 3,
    traffic_limit_strategy: null,
    tag: null,
    internal_squads: ['squad-on-the-old-panel'],
    external_squad: null,
    expire_at: '2027-01-01T00:00:00Z',
    url: 'https://old-panel.example/sub',
    plan_snapshot: null,
    created_at: '2026-01-01T00:00:00Z',
  };
}

describe('Remnashop, imported onto a different panel', () => {
  it('keeps every live subscription live and leaves the link for the sync', async () => {
    const f = fakes();
    const service = new RemnashopImporterService(f.prisma, f.remnawave);

    await service.run({
      mode: 'import',
      createdBy: null,
      users: ids.map(remnashopUser),
      subscriptions: ids.map(remnashopSubscription),
    });

    assertMigratedFresh(f.created);
  });

  it('still links and overlays when the panel DOES hold these profiles', async () => {
    // The ordinary case, and the one that must not change: the panel is the
    // truth, the link is written, and the connection url comes from the panel
    // rather than from a backup that may be months old.
    const f = fakes({ holdsTheBackup: true });
    const service = new RemnashopImporterService(f.prisma, f.remnawave);

    await service.run({
      mode: 'import',
      createdBy: null,
      users: ids.map(remnashopUser),
      subscriptions: ids.map(remnashopSubscription),
    });

    assert.equal(f.created.length, COUNT);
    for (const row of f.created) {
      assert.equal(typeof row.remnawaveId, 'string');
      assert.equal(row.configUrl, `https://this-panel.example/sub/${String(row.remnawaveId)}`);
      assert.deepEqual(row.internalSquads, ['squad-on-this-panel']);
    }
  });

  it('finds its own earlier rows by stamp on a second run', async () => {
    // There is no panel identity to look a migrated row up by, so the stamp
    // this importer wrote is the only durable key. Miss it and the re-import
    // mints a second subscription for every customer — and, once the sync runs,
    // a second panel profile to go with it.
    const f = fakes({ alreadyHere: ids });
    const service = new RemnashopImporterService(f.prisma, f.remnawave);

    await service.run({
      mode: 'import',
      createdBy: null,
      users: ids.map(remnashopUser),
      subscriptions: ids.map(remnashopSubscription),
    });

    assert.deepEqual(f.created, [], 'nothing may be created twice');
    assert.equal(f.updated.length, COUNT);
  });
});

// ── Altshop ──────────────────────────────────────────────────────────────────

function altshopSubscription(id: number): AltshopSubscription {
  return {
    id,
    user_remna_id: uuidOf(id),
    user_telegram_id: 1_000 + id,
    status: 'ACTIVE',
    is_trial: false,
    traffic_limit: 100,
    device_limit: 3,
    traffic_limit_strategy: null,
    tag: null,
    internal_squads: ['squad-on-the-old-panel'],
    external_squad: null,
    expire_at: '2027-01-01T00:00:00Z',
    url: 'https://old-panel.example/sub',
    plan_snapshot: null,
    device_type: null,
    created_at: '2026-01-01T00:00:00Z',
  };
}

describe('Altshop, imported onto a different panel', () => {
  it('keeps every live subscription live and leaves the link for the sync', async () => {
    const f = fakes();
    const service = new AltshopImporterService(f.prisma, f.remnawave, new PointsWalletService());

    const summary = await service.run({
      mode: 'import',
      createdBy: null,
      users: ids.map((id) => ({
        id,
        telegram_id: 1_000 + id,
        username: `user${id}`,
        referral_code: null,
        name: null,
        role: 1,
        language: 'ru',
        personal_discount: 0,
        purchase_discount: 0,
        points: 0,
        is_blocked: false,
        is_bot_blocked: false,
        is_rules_accepted: true,
        is_trial_available: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })),
      subscriptions: ids.map(altshopSubscription),
    });

    assert.deepEqual(summary.errors, []);
    assertMigratedFresh(f.created);
  });
});

// ── STEALTHNET ───────────────────────────────────────────────────────────────

describe('STEALTHNET, imported onto a different panel', () => {
  it('does not expire the entire customer base it was handed', async () => {
    // This importer passes a HARDCODED ACTIVE to the overlay, so before the
    // run-level verdict there was not one subscription here it would have left
    // alive — every single row would read EXPIRED and the run would report
    // success.
    const f = fakes();
    const service = new StealthnetImporterService(
      f.prisma,
      f.remnawave,
      {
        syncImport: () =>
          Promise.resolve({
            mappings: [],
            created: 0,
            existing: 0,
            skipped: 0,
            creditsCreated: 0,
            creditsExisting: 0,
            creditsSkipped: 0,
          }),
      } as unknown as StealthnetReferralSyncService,
      new PointsWalletService(),
    );

    await service.run({
      mode: 'import',
      createdBy: null,
      clients: ids.map((id) => ({
        id: `client-${id}`,
        email: null,
        password_hash: null,
        role: 'user',
        remnawave_uuid: uuidOf(id),
        referral_code: null,
        referrer_id: null,
        balance: 0,
        preferred_lang: 'ru',
        preferred_currency: 'RUB',
        telegram_id: String(1_000 + id),
        telegram_username: null,
        is_blocked: false,
        block_reason: null,
        trial_used: false,
        current_tariff_id: null,
        bot_id: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })),
      subscriptions: ids.map((id) => ({
        id: `sub-${id}`,
        owner_id: `client-${id}`,
        remnawave_uuid: uuidOf(id),
        subscription_index: 0,
        tariff_id: null,
        gift_status: null,
        gifted_to_client_id: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        expire_at: '2027-01-01T00:00:00Z',
        extra_devices: 0,
        extra_devices_monthly_price: 0,
      })),
      tariffs: [],
      tariffCategories: [],
      tariffPriceOptions: [],
      payments: [],
      referralCredits: [],
    });

    assert.equal(f.created.length, COUNT);
    for (const row of f.created) {
      assert.equal(row.status, SubscriptionStatus.ACTIVE);
      assert.equal(row.remnawaveId, null);
    }
  });
});
