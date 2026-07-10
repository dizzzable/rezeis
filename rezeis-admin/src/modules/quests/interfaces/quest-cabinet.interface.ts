import { QuestIconKind, QuestRewardType, QuestType } from '@prisma/client';

import { LocalizedText } from './quest.interface';

/** One quest as shown to a cabinet user (never a CLAIMED one — those are hidden). */
export interface QuestCabinetItem {
  readonly id: string;
  readonly type: QuestType;
  readonly title: LocalizedText;
  readonly description: LocalizedText;
  readonly iconKind: QuestIconKind;
  readonly iconRef: string;
  readonly rewardType: QuestRewardType;
  readonly rewardAmount: number;
  /** IN_PROGRESS (not yet earned) or COMPLETED (claimable). */
  readonly status: 'IN_PROGRESS' | 'COMPLETED';
  readonly progress: number;
  readonly requiredFriends?: number;
  /** True when the user can press "Забрать" now. */
  readonly claimable: boolean;
}

export interface QuestCabinetResponse {
  readonly pointsBalance: number;
  readonly quests: readonly QuestCabinetItem[];
}
