import 'reflect-metadata';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { PlanAvailability, PlanType } from '@prisma/client';

import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PlanSquadPropagationService } from '../src/modules/plans/services/plan-squad-propagation.service';
import { PlansAdminService } from '../src/modules/plans/services/plans-admin.service';
import { PlansAdminValidators } from '../src/modules/plans/services/plans-admin.validators';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { ReferralPointsExchangeService } from '../src/modules/referrals/services/referral-points-exchange.service';
import { RewardGrantService } from '../src/modules/rewards/reward-grant.service';
import { SubscriptionMutationsService } from '../src/modules/subscriptions/services/subscription-mutations.service';
import { buildPlanReferenceDb, PlanReferenceDb, Row } from './fixtures/plan-reference-db';
import { NOT_IN_TERM_MODEL } from './helpers/term-model-hooks';
import { pinAddOnStagesOffForThisFile } from './helpers/rollout-flags';

// Written against every `ADDON_*` stage off (the legacy path): these fakes
// do not stage the durable model's reads. Stages 1, 2 and 6 default ON since
// 24.09.2026, so the file says so instead of relying on the default.
pinAddOnStagesOffForThisFile();

/**
 * A DELETED PLAN REACHES SUBSCRIBERS UNDER THE NAME IT WAS SOLD AS.
 *
 * Creating a plan under a deleted plan's name renames the hidden row to
 * `<name> (deleted <id tail>)` so the unique index lets the new one have it.
 * The hidden row keeps being granted and fulfilled — that is why it is kept —
 * and every one of those paths copied the LIVE name into the new snapshot. So
 * the next wheel code, quest trial, ad bonus, referral gift or late-settling
 * payment on it delivered "Премиум (deleted n33gtpbe)" to the cabinet, the bot
 * and every expiry notice, while earlier subscribers on the same plan still
 * read "Премиум".
 *
 * Each case below drives the REAL writer over a plan renamed the real way (the
 * plans service taking its name), and reads the name out of what it wrote.
 */

const CONTEXT = {
  currentAdmin: { id: 'admin-1' } as never,
  requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
};
/** A realistic cuid, so the suffix carries a real id's tail. */
const HIDDEN_ID = 'cmsxo98e8006r01jgn33gtpbe';
const SOLD_AS = 'Премиум';
const DAY_MS = 24 * 60 * 60 * 1000;

let db: PlanReferenceDb;
let hidden: Row;

beforeEach(async () => {
  db = buildPlanReferenceDb({
    plans: [
      {
        id: HIDDEN_ID,
        name: SOLD_AS,
        deletedAt: new Date(Date.now() - DAY_MS),
        deletedWhileOnSale: true,
        isActive: false,
        isArchived: true,
        trafficLimit: 50,
        deviceLimit: 2,
        internalSquads: ['squad-a'],
        description: 'Fast',
      },
    ],
  });
  const remnawave = { getInternalSquadOptions: async () => [], getExternalSquadOptions: async () => [] };
  const plans = new PlansAdminService(
    db.client as never,
    remnawave as never,
    { syncPlanSnapshotMetadata: async () => 0 } as never,
    new PlansAdminValidators(db.client as never, remnawave as never),
    new PlanSquadPropagationService(db.client as never, { enqueue: async () => undefined } as never),
  );
  await plans.createPlan(
    {
      name: SOLD_AS,
      type: PlanType.BOTH,
      availability: PlanAvailability.ALL,
      deviceLimit: 1,
      durations: [{ days: 30, prices: [{ currency: 'USD', price: '9.99' }] }],
    },
    CONTEXT,
  );
  hidden = db.plan(HIDDEN_ID)!;
  // Anti-vacuity: the hidden row really wears the suffix every case is about.
  assert.equal(hidden.name, `${SOLD_AS} (deleted n33gtpbe)`);
});

