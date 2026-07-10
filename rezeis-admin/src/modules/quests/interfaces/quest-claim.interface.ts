import { QuestRewardType } from '@prisma/client';

/**
 * Result of claiming a quest — the concrete reward that was issued. Stored as
 * `QuestCompletion.rewardSnapshot` and returned to the caller for display.
 */
export interface QuestClaimResult {
  readonly questId: string;
  readonly rewardType: QuestRewardType;
  /** POINTS: points credited. */
  readonly points?: number;
  /** DAYS: days granted / added. */
  readonly days?: number;
  /** DISCOUNT: personal-discount percent after applying. */
  readonly discountPercent?: number;
  /** TRAFFIC: GB added. */
  readonly trafficGb?: number;
  /** PROMOCODE (or DAYS→MINT_PROMOCODE fallback): the minted single-use code. */
  readonly promoCode?: string;
  /** The subscription a days/traffic reward was applied to (when any). */
  readonly subscriptionId?: string;
}
