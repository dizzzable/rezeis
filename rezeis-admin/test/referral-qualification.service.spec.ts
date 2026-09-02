import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PurchaseChannel, PurchaseType, ReferralRewardType } from '@prisma/client';

import { ReferralQualificationService } from '../src/modules/referrals/services/referral-qualification.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';

// The service now runs its critical section inside prisma.$transaction with a
// FOR UPDATE row lock. In unit tests we pass the same mock client through as
// the transaction client and stub $queryRaw (the lock) as a no-op.
function withTx(client: Record<string, unknown>): Record<string, unknown> {
  return {
    ...client,
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ ...client, $queryRaw: async () => [] }),
  };
}

describe('ReferralQualificationService', () => {
  it('does nothing when the operator disabled the referral program', async () => {
    // `enabled` was parsed but never checked, so switching the program off in
    // the panel kept qualifying referrals and minting rewards.
    const referralUpdates: unknown[] = [];
    const rewardCreates: unknown[] = [];
    const service = new ReferralQualificationService(
      withTx({
        transaction: {
          findUnique: async () => ({
            id: 'tx-1',
            userId: 'referred-1',
            purchaseType: PurchaseType.NEW,
            channel: PurchaseChannel.WEB,
            planSnapshot: { id: 'plan-1' },
          }),
        },
        settings: {
          findFirst: async () => ({
            referralSettings: {
              enabled: false,
              reward: { type: 'POINTS', strategy: 'AMOUNT', config: { FIRST: 100 } },
            },
          }),
        },
        referral: {
          findUnique: async () => ({
            id: 'referral-1',
            referrerId: 'referrer-1',
            level: 1,
            qualifiedAt: null,
          }),
          update: async (args: unknown) => referralUpdates.push(args),
        },
        partner: { findUnique: async () => null },
        referralReward: { create: async (args: unknown) => rewardCreates.push(args) },
      }) as never,
      { info: () => undefined } as never,
      new PointsWalletService(),
    );

    await service.qualifyReferralAfterPurchase('tx-1');

    assert.deepStrictEqual(referralUpdates, []);
    assert.deepStrictEqual(rewardCreates, []);
  });

  it('stays enabled when the flag is absent (existing installs are unaffected)', async () => {
    const rewardCreates: unknown[] = [];
    const service = new ReferralQualificationService(
      withTx({
        transaction: {
          findUnique: async () => ({
            id: 'tx-1',
            userId: 'referred-1',
            purchaseType: PurchaseType.NEW,
            channel: PurchaseChannel.WEB,
            planSnapshot: { id: 'plan-1' },
          }),
        },
        settings: {
          findFirst: async () => ({
            referralSettings: {
              reward: { type: 'POINTS', strategy: 'AMOUNT', config: { FIRST: 100 } },
            },
          }),
        },
        referral: {
          findUnique: async ({ where }: { readonly where: Record<string, unknown> }) =>
            where.referredId === 'referred-1'
              ? { id: 'referral-1', referrerId: 'referrer-1', level: 1, qualifiedAt: null }
              : null,
          update: async () => undefined,
        },
        partner: { findUnique: async () => null },
        referralReward: { create: async (args: unknown) => rewardCreates.push(args) },
      }) as never,
      { info: () => undefined } as never,
      new PointsWalletService(),
    );

    await service.qualifyReferralAfterPurchase('tx-1');

    assert.equal(rewardCreates.length, 1);
  });

  it('qualifies a referral and creates configured L1/L2 rewards after a purchase', async () => {
    const referralUpdates: unknown[] = [];
    const rewardCreates: unknown[] = [];
    const events: unknown[] = [];
    const service = new ReferralQualificationService(
      withTx({
        transaction: {
          findUnique: async () => ({
            id: 'tx-1',
            userId: 'referred-1',
            purchaseType: PurchaseType.NEW,
            channel: PurchaseChannel.WEB,
            planSnapshot: { id: 'plan-1' },
          }),
        },
        settings: {
          findFirst: async () => ({
            referralSettings: {
              enabled: true,
              accrual_strategy: 'ON_FIRST_PAYMENT',
              eligible_plan_ids: ['plan-1'],
              reward: { type: 'POINTS', strategy: 'AMOUNT', config: { FIRST: 100, SECOND: 25 } },
            },
          }),
        },
        referral: {
          findUnique: async ({ where }: { readonly where: Record<string, unknown> }) => {
            if (where.referredId === 'referred-1') {
              return { id: 'referral-1', referrerId: 'referrer-1', level: 1, qualifiedAt: null };
            }
            if (where.referredId === 'referrer-1') {
              return { id: 'referral-2', referrerId: 'ancestor-1' };
            }
            return null;
          },
          update: async (args: unknown) => referralUpdates.push(args),
        },
        partner: { findUnique: async () => null },
        referralReward: { create: async (args: unknown) => rewardCreates.push(args) },
      }) as never,
      {
        info: (...args: unknown[]) => events.push(args),
      } as never,
      new PointsWalletService(),
    );

    await service.qualifyReferralAfterPurchase('tx-1');

    assert.equal(referralUpdates.length, 1);
    assert.deepStrictEqual(referralUpdates[0], {
      where: { id: 'referral-1' },
      data: {
        qualifiedAt: (referralUpdates[0] as { data: { qualifiedAt: Date } }).data.qualifiedAt,
        qualifiedTransactionId: 'tx-1',
        qualifiedPurchaseChannel: PurchaseChannel.WEB,
      },
    });
    assert.ok(
      (referralUpdates[0] as { data: { qualifiedAt: unknown } }).data.qualifiedAt instanceof Date,
    );
    assert.deepStrictEqual(rewardCreates, [
      {
        data: {
          referralId: 'referral-1',
          userId: 'referrer-1',
          type: ReferralRewardType.POINTS,
          amount: 100,
        },
      },
      {
        data: {
          referralId: 'referral-2',
          userId: 'ancestor-1',
          type: ReferralRewardType.POINTS,
          amount: 25,
        },
      },
    ]);
    assert.equal(events.length, 1);
  });

  it('creates rewards from the admin FORM shape (rewardType + levelNReward, camelCase)', async () => {
    // Regression: the admin panel persists `rewardType` + `level1Reward`/
    // `level2Reward` + `accrualStrategy` (camelCase), NOT the legacy nested
    // `reward.config`. Before the bridged reader the engine read the legacy
    // shape only, found no reward config, and created ZERO reward rows — so
    // referral rewards silently never accrued from operator-saved settings.
    const rewardCreates: unknown[] = [];
    const service = new ReferralQualificationService(
      withTx({
        transaction: {
          findUnique: async () => ({
            id: 'tx-1',
            userId: 'referred-1',
            purchaseType: PurchaseType.NEW,
            channel: PurchaseChannel.WEB,
            planSnapshot: { id: 'plan-1' },
          }),
        },
        settings: {
          findFirst: async () => ({
            referralSettings: {
              enabled: true,
              accrualStrategy: 'ON_FIRST_PAYMENT',
              rewardType: 'EXTRA_DAYS',
              level1Reward: 7,
              level2Reward: 3,
              qualifyOnPurchase: true,
            },
          }),
        },
        referral: {
          findUnique: async ({ where }: { readonly where: Record<string, unknown> }) => {
            if (where.referredId === 'referred-1') {
              return { id: 'referral-1', referrerId: 'referrer-1', level: 1, qualifiedAt: null };
            }
            if (where.referredId === 'referrer-1') {
              return { id: 'referral-2', referrerId: 'ancestor-1' };
            }
            return null;
          },
          update: async () => undefined,
        },
        partner: { findUnique: async () => null },
        referralReward: { create: async (args: unknown) => rewardCreates.push(args) },
      }) as never,
      { info: () => undefined } as never,
      new PointsWalletService(),
    );

    await service.qualifyReferralAfterPurchase('tx-1');

    assert.deepStrictEqual(rewardCreates, [
      {
        data: {
          referralId: 'referral-1',
          userId: 'referrer-1',
          type: ReferralRewardType.EXTRA_DAYS,
          amount: 7,
        },
      },
      {
        data: {
          referralId: 'referral-2',
          userId: 'ancestor-1',
          type: ReferralRewardType.EXTRA_DAYS,
          amount: 3,
        },
      },
    ]);
  });

  it('honours ON_FIRST_PAYMENT from the camelCase accrualStrategy key (skips non-NEW)', async () => {
    const rewardCreates: unknown[] = [];
    const service = new ReferralQualificationService(
      withTx({
        transaction: {
          findUnique: async () => ({
            id: 'tx-1',
            userId: 'referred-1',
            purchaseType: PurchaseType.RENEW,
            channel: PurchaseChannel.WEB,
            planSnapshot: { id: 'plan-1' },
          }),
        },
        settings: {
          findFirst: async () => ({
            referralSettings: {
              accrualStrategy: 'ON_FIRST_PAYMENT',
              rewardType: 'POINTS',
              level1Reward: 50,
            },
          }),
        },
        referral: {
          findUnique: async () => ({
            id: 'referral-1',
            referrerId: 'referrer-1',
            level: 1,
            qualifiedAt: null,
          }),
          update: async () => undefined,
        },
        partner: { findUnique: async () => null },
        referralReward: { create: async (args: unknown) => rewardCreates.push(args) },
      }) as never,
      { info: () => undefined } as never,
      new PointsWalletService(),
    );

    await service.qualifyReferralAfterPurchase('tx-1');

    // ON_FIRST_PAYMENT + a RENEW purchase → no qualification, no rewards.
    assert.deepStrictEqual(rewardCreates, []);
  });

  it('skips reward creation when the referrer is an active partner', async () => {
    const rewardCreates: unknown[] = [];
    const service = new ReferralQualificationService(
      withTx({
        transaction: {
          findUnique: async () => ({
            id: 'tx-1',
            userId: 'referred-1',
            purchaseType: PurchaseType.NEW,
            channel: PurchaseChannel.WEB,
            planSnapshot: {},
          }),
        },
        settings: {
          findFirst: async () => ({
            referralSettings: {
              reward: { type: 'POINTS', strategy: 'AMOUNT', config: { FIRST: 100 } },
            },
          }),
        },
        referral: {
          findUnique: async () => ({
            id: 'referral-1',
            referrerId: 'partner-user',
            level: 1,
            qualifiedAt: null,
          }),
          update: async () => undefined,
        },
        partner: { findUnique: async () => ({ isActive: true }) },
        referralReward: { create: async (args: unknown) => rewardCreates.push(args) },
      }) as never,
      { info: () => undefined } as never,
      new PointsWalletService(),
    );

    await service.qualifyReferralAfterPurchase('tx-1');

    assert.deepStrictEqual(rewardCreates, []);
  });

  it('UPGRADE with no prior completed payments qualifies (trial → paid first purchase)', async () => {
    const rewardCreates: unknown[] = [];
    const events: unknown[] = [];
    const service = new ReferralQualificationService(
      withTx({
        transaction: {
          findUnique: async () => ({
            id: 'tx-upgrade',
            userId: 'referred-2',
            purchaseType: PurchaseType.UPGRADE,
            channel: PurchaseChannel.WEB,
            planSnapshot: {},
          }),
          // count returns 0 — no prior completed transactions
          count: async () => 0,
        },
        settings: {
          findFirst: async () => ({
            referralSettings: {
              accrual_strategy: 'ON_FIRST_PAYMENT',
              reward: { type: 'POINTS', strategy: 'AMOUNT', config: { FIRST: 50 } },
            },
          }),
        },
        referral: {
          findUnique: async () => ({
            id: 'referral-3',
            referrerId: 'referrer-3',
            level: 1,
            qualifiedAt: null,
          }),
          update: async () => undefined,
        },
        partner: { findUnique: async () => null },
        referralReward: { create: async (args: unknown) => rewardCreates.push(args) },
      }) as never,
      { info: (...args: unknown[]) => events.push(args) } as never,
      new PointsWalletService(),
    );

    await service.qualifyReferralAfterPurchase('tx-upgrade');

    assert.equal(rewardCreates.length, 1, 'UPGRADE trial→paid should produce L1 reward');
    assert.equal(events.length, 1, 'event fires once after qualification');
  });

  it('UPGRADE with prior completed payments does NOT qualify (paid→paid upgrade)', async () => {
    const rewardCreates: unknown[] = [];
    const events: unknown[] = [];
    const service = new ReferralQualificationService(
      withTx({
        transaction: {
          findUnique: async () => ({
            id: 'tx-upgrade2',
            userId: 'referred-3',
            purchaseType: PurchaseType.UPGRADE,
            channel: PurchaseChannel.WEB,
            planSnapshot: {},
          }),
          // count returns 1 — one prior completed transaction exists
          count: async () => 1,
        },
        settings: {
          findFirst: async () => ({
            referralSettings: {
              accrual_strategy: 'ON_FIRST_PAYMENT',
              reward: { type: 'POINTS', strategy: 'AMOUNT', config: { FIRST: 50 } },
            },
          }),
        },
        referral: {
          findUnique: async () => ({
            id: 'referral-4',
            referrerId: 'referrer-4',
            level: 1,
            qualifiedAt: null,
          }),
          update: async () => undefined,
        },
        partner: { findUnique: async () => null },
        referralReward: { create: async (args: unknown) => rewardCreates.push(args) },
      }) as never,
      { info: (...args: unknown[]) => events.push(args) } as never,
      new PointsWalletService(),
    );

    await service.qualifyReferralAfterPurchase('tx-upgrade2');

    assert.deepStrictEqual(rewardCreates, [], 'paid→paid UPGRADE must not qualify');
    assert.deepStrictEqual(events, [], 'no event for non-qualifying UPGRADE');
  });

  it('manually qualifies once and stages configured rewards with the admin actor', async () => {
    const referralUpdates: unknown[] = [];
    const rewardCreates: unknown[] = [];
    const events: unknown[] = [];
    const service = new ReferralQualificationService(
      withTx({
        settings: {
          findFirst: async () => ({
            referralSettings: { rewardType: 'POINTS', level1Reward: 75 },
          }),
        },
        referral: {
          findUnique: async () => ({
            id: 'referral-manual-1',
            referrerId: 'referrer-1',
            qualifiedAt: null,
          }),
          update: async (args: unknown) => referralUpdates.push(args),
        },
        partner: { findUnique: async () => null },
        referralReward: { create: async (args: unknown) => rewardCreates.push(args) },
      }) as never,
      { info: (...args: unknown[]) => events.push(args) } as never,
      new PointsWalletService(),
    );

    const result = await service.qualifyReferralManually({
      referredUserId: 'referred-1',
      actorAdminId: 'admin-1',
    });

    assert.deepStrictEqual(result, {
      referralId: 'referral-manual-1',
      qualified: true,
      rewardsCreated: 1,
    });
    assert.equal(referralUpdates.length, 1);
    assert.deepStrictEqual(rewardCreates, [{
      data: {
        referralId: 'referral-manual-1',
        userId: 'referrer-1',
        type: ReferralRewardType.POINTS,
        amount: 75,
        grantedBy: 'admin-1',
      },
    }]);
    assert.equal(events.length, 1);
  });
});

