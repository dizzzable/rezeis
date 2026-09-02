import { Module } from '@nestjs/common';

import { PointsCashbackService } from './services/points-cashback.service';
import { PointsWalletService } from './services/points-wallet.service';

/**
 * The points wallet — the one writer of `User.points` and of its journal —
 * and the purchase cashback that credits through it.
 *
 * Imported by every module that moves points (referrals, quests, users,
 * account-merge, imports) and by payments for the cashback hook. The wallet
 * has no dependencies of its own: it writes into the transaction the caller
 * hands it. The cashback service reads the catalogue and settings through
 * the global Prisma service and reports through the global events service,
 * so this module still imports nothing.
 *
 * A writer that reaches for `prisma.user.update({ points })` instead of the
 * wallet breaks the ledger invariant the live-database spec guards; the
 * spec, not a lint rule, is what catches it.
 */
@Module({
  providers: [PointsWalletService, PointsCashbackService],
  exports: [PointsWalletService, PointsCashbackService],
})
export class PointsModule {}
