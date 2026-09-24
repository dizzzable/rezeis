import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma, PurchaseType, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * R1-02, the payment half: a plan writer keeps the subscription's import keys
 * (`carryImportDomainKeys`), on PostgreSQL, through the real fulfilment and the
 * real boundary activation. The operator's writers — «Назначить план» and
 * «Назначить план импортированным» — are `plan-writers-keep-import-keys-
 * postgres.spec.ts`.
 *
 * On an installation the customers were moved to from ANOTHER panel, the next
 * import of the same backup finds a row by the donor's ids in its
 * `planSnapshot` (`sourceSubscriptionId` above all). Two writers replaced the
 * whole document with a plan's and dropped them, so that import created a
 * second subscription — and a second profile once synced:
 *
 *  1. an UPGRADE paid by the imported customer
 *     (`PaymentSubscriptionMutationService.upgradeSubscriptionFromPayment`);
 *  2. a queued term reaching its start, which copies the term's plan onto the
 *     subscription (`EntitlementBoundaryService.activateDueScheduledTerm`).
 *
 * Each keeps the import keys now, points `planId` at the new plan, and adds
 * nothing to a row that was never imported. Skipped without
 * TEST_DATABASE_URL; listed in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `w5keys-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const GIB = 1024n * 1024n * 1024n;
const FLAGS = ['ADDON_ENTITLEMENT_SHADOW', 'ADDON_ENTITLEMENT_DIRECT_PURCHASE'] as const;

/** What an importer leaves in the snapshot (`IMPORT_DOMAIN_SNAPSHOT_KEYS`), beside a plan it linked. */
const IMPORTED = {
  importedFrom: 'bedolaga',
  importRecordId: 'import-record-1',
  sourceSubscriptionId: 'donor-subscription-42',
  sourceTariffId: 'donor-tariff-7',
  tariffName: 'Donor tariff',
  originalPlanSnapshot: { name: 'Donor tariff', price: 199 },
  purchasedTrafficGb: 5,
} as const;

let prisma: PrismaService;
let fulfilment: PaymentSubscriptionMutationService;
let cutover: EntitlementCutoverService;
let terms: SubscriptionTermService;
let boundary: EntitlementBoundaryService;
const created = { plans: [] as string[], users: [] as string[] };
let counter = 0;
const next = (): number => ++counter;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);

async function createPlan(options: { readonly upgradeTo?: readonly string[] } = {}): Promise<string> {
  const id = `${prefix}-plan-${next()}`;
  await prisma.plan.create({
    data: {
      id,
      name: id,
      orderIndex: 920_000 + next(),
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
      trafficLimitStrategy: 'NO_RESET',
      availability: 'ALL',
      upgradeToPlanIds: [...(options.upgradeTo ?? [])],
      durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '299' }] } }] },
    },
  });
  created.plans.push(id);
  return id;
}

/** A subscription on `planId`; an imported one carries the import keys and `planId`, as the plan cloner leaves it. */
async function subscriptionOn(
  planId: string,
  input: { readonly imported: boolean; readonly expiresAt: Date },
): Promise<{ readonly userId: string; readonly subscriptionId: string }> {
  const userId = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
  created.users.push(userId);
  const panelId = 850_000 + next();
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: {
        id: planId,
        name: planId,
        trafficLimit: 100,
        deviceLimit: 3,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
        selectedDurationDays: 30,
        ...(input.imported ? { ...IMPORTED, planId } : {}),
      } as Prisma.InputJsonValue,
      trafficLimit: 100,
      deviceLimit: 3,
      remnawaveId: String(panelId),
      remnawavePanelId: panelId,
      createdAt: inDays(-10),
      startedAt: inDays(-10),
      expiresAt: input.expiresAt,
    },
    select: { id: true },
  });
  return { userId, subscriptionId: subscription.id };
}

async function snapshotOf(subscriptionId: string): Promise<Record<string, unknown>> {
  const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, select: { planSnapshot: true } });
  return row.planSnapshot as Record<string, unknown>;
}

/** The import keys, carried as they were, and `planId` on the new plan. */
function assertKeptImportKeys(snapshot: Record<string, unknown>, planId: string): void {
  assert.equal(snapshot['id'], planId, 'the plan writer’s own document');
  for (const [key, value] of Object.entries(IMPORTED)) {
    assert.deepEqual(snapshot[key], value, `${key} was dropped: the next import of the backup duplicates the subscription`);
  }
  assert.equal(snapshot['planId'], planId, 'planId left at the old plan counts the row as still on it');
}

function assertNoImportKeys(snapshot: Record<string, unknown>): void {
  for (const key of [...Object.keys(IMPORTED), 'planId']) {
    assert.equal(key in snapshot, false, `${key} appeared on a row that was never imported`);
  }
}

async function withFlagsOn<T>(body: () => Promise<T>): Promise<T> {
  const previous = FLAGS.map((name) => [name, process.env[name]] as const);
  for (const name of FLAGS) process.env[name] = 'true';
  try {
    return await body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

run('an upgrade, and a queued term reaching its start, keep the subscription’s import keys (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    for (const name of FLAGS) process.env[name] = 'false';
    prisma = new PrismaService();
    await prisma.$connect();
    const events = { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined };
    terms = new SubscriptionTermService();
    const projection = new EffectiveProjectionService();
    const entitlements = new AddOnEntitlementService();
    cutover = new EntitlementCutoverService(prisma, terms, projection);
    fulfilment = new PaymentSubscriptionMutationService(prisma, events as never, entitlements, projection, terms, {} as never, cutover);
    boundary = new EntitlementBoundaryService(prisma, entitlements, terms, projection);
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, created.users).catch((error: unknown) => {
      console.error('import keys cleanup failed', error);
    });
    await prisma.plan.deleteMany({ where: { id: { in: created.plans } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  describe('an UPGRADE the imported customer paid for', () => {
    async function payUpgrade(owner: { readonly userId: string; readonly subscriptionId: string }, target: string): Promise<void> {
      const row = await prisma.transaction.create({
        data: {
          paymentId: `${prefix}-pay-${next()}`,
          userId: owner.userId,
          subscriptionId: owner.subscriptionId,
          status: 'COMPLETED',
          purchaseType: PurchaseType.UPGRADE,
          channel: 'WEB',
          gatewayType: 'YOOKASSA',
          currency: 'RUB',
          amount: new Prisma.Decimal('299'),
          planSnapshot: { id: target, selectedDurationDays: 30 } as Prisma.InputJsonValue,
        },
      });
      await fulfilment.applyCompletedTransaction(row);
    }

    for (const model of ['on the columns', 'in the term model'] as const) {
      it(`moves the row onto the new plan and keeps the donor's ids — ${model}`, async () => {
        const target = await createPlan();
        const plan = await createPlan({ upgradeTo: [target] });
        const owner = await subscriptionOn(plan, { imported: true, expiresAt: inDays(20) });

        await (model === 'in the term model' ? withFlagsOn(() => payUpgrade(owner, target)) : payUpgrade(owner, target));

        assertKeptImportKeys(await snapshotOf(owner.subscriptionId), target);
      });
    }

    it('control: a row never imported gets the plan’s document and nothing else', async () => {
      const target = await createPlan();
      const plan = await createPlan({ upgradeTo: [target] });
      const owner = await subscriptionOn(plan, { imported: false, expiresAt: inDays(20) });

      await payUpgrade(owner, target);

      const snapshot = await snapshotOf(owner.subscriptionId);
      assert.equal(snapshot['id'], target);
      assertNoImportKeys(snapshot);
    });
  });

  describe('a queued term reaching its start', () => {
    async function queueTerm(subscriptionId: string, planId: string, startsAt: Date): Promise<void> {
      await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, subscriptionId));
      await prisma.$transaction((tx) =>
        terms.createScheduledInTransaction(tx, {
          subscriptionId,
          planId,
          planSnapshot: {
            id: planId,
            name: planId,
            trafficLimit: 100,
            deviceLimit: 3,
            trafficLimitStrategy: 'NO_RESET',
            internalSquads: [],
            externalSquad: null,
            selectedDurationDays: 30,
            snapshotSource: 'RENEWAL_TERM',
          } as Prisma.InputJsonValue,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * DAY_MS),
          baseTrafficLimitBytes: 100n * GIB,
          baseDeviceLimit: 3,
          trafficResetStrategy: 'NO_RESET',
          resetAnchorAt: startsAt,
        }),
      );
    }

    it('copies the term’s plan onto the subscription and keeps the donor’s ids', async () => {
      const plan = await createPlan();
      const termPlan = await createPlan();
      const startsAt = inDays(1);
      const owner = await subscriptionOn(plan, { imported: true, expiresAt: startsAt });
      await queueTerm(owner.subscriptionId, termPlan, startsAt);

      const activation = await boundary.activateDueScheduledTerm(owner.subscriptionId, new Date(startsAt.getTime() + 1000));

      assert.equal(activation.activated, true, 'fixture: the queued term began');
      assertKeptImportKeys(await snapshotOf(owner.subscriptionId), termPlan);
    });

    it('control: a row never imported gets the term’s plan and nothing else', async () => {
      const plan = await createPlan();
      const termPlan = await createPlan();
      const startsAt = inDays(1);
      const owner = await subscriptionOn(plan, { imported: false, expiresAt: startsAt });
      await queueTerm(owner.subscriptionId, termPlan, startsAt);

      await boundary.activateDueScheduledTerm(owner.subscriptionId, new Date(startsAt.getTime() + 1000));

      const snapshot = await snapshotOf(owner.subscriptionId);
      assert.equal(snapshot['id'], termPlan);
      assertNoImportKeys(snapshot);
    });
  });
});
