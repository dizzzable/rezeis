import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { AddOnLifetime, AddOnType, Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { resolveAddOnRolloutFlags } from '../src/modules/add-on-entitlements/add-on-rollout.config';
import {
  nextRemnawaveReset,
  RESET_EXPIRY_MARGIN_MS,
} from '../src/modules/add-on-entitlements/domain/reset-cycle-policy';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import { EntitlementBoundarySchedulerService } from '../src/modules/add-on-entitlements/services/entitlement-boundary-scheduler.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { ResetBoundaryConfirmationService } from '../src/modules/add-on-entitlements/services/reset-boundary-confirmation.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { AddOnPurchaseService } from '../src/modules/payments/services/addon-purchase.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PricingService } from '../src/modules/plans/services/pricing.service';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import type { RemnawaveProfileFacts } from '../src/modules/remnawave/utils/remnawave-profile-facts.util';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * A TRAFFIC ADD-ON «ДО СБРОСА», FROM THE TILL TO THE PANEL — W7 test 2
 * ════════════════════════════════════════════════════════════════════
 * Bought through the real checkout and the real fulfilment (stage 4 on), on a
 * plan that resets every day: the add-on is ACTIVE until Remnawave's next
 * reset plus the margin. The sweep before that leaves it; the sweep after it
 * holds it while Remnawave's reset is unconfirmed, and takes it off once the
 * reset is seen — the columns back at the plan's 100 GB, and a BOUNDARY_EXPIRY
 * push whose body, run through the real profile sync, carries exactly that.
 *
 * Remnawave is two fakes: the profile read the confirmation asks, and the
 * PATCH the push sends. The checkout runs on the real clock, so the reset is
 * the next 00:05 UTC and the sweeps are run at instants around it.
 *
 * Skipped without TEST_DATABASE_URL; listed in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `s4e2e-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const GIB = 1024n * 1024n * 1024n;

let prisma: PrismaService;
const created = { users: [] as string[], addOns: [] as string[] };

const switchReader = {
  flags: async () => resolveAddOnRolloutFlags({ durableAccounting: true, trafficResetExpiry: true }, {}),
};

/** What the fake Remnawave says the profile's last reset was. */
const remnawave = { lastReset: null as Date | null, reads: 0 };

run('a traffic add-on «до сброса», bought, held and taken off — PostgreSQL', () => {
  let checkout: AddOnPurchaseService;
  let fulfilment: PaymentSubscriptionMutationService;
  let cutover: EntitlementCutoverService;
  let scheduler: EntitlementBoundarySchedulerService;

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    const events = { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined };
    const terms = new SubscriptionTermService();
    const projection = new EffectiveProjectionService();
    const entitlements = new AddOnEntitlementService();
    cutover = new EntitlementCutoverService(prisma, terms, projection);
    fulfilment = new PaymentSubscriptionMutationService(
      prisma,
      events as never,
      entitlements,
      projection,
      terms,
      {} as never,
      cutover,
      switchReader as never,
    );
    checkout = new AddOnPurchaseService(
      prisma,
      new PricingService(),
      {
        createCheckout: async () => ({
          gatewayId: 'g',
          gatewayData: {},
          checkoutUrl: 'https://pay.example/x',
          providerMode: 'REDIRECT',
        }),
      } as never,
      fulfilment,
      { enqueue: async () => undefined } as never,
      { getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }) } as never,
      { evaluate: () => null } as never,
      events as never,
      terms,
      switchReader as never,
    );
    const confirmation = new ResetBoundaryConfirmationService(prisma, {
      refreshProfileFacts: async (): Promise<RemnawaveProfileFacts> => {
        remnawave.reads += 1;
        return { createdAt: null, lastTrafficResetAt: remnawave.lastReset };
      },
    } as never);
    scheduler = new EntitlementBoundarySchedulerService(
      prisma,
      new EntitlementBoundaryService(prisma, entitlements, terms, projection),
      { enqueue: async () => undefined } as never,
      { planForSubscription: async () => ({ status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' }) } as never,
      { executePlan: async () => ({ status: 'DEFERRED' }) } as never,
      terms,
      switchReader as never,
      confirmation,
    );
    await prisma.paymentGateway.upsert({
      where: { type: 'YOOKASSA' },
      update: { isActive: true, currency: 'RUB', settings: { shopId: 's', apiKey: 'k' } },
      create: { type: 'YOOKASSA', isActive: true, currency: 'RUB', settings: { shopId: 's', apiKey: 'k' } },
    });
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, created.users).catch((error: unknown) => {
      console.error('end-to-end cleanup failed', error);
    });
    await prisma.addOn.deleteMany({ where: { id: { in: created.addOns } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('is ACTIVE until the reset plus the margin, held until Remnawave resets, then pushed back to the plan', async () => {
    // A 100 GB plan that resets every day, in the term model, ending in 20 days.
    const userId = `${prefix}-user`;
    await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
    created.users.push(userId);
    const panelId = 960_000 + (process.pid % 10_000);
    const subscription = await prisma.subscription.create({
      data: {
        userId,
        status: SubscriptionStatus.LIMITED,
        planSnapshot: {
          id: `${prefix}-plan`,
          name: 'Daily',
          trafficLimit: 100,
          deviceLimit: 3,
          trafficLimitStrategy: 'DAY',
          internalSquads: [],
          externalSquad: null,
          selectedDurationDays: 30,
        } as Prisma.InputJsonValue,
        trafficLimit: 100,
        deviceLimit: 3,
        internalSquads: [],
        externalSquad: null,
        remnawaveId: String(panelId),
        remnawavePanelId: panelId,
        remnawavePanelUsername: `${prefix}-profile`,
        createdAt: new Date(Date.now() - 10 * DAY_MS),
        startedAt: new Date(Date.now() - 10 * DAY_MS),
        expiresAt: new Date(Date.now() + 20 * DAY_MS),
      },
      select: { id: true },
    });
    const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, subscription.id));
    assert.equal(entered.outcome, 'CREATED', 'fixture: in the term model');
    const addOnId = `${prefix}-addon`;
    await prisma.addOn.create({
      data: {
        id: addOnId,
        name: '+50 GB',
        type: AddOnType.EXTRA_TRAFFIC,
        value: 50,
        prices: { create: [{ currency: 'RUB', price: '99' }] },
      },
    });
    created.addOns.push(addOnId);

    // ── Bought ────────────────────────────────────────────────────────────
    const boughtAt = new Date();
    const answer = await checkout.checkout({
      userId,
      addOnId,
      subscriptionId: subscription.id,
      gatewayType: 'YOOKASSA' as never,
      contractVersion: 2,
    });
    const draft = await prisma.transaction.findUniqueOrThrow({ where: { paymentId: answer.paymentId } });
    const paid = await prisma.transaction.update({ where: { id: draft.id }, data: { status: 'COMPLETED' } });
    await fulfilment.applyCompletedTransaction(paid);

    const entitlement = await prisma.addOnEntitlement.findFirstOrThrow({
      where: { sourceTransactionId: draft.id },
      include: { expiryEpoch: true },
    });
    const resetAt = nextRemnawaveReset({ strategy: 'DAY', anchorAt: null }, boughtAt)!;
    assert.equal(entitlement.lifetime, AddOnLifetime.UNTIL_NEXT_RESET);
    assert.equal(entitlement.state, 'ACTIVE');
    assert.equal(entitlement.expiryEpoch?.plannedEndsAt.toISOString(), resetAt.toISOString(), 'Remnawave’s next DAY reset');
    const takeOffAt = new Date(resetAt.getTime() + RESET_EXPIRY_MARGIN_MS);
    assert.equal(entitlement.expiresAt?.toISOString(), takeOffAt.toISOString(), 'the reset plus the margin');
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).trafficLimit, 150);

    // ── A sweep before that moment leaves it ──────────────────────────────
    await scheduler.runDueBoundaries(new Date(takeOffAt.getTime() - MINUTE_MS));
    assert.equal((await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } })).state, 'ACTIVE');

    // ── After it, Remnawave's reset not seen yet: held ────────────────────
    remnawave.lastReset = new Date(resetAt.getTime() - DAY_MS);
    await scheduler.runDueBoundaries(new Date(takeOffAt.getTime() + MINUTE_MS));
    assert.equal(
      (await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } })).state,
      'ACTIVE',
      'the base limit waits for the counter reset',
    );
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).trafficLimit, 150);
    assert.ok(remnawave.reads > 0, 'Remnawave was asked');

    // ── Remnawave's batch ran: taken off, back at base, and pushed ────────
    remnawave.lastReset = new Date(resetAt.getTime() + 12);
    await scheduler.runDueBoundaries(new Date(takeOffAt.getTime() + 20 * MINUTE_MS));
    const ended = await prisma.addOnEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
      include: { expiryEpoch: true },
    });
    assert.equal(ended.state, 'EXPIRED');
    assert.equal(ended.expiryEpoch?.closeSource, 'WEBHOOK_RECONCILIATION');
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    assert.equal(row.trafficLimit, 100, 'the columns are back at the plan');
    const projection = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({
      where: { subscriptionId: subscription.id },
    });
    assert.equal(projection.desiredTrafficLimitBytes, 100n * GIB);
    const job = await prisma.profileSyncJob.findFirstOrThrow({
      where: { subscriptionId: subscription.id, cause: 'BOUNDARY_EXPIRY', status: 'PENDING' },
    });

    const sent: Array<Record<string, unknown>> = [];
    const profile = { id: panelId, username: `${prefix}-profile`, subscriptionUrl: `https://sub.example/${panelId}` };
    const processor = new ProfileSyncProcessor(
      prisma,
      {
        updateUser: async (body: Record<string, unknown>) => {
          sent.push(body);
          return { kind: 'ok' as const, data: { response: { ...profile, createdAt: '2025-01-01T00:00:00.000Z' } } };
        },
        getUserById: async () => ({ kind: 'ok' as const, data: { response: profile } }),
      } as never,
      {
        generateProfileName: async () => ({ username: profile.username, description: 'e2e' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );
    await processor.process({ data: { syncJobId: job.id } } as never);
    assert.equal(sent.length, 1, 'the boundary push reached the panel once');
    assert.equal(sent[0]!['trafficLimitBytes'], Number(100n * GIB), 'the push carries the plan’s 100 GB');
  });
});
