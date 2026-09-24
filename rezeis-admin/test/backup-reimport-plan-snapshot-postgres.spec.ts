import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma, SubscriptionStatus, SubscriptionTermStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { AltshopImporterService } from '../src/modules/imports/services/altshop-importer.service';
import { BedolagaImporterService } from '../src/modules/imports/services/bedolaga-importer.service';
import { RemnashopImporterService } from '../src/modules/imports/services/remnashop-importer.service';
import { StealthnetImporterService } from '../src/modules/imports/services/stealthnet-importer.service';
import type { StealthnetReferralSyncService } from '../src/modules/imports/services/stealthnet-referral-sync.service';
import type { BedolagaBackupData } from '../src/modules/imports/utils/bedolaga-backup-parser';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import type { RemnawavePanelUser } from '../src/modules/remnawave/services/remnawave-api.service';
import { buildPlanSnapshot } from '../src/modules/users/utils/plan-snapshot.util';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { at, createPlan, newUser, termModelFixtures, type TermModelFixtures } from './helpers/term-model-fixtures';

/**
 * A BACKUP RE-IMPORT ONTO A SUBSCRIPTION IT ALREADY HAS KEEPS THE SNAPSHOT.
 *
 * The four backup importers (Remnashop, Altshop, STEALTHNET, Bedolaga) used to
 * REBUILD `planSnapshot` from donor facts on an existing row and carry `planId`
 * alone across — STEALTHNET not even that. Prisma writes a `Json` column
 * wholesale, so every other key was lost: the plan an operator assigned (`id`,
 * `name`, `trafficLimit`, `deviceLimit`, squads), the duration autopay renews
 * by (`selectedDurationDays`), the payment's own keys. The customer's plan name
 * vanished from the cabinet, the bot and invoices until a plan was assigned
 * again, and the donor's `tag` and reset strategy were written over the plan's
 * — the two the panel push reads from the snapshot.
 *
 * Through the real importers and a real database; only Remnawave is a double.
 * RS1 a row an operator assigned a plan to, RS2 a row the plan cloner linked,
 * in the term model, RS3 a never-assigned import, RS4 the donor fallback when
 * the panel cannot be read.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

const GIB = 1024 ** 3;
/** A panel-id range no other spec uses, and a Telegram-id range per run. */
const PANEL_BASE = 1_700_000_000 + (Date.now() % 1_000_000) * 50;
const TELEGRAM_BASE = 7_300_000_000 + (Date.now() % 1_000_000) * 50;
/** How a profile made on 2.x is named: a uuid, here derived from its panel id. */
const uuidIdentity = (panelId: number): string => `${String(panelId).padStart(8, '0')}-0000-4000-8000-000000000001`;

type Backup = 'Remnashop' | 'Altshop' | 'STEALTHNET' | 'Bedolaga';
const BACKUPS: readonly Backup[] = ['Remnashop', 'Altshop', 'STEALTHNET', 'Bedolaga'];
const SOURCE: Record<Backup, string> = {
  Remnashop: 'remnashop',
  Altshop: 'altshop',
  STEALTHNET: 'stealthnet',
  Bedolaga: 'bedolaga',
};

/** What the donor says about the subscription now — deliberately unlike the plan on every shared key. */
const DONOR = {
  tag: 'DONOR_TAG',
  strategy: 'DAY',
  planSnapshot: { id: 9, name: 'Donor Pro' },
  tariffId: 9,
  stealthnetTariffId: 'tariff-donor-pro',
  currency: 'USD',
  trafficGb: 50,
  devices: 2,
} as const;

let prisma: PrismaService;
let fx: TermModelFixtures;
const importRecords: string[] = [];

interface Row {
  readonly userId: string;
  readonly subscriptionId: string;
  readonly panelId: number;
  readonly identity: string;
  readonly telegramId: bigint;
  /** The donor's own id for this subscription — what the backup carries as `sourceSubscriptionId`. */
  readonly donorId: number;
}

/** A plan an operator would assign: 100 GB / 3 devices, and a tag, icon and strategy of its own. */
async function assignablePlan() {
  const id = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
  return prisma.plan.update({
    where: { id },
    data: { tag: 'PLAN_TAG', icon: 'star', trafficLimitStrategy: 'MONTH' },
  });
}