describe('the name a hidden plan is granted under', () => {
  it('a quest, wheel or contest subscription code', async () => {
    let written: Record<string, unknown> | undefined;
    const tx = {
      plan: db.client.plan,
      user: { findUnique: async () => ({ telegramId: null }) },
      promocode: {
        findUnique: async () => null,
        create: async (args: { data: Record<string, unknown> }) => {
          written = args.data;
          return { id: 'promo-1' };
        },
      },
    };

    await new RewardGrantService(new PointsWalletService()).apply(tx as never, {
      userId: 'user-1',
      grant: { kind: 'PROMOCODE', amount: 30, planId: HIDDEN_ID },
      origin: { pointsSource: 'QUEST_REWARD', referenceKey: 'quest-1', details: {}, codePrefix: 'QUEST-' },
    });

    const plan = written?.plan as Record<string, unknown> | undefined;
    assert.equal(plan?.name, SOLD_AS, 'the minted code carries the name the plan was renamed to');
    assert.equal(plan?.id, HIDDEN_ID);
    assert.equal('deletedAt' in (plan ?? {}), false, 'the snapshot grew a key it never had');
  });

  it('a trial grant — a quest’s DAYS fallback, an ad placement’s TARIFF bonus', async () => {
    let written: Record<string, unknown> | undefined;
    const tx = {
      $queryRaw: async () => [{ id: 'user-1' }],
      trialClaim: {
        aggregate: async () => ({ _sum: { units: 0 } }),
        create: async (args: { data: Record<string, unknown> }) => ({ id: 'claim-1', ...args.data }),
      },
      trialGrant: { upsert: async () => undefined },
      subscription: {
        create: async (args: { data: Record<string, unknown> }) => {
          written = args.data;
          return { id: 'sub-1', ...args.data };
        },
      },
      profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
    };
    const prisma = {
      plan: db.client.plan,
      $transaction: async <T>(callback: (client: unknown) => Promise<T>): Promise<T> => callback(tx),
    };

    await new SubscriptionMutationsService(prisma as never, { enqueue: async () => undefined } as never, NOT_IN_TERM_MODEL as never).grantTrial({
      userId: 'user-1',
      planId: HIDDEN_ID,
      durationDays: 14,
    });

    const snapshot = written?.planSnapshot as Record<string, unknown> | undefined;
    assert.equal(snapshot?.name, SOLD_AS, 'the trial subscription carries the name the plan was renamed to');
    assert.equal(snapshot?.id, HIDDEN_ID);
    assert.equal('deletedAt' in (snapshot ?? {}), false, 'the snapshot grew a key it never had');
  });

  it('a referral points-exchange gift code', async () => {
    let written: Record<string, unknown> | undefined;
    const giftSettings = {
      points_exchange: {
        exchange_enabled: true,
        gift_subscription: {
          enabled: true,
          points_cost: 500,
          min_points: 500,
          max_points: -1,
          gift_plan_id: HIDDEN_ID,
          gift_duration_days: 30,
        },
      },
    };
    const service = new ReferralPointsExchangeService(
      {
        settings: { findFirst: async () => ({ referralSettings: giftSettings }) },
        user: { findUnique: async () => ({ id: 'user-1', points: 1200, currentSubscriptionId: null }) },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({
            user: { findUnique: async () => ({ id: 'user-1' }), updateMany: async () => ({ count: 1 }) },
            plan: db.client.plan,
            promocode: {
              create: async (args: { data: Record<string, unknown> }) => {
                written = args.data;
                return { id: 'gift-promo-1' };
              },
            },
            referralPointsExchange: { create: async () => ({ id: 'exchange-1' }) },
            pointsLedgerEntry: { findUnique: async () => null, create: async () => ({ id: 'ledger-1' }) },
          }),
      } as never,
      {} as never,
      new PointsWalletService(),
      NOT_IN_TERM_MODEL as never,
    );

    await service.executeExchange({ userId: 'user-1', type: 'GIFT_SUBSCRIPTION', points: 500 });

    const plan = written?.plan as Record<string, unknown> | undefined;
    assert.equal(plan?.name, SOLD_AS, 'the gift code carries the name the plan was renamed to');
    assert.equal(plan?.id, HIDDEN_ID);
  });
});

