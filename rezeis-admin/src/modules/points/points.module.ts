import { Module } from '@nestjs/common';

import { PointsWalletService } from './services/points-wallet.service';

/**
 * The points wallet — the one writer of `User.points` and of its journal.
 *
 * Imported by every module that moves points (referrals, quests, users,
 * account-merge, imports, and the payments hook that credits cashback). The
 * service has no dependencies of its own: it writes into the transaction the
 * caller hands it, so this module imports nothing.
 *
 * A writer that reaches for `prisma.user.update({ points })` instead of this
 * service breaks the ledger invariant the live-database spec guards; the
 * spec, not a lint rule, is what catches it.
 */
@Module({
  providers: [PointsWalletService],
  exports: [PointsWalletService],
})
export class PointsModule {}
