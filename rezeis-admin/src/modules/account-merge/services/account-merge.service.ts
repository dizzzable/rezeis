import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PointsLedgerSource, Prisma, SpinLedgerSource, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import { PointsWalletService } from '../../points/services/points-wallet.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { SpinWalletService } from '../../wheel/services/spin-wallet.service';
import { AccountMergeInput, AccountMergeResult } from '../interfaces/account-merge.interface';
import { lockTrialClaimUser } from '../../subscriptions/services/trial-claim-ledger.util';
import { RECOVERY_WITHDRAWAL_HOLD_PURPOSE } from '../../web-auth/utils/recovery-withdrawal-hold.util';

type Tx = Prisma.TransactionClient;

/**
 * The child tables of `User` the merge leaves to the source's delete, on
 * purpose. Everything else is moved — `test/account-merge-relations.spec.ts`
 * holds the schema to that.
 *
 * Both are wallet journals: every `balance_after` in them is relative to a
 * wallet that will no longer exist, and re-pointed they would stop the
 * survivor's own rows summing to its balance. The balance itself moves
 * through the wallet, journaled on both sides (`ACCOUNT_MERGE` for the points,
 * `MANUAL_ADJUSTMENT` for the spins).
 */
export const MERGE_DROPS: Readonly<Record<string, string>> = {
  PointsLedgerEntry: 'the points journal of the deleted wallet; the balance moves through PointsWalletService',
  SpinLedgerEntry: 'the spins journal of the deleted wallet; the balance moves through SpinWalletService',
};

/**
 * AccountMergeService
 * ───────────────────
 * Transactionally consolidates a SOURCE `User` into a TARGET `User`, then
 * deletes the source. Every child row is re-pointed BEFORE the delete — both
 * the `onDelete: Restrict` tables (Transaction / ReferralReward /
 * PromocodeActivation / PartnerWithdrawal) that would otherwise block, and the
 * `onDelete: Cascade` tables that would otherwise be lost. Unique constraints
 * that can collide on a userId re-point are deduped (the target's row wins).
 * Partner balances are summed. Irreversible by design — the caller must pass
 * `confirm: true` and the operation is audited.
 */
@Injectable()
export class AccountMergeService {
  private readonly logger = new Logger(AccountMergeService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly systemEventsService: SystemEventsService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly pointsWallet: PointsWalletService,
    /**
     * The wheel's spin balance moves through its own wallet, as the points do.
     * Last, `@Optional()` and defaulted, so a positional construction or a
     * testing module that predates it keeps working; it has no dependencies of
     * its own.
     */
    @Optional()
    private readonly spinWallet: SpinWalletService = new SpinWalletService(),
  ) {}