/**
 * THE DELETION GUARD.
 *
 * `ReferralQualificationService.issueReward` was a second, DIVERGED copy of
 * `AdminRewardsService.issue` + `applyRewardEffect`, with no caller anywhere in
 * `src/`, `test/` or `scripts/` — and it was strictly worse on every point that
 * matters for an `EXTRA_DAYS` reward:
 *
 *   • it only ever looked at `user.currentSubscriptionId`, where the live one
 *     falls back to the newest ACTIVE finite subscription under
 *     `SELECT … FOR UPDATE` and verifies owner and status;
 *   • finding no eligible subscription it marked the reward ISSUED and granted
 *     nothing, where the live one throws `BadRequestException`;
 *   • it created no `ProfileSyncJob`, so the extra days would have lived in the
 *     local database and never reached the customer's real VPN profile.
 *
 * Dead code that LOOKS supported is the hazard: the live service used to cite
 * this method as the model to copy. The guard is a runtime property check
 * rather than a compile-time one on purpose — a type-level assertion on a
 * method that no longer exists is a COMPILE error, and a spec that fails to
 * compile reports zero tests instead of one named failure.
 */
describe('ReferralQualificationService no longer carries a second reward issuer', () => {
  it('exposes no issueReward, on the instance or the prototype', () => {
    const service = new ReferralQualificationService(
      withTx({}) as never,
      { info: () => undefined } as never,
      new PointsWalletService(),
    );
    const holder = service as unknown as Record<string, unknown>;

    assert.equal(
      typeof holder.issueReward,
      'undefined',
      'ReferralQualificationService.issueReward is back: it silently marks an ' +
        'EXTRA_DAYS reward issued when the user has no eligible subscription, ' +
        'and it enqueues no ProfileSyncJob, so the days never reach the panel. ' +
        'Reward issuance belongs to AdminRewardsService.issue.',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        ReferralQualificationService.prototype as object,
        'issueReward',
      ),
      false,
      'issueReward is on the prototype of ReferralQualificationService',
    );
  });

  it('still exposes the methods that DO have callers', () => {
    // The anti-vacuity control. A renamed class, a broken import or a
    // constructor that threw would make the assertion above pass against
    // nothing at all.
    //
    // Every name here is reachable from production code — `payment-reconciliation`
    // and `referral-manual-attach` for the purchase path, `payment-reconciliation`
    // for the reversal, `admin-user-management` for the manual one. A method that
    // is merely PRESENT would make a weaker control, which is why this list is
    // caller-reachable names only: `listRewardsByUser` used to sit on this class
    // with no caller in `src/`, `test/` or `scripts/` — the admin surface reads
    // rewards through `AdminRewardsService.list` — so listing it here would have
    // guarded the very state this spec exists to reject. It has since been
    // deleted; do not add a name here without checking it has a caller first.
    for (const method of [
      'qualifyReferralAfterPurchase',
      'qualifyReferralManually',
      'reverseQualificationForTransaction',
    ]) {
      assert.equal(
        typeof (ReferralQualificationService.prototype as unknown as Record<string, unknown>)[
          method
        ],
        'function',
        `expected ${method} to still be a method on ReferralQualificationService`,
      );
    }
  });
});
