import { Module } from '@nestjs/common';

import { PointsCashbackService } from './services/points-cashback.service';
import { PointsLedgerService } from './services/points-ledger.service';
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
  // NOTHING is imported here on purpose, and the "cashback credited" message
  // is why it is worth saying out loud. Emitting it from this module would
  // mean importing `NotificationsModule`, which brings auth, web push, custom
  // emoji and two Bull queues along — into the seven modules that import this
  // one merely to move a balance. Telling the buyer what a payment earned is
  // the payment pipeline's business, so the message is sent from the
  // post-fulfilment hook in `PaymentReconciliationService`, where that stack
  // already lives, and this module stays a leaf.
  providers: [PointsWalletService, PointsCashbackService, PointsLedgerService],
  exports: [PointsWalletService, PointsCashbackService, PointsLedgerService],
})
export class PointsModule {}
