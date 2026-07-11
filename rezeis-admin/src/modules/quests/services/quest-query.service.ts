import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Quest, QuestCompletion, QuestCompletionStatus, QuestType } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  QuestCabinetItem,
  QuestCabinetResponse,
} from '../interfaces/quest-cabinet.interface';
import { LocalizedText } from '../interfaces/quest.interface';
import {
  QuestProgressService,
  readRequiredFriends,
  withinWindow,
} from './quest-progress.service';
import { resolveQuestPartnerConfig } from '../utils/quest-partner-config.util';

interface CabinetUser {
  readonly points: number;
  readonly telegramId: bigint | null;
  readonly emailVerified: boolean;
}

/**
 * Builds the cabinet's quest list for one user — the single source of truth for
 * which quests are shown (the SPA uses the session only for cheap hints). A
 * quest appears when the user can act on it or claim it; it is hidden when the
 * reward was already claimed, the campaign is over/out of budget, the user is
 * outside the audience, or the underlying action is already done with nothing
 * pending (auto-hide).
 */
@Injectable()
export class QuestQueryService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly progressService: QuestProgressService,
  ) {}

  public async listForUser(userId: string): Promise<QuestCabinetResponse> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: {
        points: true,
        telegramId: true,
        webAccount: { select: { emailVerifiedAt: true } },
      },
    });
    if (user === null) {
      throw new NotFoundException('User not found');
    }
    const cabinetUser: CabinetUser = {
      points: user.points,
      telegramId: user.telegramId,
      emailVerified: user.webAccount?.emailVerifiedAt != null,
    };

    const quests = await this.prismaService.quest.findMany({
      where: { enabled: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
    const completions = await this.prismaService.questCompletion.findMany({
      where: { userId, periodKey: '' },
      select: { questId: true, status: true, progress: true },
    });
    const byQuest = new Map<string, Pick<QuestCompletion, 'status' | 'progress'>>();
    for (const c of completions) byQuest.set(c.questId, { status: c.status, progress: c.progress });

    const items: QuestCabinetItem[] = [];
    for (const quest of quests) {
      if (!withinWindow(quest)) continue;
      if (budgetExhausted(quest)) continue;

      const completion = byQuest.get(quest.id) ?? null;
      // Already rewarded — hide.
      if (completion?.status === QuestCompletionStatus.CLAIMED) continue;

      if (completion === null) {
        // No progress yet: hide if the user isn't targeted, or if the action is
        // already done (the reconciler will surface it as claimable shortly).
        if (actionAlreadyDone(quest.type, cabinetUser)) continue;
        if (!(await this.progressService.isEligible(quest, userId))) continue;
      }

      items.push(toCabinetItem(quest, completion));
    }

    return { pointsBalance: user.points, quests: items };
  }
}

function budgetExhausted(quest: Quest): boolean {
  return quest.maxCompletionsGlobal !== null && quest.issuedCount >= quest.maxCompletionsGlobal;
}

function actionAlreadyDone(type: QuestType, user: CabinetUser): boolean {
  if (type === QuestType.LINK_TELEGRAM) return user.telegramId !== null;
  if (type === QuestType.LINK_EMAIL) return user.emailVerified;
  return false;
}

function toCabinetItem(
  quest: Quest,
  completion: Pick<QuestCompletion, 'status' | 'progress'> | null,
): QuestCabinetItem {
  const claimable = completion?.status === QuestCompletionStatus.COMPLETED;
  const base: QuestCabinetItem = {
    id: quest.id,
    type: quest.type,
    title: readLocalized(quest.title),
    description: readLocalized(quest.description),
    iconKind: quest.iconKind,
    iconRef: quest.iconRef,
    rewardType: quest.rewardType,
    rewardAmount: quest.rewardAmount,
    status: claimable ? 'COMPLETED' : 'IN_PROGRESS',
    progress: completion?.progress ?? 0,
    claimable,
  };
  if (quest.type === QuestType.INVITE_FRIENDS) {
    return { ...base, requiredFriends: readRequiredFriends(quest.params) };
  }
  if (quest.type === QuestType.PARTNER_TASK) {
    const partner = resolveQuestPartnerConfig(quest.params);
    if (partner === null) return base;
    // Expose ONLY presentation-safe fields — never the slug, code or secret.
    return {
      ...base,
      partnerMethod: partner.method,
      ...(partner.landingUrl !== null ? { partnerUrl: partner.landingUrl } : {}),
      ...(partner.minDwellSeconds !== null ? { partnerVisitSeconds: partner.minDwellSeconds } : {}),
    };
  }
  return base;
}

function readLocalized(value: Prisma.JsonValue): LocalizedText {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ru: '', en: '' };
  }
  const record = value as Record<string, unknown>;
  return {
    ru: typeof record.ru === 'string' ? record.ru : '',
    en: typeof record.en === 'string' ? record.en : '',
  };
}