  public async merge(input: AccountMergeInput): Promise<AccountMergeResult> {
    if (!input.confirm) {
      throw new BadRequestException('Merge must be explicitly confirmed');
    }
    if (input.sourceId === input.targetId) {
      throw new BadRequestException('Cannot merge an account into itself');
    }

    const result = await this.prismaService.$transaction(async (tx) => {
      const source = await tx.user.findUnique({
        where: { id: input.sourceId },
        select: {
          id: true,
          telegramId: true,
          email: true,
          points: true,
          spinBalance: true,
          personalDiscount: true,
          purchaseDiscount: true,
          maxSubscriptions: true,
          acquisitionPlacementId: true,
          acquisitionAt: true,
          registrationIp: true,
          registrationUserAgent: true,
          registrationReferer: true,
          registrationUtm: true,
          registrationChannel: true,
          partner: { select: { id: true, balance: true, totalEarned: true, totalWithdrawn: true } },
          webAccount: { select: { id: true } },
          trialGrant: { select: { id: true } },
        },
      });
      const target = await tx.user.findUnique({
        where: { id: input.targetId },
        select: {
          id: true,
          telegramId: true,
          email: true,
          points: true,
          spinBalance: true,
          personalDiscount: true,
          purchaseDiscount: true,
          maxSubscriptions: true,
          acquisitionPlacementId: true,
          acquisitionAt: true,
          registrationIp: true,
          registrationUserAgent: true,
          registrationReferer: true,
          registrationUtm: true,
          registrationChannel: true,
          partner: { select: { id: true } },
          webAccount: { select: { id: true } },
          trialGrant: { select: { id: true } },
        },
      });
      if (source === null) throw new NotFoundException('Source account not found');
      if (target === null) throw new NotFoundException('Target account not found');

      // Serialize quota admission/claim writers on both identities. Stable id
      // order prevents two opposite merge attempts from deadlocking.
      for (const userId of [source.id, target.id].sort()) {
        await lockTrialClaimUser(tx, userId);
      }

      const srcBalance = source.partner?.balance ?? 0;

      // 1. Free the source's unique scalars up-front so the later target set
      //    can never transiently collide.
      await tx.user.update({
        where: { id: source.id },
        data: { telegramId: null, email: null, currentSubscriptionId: null },
      });

      // 2. Re-point straightforward child collections (no userId-unique).
      const [subscriptions, transactions] = await Promise.all([
        tx.subscription.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
        tx.transaction.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
      ]);
      await Promise.all([
        tx.referralReward.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
        tx.referralInvite.updateMany({ where: { inviterId: source.id }, data: { inviterId: target.id } }),
        tx.userNotificationEvent.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
        tx.webPushSubscription.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
        tx.supportTicket.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
        tx.adClick.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
        tx.broadcastMessage.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
        // OAuth links + saved payment instruments: all keyed on a GLOBALLY
        // unique provider id (UserOAuthLink `(provider, providerUserId)`,
        // SavedPaymentMethod `(gatewayType, providerMethodId)`,
        // PaymentMethodSetup `providerMethodId`), so re-pointing userId can
        // never collide on the target. Previously these were silently
        // cascade-DELETED with the source user — losing a person's social
        // logins and bound cards on merge (HIGH #14).
        tx.userOAuthLink.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
        tx.savedPaymentMethod.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
        tx.paymentMethodSetup.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
        // Trial quota is global per surviving identity. Preserve every
        // CONSUMED/RESERVED/RELEASED audit row; transaction/subscription ids
        // remain stable and globally unique, so this re-point cannot collide.
        tx.trialClaim.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
      ]);

      // 3. Dedupe-then-repoint the userId-unique collections.
      await this.moveReferralPointsExchanges(tx, source.id, target.id);
      await this.movePromocodeActivations(tx, source.id, target.id);
      await this.moveLegalConsents(tx, source.id, target.id);
      const partnerTransactions = await this.movePartnerTransactionsAsReferral(tx, source.id, target.id);
      await this.movePartnerReferralsAsReferral(tx, source.id, target.id);
      await this.moveAdConversion(tx, source.id, target.id);
      await this.moveQuestCompletions(tx, source.id, target.id);

      // 4. Referral edges: drop any direct source↔target edge (would become a
      //    self-referral), then move referredBy (1:1 unique) + referralsGiven.
      await tx.referral.deleteMany({
        where: {
          OR: [
            { referrerId: source.id, referredId: target.id },
            { referrerId: target.id, referredId: source.id },
          ],
        },
      });
      await this.moveReferredBy(tx, source.id, target.id);
      await tx.referral.updateMany({ where: { referrerId: source.id }, data: { referrerId: target.id } });

      // 5. Partner consolidation.
      if (source.partner !== null && target.partner !== null) {
        await this.movePartnerLedger(tx, source.partner.id, target.partner.id);
        await tx.partner.update({
          where: { id: target.partner.id },
          data: {
            balance: { increment: srcBalance },
            totalEarned: { increment: source.partner.totalEarned },
            totalWithdrawn: { increment: source.partner.totalWithdrawn },
          },
        });
        await tx.partner.delete({ where: { id: source.partner.id } });
      } else if (source.partner !== null && target.partner === null) {
        await tx.partner.update({ where: { id: source.partner.id }, data: { userId: target.id } });
      }

      // 6. Trial grant — keep exactly one.
      if (source.trialGrant !== null) {
        if (target.trialGrant !== null) {
          await tx.trialGrant.delete({ where: { id: source.trialGrant.id } });
        } else {
          await tx.trialGrant.update({ where: { id: source.trialGrant.id }, data: { userId: target.id } });
        }
      }

      // 7. Web account — at most one survives (unique userId/login/email).
      //
      //    The recovery hold on a partner balance (72 hours after a password
      //    recovery by login alone) is a row on the WEB ACCOUNT and
      //    cascades with it. Step 5 already put the source's balance on the
      //    survivor; deleting either web account here would delete its hold
      //    with it and make held money withdrawable at once. So a standing hold
      //    moves to the web account that is kept, first. With a hold on each
      //    side both land there, and the lookup takes the later end.
      if (source.webAccount !== null) {
        const keepSource = input.choices.keepLogin === 'source';
        if (target.webAccount !== null && keepSource) {
          await this.carryRecoveryHold(tx, target.webAccount.id, source.webAccount.id, target.id);
          await tx.webAccount.delete({ where: { id: target.webAccount.id } });
          await tx.webAccount.update({ where: { id: source.webAccount.id }, data: { userId: target.id } });
        } else if (target.webAccount !== null) {
          await this.carryRecoveryHold(tx, source.webAccount.id, target.webAccount.id, target.id);
          await tx.webAccount.delete({ where: { id: source.webAccount.id } });
        } else {
          await tx.webAccount.update({ where: { id: source.webAccount.id }, data: { userId: target.id } });
        }
      }

      // 8. Re-read the source's freed telegram/email (captured before nulling).
      //    Apply the chosen survivors + scalar merges to the target.
      const currentSubscriptionId = await this.resolveCurrentSubscription(
        tx,
        target.id,
        input.choices.currentSubscriptionId ?? null,
      );
      // telegram/email survivor: when only one side has the value, it always
      // moves to the surviving target; when both have it, the explicit keep
      // choice decides ('source' → take the deleted account's value).
      const finalTelegram =
        source.telegramId === null
          ? undefined
          : target.telegramId === null
            ? source.telegramId
            : input.choices.keepTelegram === 'source'
              ? source.telegramId
              : undefined;
      const finalEmail =
        source.email === null
          ? undefined
          : target.email === null
            ? source.email
            : input.choices.keepEmail === 'source'
              ? source.email
              : undefined;
      // The balance moves through the wallet, not through the update below, so
      // the merge leaves two ACCOUNT_MERGE rows behind: the source emptied and
      // the survivor credited by the same amount. The source's own ledger rows
      // go with it when it is deleted further down; they are not re-pointed,
      // because every `balance_after` in them was relative to a wallet that
      // will no longer exist, and the survivor's own rows would stop summing
      // to its balance.
      //
      // Both rows were locked FOR UPDATE at the top of this transaction, so
      // `source.points` is the balance the debit finds. A legacy negative
      // balance (the unfloored referral reversal could produce one) is
      // credited up to zero on the source and floored on the survivor: the
      // old arithmetic would have pushed the survivor's balance down by a
      // debt nobody was ever going to collect.
      const movedPoints = source.points;
      if (movedPoints !== 0) {
        const emptied = await this.pointsWallet.apply(tx, {
          userId: source.id,
          delta: -movedPoints,
          source: PointsLedgerSource.ACCOUNT_MERGE,
          referenceKey: `merge:${source.id}:out`,
          details: { mergedInto: target.id },
        });
        if (!emptied.applied) {
          throw new BadRequestException(
            `Account merge could not move the points of ${source.id}: ${emptied.reason}`,
          );
        }
        const credited = await this.pointsWallet.apply(tx, {
          userId: target.id,
          delta: movedPoints,
          source: PointsLedgerSource.ACCOUNT_MERGE,
          referenceKey: `merge:${source.id}:in`,
          details: { mergedFrom: source.id },
          shortfall: 'floor',
        });
        if (!credited.applied) {
          throw new BadRequestException(
            `Account merge could not credit the points of ${source.id} to ${target.id}: ${credited.reason}`,
          );
        }
      }
      await tx.user.update({
        where: { id: target.id },
        data: {
          telegramId: finalTelegram,
          email: finalEmail,
          maxSubscriptions: Math.max(target.maxSubscriptions, source.maxSubscriptions),
          personalDiscount: Math.max(target.personalDiscount, source.personalDiscount),
          purchaseDiscount: Math.max(target.purchaseDiscount, source.purchaseDiscount),
          acquisitionPlacementId:
            target.acquisitionPlacementId ?? source.acquisitionPlacementId ?? undefined,
          acquisitionAt: target.acquisitionAt ?? source.acquisitionAt ?? undefined,
          // Registration snapshot: target-first write-once (same as acquisition).
          registrationIp: target.registrationIp ?? source.registrationIp ?? undefined,
          registrationUserAgent:
            target.registrationUserAgent ?? source.registrationUserAgent ?? undefined,
          registrationReferer: target.registrationReferer ?? source.registrationReferer ?? undefined,
          registrationUtm:
            (target.registrationUtm as Prisma.InputJsonValue | null) ??
            (source.registrationUtm as Prisma.InputJsonValue | null) ??
            undefined,
          registrationChannel:
            target.registrationChannel ?? source.registrationChannel ?? undefined,
          currentSubscriptionId: currentSubscriptionId ?? undefined,
        },
      });

      // 8b. Unspent discount grants move with the customer.
      //
      // `purchaseDiscount` above is a bare percentage and is merged by taking
      // the larger; a GRANT carries the plans it may be spent on and when it
      // expires, and neither survives that column. The delete below cascades
      // (`UserPendingDiscount.user` is `onDelete: Cascade`), so without this
      // every restricted discount the source account held is destroyed
      // silently — the customer merges two accounts and loses the offer they
      // merged them to keep.
      await tx.userPendingDiscount.updateMany({
        where: { userId: source.id, consumedAt: null },
        data: { userId: target.id },
      });

      // 8c. The wheel's spins move like the points: the source emptied and the
      //     survivor credited, a journal row on each side. Until 17.10.2026 the
      //     balance was not read at all and died with the source.
      await this.moveSpinBalance(tx, source.id, source.spinBalance, target.id);

      // 8d. Everything the schema grew after this service was written, which
      //     the delete below would have taken (Cascade) or orphaned (SetNull).
      await this.moveLaterChildren(tx, source.id, target.id);

      // 9. Delete the now-drained source.
      await tx.user.delete({ where: { id: source.id } });

      // Subscriptions with a live Remnawave profile → re-sync candidates.
      const remnawaveSubs = await tx.subscription.findMany({
        where: { userId: target.id, remnawaveId: { not: null } },
        select: { id: true },
      });

      return {
        mergedUserId: target.id,
        movedCounts: {
          subscriptions: subscriptions.count,
          transactions: transactions.count,
          partnerTransactions,
        },
        remnawaveSubscriptionIds: remnawaveSubs.map((s) => s.id),
        sourceBalanceMinor: srcBalance,
      };
    });

    this.systemEventsService.info(
      EVENT_TYPES.USER_ACCOUNTS_MERGED,
      'USER',
      'Accounts merged',
      {
        sourceId: input.sourceId,
        targetId: input.targetId,
        actorAdminId: input.actorAdminId,
        choices: input.choices,
        movedCounts: result.movedCounts,
        sourcePartnerBalanceMinor: result.sourceBalanceMinor,
      },
    );

    // Post-commit, best-effort: re-sync each moved subscription's Remnawave
    // profile so the panel description (target login / username / reiwa_id) and
    // telegramId reflect the surviving account. A panel hiccup never rolls back
    // the committed merge — the profile-sync sweep retries PENDING jobs.
    for (const subscriptionId of result.remnawaveSubscriptionIds) {
      try {
        const job = await this.prismaService.profileSyncJob.create({
          data: {
            subscriptionId,
            action: SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            payload: { source: 'ACCOUNT_MERGE' } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        await this.profileSyncQueueService.enqueue(job.id);
      } catch (err) {
        this.logger.warn(
          `Account merge: failed to enqueue Remnawave re-sync for subscription ${subscriptionId}: ${(err as Error).message}`,
        );
      }
    }

    return {
      mergedUserId: result.mergedUserId,
      movedCounts: result.movedCounts,
      remnawaveSubscriptionIds: result.remnawaveSubscriptionIds,
    };
  }

  /**
   * Moves every standing recovery hold of the web account about to be deleted
   * onto the one that is kept, so the delete's cascade takes only holds that
   * already ended. `destination` names the surviving customer, as a hold
   * written for that account would.
   */
  private async carryRecoveryHold(
    tx: Tx,
    fromWebAccountId: string,
    toWebAccountId: string,
    survivorUserId: string,
  ): Promise<void> {
    await tx.authChallenge.updateMany({
      where: {
        webAccountId: fromWebAccountId,
        purpose: RECOVERY_WITHDRAWAL_HOLD_PURPOSE,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { webAccountId: toWebAccountId, destination: survivorUserId },
    });
  }

  /**
   * `(userId, idempotencyKey)` unique — retain the complete source ledger,
   * but clear a source key that already belongs to the target. The target
   * exchange remains the canonical replay for that key after the accounts
   * become one; the historical source row is still auditable.
   */
  private async moveReferralPointsExchanges(tx: Tx, sourceId: string, targetId: string): Promise<void> {
    const targetRows = await tx.referralPointsExchange.findMany({
      where: { userId: targetId, idempotencyKey: { not: null } },
      select: { idempotencyKey: true },
    });
    const targetKeys = targetRows
      .map((row) => row.idempotencyKey)
      .filter((key): key is string => key !== null);
    if (targetKeys.length > 0) {
      await tx.referralPointsExchange.updateMany({
        where: { userId: sourceId, idempotencyKey: { in: targetKeys } },
        data: { idempotencyKey: null },
      });
    }
    await tx.referralPointsExchange.updateMany({
      where: { userId: sourceId },
      data: { userId: targetId },
    });
  }

  /**
   * `(userId, documentKey)` is the primary key — drop source rows the target
   * already holds, then move the rest.
   *
   * Without this the consents die with the source user on the CASCADE at the
   * end of the merge, and the surviving account has no record of having
   * accepted anything. Nothing stops working — consent is asked once, at
   * sign-up, and is never re-checked — so the loss is silent and purely
   * evidentiary, which is exactly the kind that is noticed far too late.
   *
   * The EARLIEST acceptance wins on a collision: the source row is dropped only
   * when the target already has one for that document, and if the source
   * accepted first its timestamp is the one worth keeping. So the collision is
   * resolved by comparing dates rather than by blindly preferring the target.
   */
  private async moveLegalConsents(tx: Tx, sourceId: string, targetId: string): Promise<void> {
    const [sourceRows, targetRows] = await Promise.all([
      tx.userLegalConsent.findMany({ where: { userId: sourceId } }),
      tx.userLegalConsent.findMany({ where: { userId: targetId } }),
    ]);
    if (sourceRows.length === 0) return;

    const targetByKey = new Map(targetRows.map((row) => [row.documentKey, row]));
    for (const row of sourceRows) {
      const existing = targetByKey.get(row.documentKey);
      if (existing === undefined) {
        await tx.userLegalConsent.update({
          where: { userId_documentKey: { userId: sourceId, documentKey: row.documentKey } },
          data: { userId: targetId },
        });
        continue;
      }
      if (row.acceptedAt < existing.acceptedAt) {
        await tx.userLegalConsent.update({
          where: { userId_documentKey: { userId: targetId, documentKey: row.documentKey } },
          data: { acceptedAt: row.acceptedAt },
        });
      }
      await tx.userLegalConsent.delete({
        where: { userId_documentKey: { userId: sourceId, documentKey: row.documentKey } },
      });
    }
  }

  /** `(promocodeId, userId)` unique — drop source rows that collide on target. */
  private async movePromocodeActivations(tx: Tx, sourceId: string, targetId: string): Promise<void> {
    const targetRows = await tx.promocodeActivation.findMany({
      where: { userId: targetId },
      select: { promocodeId: true },
    });
    const taken = new Set(targetRows.map((r) => r.promocodeId));
    const sourceRows = await tx.promocodeActivation.findMany({
      where: { userId: sourceId },
      select: { id: true, promocodeId: true },
    });
    const dupes = sourceRows.filter((r) => taken.has(r.promocodeId)).map((r) => r.id);
    if (dupes.length > 0) {
      await tx.promocodeActivation.deleteMany({ where: { id: { in: dupes } } });
    }
    await tx.promocodeActivation.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });
  }

  /** `PartnerTransaction.referralUserId` (the payer) — no unique, plain move. */
  private async movePartnerTransactionsAsReferral(tx: Tx, sourceId: string, targetId: string): Promise<number> {
    const moved = await tx.partnerTransaction.updateMany({
      where: { referralUserId: sourceId },
      data: { referralUserId: targetId },
    });
    return moved.count;
  }

  /** `(partnerId, referralUserId)` unique — dedupe on the referral side. */
  private async movePartnerReferralsAsReferral(tx: Tx, sourceId: string, targetId: string): Promise<void> {
    const targetRows = await tx.partnerReferral.findMany({
      where: { referralUserId: targetId },
      select: { partnerId: true },
    });
    const taken = new Set(targetRows.map((r) => r.partnerId));
    const sourceRows = await tx.partnerReferral.findMany({
      where: { referralUserId: sourceId },
      select: { id: true, partnerId: true },
    });
    const dupes = sourceRows.filter((r) => taken.has(r.partnerId)).map((r) => r.id);
    if (dupes.length > 0) {
      await tx.partnerReferral.deleteMany({ where: { id: { in: dupes } } });
    }
    await tx.partnerReferral.updateMany({ where: { referralUserId: sourceId }, data: { referralUserId: targetId } });
  }

  /**
   * `(questId, userId, periodKey)` unique — a merge can produce two rows for
   * the same quest+period (one per account). The target's completion wins
   * (its claim/reward-issued state is canonical for the surviving user); the
   * source's colliding row is dropped, non-colliding source completions are
   * re-pointed so the merged account keeps quests only the source had.
   * Previously the whole set was cascade-deleted with the source (HIGH #14).
   */
  private async moveQuestCompletions(tx: Tx, sourceId: string, targetId: string): Promise<void> {
    const targetRows = await tx.questCompletion.findMany({
      where: { userId: targetId },
      select: { questId: true, periodKey: true },
    });
    const taken = new Set(targetRows.map((r) => `${r.questId}\u0000${r.periodKey}`));
    const sourceRows = await tx.questCompletion.findMany({
      where: { userId: sourceId },
      select: { id: true, questId: true, periodKey: true },
    });
    const dupes = sourceRows
      .filter((r) => taken.has(`${r.questId}\u0000${r.periodKey}`))
      .map((r) => r.id);
    if (dupes.length > 0) {
      await tx.questCompletion.deleteMany({ where: { id: { in: dupes } } });
    }
    await tx.questCompletion.updateMany({
      where: { userId: sourceId },
      data: { userId: targetId },
    });
  }

  /**
   * At most one ATTRIBUTED conversion per user — keep the target's, drop the
   * source's. The uniqueness is now a partial index (a REVERTED row must not
   * block a later purchase), so the target is probed with `findFirst` on that
   * status rather than by unique key. REVERTED history moves across so the
   * placement's refund record survives the merge.
   */
  private async moveAdConversion(tx: Tx, sourceId: string, targetId: string): Promise<void> {
    const targetConv = await tx.adConversion.findFirst({
      where: { userId: targetId, status: 'ATTRIBUTED' },
      select: { id: true },
    });
    if (targetConv !== null) {
      await tx.adConversion.deleteMany({ where: { userId: sourceId, status: 'ATTRIBUTED' } });
    }
    await tx.adConversion.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });
  }

