import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  Quest,
  QuestCompletionStatus,
  QuestType,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import { QuestProgressService, withinWindow } from './quest-progress.service';
import { resolveQuestChannelConfig } from '../utils/quest-channel-config.util';

export type QuestChannelState = 'IN_PROGRESS' | 'COMPLETED' | 'CLAIMED';

export interface QuestChannelTarget {
  readonly questId: string;
  /** Internal-only Telegram chat reference. Never returned to the browser. */
  readonly chatId: string;
  /** Operator-approved Telegram join link for the bot keyboard. */
  readonly joinUrl: string;
}

export interface QuestChannelRecheckCandidate extends QuestChannelTarget {
  readonly telegramId: string;
}

/**
 * Authoritative server-side state transitions for SUBSCRIBE_CHANNEL quests.
 *
 * The Reiwa bot owns the Telegram Bot API call and only invokes this service
 * after a fresh positive membership proof. This service owns account lookup,
 * quest eligibility, completion state and the irreversible claim boundary; it
 * never issues a reward itself.
 */
@Injectable()
export class QuestChannelService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly progressService: QuestProgressService,
  ) {}

  public async listRecheckCandidates(): Promise<readonly QuestChannelRecheckCandidate[]> {
    const completions = await this.prismaService.questCompletion.findMany({
      where: {
        status: QuestCompletionStatus.COMPLETED,
        verifiedAt: { not: null },
        user: { telegramId: { not: null } },
        quest: { enabled: true, type: QuestType.SUBSCRIBE_CHANNEL },
      },
      select: {
        questId: true,
        user: { select: { telegramId: true } },
        quest: true,
      },
      take: 200,
      orderBy: { verifiedAt: 'asc' },
    });

    const candidates: QuestChannelRecheckCandidate[] = [];
    for (const completion of completions) {
      const config = resolveQuestChannelConfig(completion.quest.params);
      if (completion.user.telegramId === null || config === null) continue;
      candidates.push({
        questId: completion.questId,
        telegramId: completion.user.telegramId.toString(),
        chatId: config.chatId,
        joinUrl: config.joinUrl,
      });
    }
    return candidates;
  }

  public async getVerificationTarget(input: {
    readonly telegramId: string;
    readonly questId: string;
  }): Promise<QuestChannelTarget> {
    const { quest } = await this.resolveEligible(input);
    const config = resolveQuestChannelConfig(quest.params);
    // resolveEligible already guards this; keep the invariant local in case the
    // method is ever refactored to a narrower lookup.
    if (config === null) {
      throw new BadRequestException('Quest channel is not configured for verification');
    }
    return { questId: quest.id, chatId: config.chatId, joinUrl: config.joinUrl };
  }

  public async verifyMembership(input: {
    readonly telegramId: string;
    readonly questId: string;
  }): Promise<{ readonly state: QuestChannelState }> {
    const { quest, userId } = await this.resolveEligible(input);
    const existing = await this.prismaService.questCompletion.findUnique({
      where: {
        questId_userId_periodKey: { questId: quest.id, userId, periodKey: '' },
      },
      select: { id: true, status: true },
    });

    if (existing?.status === QuestCompletionStatus.CLAIMED) {
      return { state: 'CLAIMED' };
    }

    const now = new Date();
    if (existing === null) {
      try {
        await this.prismaService.questCompletion.create({
          data: {
            questId: quest.id,
            userId,
            status: QuestCompletionStatus.COMPLETED,
            progress: 1,
            verifiedAt: now,
            completedAt: now,
          },
        });
      } catch (err: unknown) {
        // Bot retries and the periodic verifier can race on the unique
        // (questId,userId,periodKey) completion. A concurrent winner already
        // persisted equivalent completion state, so accept only P2002.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          throw err;
        }
      }
      return { state: 'COMPLETED' };
    }

    await this.prismaService.questCompletion.update({
      where: { id: existing.id },
      data: {
        status: QuestCompletionStatus.COMPLETED,
        progress: 1,
        verifiedAt: now,
        completedAt: now,
      },
    });
    return { state: 'COMPLETED' };
  }

  /**
   * Applies an already-observed membership result from the bot recheck worker.
   * A negative check revokes only unclaimed claimability; once CLAIMED, reward
   * history is immutable and must never be reopened or reversed here.
   */
  public async recordRecheck(input: {
    readonly telegramId: string;
    readonly questId: string;
    readonly isMember: boolean;
  }): Promise<{ readonly state: QuestChannelState }> {
    const { quest, userId } = await this.resolveEligible(input);
    const existing = await this.prismaService.questCompletion.findUnique({
      where: {
        questId_userId_periodKey: { questId: quest.id, userId, periodKey: '' },
      },
      select: { id: true, status: true, verifiedAt: true },
    });

    if (existing === null) return { state: 'IN_PROGRESS' };
    if (existing.status === QuestCompletionStatus.CLAIMED) return { state: 'CLAIMED' };

    if (input.isMember) {
      const now = new Date();
      await this.prismaService.questCompletion.update({
        where: { id: existing.id },
        data: {
          status: QuestCompletionStatus.COMPLETED,
          progress: 1,
          verifiedAt: now,
          completedAt: now,
        },
      });
      return { state: 'COMPLETED' };
    }

    if (existing.status === QuestCompletionStatus.COMPLETED || existing.verifiedAt !== null) {
      await this.prismaService.questCompletion.update({
        where: { id: existing.id },
        data: {
          status: QuestCompletionStatus.IN_PROGRESS,
          completedAt: null,
          verifiedAt: null,
        },
      });
    }
    return { state: 'IN_PROGRESS' };
  }

  private async resolveEligible(input: {
    readonly telegramId: string;
    readonly questId: string;
  }): Promise<{ readonly quest: Quest; readonly userId: string }> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(input.telegramId),
      select: { id: true },
    });
    if (user === null) {
      throw new NotFoundException('No account is linked to this Telegram user');
    }

    const quest = await this.prismaService.quest.findUnique({ where: { id: input.questId } });
    if (quest === null) throw new NotFoundException('Quest not found');
    if (quest.type !== QuestType.SUBSCRIBE_CHANNEL) {
      throw new BadRequestException('Quest is not a channel subscription quest');
    }
    if (!quest.enabled || !withinWindow(quest)) {
      throw new BadRequestException('Quest is not available');
    }
    if (resolveQuestChannelConfig(quest.params) === null) {
      throw new BadRequestException('Quest channel is not configured for verification');
    }
    if (!(await this.progressService.isEligible(quest, user.id))) {
      throw new BadRequestException('Quest is not available for this user');
    }

    return { quest, userId: user.id };
  }
}
