import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { BedolagaImporterService } from '../src/modules/imports/services/bedolaga-importer.service';
import type {
  BedolagaBackupData,
  BedolagaSubscription,
  BedolagaUser,
} from '../src/modules/imports/utils/bedolaga-backup-parser';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import type {
  RemnawaveApiService,
  RemnawavePanelUser,
} from '../src/modules/remnawave/services/remnawave-api.service';

/**
 * Moving a Bedolaga install onto a DIFFERENT Remnawave panel.
 *
 * Every importer before this one assumed the donor bot sold on the same panel
 * this install talks to, and the assumption failed silently in the worst
 * direction: the dump's identifiers name no profile here, the overlay reads
 * that as "the panel proves this profile is gone", and the run writes EXPIRED
 * over every ACTIVE subscription in the file while reporting success.
 *
 * These two runs are the same backup against the two panels. The assertions are
 * about what ended up in the row, not about what the importer decided — the
 * decision is easy to keep and easy to stop acting on.
 */

// ── The backup ───────────────────────────────────────────────────────────────

const HEAD_COUNT = 6;

function user(id: number): BedolagaUser {
  return {
    id,
    telegram_id: 1_000 + id,
    username: `user${id}`,
    first_name: null,
    last_name: null,
    status: 'active',
    language: 'ru',
    balance_kopeks: 0,
    referred_by_id: null,
    referral_code: null,
    email: null,
    promo_group_id: null,
    promo_offer_discount_percent: 0,
    promo_offer_discount_expires_at: null,
    has_had_paid_subscription: true,
    remnawave_id: null,
    remnawave_uuid: null,
    created_at: '2026-01-01T00:00:00Z',
  };
}

function subscription(id: number): BedolagaSubscription {
  return {
    id,
    user_id: id,
    status: 'active',
    is_trial: false,
    start_date: '2026-01-01T00:00:00Z',
    end_date: '2027-01-01T00:00:00Z',
    traffic_limit_gb: 100,
    traffic_used_gb: 1,
    purchased_traffic_gb: 0,
    device_limit: 3,
    connected_squads: ['squad-on-the-old-panel'],
    subscription_url: `https://old-panel.example/sub/${id}`,
    remnawave_id: id,
    remnawave_short_uuid: null,
    remnawave_uuid: null,
    tariff_id: null,
    autopay_enabled: false,
    created_at: '2026-01-01T00:00:00Z',
  };
}

function backup(): BedolagaBackupData {
  const ids = Array.from({ length: HEAD_COUNT }, (_, i) => i + 1);
  return {
    users: ids.map(user),
    subscriptions: ids.map(subscription),
    tariffs: [],
    promoGroups: [],
    userPromoGroups: [],
    transactions: [],
    promocodes: [],
    promocodeUses: [],
    referralEarnings: [],
    serverSquads: [],
    excludedDataIsComplete: true,
    sourceFormat: 'sql',
    excludedData: {
      pendingWithdrawals: 0,
      withdrawals: 0,
      coupons: 0,
      gifts: 0,
      wheelSpins: 0,
      contests: 0,
      temporaryAccess: 0,
      discountOffers: 0,
      tickets: 0,
    },
  };
}

// ── The panel ────────────────────────────────────────────────────────────────

/**
 * One profile as the panel serves it.
 *
 * Spelled out in full rather than cast from a partial: a stub the compiler is
 * not allowed to check is a stub that keeps passing after the shape it stands
 * for has changed underneath it.
 */
