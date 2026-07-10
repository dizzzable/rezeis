import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Quest, QuestType } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { QuestProgressService, withinWindow } from './quest-progress.service';

/**
 * Catch-up backstop for event-driven completion detection. The event bus has no
 * delivery guarantee AND never fires for users who satisfied a quest's
 * condition BEFORE the quest was created (already-linked Telegram/email,
 * already-qualified referrals). This cron periodically finds such users and
 * backfills their completions idempotently.
 */
@Injectable()
export class QuestDetectionReconcilerService {
  private readonly logger = new Logger(QuestDetectionReconcilerService.name);
  private static readonly BATCH = 200;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly progressService: QuestProgressService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'quest-detection-backfill' })
  public async backfill(): Promise<void> {
    if (!shouldRunSchedules()) return;
    const quests = await this.prismaService.quest.findMany({
      where: {
        enabled: true,
        type: {
          in: [QuestType.LINK_TELEGRAM, QuestType.LINK_EMAIL, QuestType.INVITE_FRIENDS],
        },
      },
    });
    for (const quest of quests) {
      if (!withinWindow(quest)) continue;
      try {
        await this.backfillQuest(quest);
      } catch (err: unknown) {
        this.logger.warn(
          `Quest backfill failed for ${quest.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private async backfillQuest(quest: Quest): Promise<void> {
    if (quest.type === QuestType.LINK_TELEGRAM) {
      const users = await this.prismaService.user.findMany({
        where: { telegramId: { not: null }, questCompletions: { none: { questId: quest.id } } },
        select: { id: true },
        take: QuestDetectionReconcilerService.BATCH,
      });
      for (const user of users) {
        await this.progressService.completeForUser(quest, user.id);
      }
      return;
    }

    if (quest.type === QuestType.LINK_EMAIL) {
      const users = await this.prismaService.user.findMany({
        where: {
          webAccount: { emailVerifiedAt: { not: null } },
          questCompletions: { none: { questId: quest.id } },
        },
        select: { id: true },
        take: QuestDetectionReconcilerService.BATCH,
      });
      for (const user of users) {
        await this.progressService.completeForUser(quest, user.id);
      }
      return;
    }

    // INVITE_FRIENDS — referrers with at least one qualified referral who don't
    // yet have a completion for this quest. advanceInvite recomputes the count.
    const referrers = await this.prismaService.referral.findMany({
      where: {
        qualifiedAt: { not: null },
        referrer: { questCompletions: { none: { questId: quest.id } } },
      },
      distinct: ['referrerId'],
      select: { referrerId: true },
      take: QuestDetectionReconcilerService.BATCH,
    });
    for (const ref of referrers) {
      await this.progressService.advanceInvite(ref.referrerId);
    }
  }
}
