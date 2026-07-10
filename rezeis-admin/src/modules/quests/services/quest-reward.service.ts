import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  Quest,
  QuestCompletionStatus,
  SubscriptionStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { SubscriptionMutationsService } from '../../subscriptions/services/subscription-mutations.service';
import { buildPlanSnapshot } from '../../users/utils/plan-snapshot.util';
import { QuestClaimResult } from '../interfaces/quest-claim.interface';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Issues quest rewards. Because the reward primitives commit external effects
 * (profile-sync, grantTrial) that cannot be rolled back, correctness is a state
 * machine, NOT one big transaction:
 *
 *   1. reserveAndClaim  — atomically flip COMPLETED→CLAIMED (single winner) and
 *      reserve the global budget; a failure here rolls both back.
 *   2. issueReward      — pay out (inline `tx.*` writes mirroring the referral
 *      points-exchange) and stamp `rewardIssuedAt`; a crash between (1) and (2)
 *      is repaired by the reconciler.
 *
 * Points credit the SAME `User.points` balance the referral exchange spends.
 */
@Injectable()
export class QuestRewardService {
  private readonly logger = new Logger(QuestRewardService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly subscriptionMutationsService: SubscriptionMutationsService,
  ) {}

  /**
   * Claim a completed quest for a user and issue its reward. Idempotent:
   * re-claiming an already-issued completion returns the stored snapshot.
   */
  public async claim(input: {
    readonly userId: string;
    readonly questId: string;
    readonly periodKey?: string;
  }): Promise<QuestClaimResult> {
    const periodKey = input.periodKey ?? '';
    const quest = await this.prismaService.quest.findUnique({ where: { id: input.questId } });
    if (quest === null) {
      throw new NotFoundException('Quest not found');
    }
    if (!quest.enabled) {
      throw new BadRequestException('Quest is not available');
    }
    assertWindowActive(quest);

    const completion = await this.prismaService.questCompletion.findUnique({
      where: {
        questId_userId_periodKey: { questId: input.questId, userId: input.userId, periodKey },
      },
      select: { id: true, status: true, rewardIssuedAt: true, rewardSnapshot: true },
    });
    if (completion === null || completion.status === QuestCompletionStatus.IN_PROGRESS) {
      throw new BadRequestException('Quest is not completed yet');
    }

    // Already claimed: return the stored reward if issued, otherwise re-drive
    // issuance (crash between reserve and payout — same path the reconciler uses).
    if (completion.status === QuestCompletionStatus.CLAIMED) {
      if (completion.rewardIssuedAt !== null) {
        return snapshotToResult(input.questId, completion.rewardSnapshot);
      }
      return this.issueReward(quest, input.userId, completion.id);
    }

    // COMPLETED → reserve budget + claim atomically (single winner).
    await this.reserveAndClaim(quest, completion.id);
    return this.issueReward(quest, input.userId, completion.id);
  }

  /**
   * Re-drive a claimed-but-unpaid completion (reconciler entry point). Safe to
   * call repeatedly — issuance is guarded by `rewardIssuedAt`.
   */
  public async reissue(questId: string, userId: string, completionId: string): Promise<void> {
    const quest = await this.prismaService.quest.findUnique({ where: { id: questId } });
    if (quest === null) return;
    await this.issueReward(quest, userId, completionId);
  }

  // ── Claim reservation ─────────────────────────────────────────────────────