function panelUser(id: number, telegramId: number | null): RemnawavePanelUser {
  return {
    uuid: String(id),
    username: `panel-${id}`,
    status: 'ACTIVE',
    subscriptionUrl: `https://this-panel.example/sub/${id}`,
    telegramId,
    panelId: id,
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

type Row = Record<string, unknown>;

interface Harness {
  readonly service: BedolagaImporterService;
  readonly created: Row[];
  readonly updated: Row[];
  readonly result: () => Row;
}

/** A row a previous run of this same import already wrote. */
interface AlreadyMigrated {
  readonly id: string;
  readonly sourceSubscriptionId: number;
  readonly remnawaveId: string | null;
}

/**
 * @param profiles what THIS panel holds, keyed the way its bulk list is keyed.
 * @param alreadyHere rows a previous run left behind, found by their stamp.
 */
function harness(
  profiles: readonly RemnawavePanelUser[],
  alreadyHere: readonly AlreadyMigrated[] = [],
): Harness {
  const created: Row[] = [];
  const updated: Row[] = [];
  let result: Row = {};
  let seq = 0;

  const tx = {
    subscription: {
      create: ({ data }: { data: Row }) => {
        created.push(data);
        return Promise.resolve({ id: `sub-${(seq += 1)}` });
      },
      update: ({ data }: { data: Row }) => {
        updated.push(data);
        return Promise.resolve({});
      },
    },
  };

  const prisma = {
    user: {
      findUnique: ({ select }: { select?: Record<string, boolean> }) => {
        // `wasJustCreated` and the "does this person already have a current
        // subscription" read are told apart by what they select, the same way
        // the service distinguishes them.
        if (select?.createdAt === true) return Promise.resolve({ createdAt: new Date() });
        if (select?.currentSubscriptionId === true) {
          return Promise.resolve({ currentSubscriptionId: null });
        }
        return Promise.resolve(null);
      },
      create: ({ data }: { data: Row }) => Promise.resolve({ id: `user-${String(data.telegramId)}` }),
      update: () => Promise.resolve({}),
      updateMany: () => Promise.resolve({ count: 0 }),
    },
    subscription: {
      // The importer asks two different questions depending on the verdict: by
      // panel identity on the same panel, and by its own import stamp on a
      // foreign one. Only the second is answered here, because a foreign panel
      // must never be allowed to find a row by an identifier that belongs to
      // somebody else's customer.
      findFirst: ({ where }: { where: Record<string, unknown> }) => {
        const snapshot = where['planSnapshot'] as { equals?: unknown } | undefined;
        if (snapshot === undefined) return Promise.resolve(null);
        const match = alreadyHere.find((row) => row.sourceSubscriptionId === snapshot.equals);
        return Promise.resolve(
          match === undefined
            ? null
            : {
                id: match.id,
                userId: `user-${1_000 + match.sourceSubscriptionId}`,
                planSnapshot: { sourceSubscriptionId: match.sourceSubscriptionId },
                remnawaveId: match.remnawaveId,
              },
        );
      },
    },
    transaction: { findUnique: () => Promise.resolve(null), create: () => Promise.resolve({}) },
    importRecord: {
      create: ({ data }: { data: Row }) => {
        result = data.result as Row;
        return Promise.resolve({ id: 'record-1' });
      },
      update: ({ data }: { data: Row }) => {
        result = data.result as Row;
        return Promise.resolve({ id: 'record-1' });
      },
    },
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const byId = new Map(profiles.map((profile) => [profile.uuid, profile]));
  const remnawave = {
    strictGetAllPanelUsers: () =>
      Promise.resolve({
        kind: 'ok' as const,
        value: { users: profiles, total: profiles.length, complete: true },
      }),
    getPanelUser: (id: string) => Promise.resolve(byId.get(id) ?? null),
    strictGetPanelUserExpiry: (id: string) =>
      Promise.resolve(byId.has(id) ? { kind: 'ok' as const, value: null } : { kind: 'notFound' as const }),
  };

  const points = { apply: () => Promise.resolve({ applied: false, balance: 0 }) };

  return {
    service: new BedolagaImporterService(
      prisma as unknown as PrismaService,
      remnawave as unknown as RemnawaveApiService,
      points as unknown as PointsWalletService,
    ),
    created,
    updated,
    result: () => result,
  };
}

const run = (h: Harness) =>
  h.service.run({ mode: 'import', createdBy: null, data: backup() });

// ── The two readings ─────────────────────────────────────────────────────────

describe('importing onto the panel these customers were already on', () => {
  it('links every subscription to its profile and takes the panel as truth', async () => {
    const h = harness(
      Array.from({ length: HEAD_COUNT }, (_, i) => panelUser(i + 1, 1_000 + i + 1)),
    );

    await run(h);

    assert.equal(h.created.length, HEAD_COUNT);
    for (const row of h.created) {
      assert.equal(typeof row.remnawaveId, 'string', 'the profile link is what makes it an UPDATE');
      assert.equal(row.remnawavePanelId, Number(row.remnawaveId));
      assert.equal(row.configUrl, `https://this-panel.example/sub/${String(row.remnawaveId)}`);
      assert.deepEqual(row.internalSquads, ['squad-on-this-panel']);
    }
    assert.equal((h.result().panelRelationship as Row).verdict, 'same');
    assert.equal((h.result().panelRelationship as Row).profilesToCreate, 0);
  });
});

describe('importing onto a DIFFERENT panel', () => {
  it('keeps every live subscription live instead of expiring the whole base', async () => {
    // THE DEFECT THIS EXISTS FOR. The panel is reachable, its list is complete,
    // and it holds none of the dump's ids — which `reconcileMissingPanelStatus`
    // reads as proof the profile is gone and turns into EXPIRED. Six ACTIVE
    // customers, one successful-looking run, nobody connected.
    const h = harness([panelUser(1, 55_555), panelUser(2, 55_556)]);

    await run(h);

    assert.equal(h.created.length, HEAD_COUNT);
    for (const row of h.created) {
      assert.equal(row.status, SubscriptionStatus.ACTIVE);
    }
  });

  it('leaves the profile link empty so the sync CREATES rather than UPDATES', async () => {
    // `enqueuePostImportSync` picks the action off exactly this column:
    // `remnawaveId === null ? CREATE : UPDATE`. Stamping the donor's id would
    // both point at a stranger — 3.x numbers users from one, so this panel has
    // an id 1 too — and send the sync down the UPDATE path for good.
    const h = harness([panelUser(1, 55_555), panelUser(2, 55_556)]);

    await run(h);

    for (const row of h.created) {
      assert.equal(row.remnawaveId, null);
      assert.equal(row.remnawavePanelId, null);
    }
  });

  it('does not carry the old panel’s squads or connection link across', async () => {
    // The squad uuids name nothing on the new panel, so pushing them fails the
    // profile CREATE outright; the link is a dead address the customer would be
    // shown as though it worked. "Назначить тариф" fills in both.
    const h = harness([panelUser(1, 55_555), panelUser(2, 55_556)]);

    await run(h);

    for (const row of h.created) {
      assert.deepEqual(row.internalSquads, []);
      assert.equal(row.externalSquad, null);
      assert.equal(row.configUrl, null);
    }
  });

  it('tells the operator, because every customer gets a new link', async () => {
    const h = harness([panelUser(1, 55_555), panelUser(2, 55_556)]);

    await run(h);

    const report = h.result().panelRelationship as Row;
    assert.equal(report.verdict, 'different');
    assert.equal(report.profilesToCreate, HEAD_COUNT);
    assert.ok(String(report.reason).length > 0);
  });

  it('finds its own earlier rows by stamp rather than by a stranger’s id', async () => {
    // THE SECOND RUN. There is no panel identity to look a migrated row up by,
    // so the stamp this importer wrote is the only durable key. Miss it and the
    // re-import mints a second subscription for every customer — and, once the
    // sync runs, a second panel profile to go with it.
    const h = harness(
      [panelUser(1, 55_555)],
      Array.from({ length: HEAD_COUNT }, (_, i) => ({
        id: `existing-${i + 1}`,
        sourceSubscriptionId: i + 1,
        remnawaveId: null,
      })),
    );

    await run(h);

    assert.deepEqual(h.created, [], 'nothing may be created twice');
    assert.equal(h.updated.length, HEAD_COUNT);
  });

  it('does not wipe a link the sync has already made', async () => {
    // Once the profiles exist, the columns hold what THIS panel reported. The
    // backup still names the old panel, so re-importing it must not write the
    // dead link and the old squads back over a customer who is connected.
    const h = harness(
      [panelUser(1, 55_555)],
      Array.from({ length: HEAD_COUNT }, (_, i) => ({
        id: `existing-${i + 1}`,
        sourceSubscriptionId: i + 1,
        remnawaveId: `90${i + 1}`,
      })),
    );

    await run(h);

    for (const row of h.updated) {
      assert.ok(!('configUrl' in row), 'the connection link is the panel’s to write');
      assert.ok(!('internalSquads' in row), 'so are the squads');
      assert.ok(!('remnawaveId' in row), 'and the link itself is never rewritten from a backup');
    }
  });

  it('is not fooled by ids that collide with this panel’s own customers', async () => {
    // Every id RESOLVES here — to somebody else. Before the run-level verdict
    // this was not a mass-expiry but a mass-refusal: the per-row owner check
    // threw for all six, and the operator got six errors and no migration.
    const h = harness(
      Array.from({ length: HEAD_COUNT }, (_, i) => panelUser(i + 1, 900_000 + i)),
    );

    const summary = await run(h);

    assert.deepEqual(summary.errors, []);
    assert.equal(h.created.length, HEAD_COUNT);
    for (const row of h.created) assert.equal(row.remnawaveId, null);
  });
});