  /** `Referral.referredId` unique (the 1:1 `referredBy`). */
  private async moveReferredBy(tx: Tx, sourceId: string, targetId: string): Promise<void> {
    const targetReferred = await tx.referral.findUnique({
      where: { referredId: targetId },
      select: { id: true },
    });
    if (targetReferred !== null) {
      await tx.referral.deleteMany({ where: { referredId: sourceId } });
    } else {
      await tx.referral.updateMany({ where: { referredId: sourceId }, data: { referredId: targetId } });
    }
  }

  /**
   * Re-point a source `Partner`'s ledger to the target `Partner`:
   * withdrawals (Restrict), ledger transactions, and the partner-side referral
   * edges (dedupe on the `(partnerId, referralUserId)` unique).
   */
  private async movePartnerLedger(tx: Tx, sourcePartnerId: string, targetPartnerId: string): Promise<void> {
    await tx.partnerWithdrawal.updateMany({
      where: { partnerId: sourcePartnerId },
      data: { partnerId: targetPartnerId },
    });
    await tx.partnerTransaction.updateMany({
      where: { partnerId: sourcePartnerId },
      data: { partnerId: targetPartnerId },
    });
    const targetRefs = await tx.partnerReferral.findMany({
      where: { partnerId: targetPartnerId },
      select: { referralUserId: true },
    });
    const taken = new Set(targetRefs.map((r) => r.referralUserId));
    const sourceRefs = await tx.partnerReferral.findMany({
      where: { partnerId: sourcePartnerId },
      select: { id: true, referralUserId: true },
    });
    const dupes = sourceRefs.filter((r) => taken.has(r.referralUserId)).map((r) => r.id);
    if (dupes.length > 0) {
      await tx.partnerReferral.deleteMany({ where: { id: { in: dupes } } });
    }
    await tx.partnerReferral.updateMany({
      where: { partnerId: sourcePartnerId },
      data: { partnerId: targetPartnerId },
    });
  }

