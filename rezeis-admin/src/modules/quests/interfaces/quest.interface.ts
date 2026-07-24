import {
  QuestDaysFallback,
  QuestIconKind,
  QuestRepeat,
  QuestRewardType,
  QuestType,
} from '@prisma/client';

import type { BroadcastAudienceFilter } from '../../broadcast/utils/broadcast-audience.util';

/** Localized copy stored in the `title` / `description` JSON columns. */
export interface LocalizedText {
  readonly ru: string;
  readonly en: string;
}

/**
 * Type-specific quest parameters (stored in the `params` JSON column):
 *   - SUBSCRIBE_CHANNEL → `channelId` / `channelUsername` / `channelLink`
 *   - INVITE_FRIENDS    → `requiredFriends`
 *   - PARTNER_TASK      → `partner` verification config (Phase C)
 */
export interface QuestParams {
  readonly channelId?: string;
  readonly channelUsername?: string;
  readonly channelLink?: string;
  readonly requiredFriends?: number;
  readonly partner?: Record<string, unknown>;
}

/** Admin-facing, service-mapped shape of a quest. */
export interface QuestInterface {
  readonly id: string;
  readonly type: QuestType;
  readonly title: LocalizedText;
  readonly description: LocalizedText;
  readonly iconKind: QuestIconKind;
  readonly iconRef: string;
  readonly rewardType: QuestRewardType;
  readonly rewardAmount: number;
  readonly rewardPlanId: string | null;
  readonly daysFallback: QuestDaysFallback;
  readonly audienceFilter: BroadcastAudienceFilter | null;
  readonly repeat: QuestRepeat;
  readonly cooldownHours: number | null;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly maxCompletionsGlobal: number | null;
  readonly issuedCount: number;
  readonly params: QuestParams | null;
  readonly order: number;
  readonly enabled: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