  private async reserveAndClaim(quest: Quest, completionId: string): Promise<void> {
    await this.prismaService.$transaction(async (tx) => {
      const claimed = await tx.questCompletion.updateMany({
        where: { id: completionId, status: QuestCompletionStatus.COMPLETED },
        data: { status: QuestCompletionStatus.CLAIMED, claimedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new BadRequestException('Quest already claimed or not claimable');
      }
      // Budget: Prisma cannot compare two columns, so guard against the literal
      // max read from the loaded quest row. Conditional increment = single-winner.
      if (quest.maxCompletionsGlobal !== null) {
        const reserved = await tx.quest.updateMany({
          where: { id: quest.id, issuedCount: { lt: quest.maxCompletionsGlobal } },
          data: { issuedCount: { increment: 1 } },
        });
        if (reserved.count === 0) {
          throw new BadRequestException('Quest reward budget is exhausted');
        }
      }
    });
  }

  // ── Reward issuance (idempotent per completion) ───────────────────────────

  private async issueReward(
    quest: Quest,
    userId: string,
    completionId: string,
  ): Promise<QuestClaimResult> {
    const current = await this.prismaService.questCompletion.findUnique({
      where: { id: completionId },
      select: { rewardIssuedAt: true, rewardSnapshot: true },
    });
    if (current?.rewardIssuedAt != null) {
      return snapshotToResult(quest.id, current.rewardSnapshot);
    }

    // DAYS with no bounded active subscription + GRANT_TRIAL fallback runs its
    // OWN transaction (the service is not tx-aware), so handle it out-of-band.
    if (quest.rewardType === 'DAYS') {
      const targetSubId = await this.resolveBoundedSubscriptionId(userId);
      if (targetSubId === null && quest.daysFallback === 'GRANT_TRIAL') {
        return this.grantTrialFallback(quest, userId, completionId);
      }
    }

    let result: QuestClaimResult = { questId: quest.id, rewardType: quest.rewardType };
    let syncSubscriptionId: string | null = null;
    let alreadyIssued = false;

    await this.prismaService.$transaction(async (tx) => {
      // Atomic single-winner claim of the reward slot. The conditional update
      // takes a row lock, so a concurrent claim()/reconciler drive that already
      // stamped `rewardIssuedAt` yields count === 0 here and pays out NOTHING.
      // If the payout below throws, the whole tx rolls back and the stamp is
      // released automatically for a later retry.
      const claimed = await tx.questCompletion.updateMany({
        where: { id: completionId, rewardIssuedAt: null },
        data: { rewardIssuedAt: new Date() },
      });
      if (claimed.count === 0) {
        alreadyIssued = true;
        return;
      }
      switch (quest.rewardType) {
        case 'POINTS': {
          await tx.user.update({
            where: { id: userId },
            data: { points: { increment: quest.rewardAmount } },
          });
          result = { ...result, points: quest.rewardAmount };
          break;
        }
        case 'DISCOUNT': {
          const user = await tx.user.findUnique({
            where: { id: userId },
            select: { personalDiscount: true },
          });
          const next = Math.min((user?.personalDiscount ?? 0) + quest.rewardAmount, 100);
          await tx.user.update({ where: { id: userId }, data: { personalDiscount: next } });
          result = { ...result, discountPercent: next };
          break;
        }
        case 'TRAFFIC': {
          const subId = await this.resolveActiveSubscriptionId(userId);
          if (subId !== null) {
            const sub = await tx.subscription.findUnique({
              where: { id: subId },
              select: { trafficLimit: true },
            });
            if (sub?.trafficLimit != null) {
              await tx.subscription.update({
                where: { id: subId },
                data: { trafficLimit: { increment: quest.rewardAmount } },
              });
              syncSubscriptionId = subId;
            }
          }
          result = { ...result, trafficGb: quest.rewardAmount, subscriptionId: subId ?? undefined };
          break;
        }
        case 'DAYS': {
          const subId = await this.resolveBoundedSubscriptionId(userId);
          if (subId !== null) {
            const sub = await tx.subscription.findUnique({
              where: { id: subId },
              select: { expiresAt: true },
            });
            const base =
              sub?.expiresAt != null && sub.expiresAt.getTime() > Date.now()
                ? sub.expiresAt
                : new Date();
            await tx.subscription.update({
              where: { id: subId },
              data: {
                expiresAt: new Date(base.getTime() + quest.rewardAmount * MS_PER_DAY),
                status: SubscriptionStatus.ACTIVE,
              },
            });
            syncSubscriptionId = subId;
            result = { ...result, days: quest.rewardAmount, subscriptionId: subId };
          } else {
            // No bounded sub → MINT_PROMOCODE fallback.
            const code = await this.mintPromocode(tx, quest);
            result = { ...result, days: quest.rewardAmount, promoCode: code };
          }
          break;
        }
        case 'PROMOCODE': {
          const code = await this.mintPromocode(tx, quest);
          result = { ...result, promoCode: code };
          break;
        }
      }

      await tx.questCompletion.update({
        where: { id: completionId },
        data: { rewardSnapshot: result as unknown as Prisma.InputJsonValue },
      });
    });

    // Lost the race — another driver issued the reward. Return its snapshot.
    if (alreadyIssued) {
      const snap = await this.prismaService.questCompletion.findUnique({
        where: { id: completionId },
        select: { rewardSnapshot: true },
      });
      return snapshotToResult(quest.id, snap?.rewardSnapshot ?? null);
    }

    if (syncSubscriptionId !== null) {
      await this.enqueueProfileSync(syncSubscriptionId, { source: 'QUEST_REWARD' });
    }
    this.logger.log(`Quest ${quest.id} reward issued to user ${userId} (${quest.rewardType})`);
    return result;
  }

  private async grantTrialFallback(
    quest: Quest,
    userId: string,
    completionId: string,
  ): Promise<QuestClaimResult> {
    if (quest.rewardPlanId === null) {
      throw new BadRequestException('Quest DAYS→GRANT_TRIAL requires a reward plan');
    }
    // grantTrial commits its OWN transaction (not tx-aware), so acquire the
    // single-winner mutex BEFORE calling it: a concurrent driver that already
    // stamped `rewardIssuedAt` gets count === 0 and returns the stored snapshot
    // instead of granting a second trial.
    const claimed = await this.prismaService.questCompletion.updateMany({
      where: { id: completionId, rewardIssuedAt: null },
      data: { rewardIssuedAt: new Date() },
    });
    if (claimed.count === 0) {
      const snap = await this.prismaService.questCompletion.findUnique({
        where: { id: completionId },
        select: { rewardSnapshot: true },
      });
      return snapshotToResult(quest.id, snap?.rewardSnapshot ?? null);
    }
    let granted: { readonly subscriptionId: string };
    try {
      granted = await this.subscriptionMutationsService.grantTrial({
        userId,
        planId: quest.rewardPlanId,
        durationDays: quest.rewardAmount,
      });
    } catch (err: unknown) {
      // Release the mutex so the reconciler can retry a transient failure
      // rather than the reward being lost forever behind the stamp.
      await this.prismaService.questCompletion
        .update({ where: { id: completionId }, data: { rewardIssuedAt: null } })
        .catch(() => undefined);
      throw err;
    }
    const result: QuestClaimResult = {
      questId: quest.id,
      rewardType: 'DAYS',
      days: quest.rewardAmount,
      subscriptionId: granted.subscriptionId,
    };
    await this.prismaService.questCompletion.update({
      where: { id: completionId },
      data: { rewardSnapshot: result as unknown as Prisma.InputJsonValue },
    });
    return result;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Mint a single-use promocode. When the quest carries a `rewardPlanId` the
   * code is a SUBSCRIPTION reward (creates/extends a subscription from the plan
   * snapshot, usable even by a user with none); otherwise a DURATION code that
   * adds `rewardAmount` days to an existing subscription.
   */
  private async mintPromocode(tx: Prisma.TransactionClient, quest: Quest): Promise<string> {
    const code = generateQuestPromoCode();
    if (quest.rewardPlanId !== null) {
      const plan = await tx.plan.findUnique({
        where: { id: quest.rewardPlanId },
        select: {
          id: true,
          name: true,
          tag: true,
          type: true,
          trafficLimit: true,
          deviceLimit: true,
          trafficLimitStrategy: true,
          internalSquads: true,
          externalSquad: true,
        },
      });
      if (plan === null) {
        throw new BadRequestException('Quest reward plan not found');
      }
      const snapshot = {
        ...(buildPlanSnapshot(plan) as Record<string, unknown>),
        duration: quest.rewardAmount,
      };
      await tx.promocode.create({
        data: {
          code,
          isActive: true,
          availability: 'ALL',
          rewardType: 'SUBSCRIPTION',
          reward: quest.rewardAmount,
          plan: snapshot as Prisma.InputJsonValue,
          maxActivations: 1,
        },
      });
      return code;
    }
    await tx.promocode.create({
      data: {
        code,
        isActive: true,
        availability: 'ALL',
        rewardType: 'DURATION',
        reward: quest.rewardAmount,
        maxActivations: 1,
      },
    });
    return code;
  }

  /** Most-recent ACTIVE subscription with a bounded expiry (extendable). */
  private async resolveBoundedSubscriptionId(userId: string): Promise<string | null> {
    const sub = await this.prismaService.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE, expiresAt: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return sub?.id ?? null;
  }

  /** Most-recent ACTIVE subscription (bounded or unlimited). */
  private async resolveActiveSubscriptionId(userId: string): Promise<string | null> {
    const sub = await this.prismaService.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return sub?.id ?? null;
  }

  private async enqueueProfileSync(
    subscriptionId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const subscription = await this.prismaService.subscription.findUnique({
        where: { id: subscriptionId },
        select: { remnawaveId: true },
      });
      const job = await this.prismaService.profileSyncJob.create({
        data: {
          subscriptionId,
          action: subscription?.remnawaveId == null ? SyncAction.CREATE : SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          payload: payload as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      await this.profileSyncQueueService.enqueue(job.id);
    } catch (err: unknown) {
      this.logger.error(
        `Quest reward profile-sync enqueue failed for ${subscriptionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function assertWindowActive(quest: Quest): void {
  const now = Date.now();
  if (quest.startAt !== null && quest.startAt.getTime() > now) {
    throw new BadRequestException('Quest campaign has not started');
  }
  if (quest.endAt !== null && quest.endAt.getTime() <= now) {
    throw new BadRequestException('Quest campaign has ended');
  }
}

function snapshotToResult(questId: string, snapshot: Prisma.JsonValue): QuestClaimResult {
  if (snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    return snapshot as unknown as QuestClaimResult;
  }
  return { questId, rewardType: 'POINTS' };
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateQuestPromoCode(): string {
  let code = 'QUEST-';
  for (let i = 0; i < 8; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}
