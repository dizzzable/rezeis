import { Injectable, Logger } from '@nestjs/common';
import {
  BroadcastAudience,
  Prisma,
  Quest,
  QuestCompletionStatus,
  QuestType,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  buildAudienceWhere,
  normalizeAudienceFilter,
} from '../../broadcast/utils/broadcast-audience.util';

/**
 * Advances quest completions when the underlying user action happens. Called
 * both by the live event listener (fast path) and the catch-up reconciler
 * (backstop). Every write is idempotent on the (questId, userId, periodKey="")
 * unique — a repeated signal never creates a duplicate or re-opens a CLAIMED
 * completion.
 */
@Injectable()
export class QuestProgressService {
  private readonly logger = new Logger(QuestProgressService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  /** Mark all eligible enabled quests of `type` complete for `userId`. */
  public async markCompleted(type: QuestType, userId: string): Promise<void> {
    const quests = await this.prismaService.quest.findMany({ where: { type, enabled: true } });
    for (const quest of quests) {
      await this.completeForUser(quest, userId);
    }
  }

  /** Recompute INVITE_FRIENDS progress for a referrer and complete at threshold. */
  public async advanceInvite(referrerId: string): Promise<void> {
    const quests = await this.prismaService.quest.findMany({
      where: { type: QuestType.INVITE_FRIENDS, enabled: true },
    });
    if (quests.length === 0) return;
    const qualified = await this.prismaService.referral.count({
      where: { referrerId, qualifiedAt: { not: null } },
    });
    for (const quest of quests) {
      await this.completeForUser(quest, referrerId, qualified);
    }
  }

  /**
   * Upsert a single quest's completion for one user. `progress` is used by
   * counted quests (INVITE_FRIENDS); when omitted the quest completes outright.
   */
  public async completeForUser(quest: Quest, userId: string, progress?: number): Promise<void> {
    if (!withinWindow(quest)) return;
    if (!(await this.isEligible(quest, userId))) return;

    const required = quest.type === QuestType.INVITE_FRIENDS ? readRequiredFriends(quest.params) : 1;
    const reached = progress === undefined ? true : progress >= required;

    const existing = await this.prismaService.questCompletion.findUnique({
      where: { questId_userId_periodKey: { questId: quest.id, userId, periodKey: '' } },
      select: { id: true, status: true },
    });

    if (existing === null) {
      try {
        await this.prismaService.questCompletion.create({
          data: {
            questId: quest.id,
            userId,
            status: reached ? QuestCompletionStatus.COMPLETED : QuestCompletionStatus.IN_PROGRESS,
            progress: progress ?? 0,
            completedAt: reached ? new Date() : null,
          },
        });
      } catch (err: unknown) {
        // Concurrent create (event + reconciler) — the unique guards it.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          throw err;
        }
      }
      return;
    }

    // Never re-open a CLAIMED completion.
    if (existing.status === QuestCompletionStatus.CLAIMED) return;

    const data: Prisma.QuestCompletionUpdateInput = {};
    if (progress !== undefined) data.progress = progress;
    if (reached && existing.status !== QuestCompletionStatus.COMPLETED) {
      data.status = QuestCompletionStatus.COMPLETED;
      data.completedAt = new Date();
    }
    if (Object.keys(data).length > 0) {
      await this.prismaService.questCompletion.update({ where: { id: existing.id }, data });
    }
  }

  /** A quest with an audience filter only applies to matching users. */
  public async isEligible(quest: Quest, userId: string): Promise<boolean> {
    const filter = normalizeAudienceFilter(quest.audienceFilter);
    // Always exclude blocked users (broadcast parity) — even when the quest has
    // no audience filter, a blocked user must never be targeted.
    const where =
      filter === null ? {} : buildAudienceWhere(BroadcastAudience.ALL, filter);
    const count = await this.prismaService.user.count({
      where: { AND: [{ id: userId }, { isBlocked: false }, where] },
    });
    return count > 0;
  }
}

export function withinWindow(quest: Pick<Quest, 'startAt' | 'endAt'>, now: number = Date.now()): boolean {
  if (quest.startAt !== null && quest.startAt.getTime() > now) return false;
  if (quest.endAt !== null && quest.endAt.getTime() <= now) return false;
  return true;
}

export function readRequiredFriends(params: Prisma.JsonValue): number {
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    const value = (params as Record<string, unknown>).requiredFriends;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return 1;
}