  /**
   * Validates the operator's chosen current-subscription id belongs to the
   * target (after re-point); returns it, or null to leave the target's current
   * pointer untouched.
   */
  /**
   * The source's spins on the wheel, onto the survivor.
   *
   * Through the spin wallet, so each side gets a journal row and both balances
   * keep summing to their journals — the reason the source's own journal rows
   * are NOT re-pointed (see `MERGE_DROPS`). `MANUAL_ADJUSTMENT`, not a new
   * source: a merge is an operator's hand on the balance, and a new enum value
   * would be a row a panel rolled back to an earlier release cannot read.
   */
  private async moveSpinBalance(tx: Tx, sourceId: string, spins: number, targetId: string): Promise<void> {
    // A legacy row may hold none at all; nothing below zero is moved either.
    if (!(spins > 0)) return;
    const emptied = await this.spinWallet.apply(tx, {
      userId: sourceId,
      delta: -spins,
      source: SpinLedgerSource.MANUAL_ADJUSTMENT,
      referenceKey: null,
      details: { accountMerge: true, mergedInto: targetId },
    });
    if (!emptied.applied) {
      throw new BadRequestException(`Account merge could not move the spins of ${sourceId}: ${emptied.reason}`);
    }
    const credited = await this.spinWallet.apply(tx, {
      userId: targetId,
      delta: spins,
      source: SpinLedgerSource.MANUAL_ADJUSTMENT,
      referenceKey: null,
      details: { accountMerge: true, mergedFrom: sourceId },
    });
    if (!credited.applied) {
      throw new BadRequestException(
        `Account merge could not credit the spins of ${sourceId} to ${targetId}: ${credited.reason}`,
      );
    }
  }