/** A linked subscription with `snapshot`, its columns on the plan's 100 GB / 3 devices. */
async function linkedRow(backup: Backup, snapshot: (row: { donorId: number }) => Record<string, unknown>): Promise<Row> {
  const telegramId = BigInt(TELEGRAM_BASE + fx.next());
  const userId = await newUser(fx, { telegramId });
  const panelId = PANEL_BASE + fx.next();
  const identity = backup === 'Bedolaga' ? String(panelId) : uuidIdentity(panelId);
  const donorId = fx.next();
  const created = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: snapshot({ donorId }) as Prisma.InputJsonValue,
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: identity,
      remnawavePanelId: panelId,
      createdAt: at(-10),
      startedAt: at(-10),
      expiresAt: at(20),
    },
    select: { id: true },
  });
  return { userId, subscriptionId: created.id, panelId, identity, telegramId, donorId };
}

async function enterModel(row: Row): Promise<void> {
  const terms = new SubscriptionTermService();
  const projections = new EffectiveProjectionService();
  const cutover = new EntitlementCutoverService(prisma, terms, projections);
  const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, row.subscriptionId));
  assert.equal(entered.outcome, 'CREATED');
}

async function snapshotOf(row: Row): Promise<Record<string, unknown>> {
  const stored = await prisma.subscription.findUniqueOrThrow({
    where: { id: row.subscriptionId },
    select: { planSnapshot: true },
  });
  return stored.planSnapshot as Record<string, unknown>;
}

async function columnsOf(row: Row) {
  return prisma.subscription.findUniqueOrThrow({
    where: { id: row.subscriptionId },
    select: { trafficLimit: true, deviceLimit: true },
  });
}

async function newImportRecord(sourceType: string): Promise<string> {
  const record = await prisma.importRecord.create({
    data: { filename: `${fx.prefix}-${sourceType}.json`, sourceType },
    select: { id: true },
  });
  importRecords.push(record.id);
  return record.id;
}

/** The profile as the panel answers for it: 300 GB, 7 devices. */
function profileOf(row: Row): RemnawavePanelUser {
  return {
    uuid: row.identity,
    username: `rsnap-${row.panelId}`,
    status: 'ACTIVE',
    subscriptionUrl: `https://panel.example/sub/${row.panelId}`,
    telegramId: Number(row.telegramId),
    panelId: row.panelId,
    email: null,
    expireAt: at(25).toISOString(),
    createdAt: at(-10).toISOString(),
    lastTrafficResetAt: null,
    trafficLimitBytes: 300 * GIB,
    hwidDeviceLimit: 7,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    description: `reiwa_id: ${row.userId}`,
    activeInternalSquads: [],
    externalSquadUuid: null,
  } as RemnawavePanelUser;
}

function panelServing(profiles: readonly RemnawavePanelUser[]) {
  const byId = new Map(profiles.map((profile) => [profile.uuid, profile]));
  return {
    strictGetAllPanelUsers: async () => ({
      kind: 'ok' as const,
      value: { users: [...profiles], total: profiles.length, complete: true },
    }),
    getPanelUser: async (id: string) => byId.get(id) ?? null,
    strictGetPanelUserExpiry: async (id: string) =>
      byId.has(id) ? { kind: 'ok' as const, value: null } : { kind: 'notFound' as const },
    updatePanelUser: async () => ({}),
  };
}

/** A panel that cannot be read: every importer falls back to the donor's own values. */
const PANEL_DOWN = {
  strictGetAllPanelUsers: async () => ({ kind: 'unavailable' as const, reason: 'down' }),
  getPanelUser: async () => null,
  strictGetPanelUserExpiry: async () => ({ kind: 'unavailable' as const, reason: 'down' }),
};

