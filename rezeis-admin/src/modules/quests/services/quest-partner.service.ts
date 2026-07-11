import { createHash, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Quest, QuestCompletionStatus, QuestType } from '@prisma/client';

import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import {
  QuestPartnerConfig,
  resolveQuestPartnerConfig,
} from '../utils/quest-partner-config.util';
import { QuestProgressService, withinWindow } from './quest-progress.service';
import { QuestPartnerSecretRegistry } from './quest-partner-secret.registry';

export type QuestPartnerState = 'IN_PROGRESS' | 'COMPLETED' | 'CLAIMED';

/**
 * Authoritative server-side state transitions for PARTNER_TASK quests.
 *
 * Detection differs per verification method (manual code / signed postback /
 * timed visit) but they all funnel through the same idempotent completion
 * upsert, then `QuestRewardService.claim` owns the irreversible payout. Reward
 * is never issued here. Per-partner secrets are resolved from the registry by
 * slug — they are never read from `Quest.params`.
 */
@Injectable()
export class QuestPartnerService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly progressService: QuestProgressService,
    private readonly cache: RawCacheService,
    private readonly secretRegistry: QuestPartnerSecretRegistry,
  ) {}

  /** manual_code: user enters a code; complete when it matches (constant-time). */
  public async verifyManualCode(input: {
    readonly userRef: string;
    readonly questId: string;
    readonly code: string;
  }): Promise<{ readonly state: QuestPartnerState }> {
    const { quest, userId, config } = await this.resolveEligible(input);
    if (config.method !== 'manual_code' || config.code === null) {
      throw new BadRequestException('Quest is not a manual-code partner quest');
    }
    if (!constantTimeEquals(input.code.trim(), config.code)) {
      throw new BadRequestException('Partner code is incorrect');
    }
    return this.completeOnce(quest.id, userId);
  }

  /** postback: called AFTER the controller verified signature + nonce. */
  public async applyPostback(input: {
    readonly userRef: string;
    readonly questId: string;
  }): Promise<{ readonly state: QuestPartnerState }> {
    const { quest, userId, config } = await this.resolveEligible(input);
    if (config.method !== 'postback') {
      throw new BadRequestException('Quest is not a postback partner quest');
    }
    return this.completeOnce(quest.id, userId);
  }

  /** timed_visit: complete only once the server-side minimum dwell has elapsed. */
  public async completeTimedVisit(input: {
    readonly userRef: string;
    readonly questId: string;
    readonly startedAtMs: number;
  }): Promise<{ readonly state: QuestPartnerState }> {
    const { quest, userId, config } = await this.resolveEligible(input);
    if (config.method !== 'timed_visit') {
      throw new BadRequestException('Quest is not a timed-visit partner quest');
    }
    const dwellMs = (config.minDwellSeconds ?? 0) * 1000;
    const elapsed = Date.now() - input.startedAtMs;
    if (!Number.isFinite(input.startedAtMs) || elapsed < dwellMs) {
      throw new BadRequestException('Minimum visit dwell time has not elapsed yet');
    }
    return this.completeOnce(quest.id, userId);
  }

  /**
   * Records the server-authoritative visit start (Valkey), returning the landing
   * URL for the cabinet to open. The start time lives server-side so a client
   * cannot backdate it to satisfy the dwell requirement.
   */
  public async startTimedVisit(input: {
    readonly userRef: string;
    readonly questId: string;
  }): Promise<{ readonly landingUrl: string | null }> {
    const { quest, userId, config } = await this.resolveEligible(input);
    if (config.method !== 'timed_visit') {
      throw new BadRequestException('Quest is not a timed-visit partner quest');
    }
    await this.cache.set(this.visitKey(quest.id, userId), Date.now(), (config.minDwellSeconds ?? 0) + 3600);
    return { landingUrl: config.landingUrl };
  }

  /** Completes a timed visit using the server-stored start time (not a client value). */
  public async completeTimedVisitFromCache(input: {
    readonly userRef: string;
    readonly questId: string;
  }): Promise<{ readonly state: QuestPartnerState }> {
    const { quest, userId } = await this.resolveEligible(input);
    const startedAtMs = await this.cache.get<number>(this.visitKey(quest.id, userId));
    if (typeof startedAtMs !== 'number') {
      throw new BadRequestException('No visit was started for this quest');
    }
    return this.completeTimedVisit({ userRef: input.userRef, questId: input.questId, startedAtMs });
  }

  private visitKey(questId: string, userId: string): string {
    return `quest:partner:visit:${questId}:${userId}`;
  }

  /**
   * Resolves the per-partner secret for a callback, but ONLY if the slug matches
   * the quest's configured partner — prevents a valid signature from partner A
   * being replayed against partner B's quest.
   */
  public async resolveCallbackSecret(questId: string, partnerSlug: string): Promise<string | null> {
    const quest = await this.prismaService.quest.findUnique({ where: { id: questId } });
    if (quest === null || quest.type !== QuestType.PARTNER_TASK) return null;
    const config = resolveQuestPartnerConfig(quest.params);
    if (config === null || config.partnerSlug !== partnerSlug) return null;
    return this.secretRegistry.getSecret(partnerSlug);
  }

  /** Idempotent COMPLETED upsert, shared by all three verification methods. */
  private async completeOnce(
    questId: string,
    userId: string,
  ): Promise<{ readonly state: QuestPartnerState }> {
    const existing = await this.prismaService.questCompletion.findUnique({
      where: { questId_userId_periodKey: { questId, userId, periodKey: '' } },
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
            questId,
            userId,
            status: QuestCompletionStatus.COMPLETED,
            progress: 1,
            verifiedAt: now,
            completedAt: now,
          },
        });
      } catch (err: unknown) {
        // Concurrent detection (retry / parallel callback) races on the unique
        // (questId,userId,periodKey). A winner already persisted equivalent
        // state, so accept only P2002.
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

  private async resolveEligible(input: {
    readonly userRef: string;
    readonly questId: string;
  }): Promise<{ readonly quest: Quest; readonly userId: string; readonly config: QuestPartnerConfig }> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(input.userRef),
      select: { id: true },
    });
    if (user === null) {
      throw new NotFoundException('No account is linked to this user');
    }

    const quest = await this.prismaService.quest.findUnique({ where: { id: input.questId } });
    if (quest === null) throw new NotFoundException('Quest not found');
    if (quest.type !== QuestType.PARTNER_TASK) {
      throw new BadRequestException('Quest is not a partner task quest');
    }
    if (!quest.enabled || !withinWindow(quest)) {
      throw new BadRequestException('Quest is not available');
    }
    const config = resolveQuestPartnerConfig(quest.params);
    if (config === null || !this.secretRegistry.has(config.partnerSlug)) {
      throw new BadRequestException('Quest partner is not configured for verification');
    }
    if (!(await this.progressService.isEligible(quest, user.id))) {
      throw new BadRequestException('Quest is not available for this user');
    }

    return { quest, userId: user.id, config };
  }
}

/** Constant-time string compare that never short-circuits on length. */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