describe('the name a paid invoice on a hidden plan is fulfilled under', () => {
  function paymentService(prisma: unknown, captured: { termSnapshot?: Record<string, unknown> } = {}) {
    return new PaymentSubscriptionMutationService(
      prisma as never,
      { info: () => undefined, warn: () => undefined } as never,
      {} as never,
      {} as never,
      {
        // The tail is aligned before a renewal appends; already aligned here.
        alignTailToExpiryInTransaction: async () => ({ outcome: 'UNCHANGED', termId: 'term-active' }),
        createScheduledInTransaction: async (_tx: unknown, input: { planSnapshot: Record<string, unknown> }) => {
          captured.termSnapshot = input.planSnapshot;
          return { id: 'term-2', generation: 2, status: 'SCHEDULED' };
        },
        activateInTransaction: async () => undefined,
      } as never,
      {} as never,
    );
  }

  const transaction = {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    subscriptionId: 'sub-1',
    purchaseType: 'NEW',
    gatewayType: 'YOOKASSA',
    currency: 'USD',
    amount: { toString: () => '9.99' },
    deviceTypes: [],
    planSnapshot: { id: HIDDEN_ID, selectedDurationDays: 30, availability: 'ALL' },
  };

  it('a purchase paid before the delete (the same snapshot a renewal and an upgrade write)', async () => {
    let written: Record<string, unknown> | undefined;
    const tx = {
      subscription: {
        create: async (args: { data: Record<string, unknown> }) => {
          written = args.data;
          return { id: 'sub-1', remnawaveId: null, ...args.data };
        },
      },
      profileSyncJob: { create: async () => ({ id: 'sync-1', subscriptionId: 'sub-1' }) },
      transaction: { update: async () => undefined },
      user: { updateMany: async () => ({ count: 1 }) },
    };
    const service = paymentService({ $transaction: async (callback: (client: unknown) => unknown) => callback(tx) });
    const create = (
      service as unknown as {
        createSubscriptionFromPayment(input: unknown): Promise<unknown>;
      }
    ).createSubscriptionFromPayment.bind(service);

    await create({ transaction, purchasedPlan: hidden, selectedDurationDays: 30 });

    const snapshot = written?.planSnapshot as Record<string, unknown> | undefined;
    assert.equal(snapshot?.name, SOLD_AS, 'the paid subscription carries the name the plan was renamed to');
    assert.equal(snapshot?.id, HIDDEN_ID);
  });

  it('a line of a combined renewal drafted before snapshots were versioned', async () => {
    let written: Record<string, unknown> | undefined;
    const subscription = {
      id: 'sub-1',
      status: 'ACTIVE',
      isTrial: false,
      expiresAt: new Date(Date.now() + 10 * DAY_MS),
      remnawaveId: 'rw-1',
      planSnapshot: { id: HIDDEN_ID, name: SOLD_AS, trafficLimit: 50, deviceLimit: 2, internalSquads: ['squad-a'], externalSquad: null },
      trafficLimit: 50,
      deviceLimit: 2,
      internalSquads: ['squad-a'],
      externalSquad: null,
    };
    // No `snapshotVersion`: fulfilment falls back to the LIVE plan row.
    const item = {
      id: 'item-1',
      transactionId: 'tx-1',
      subscriptionId: 'sub-1',
      planId: HIDDEN_ID,
      durationDays: 30,
      appliedAt: null,
      amount: '9.99',
      currency: 'USD',
      addOnLines: null,
      planSnapshot: { id: HIDDEN_ID, selectedDurationDays: 30 },
    };
    const tx = {
      $queryRaw: async () => [{ id: 'sub-1', status: 'ACTIVE' }],
      transactionItem: {
        updateMany: async () => ({ count: 1 }),
        findUnique: async () => item,
        update: async () => item,
      },
      transaction: { update: async () => ({}) },
      plan: db.client.plan,
      subscription: {
        findUnique: async () => subscription,
        update: async (args: { data: Record<string, unknown> }) => {
          written = args.data;
          return { ...subscription, ...args.data };
        },
      },
      subscriptionEffectiveProjection: { findUnique: async () => null },
      // Not in the term model: the renewal stays on the columns.
      subscriptionTerm: { findFirst: async () => null },
      profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
    };
    const previousShadow = process.env.ADDON_ENTITLEMENT_SHADOW;
    // Stage 1 explicitly OFF: unset means ON since the 24.09.2026 flip.
    process.env.ADDON_ENTITLEMENT_SHADOW = 'false';
    try {
      const service = paymentService({
        transactionItem: { findMany: async () => [item] },
        user: { updateMany: async () => ({ count: 0 }) },
        $transaction: async (callback: (client: unknown) => unknown) => callback(tx),
      });
      await service.applyCompletedTransaction({
        ...transaction,
        subscriptionId: null,
        purchaseType: 'RENEW',
        planSnapshot: { combinedRenewal: true, snapshotVersion: 1 },
      } as never);
    } finally {
      if (previousShadow === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
      else process.env.ADDON_ENTITLEMENT_SHADOW = previousShadow;
    }

    const snapshot = written?.planSnapshot as Record<string, unknown> | undefined;
    assert.equal(snapshot?.name, SOLD_AS, 'the renewed subscription carries the name the plan was renamed to');
    assert.equal(snapshot?.id, HIDDEN_ID);
  });

  it('the durable term a renewal schedules', async () => {
    const captured: { termSnapshot?: Record<string, unknown> } = {};
    const service = paymentService({}, captured);
    const tx = {
      $queryRaw: async () => [{ id: 'sub-1', status: 'ACTIVE' }],
      subscriptionTerm: {
        findFirst: async (args: { where: { status?: unknown } }) =>
          args.where.status === 'ACTIVE'
            ? { id: 'term-1' }
            : { id: 'term-1', status: 'ACTIVE', generation: 1, endsAt: new Date(Date.now() + 5 * DAY_MS) },
      },
    };
    const schedule = (
      service as unknown as {
        scheduleRenewalTermInTransaction(tx: unknown, input: unknown): Promise<unknown>;
      }
    ).scheduleRenewalTermInTransaction.bind(service);

    await schedule(tx, { subscriptionId: 'sub-1', plan: hidden, durationDays: 30 });

    assert.equal(captured.termSnapshot?.snapshotSource, 'RENEWAL_TERM', 'fixture: the renewal term was not written');
    assert.equal(captured.termSnapshot?.name, SOLD_AS, 'the renewal term carries the name the plan was renamed to');
  });

  it('the durable term an upgrade starts', async () => {
    const captured: { termSnapshot?: Record<string, unknown> } = {};
    const service = paymentService({}, captured);
    const tx = {
      $queryRaw: async () => [{ id: 'sub-1', status: 'ACTIVE' }],
      subscriptionTerm: {
        findFirst: async () => ({ id: 'term-1' }),
        findMany: async () => [],
      },
    };
    const start = (
      service as unknown as {
        startUpgradeTermInTransaction(tx: unknown, input: unknown): Promise<unknown>;
      }
    ).startUpgradeTermInTransaction.bind(service);

    await start(tx, {
      deferrals: [],
      subscriptionId: 'sub-1',
      plan: hidden,
      durationDays: 30,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * DAY_MS),
    });

    assert.equal(captured.termSnapshot?.snapshotSource, 'UPGRADE_TERM', 'fixture: the upgrade term was not written');
    assert.equal(captured.termSnapshot?.name, SOLD_AS, 'the upgrade term carries the name the plan was renamed to');
  });
});