function donorUser(row: Row) {
  return {
    id: row.donorId,
    telegram_id: Number(row.telegramId),
    username: null,
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
    is_trial_available: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function remnashopSubscription(row: Row) {
  return {
    id: row.donorId,
    user_remna_id: row.identity,
    user_telegram_id: Number(row.telegramId),
    status: 'ACTIVE',
    is_trial: false,
    traffic_limit: DONOR.trafficGb,
    device_limit: DONOR.devices,
    traffic_limit_strategy: DONOR.strategy,
    tag: DONOR.tag,
    internal_squads: [],
    external_squad: null,
    expire_at: '2027-01-01T00:00:00Z',
    url: 'https://old-panel.example/sub',
    plan_snapshot: { ...DONOR.planSnapshot },
    created_at: '2026-01-01T00:00:00Z',
  };
}

function stealthnetInput(row: Row, importRecordId: string) {
  const client = `client-${row.donorId}`;
  return {
    mode: 'sync',
    createdBy: null,
    importRecordId,
    clients: [
      {
        id: client,
        email: null,
        password_hash: null,
        role: 'user',
        remnawave_uuid: row.identity,
        referral_code: null,
        referrer_id: null,
        balance: 0,
        preferred_lang: 'ru',
        preferred_currency: 'RUB',
        telegram_id: String(row.telegramId),
        telegram_username: null,
        is_blocked: false,
        block_reason: null,
        trial_used: false,
        current_tariff_id: null,
        bot_id: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
    subscriptions: [
      {
        id: `sub-${row.donorId}`,
        owner_id: client,
        remnawave_uuid: row.identity,
        subscription_index: 0,
        tariff_id: DONOR.stealthnetTariffId,
        gift_status: null,
        gifted_to_client_id: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        expire_at: '2027-01-01T00:00:00Z',
        extra_devices: 0,
        extra_devices_monthly_price: 0,
      },
    ],
    tariffs: [
      {
        id: DONOR.stealthnetTariffId,
        category_id: 'category-1',
        name: DONOR.planSnapshot.name,
        description: null,
        duration_days: 30,
        internal_squad_uuids: [],
        traffic_limit_bytes: DONOR.trafficGb * GIB,
        traffic_reset_mode: 'no_reset',
        device_limit: DONOR.devices,
        price: 5,
        currency: DONOR.currency,
        sort_order: 0,
        included_devices: DONOR.devices,
        max_extra_devices: 0,
        price_per_extra_device: 0,
      },
    ],
    tariffCategories: [],
    tariffPriceOptions: [],
    payments: [],
    referralCredits: [],
  } as never;
}

function bedolagaData(row: Row): BedolagaBackupData {
  return {
    users: [
      {
        id: row.donorId,
        telegram_id: Number(row.telegramId),
        username: null,
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
      },
    ],
    subscriptions: [
      {
        id: row.donorId,
        user_id: row.donorId,
        status: 'active',
        is_trial: false,
        start_date: '2026-01-01T00:00:00Z',
        end_date: '2027-01-01T00:00:00Z',
        traffic_limit_gb: DONOR.trafficGb,
        traffic_used_gb: 1,
        purchased_traffic_gb: 0,
        device_limit: DONOR.devices,
        connected_squads: [],
        subscription_url: 'https://old-panel.example/sub',
        remnawave_id: row.panelId,
        remnawave_short_uuid: null,
        remnawave_uuid: null,
        tariff_id: DONOR.tariffId,
        autopay_enabled: false,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    tariffs: [
      {
        id: DONOR.tariffId,
        name: DONOR.planSnapshot.name,
        description: null,
        traffic_limit_gb: DONOR.trafficGb,
        device_limit: DONOR.devices,
        allowed_squads: [],
        period_prices: { '30': 50_000 },
        external_squad_uuid: null,
        is_daily: false,
        daily_price_kopeks: 0,
        is_active: true,
        display_order: 0,
      },
    ],
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
  } as unknown as BedolagaBackupData;
}

/** Re-imports the donor account behind `row` from a `backup` backup; returns the run's import record. */
async function reimport(backup: Backup, row: Row, panel: object): Promise<string> {
  const importRecordId = await newImportRecord(SOURCE[backup]);
  let errors: readonly string[];
  switch (backup) {
    case 'Remnashop': {
      const importer = new RemnashopImporterService(prisma, panel as never);
      errors = (
        await importer.run({
          mode: 'sync',
          createdBy: null,
          importRecordId,
          users: [donorUser(row)],
          subscriptions: [remnashopSubscription(row)],
        })
      ).errors;
      break;
    }
    case 'Altshop': {
      const importer = new AltshopImporterService(prisma, panel as never, new PointsWalletService());
      errors = (
        await importer.run({
          mode: 'sync',
          createdBy: null,
          importRecordId,
          users: [donorUser(row)],
          subscriptions: [{ ...remnashopSubscription(row), device_type: 'ANDROID' }],
        })
      ).errors;
      break;
    }
    case 'STEALTHNET': {
      const importer = new StealthnetImporterService(
        prisma,
        panel as never,
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
        } as unknown as StealthnetReferralSyncService,
        new PointsWalletService(),
      );
      errors = (await importer.run(stealthnetInput(row, importRecordId))).errors;
      break;
    }
    case 'Bedolaga': {
      const importer = new BedolagaImporterService(prisma, panel as never, new PointsWalletService());
      errors = (await importer.run({ mode: 'sync', createdBy: null, importRecordId, data: bedolagaData(row) })).errors;
      break;
    }
  }
  assert.deepEqual(errors, []);
  return importRecordId;
}

/** What `backup` writes under its own keys, from this backup: the keys a re-import owns. */
function ownKeysAfter(backup: Backup, row: Row, importRecordId: string): Record<string, unknown> {
  switch (backup) {
    case 'Remnashop':
      return {
        importedFrom: 'remnashop',
        importRecordId,
        sourceSubscriptionId: row.donorId,
        originalPlanSnapshot: DONOR.planSnapshot,
      };
    case 'Altshop':
      return {
        importedFrom: 'altshop',
        importRecordId,
        sourceSubscriptionId: row.donorId,
        deviceType: 'ANDROID',
        originalPlanSnapshot: DONOR.planSnapshot,
      };
    case 'STEALTHNET':
      return {
        importedFrom: 'stealthnet',
        importRecordId,
        sourceSubscriptionId: `sub-${row.donorId}`,
        sourceTariffId: DONOR.stealthnetTariffId,
        tariffName: DONOR.planSnapshot.name,
      };
    case 'Bedolaga':
      return {
        importedFrom: 'bedolaga',
        importRecordId,
        sourceSubscriptionId: row.donorId,
        sourceTariffId: DONOR.tariffId,
        tariffName: DONOR.planSnapshot.name,
      };
  }
}

/**
 * The donor facts `backup` writes under names a plan snapshot uses too — only
 * onto a row whose snapshot names no plan.
 */
function donorPlanFacts(backup: Backup): Record<string, unknown> {
  switch (backup) {
    case 'Remnashop':
    case 'Altshop':
      return { tag: DONOR.tag, trafficLimitStrategy: DONOR.strategy };
    case 'STEALTHNET':
      return { currency: DONOR.currency };
    case 'Bedolaga':
      return {};
  }
}

/** Every key of `expected` holds exactly that value in `actual`. */
function assertKeys(actual: Record<string, unknown>, expected: Record<string, unknown>, what: string): void {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `${what}: \`${key}\``);
  }
}

run('A backup re-import keeps the snapshot of a subscription it already has (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `rsnap-${process.pid}-${Date.now()}`);
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.profileSyncJob
      .deleteMany({ where: { subscription: { userId: { in: fx.users } } } })
      .catch(() => undefined);
    await prisma.trialClaim.deleteMany({ where: { userId: { in: fx.users } } }).catch(() => undefined);
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.importRecord.deleteMany({ where: { id: { in: importRecords } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  for (const backup of BACKUPS) {
    it(`RS1 ${backup}: onto a row an operator assigned a plan to and that was renewed here, every key it does not own stays`, async () => {
      const plan = await assignablePlan();
      // «Назначить план» writes the snapshot with the panel's own builder; a
      // renewal paid here then records the duration autopay renews by and the
      // payment's own keys. Both drop the import's keys, which the re-import
      // writes back.
      const assigned = {
        ...(buildPlanSnapshot(plan) as Record<string, unknown>),
        selectedDurationDays: 90,
        snapshotSource: 'PAYMENT_COMPLETION',
        currency: 'RUB',
        amount: '299',
      };
      const row = await linkedRow(backup, () => assigned);
      const importRecordId = await reimport(backup, row, panelServing([profileOf(row)]));
      const after = await snapshotOf(row);
      assertKeys(after, assigned, 'the plan, its limits and the renewal stay');
      assertKeys(after, ownKeysAfter(backup, row, importRecordId), 'the import’s own keys are refreshed');
    });

    it(`RS2 ${backup}: onto a row the plan cloner linked, in the term model, the plan and its term stay and the limits are not taken`, async () => {
      const plan = await assignablePlan();
      // «Клонировать тарифы» → «Привязать импортированные подписки к клонам»:
      // the earlier import's keys, with the clone's identity and display keys
      // spread over them (`BackupPlanClonerService`).
      const linked = (earlier: { donorId: number }) => ({
        importedFrom: SOURCE[backup],
        importRecordId: 'an-earlier-import',
        sourceSubscriptionId: backup === 'STEALTHNET' ? `sub-${earlier.donorId}` : earlier.donorId,
        originalPlanSnapshot: { id: 7, name: 'Donor Basic' },
        id: plan.id,
        planId: plan.id,
        name: plan.name,
        tag: plan.tag,
        type: plan.type,
        icon: plan.icon,
        trafficLimitStrategy: plan.trafficLimitStrategy,
        duration: 30,
      });
      const row = await linkedRow(backup, linked);
      await enterModel(row);
      const termBefore = await prisma.subscriptionTerm.findFirstOrThrow({
        where: { subscriptionId: row.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      });
      const importRecordId = await reimport(backup, row, panelServing([profileOf(row)]));
      const after = await snapshotOf(row);
      const { importedFrom: _source, importRecordId: _earlier, sourceSubscriptionId: _donor, originalPlanSnapshot: _old, ...planKeys } =
        linked(row);
      assertKeys(after, planKeys, 'the linked plan stays');
      assertKeys(after, ownKeysAfter(backup, row, importRecordId), 'the import’s own keys are refreshed');
      assert.deepEqual(await columnsOf(row), { trafficLimit: 100, deviceLimit: 3 }, 'the panel’s 300 GB / 7 are not taken');
      const termAfter = await prisma.subscriptionTerm.findFirstOrThrow({
        where: { subscriptionId: row.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      });
      assert.deepEqual(
        { id: termAfter.id, planId: termAfter.planId, planSnapshot: termAfter.planSnapshot },
        { id: termBefore.id, planId: termBefore.planId, planSnapshot: termBefore.planSnapshot },
        'no term was rotated or rewritten',
      );
    });

    it(`RS3 ${backup}: onto a never-assigned import, the donor’s facts are refreshed and nothing else is lost`, async () => {
      const donorOnly = (earlier: { donorId: number }) => ({
        importedFrom: SOURCE[backup],
        importRecordId: 'an-earlier-import',
        sourceSubscriptionId: backup === 'STEALTHNET' ? `sub-${earlier.donorId}` : earlier.donorId,
        originalPlanSnapshot: { id: 7, name: 'Donor Basic' },
        tag: 'EARLIER_TAG',
        trafficLimitStrategy: 'WEEK',
        currency: 'EUR',
        // Recorded by a renewal of the never-assigned import paid here: the
        // duration autopay renews by.
        selectedDurationDays: 90,
      });
      const row = await linkedRow(backup, donorOnly);
      const importRecordId = await reimport(backup, row, panelServing([profileOf(row)]));
      const after = await snapshotOf(row);
      assertKeys(after, ownKeysAfter(backup, row, importRecordId), 'the import’s own keys are refreshed');
      assertKeys(after, donorPlanFacts(backup), 'the donor’s facts are the row’s own while it is on no plan');
      assert.equal(after['selectedDurationDays'], 90, 'the duration autopay renews by stays');
      assert.equal('id' in after || 'planId' in after, false, 'and no plan is invented');
    });

    it(`RS4 ${backup}: with the panel unreadable, the donor’s own limits are written as before and the snapshot is kept`, async () => {
      const plan = await assignablePlan();
      const assigned = { ...(buildPlanSnapshot(plan) as Record<string, unknown>), selectedDurationDays: 90 };
      const row = await linkedRow(backup, () => assigned);
      const importRecordId = await reimport(backup, row, PANEL_DOWN);
      const after = await snapshotOf(row);
      assertKeys(after, assigned, 'the plan stays');
      assertKeys(after, ownKeysAfter(backup, row, importRecordId), 'the import’s own keys are refreshed');
      const columns = await columnsOf(row);
      assert.equal(columns.deviceLimit, DONOR.devices, 'the donor fallback still writes the donor’s devices');
    });
  }
});
