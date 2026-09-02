import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Test } from '@nestjs/testing';

import { AccountMergeService } from '../src/modules/account-merge/services/account-merge.service';
import { AltshopImporterService } from '../src/modules/imports/services/altshop-importer.service';
import { StealthnetImporterService } from '../src/modules/imports/services/stealthnet-importer.service';
import { PointsModule } from '../src/modules/points/points.module';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { QuestRewardService } from '../src/modules/quests/services/quest-reward.service';
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
 */
const WRITERS: ReadonlyArray<{ readonly name: string; readonly token: abstract new (...args: never[]) => unknown }> = [
  { name: 'AdminRewardsService', token: AdminRewardsService },
  { name: 'ReferralQualificationService', token: ReferralQualificationService },
  { name: 'ReferralPointsExchangeService', token: ReferralPointsExchangeService },
  { name: 'QuestRewardService', token: QuestRewardService },
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
