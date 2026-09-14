import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PointsLedgerSource,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  ReferralRewardType,
  SubscriptionStatus,
  SyncAction,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { AdminRewardsService } from '../src/modules/referrals/services/admin-rewards.service';
import {
  referralPaymentRewardSourceKey,
  ReferralQualificationService,
} from '../src/modules/referrals/services/referral-qualification.service';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Referral rewards issued on the spot, and taken back on a refund, on a real
 * PostgreSQL.
 *
 * `referral-qualification.service.spec.ts` models the database, and a model
 * cannot answer the questions that decide whether this works in production:
 * whether the `FOR UPDATE` on `referrals` really serialises two workers that
 * picked up the same payment, whether the JSON-path lookup that finds the
 * subscription an EXTRA_DAYS reward extended matches the payload the issue
 * wrote, and whether `NOT startsWith` on a nullable `source_key` keeps or drops
 * the NULL rows. Each of those is asked of PostgreSQL here.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `rr-${process.pid}-${Date.now()}`;
const DAY_MS = 24 * 60 * 60 * 1000;

let prisma: PrismaService;
let service: ReferralQualificationService;
const enqueued: string[] = [];

run('Referral rewards on PostgreSQL', () => {
  const userIds: string[] = [];
  const transactionIds: string[] = [];
  let previousReferralSettings: Prisma.JsonValue | null = null;

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    service = new ReferralQualificationService(
      prisma,
      { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      new PointsWalletService(),
      {
        enqueue: async (syncJobId: string) => {
          enqueued.push(syncJobId);
        },
      } as never,
    );
    const settings = await prisma.settings.upsert({
      where: { id: 1 },
      update: {},
      create: {},
      select: { referralSettings: true },
    });
    previousReferralSettings = settings.referralSettings;
  });

  after(async () => {
    if (prisma === undefined) return;
    if (previousReferralSettings !== null) {
      await prisma.settings
        .update({
          where: { id: 1 },
          data: { referralSettings: previousReferralSettings as Prisma.InputJsonValue },
        })
        .catch(() => undefined);
    }
    await prisma.referralReward.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.transaction.deleteMany({ where: { id: { in: transactionIds } } }).catch(() => undefined);
    await prisma.user
      .updateMany({ where: { id: { in: userIds } }, data: { currentSubscriptionId: null } })
      .catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  async function useReferralSettings(settings: Prisma.InputJsonObject): Promise<void> {
    await prisma.settings.update({ where: { id: 1 }, data: { referralSettings: settings } });
  }

  async function user(suffix: string): Promise<string> {
    const id = `${prefix}-${suffix}`;
    userIds.push(id);
    await prisma.user.create({ data: { id, referralCode: `${id}-code`, name: suffix } });
    return id;
  }

  async function invite(referrerId: string, referredId: string): Promise<string> {
    const referral = await prisma.referral.create({
      data: { referrerId, referredId },
      select: { id: true },
    });
    return referral.id;
  }

  async function payment(input: {
    readonly suffix: string;
    readonly userId: string;
    readonly createdAt: Date;
    readonly gatewayType?: PaymentGatewayType;
    readonly planSnapshot?: Prisma.InputJsonObject;
  }): Promise<string> {
    const id = `${prefix}-tx-${input.suffix}`;
    transactionIds.push(id);
    await prisma.transaction.create({
      data: {
        id,
        paymentId: `${prefix}-pay-${input.suffix}`,
        userId: input.userId,
        status: TransactionStatus.COMPLETED,
        purchaseType: PurchaseType.NEW,
        channel: PurchaseChannel.WEB,
        gatewayType: input.gatewayType ?? PaymentGatewayType.TELEGRAM_STARS,
        currency: Currency.RUB,
        amount: new Prisma.Decimal('300'),
        planSnapshot: input.planSnapshot ?? {},
        createdAt: input.createdAt,
      },
    });
    return id;
  }

  async function points(userId: string): Promise<number> {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { points: true } });
    return row.points;
  }

  it('pays a payment once when two workers race for it, at both levels, through the wallet', async () => {
    await useReferralSettings({
      enabled: true,
      accrualStrategy: 'ON_EACH_PAYMENT',
      rewardType: 'POINTS',
      level1Reward: 100,
      level2Reward: 10,
    });
    const grandparent = await user('race-gp');
    const referrer = await user('race-ref');
    const payer = await user('race-payer');
    await invite(grandparent, referrer);
    const referralId = await invite(referrer, payer);
    const first = await payment({ suffix: 'race-1', userId: payer, createdAt: new Date(Date.now() - 60_000) });

    const outcomes = await Promise.all([
      service.qualifyReferralAfterPurchase(first),
      service.qualifyReferralAfterPurchase(first),
    ]);

    const paid = outcomes.filter((outcome) => outcome !== null);
    assert.equal(paid.length, 1, 'exactly one worker pays; the other queues on the lock and finds it done');
    assert.equal(paid[0]!.issued.length, 2);
    assert.equal(await points(referrer), 100);
    assert.equal(await points(grandparent), 10);

    const rewards = await prisma.referralReward.findMany({
      where: { sourceKey: { startsWith: `referral-payment:${first}:` } },
      orderBy: { sourceKey: 'asc' },
    });
    assert.deepEqual(
      rewards.map((reward) => [reward.sourceKey, reward.userId, reward.isIssued, reward.issuedBy]),
      [
        [referralPaymentRewardSourceKey(first, 1), referrer, true, null],
        [referralPaymentRewardSourceKey(first, 2), grandparent, true, null],
      ],
    );
    const ledger = await prisma.pointsLedgerEntry.findMany({
      where: { source: PointsLedgerSource.REFERRAL_REWARD, referenceKey: { in: rewards.map((r) => r.id) } },
    });
    assert.equal(ledger.length, 2, 'one ledger row per reward, keyed on the reward');
    const referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    assert.equal(referral.qualifiedTransactionId, first);

    // The next payment earns its own rewards and does not re-qualify.
    const second = await payment({ suffix: 'race-2', userId: payer, createdAt: new Date() });
    const again = await service.qualifyReferralAfterPurchase(second);
    assert.equal(again?.issued.length, 2);
    assert.equal(await points(referrer), 200);
    assert.equal(await points(grandparent), 20);

    // A refund of the first payment takes back exactly its two rewards…
    await service.reverseQualificationForTransaction(first);
    assert.equal(await points(referrer), 100);
    assert.equal(await points(grandparent), 10);
    const revoked = await prisma.referralReward.findMany({
      where: { sourceKey: { startsWith: `referral-payment:${first}:` }, revokedAt: { not: null } },
    });
    assert.equal(revoked.length, 2);
    // …and the payment that still holds its reward takes the qualification over.
    const moved = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    const secondL1 = await prisma.referralReward.findUniqueOrThrow({
      where: { sourceKey: referralPaymentRewardSourceKey(second, 1) },
    });
    assert.equal(moved.qualifiedTransactionId, second);
    assert.equal(moved.qualifiedAt?.getTime(), secondL1.createdAt.getTime());

    // A replayed refund and a replayed webhook of the refunded payment change nothing.
    await service.reverseQualificationForTransaction(first);
    assert.equal(await service.qualifyReferralAfterPurchase(first), null);
    assert.equal(await points(referrer), 100);
    assert.equal(await points(grandparent), 10);
    const revokedLedger = await prisma.pointsLedgerEntry.count({
      where: { source: PointsLedgerSource.REFERRAL_REWARD_REVOKED, userId: { in: [referrer, grandparent] } },
    });
    assert.equal(revokedLedger, 2);
  });

  it('takes EXTRA_DAYS back from the subscription that got them, found through the sync job payload', async () => {
    await useReferralSettings({
      enabled: true,
      accrualStrategy: 'ON_FIRST_PAYMENT',
      rewardType: 'EXTRA_DAYS',
      level1Reward: 7,
      level2Reward: 0,
    });
    const referrer = await user('days-ref');
    const payer = await user('days-payer');
    const referralId = await invite(referrer, payer);

    // The current subscription is perpetual, so the issue falls back to the
    // newest finite one — not `currentSubscriptionId`.
    const perpetual = await prisma.subscription.create({
      data: { id: `${prefix}-sub-perpetual`, userId: referrer, status: SubscriptionStatus.ACTIVE, expiresAt: null },
    });
    const finiteEnd = new Date(Date.now() + 30 * DAY_MS);
    const finite = await prisma.subscription.create({
      data: {
        id: `${prefix}-sub-finite`,
        userId: referrer,
        status: SubscriptionStatus.ACTIVE,
        expiresAt: finiteEnd,
        remnawaveId: '8c1e9a52-5d7e-4c1a-9f2b-2d6f4b7a1e30',
      },
    });
    await prisma.user.update({ where: { id: referrer }, data: { currentSubscriptionId: perpetual.id } });
    const paid = await payment({ suffix: 'days', userId: payer, createdAt: new Date() });

    const outcome = await service.qualifyReferralAfterPurchase(paid);

    assert.equal(outcome?.issued.length, 1);
    const reward = outcome!.issued[0]!;
    assert.equal(reward.type, ReferralRewardType.EXTRA_DAYS);
    const extended = await prisma.subscription.findUniqueOrThrow({ where: { id: finite.id } });
    assert.equal(extended.expiresAt?.getTime(), finiteEnd.getTime() + 7 * DAY_MS);
    const issueJob = await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: reward.syncJobId! } });
    assert.equal(issueJob.subscriptionId, finite.id);
    assert.equal((issueJob.payload as { rewardId?: string }).rewardId, reward.id);

    // Before the refund the customer moves on: a newer finite subscription is
    // now both current and what the fallback would pick. Neither got the days.
    const newerEnd = new Date(Date.now() + 90 * DAY_MS);
    const newer = await prisma.subscription.create({
      data: { id: `${prefix}-sub-newer`, userId: referrer, status: SubscriptionStatus.ACTIVE, expiresAt: newerEnd },
    });
    await prisma.user.update({ where: { id: referrer }, data: { currentSubscriptionId: newer.id } });
    enqueued.length = 0;

    await service.reverseQualificationForTransaction(paid);

    const restored = await prisma.subscription.findUniqueOrThrow({ where: { id: finite.id } });
    assert.equal(restored.expiresAt?.getTime(), finiteEnd.getTime(), 'the days leave the subscription that got them');
    const untouched = await prisma.subscription.findUniqueOrThrow({ where: { id: newer.id } });
    assert.equal(untouched.expiresAt?.getTime(), newerEnd.getTime());
    const reversalJobs = await prisma.profileSyncJob.findMany({
      where: { subscriptionId: finite.id, id: { not: issueJob.id } },
    });
    assert.equal(reversalJobs.length, 1);
    assert.equal(reversalJobs[0]!.action, SyncAction.UPDATE);
    assert.deepEqual(
      [
        (reversalJobs[0]!.payload as { source?: string }).source,
        (reversalJobs[0]!.payload as { days?: number }).days,
      ],
      ['REFERRAL_EXTRA_DAYS_REWARD_REVOKED', -7],
    );
    assert.deepEqual(enqueued, [reversalJobs[0]!.id], 'Remnawave follows after commit');
    const cleared = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    assert.equal(cleared.qualifiedAt, null, 'no payment on the referral still holds a reward');
    assert.equal(cleared.qualifiedTransactionId, null);
  });

  it('revokes the unkeyed and the donor-keyed rewards of the referral a refunded IMPORTED payment qualified', async () => {
    // Imported with its donor rewards (Altshop): the one case where a refund
    // takes donor rewards back, and so the one query that asks for NULL keys and
    // donor keys at once.
    const referrer = await user('legacy-ref');
    const payer = await user('legacy-payer');
    const referralId = await invite(referrer, payer);
    const paid = await payment({
      suffix: 'legacy',
      userId: payer,
      createdAt: new Date(),
      planSnapshot: { importedFrom: 'altshop' },
    });
    await prisma.referral.update({
      where: { id: referralId },
      data: { qualifiedAt: new Date(), qualifiedTransactionId: paid },
    });
    // Issued before rewards carried a per-payment key, and imported with a donor key.
    await prisma.referralReward.create({
      data: { referralId, userId: referrer, type: ReferralRewardType.POINTS, amount: 50, isIssued: true },
    });
    await prisma.referralReward.create({
      data: {
        referralId,
        userId: referrer,
        type: ReferralRewardType.POINTS,
        amount: 20,
        isIssued: true,
        sourceKey: `altshop-reward:${prefix}`,
      },
    });
    await prisma.user.update({ where: { id: referrer }, data: { points: 70 } });

    await service.reverseQualificationForTransaction(paid);

    const rewards = await prisma.referralReward.findMany({ where: { referralId } });
    assert.equal(rewards.length, 2);
    assert.ok(
      rewards.every((reward) => reward.revokedAt !== null),
      'NULL source_key survives the NOT startsWith filter because it is asked for explicitly',
    );
    assert.equal(await points(referrer), 0);
  });

  it('first payment only: an imported donor reward blocks it, a partner-balance payment does not take its place', async () => {
    await useReferralSettings({
      enabled: true,
      accrualStrategy: 'ON_FIRST_PAYMENT',
      rewardType: 'POINTS',
      level1Reward: 100,
      level2Reward: 0,
    });
    const referrer = await user('first-ref');
    const payer = await user('first-payer');
    const referralId = await invite(referrer, payer);

    const donorReward = await prisma.referralReward.create({
      data: {
        referralId,
        userId: referrer,
        type: ReferralRewardType.POINTS,
        amount: 30,
        sourceKey: `remnashop-reward:${prefix}`,
      },
    });
    const imported = await payment({ suffix: 'first-imported', userId: payer, createdAt: new Date(Date.now() - 120_000) });
    assert.equal(await service.qualifyReferralAfterPurchase(imported), null, 'paid for in the donor system');
    await prisma.referralReward.delete({ where: { id: donorReward.id } });
    await prisma.transaction.update({ where: { id: imported }, data: { status: TransactionStatus.FAILED } });

    await payment({
      suffix: 'first-partner-balance',
      userId: payer,
      createdAt: new Date(Date.now() - 60_000),
      gatewayType: PaymentGatewayType.PARTNER_BALANCE,
    });
    const withMoney = await payment({ suffix: 'first-money', userId: payer, createdAt: new Date() });

    const outcome = await service.qualifyReferralAfterPurchase(withMoney);

    assert.equal(outcome?.issued.length, 1, 'an earlier partner-balance payment is not the first payment');
    assert.equal(await points(referrer), 100);
    const referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    assert.equal(referral.qualifiedTransactionId, withMoney);
  });

  it('a refund that reverses the referral program before the payment’s own reward hook leaves that hook nothing to issue', async () => {
    // `reverseFulfilledPayment` reverses first and marks the payment CANCELED
    // last; the success hook of the same payment can land in between.
    await useReferralSettings({ enabled: true, accrualStrategy: 'ON_FIRST_PAYMENT', rewardType: 'POINTS', level1Reward: 100 });
    const referrer = await user('early-refund-ref');
    const payer = await user('early-refund-payer');
    await invite(referrer, payer);
    const paid = await payment({ suffix: 'early-refund', userId: payer, createdAt: new Date() });

    await service.reverseQualificationForTransaction(paid);
    const late = await service.qualifyReferralAfterPurchase(paid);
    await prisma.transaction.update({ where: { id: paid }, data: { status: TransactionStatus.CANCELED } });

    assert.equal(late, null);
    assert.equal(await points(referrer), 0);
    assert.equal(await prisma.referralReward.count({ where: { sourceKey: { startsWith: `referral-payment:${paid}:` } } }), 0);
  });

  it('«Выдать» racing a refund: the refund waits for the issue, then takes back what it granted', async () => {
    await useReferralSettings({ enabled: true, accrualStrategy: 'ON_FIRST_PAYMENT', rewardType: 'EXTRA_DAYS', level1Reward: 7 });
    const referrer = await user('race-issue-ref');
    const payer = await user('race-issue-payer');
    await invite(referrer, payer);
    const paid = await payment({ suffix: 'race-issue', userId: payer, createdAt: new Date() });
    const outcome = await service.qualifyReferralAfterPurchase(paid);
    assert.equal(outcome?.pending.length, 1, 'setup: nothing to extend yet, so the reward waits for «Выдать»');
    const rewardId = outcome!.pending[0]!.id;
    const end = new Date(Date.now() + 30 * DAY_MS);
    const subscription = await prisma.subscription.create({
      data: {
        id: `${prefix}-race-issue-sub`,
        userId: referrer,
        status: SubscriptionStatus.ACTIVE,
        expiresAt: end,
        remnawaveId: '0c1e9a52-5d7e-4c1a-9f2b-2d6f4b7a1e31',
      },
    });
    await prisma.user.update({ where: { id: referrer }, data: { currentSubscriptionId: subscription.id } });
    const admin = await prisma.adminUser.create({
      data: { login: `${prefix}-adm`, loginNormalized: `${prefix}-adm`, passwordHash: 'x' },
      select: { id: true },
    });

    // The issue holds its reward row lock across a slow audit write, and the
    // refund starts while it does.
    let auditReached: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      auditReached = resolve;
    });
    const slowAudit = new Proxy(prisma as unknown as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop !== '$transaction') {
          const value = target[prop];
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
        return (run: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction(async (tx) =>
            run(
              new Proxy(tx as unknown as Record<string | symbol, unknown>, {
                get(txTarget, txProp) {
                  if (txProp === 'adminAuditLog') {
                    return {
                      create: async (args: unknown) => {
                        auditReached();
                        await sleep(1500);
                        return (txTarget['adminAuditLog'] as { create: (a: unknown) => Promise<unknown> }).create(args);
                      },
                    };
                  }
                  const value = txTarget[txProp];
                  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(txTarget) : value;
                },
              }),
            ),
            { timeout: 10_000 },
          );
      },
    });
    const adminRewards = new AdminRewardsService(
      slowAudit as never,
      { enqueue: async () => undefined } as never,
      { info: () => undefined } as never,
      new PointsWalletService(),
    );

    const issuing = adminRewards.issue(rewardId, admin.id, { requestId: null, remoteAddress: null, userAgent: null } as never);
    await reached;
    await Promise.all([issuing, service.reverseQualificationForTransaction(paid)]);

    const reward = await prisma.referralReward.findUniqueOrThrow({ where: { id: rewardId } });
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    assert.equal(reward.isIssued, true);
    assert.notEqual(reward.revokedAt, null);
    assert.equal(after.expiresAt?.getTime(), end.getTime(), 'the days the issue granted are taken back');
  });

  it('a refund of the payer and a payment by the payer’s invitee do not deadlock', async () => {
    // The payer's refunded payment qualified his referral before rewards were
    // keyed, so its refund reverses that referral's unkeyed rewards: the
    // grandparent's reward first, then an operator grant to the payer himself
    // (his wallet) — holding the payer's referral row throughout. The invitee's
    // payment credits the payer (his wallet) and inserts its level-2 reward on
    // that same referral row. Locking the row only at that insert, after the
    // credit, was a deadlock.
    await useReferralSettings({ enabled: true, accrualStrategy: 'ON_EACH_PAYMENT', rewardType: 'POINTS', level1Reward: 100, level2Reward: 10 });
    const grandparent = await user('deadlock-g');
    const payer = await user('deadlock-p');
    const invitee = await user('deadlock-u');
    const payerReferral = await invite(grandparent, payer);
    await invite(payer, invitee);
    const refunded = await payment({ suffix: 'deadlock-refunded', userId: payer, createdAt: new Date(Date.now() - DAY_MS) });
    await prisma.referral.update({
      where: { id: payerReferral },
      data: { qualifiedAt: new Date(Date.now() - DAY_MS), qualifiedTransactionId: refunded },
    });
    await prisma.referralReward.create({
      data: { referralId: payerReferral, userId: grandparent, type: ReferralRewardType.POINTS, amount: 100, isIssued: true },
    });
    await prisma.referralReward.create({
      data: { referralId: payerReferral, userId: payer, type: ReferralRewardType.POINTS, amount: 50, isIssued: true, grantedBy: 'admin' },
    });
    await prisma.user.update({ where: { id: grandparent }, data: { points: 100 } });
    await prisma.user.update({ where: { id: payer }, data: { points: 50 } });
    const inviteePayment = await payment({ suffix: 'deadlock-invitee', userId: invitee, createdAt: new Date() });

    // Holding the grandparent's wallet parks the refund after it has locked
    // the payer's referral row.
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${grandparent} FOR UPDATE`);
        await sleep(1200);
      },
      { timeout: 10_000 },
    );
    await sleep(100);
    const errors: string[] = [];
    const warnings: string[] = [];
    const logger = (service as unknown as {
      logger: { error: (message: string) => void; warn: (message: string) => void };
    }).logger;
    const originalError = logger.error;
    const originalWarn = logger.warn;
    logger.error = (message: string) => {
      errors.push(message);
    };
    logger.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      const refund = service.reverseQualificationForTransaction(refunded);
      await sleep(200);
      const qualification = service.qualifyReferralAfterPurchase(inviteePayment);
      await holder;
      const [qualified] = await Promise.all([qualification, refund]);

      assert.deepEqual(errors, [], 'neither side failed');
      // Not merely recovered: the retry on a conflict would hide a deadlock the
      // lock order is there to prevent.
      assert.deepEqual(
        warnings.filter((message) => message.includes('aborted the transaction')),
        [],
        'no transaction was aborted on a conflict',
      );
      assert.equal(qualified?.issued.length, 2, 'the invitee’s payment paid both levels');
    } finally {
      logger.error = originalError;
      logger.warn = originalWarn;
    }
    const unkeyed = await prisma.referralReward.findMany({ where: { referralId: payerReferral, sourceKey: null } });
    assert.ok(unkeyed.length === 2 && unkeyed.every((reward) => reward.revokedAt !== null), 'the refund took both back');
    assert.equal(await points(payer), 100, '50 from the grant taken back, 100 from the invitee’s payment');
    assert.equal(await points(grandparent), 10, 'the refunded 100 taken back, the invitee’s level-2 10 kept');
  });

  it('refunding the first local payment of a referral imported with its donor rewards keeps the donor history', async () => {
    await useReferralSettings({ enabled: true, accrualStrategy: 'ON_EACH_PAYMENT', rewardType: 'POINTS', level1Reward: 100 });
    const referrer = await user('imported-ref');
    const payer = await user('imported-payer');
    // Bedolaga import: an edge without `qualifiedAt`, the donor's earnings as issued keyed rewards.
    const referralId = await invite(referrer, payer);
    await prisma.user.update({ where: { id: referrer }, data: { points: 500 } });
    for (const n of [1, 2]) {
      await prisma.referralReward.create({
        data: {
          referralId,
          userId: referrer,
          type: ReferralRewardType.POINTS,
          amount: 250,
          isIssued: true,
          issuedAt: new Date(),
          sourceKey: `bedolaga-earning:${prefix}-${n}`,
        },
      });
    }
    const local = await payment({ suffix: 'imported-local', userId: payer, createdAt: new Date() });
    await service.qualifyReferralAfterPurchase(local);
    assert.equal(await points(referrer), 600);

    await service.reverseQualificationForTransaction(local);

    assert.equal(await points(referrer), 500, 'the refund of a 100-point payment takes 100');
    const donor = await prisma.referralReward.findMany({ where: { referralId, sourceKey: { startsWith: 'bedolaga-earning:' } } });
    assert.ok(donor.every((reward) => reward.revokedAt === null));
  });

  it('first payment only: after a refund the next payment is paid, even with a payment made in between', async () => {
    await useReferralSettings({ enabled: true, accrualStrategy: 'ON_FIRST_PAYMENT', rewardType: 'POINTS', level1Reward: 100 });
    const referrer = await user('between-ref');
    const payer = await user('between-payer');
    const referralId = await invite(referrer, payer);
    const first = await payment({ suffix: 'between-1', userId: payer, createdAt: new Date(Date.now() - 3 * DAY_MS) });
    assert.equal((await service.qualifyReferralAfterPurchase(first))?.issued.length, 1);
    const between = await payment({ suffix: 'between-2', userId: payer, createdAt: new Date(Date.now() - 2 * DAY_MS) });
    assert.equal(await service.qualifyReferralAfterPurchase(between), null);
    await service.reverseQualificationForTransaction(first);
    await prisma.transaction.update({ where: { id: first }, data: { status: TransactionStatus.CANCELED } });

    const next = await payment({ suffix: 'between-3', userId: payer, createdAt: new Date() });
    const outcome = await service.qualifyReferralAfterPurchase(next);

    assert.equal(outcome?.issued.length, 1);
    assert.equal(await points(referrer), 100);
    const referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    assert.equal(referral.qualifiedTransactionId, next);
  });
});
