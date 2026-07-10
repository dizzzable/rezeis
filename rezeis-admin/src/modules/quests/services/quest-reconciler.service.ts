import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { QuestCompletionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { QuestRewardService } from './quest-reward.service';

/**
 * Correctness backstop for the reward state machine. A claim reserves budget
 * and flips a completion to CLAIMED, then issues the reward and stamps
 * `rewardIssuedAt`. A crash between those two steps would leave a completion
 * CLAIMED with `rewardIssuedAt = null`; this cron re-drives issuance (idempotent
 * — the reward service returns the stored snapshot if it was already paid).
 */
@Injectable()
export class QuestReconcilerService {
  private readonly logger = new Logger(QuestReconcilerService.name);
  private static readonly BATCH = 50;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly questRewardService: QuestRewardService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'quest-reward-reconcile' })
  public async reconcile(): Promise<void> {
    if (!shouldRunSchedules()) return;
    const stuck = await this.prismaService.questCompletion.findMany({
      where: { status: QuestCompletionStatus.CLAIMED, rewardIssuedAt: null },
      select: { id: true, questId: true, userId: true },
      take: QuestReconcilerService.BATCH,
      orderBy: { claimedAt: 'asc' },
    });
    if (stuck.length === 0) return;

    let repaired = 0;
    for (const completion of stuck) {
      try {
        await this.questRewardService.reissue(completion.questId, completion.userId, completion.id);
        repaired++;
      } catch (err: unknown) {
        this.logger.warn(
          `Quest reconcile failed for completion ${completion.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.logger.log(`Quest reward reconcile: re-drove ${repaired}/${stuck.length} completions`);
  }
}
