import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Test } from '@nestjs/testing';

import { AccountMergeService } from '../src/modules/account-merge/services/account-merge.service';
import { AltshopImporterService } from '../src/modules/imports/services/altshop-importer.service';
import { StealthnetImporterService } from '../src/modules/imports/services/stealthnet-importer.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { PointsModule } from '../src/modules/points/points.module';
import { PointsCashbackService } from '../src/modules/points/services/points-cashback.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { RewardGrantService } from '../src/modules/rewards/reward-grant.service';
import { AdminRewardsService } from '../src/modules/referrals/services/admin-rewards.service';
import { ReferralPointsExchangeService } from '../src/modules/referrals/services/referral-points-exchange.service';
import { ReferralQualificationService } from '../src/modules/referrals/services/referral-qualification.service';
import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';

/**
 * Every writer of `User.points` takes the wallet as a REQUIRED dependency, and
 * this proves both halves of "required": Nest supplies the real class when the
 * module is imported, and refuses to construct the writer when it is not.
 *
 * ── Why a test exists for a constructor ───────────────────────────────────
 *
 * The ledger invariant (for every user, SUM(delta) = users.points) holds only
 * while every movement goes through the one writer. A dependency declared
 * `@Optional()` would let a writer come up without it and fall back to — or be
 * tempted back into — writing the column by hand, and the only symptom would
 * be a journal that quietly stops summing to the balance. Required means Nest
 * refuses to start instead, so the thing worth guarding is that Nest CAN
 * start with the wallet and CANNOT without it.
 *
 * `QuestRewardService` used to be on this list and is not any more: the
 * payout moved to `RewardGrantService`, so a quest no longer writes the
 * balance at all. The applier took its place, which is the whole point of
 * the move.
 */
const WRITERS: ReadonlyArray<{ readonly name: string; readonly token: abstract new (...args: never[]) => unknown }> = [
  { name: 'AdminRewardsService', token: AdminRewardsService },
  { name: 'ReferralQualificationService', token: ReferralQualificationService },
  { name: 'ReferralPointsExchangeService', token: ReferralPointsExchangeService },
  { name: 'RewardGrantService', token: RewardGrantService },
  { name: 'AccountMergeService', token: AccountMergeService },
  { name: 'StealthnetImporterService', token: StealthnetImporterService },
  { name: 'AltshopImporterService', token: AltshopImporterService },
  { name: 'AdminUserManagementController', token: AdminUserManagementController },
];

describe('every points writer can be constructed by the injector with the wallet', () => {
  for (const writer of WRITERS) {
    it(`${writer.name} resolves the wallet to the real PointsWalletService`, async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [PointsModule],
        providers: [writer.token as never],
      })
        .useMocker(() => ({}))
        .compile();

      const instance = moduleRef.get(writer.token as never) as { pointsWallet?: unknown };
      assert.ok(
        instance.pointsWallet instanceof PointsWalletService,
        `${writer.name}.pointsWallet did not resolve to the real service`,
      );
      assert.equal(typeof (instance.pointsWallet as PointsWalletService).apply, 'function');

      await moduleRef.close();
    });
  }
});

describe('the payment reconciliation resolves the cashback service', () => {
  it('gets the real PointsCashbackService, itself built on the real wallet', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PointsModule],
      providers: [PaymentReconciliationService],
    })
      .useMocker(() => ({}))
      .compile();

    const reconciliation = moduleRef.get(PaymentReconciliationService) as unknown as {
      pointsCashbackService?: unknown;
    };
    const cashback = reconciliation.pointsCashbackService;
    assert.ok(
      cashback instanceof PointsCashbackService,
      'the cashback hook did not resolve to the real service',
    );
    assert.ok(
      (cashback as unknown as { pointsWallet?: unknown }).pointsWallet instanceof PointsWalletService,
      'and the cashback service did not get the real wallet',
    );

    await moduleRef.close();
  });

  it('Nest refuses to build the reconciliation without the cashback service', async () => {
    await assert.rejects(
      () =>
        Test.createTestingModule({ providers: [PaymentReconciliationService] })
          .useMocker((token) => (token === PointsCashbackService ? undefined : {}))
          .compile(),
      /PointsCashbackService|Nest can't resolve dependencies/,
    );
  });
});

describe('no points writer comes up without the wallet', () => {
  for (const writer of WRITERS) {
    it(`Nest refuses to build ${writer.name} when the wallet is not provided`, async () => {
      await assert.rejects(
        () =>
          Test.createTestingModule({
            providers: [writer.token as never],
          })
            // Every other dependency is mocked; the wallet alone is left
            // unresolved, which is what a module that forgot PointsModule looks
            // like to the injector.
            .useMocker((token) => (token === PointsWalletService ? undefined : {}))
            .compile(),
        /PointsWalletService|Nest can't resolve dependencies/,
        `${writer.name} was constructed without a wallet`,
      );
    });
  }
});
