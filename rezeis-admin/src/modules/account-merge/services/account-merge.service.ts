import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { AccountMergeInput, AccountMergeResult } from '../interfaces/account-merge.interface';

type Tx = Prisma.TransactionClient;

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
          personalDiscount: true,
          purchaseDiscount: true,
          maxSubscriptions: true,
          acquisitionPlacementId: true,
          acquisitionAt: true,
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
          personalDiscount: true,
          purchaseDiscount: true,
          maxSubscriptions: true,
          acquisitionPlacementId: true,
          acquisitionAt: true,
          partner: { select: { id: true } },
          webAccount: { select: { id: true } },
          trialGrant: { select: { id: true } },
        },
      });
      if (source === null) throw new NotFoundException('Source account not found');
      if (target === null) throw new NotFoundException('Target account not found');

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
      ]);

      // 3. Dedupe-then-repoint the userId-unique collections.
      await this.movePromocodeActivations(tx, source.id, target.id);
      const partnerTransactions = await this.movePartnerTransactionsAsReferral(tx, source.id, target.id);
      await this.movePartnerReferralsAsReferral(tx, source.id, target.id);
      await this.moveAdConversion(tx, source.id, target.id);

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
      if (source.webAccount !== null) {
        const keepSource = input.choices.keepLogin === 'source';
        if (target.webAccount !== null && keepSource) {
          await tx.webAccount.delete({ where: { id: target.webAccount.id } });
          await tx.webAccount.update({ where: { id: source.webAccount.id }, data: { userId: target.id } });
        } else if (target.webAccount !== null) {
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
      await tx.user.update({
        where: { id: target.id },
        data: {
          telegramId: finalTelegram,
          email: finalEmail,
          points: target.points + source.points,
          maxSubscriptions: Math.max(target.maxSubscriptions, source.maxSubscriptions),
          personalDiscount: Math.max(target.personalDiscount, source.personalDiscount),
          purchaseDiscount: Math.max(target.purchaseDiscount, source.purchaseDiscount),
          acquisitionPlacementId:
            target.acquisitionPlacementId ?? source.acquisitionPlacementId ?? undefined,
          acquisitionAt: target.acquisitionAt ?? source.acquisitionAt ?? undefined,
          currentSubscriptionId: currentSubscriptionId ?? undefined,
        },
      });

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

  /** `AdConversion.userId` unique — keep the target's, drop the source's. */
  private async moveAdConversion(tx: Tx, sourceId: string, targetId: string): Promise<void> {
    const targetConv = await tx.adConversion.findUnique({
      where: { userId: targetId },
      select: { id: true },
    });
    if (targetConv !== null) {
      await tx.adConversion.deleteMany({ where: { userId: sourceId } });
    } else {
      await tx.adConversion.updateMany({ where: { userId: sourceId }, data: { userId: targetId } });
    }
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