  /**
   * Every child table the schema grew after this service was written.
   *
   * They were neither moved nor named, so the source's delete decided for them:
   *  - `ProviderSubscription` (SetNull) — the customer's autopay at the provider
   *    lost its owner, and the sweep that cancels an owner-less one stopped the
   *    survivor's autopay, though the subscription it renews had moved;
   *  - `WheelKey.claimedByUserId` (SetNull) — a key the customer won lost its owner;
   *  - wheel spins, contest entries and wins, hint deliveries, device and
   *    address observations, review flags, fraud exemptions (Cascade) — gone.
   *
   * `test/account-merge-relations.spec.ts` holds every relation onto `User` to
   * this method, the steps above, or `MERGE_DROPS`, so the next table cannot
   * be forgotten the same way.
   */
  private async moveLaterChildren(tx: Tx, sourceId: string, targetId: string): Promise<void> {
    // Nothing unique on the user: a plain move.
    await tx.providerSubscription.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });
    await tx.wheelKey.updateMany({ where: { claimedByUserId: sourceId }, data: { claimedByUserId: targetId } });
    await tx.userHintDelivery.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });
    await tx.fraudExemption.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });

    // `(userId, idempotencyKey)`: the spin is kept, a key the survivor already
    // used is suffixed — the key only replays a request, and neither request
    // is replayable after the accounts become one.
    const targetSpinKeys = (
      await tx.wheelSpin.findMany({ where: { userId: targetId }, select: { idempotencyKey: true } })
    ).map((row) => row.idempotencyKey);
    const clashingSpins =
      targetSpinKeys.length === 0
        ? []
        : await tx.wheelSpin.findMany({
            where: { userId: sourceId, idempotencyKey: { in: targetSpinKeys } },
            select: { id: true, idempotencyKey: true },
          });
    for (const spin of clashingSpins) {
      await tx.wheelSpin.update({
        where: { id: spin.id },
        data: { idempotencyKey: `${spin.idempotencyKey}~merged-${sourceId}` },
      });
    }
    await tx.wheelSpin.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });

    // Unique per user and something else: the survivor's own row stands, the
    // source's duplicate goes — as the delete would have taken it — and the
    // rest move.
    const enteredByTarget = (
      await tx.contestEntry.findMany({ where: { userId: targetId }, select: { contestId: true } })
    ).map((row) => row.contestId);
    await tx.contestEntry.deleteMany({ where: { userId: sourceId, contestId: { in: enteredByTarget } } });
    await tx.contestEntry.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });

    const wonByTarget = (
      await tx.contestWinner.findMany({ where: { userId: targetId }, select: { contestId: true } })
    ).map((row) => row.contestId);
    await tx.contestWinner.deleteMany({ where: { userId: sourceId, contestId: { in: wonByTarget } } });
    await tx.contestWinner.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });

    const targetDevices = await tx.deviceObservation.findMany({
      where: { userId: targetId },
      select: { kind: true, value: true },
    });
    if (targetDevices.length > 0) {
      await tx.deviceObservation.deleteMany({
        where: { userId: sourceId, OR: targetDevices.map((row) => ({ kind: row.kind, value: row.value })) },
      });
    }
    await tx.deviceObservation.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });

    const targetAddresses = (
      await tx.userIpObservation.findMany({ where: { userId: targetId }, select: { address: true } })
    ).map((row) => row.address);
    await tx.userIpObservation.deleteMany({ where: { userId: sourceId, address: { in: targetAddresses } } });
    await tx.userIpObservation.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });

    const targetFlags = await tx.userReviewFlag.findMany({
      where: { userId: targetId },
      select: { kind: true, fingerprint: true },
    });
    if (targetFlags.length > 0) {
      await tx.userReviewFlag.deleteMany({
        where: {
          userId: sourceId,
          OR: targetFlags.map((row) => ({ kind: row.kind, fingerprint: row.fingerprint })),
        },
      });
    }
    await tx.userReviewFlag.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });
  }

  private async resolveCurrentSubscription(
    tx: Tx,
    targetId: string,
    chosenId: string | null,
  ): Promise<string | null> {
    if (chosenId === null) return null;
    const sub = await tx.subscription.findFirst({
      where: { id: chosenId, userId: targetId },
      select: { id: true },
    });
    return sub?.id ?? null;
  }
}
