import { PointsLedgerSource, Prisma } from '@prisma/client';

/**
 * The five things this platform knows how to give somebody. Quests award one
 * of them for finishing a task; the wheel awards one of them for a spin; the
 * shapes are identical because the giving is identical.
 */
export type RewardKind = 'POINTS' | 'DAYS' | 'TRAFFIC' | 'DISCOUNT' | 'PROMOCODE';

export interface RewardGrant {
  readonly kind: RewardKind;
  /** Points, days, gigabytes or percent, by kind. */
  readonly amount: number;
  /**
   * The plan a minted promocode grants. `null` mints a duration code instead,
   * which is what a code without a plan has always meant.
   */
  readonly planId: string | null;
}

/**
 * WHO is giving, which is everything the ledger and the minted code need in
 * order to be traceable back to the reason.
 */
export interface RewardOrigin {
  /** The points ledger source: QUEST_REWARD, and later the wheel's own. */
  readonly pointsSource: PointsLedgerSource;
  /**
   * Idempotency handle for the points ledger — the quest completion id, the
   * spin id. Exactly-once is already guaranteed by the caller's own
   * single-winner claim; this makes the JOURNAL agree with it.
   */
  readonly referenceKey: string;
  /** What the ledger row shows: which quest, which sector. */
  readonly details: Prisma.InputJsonObject;
  /** Prefix of a minted promocode, so a person can see where it came from. */
  readonly codePrefix: string;
}

/**
 * What actually happened, which is not always what was asked for: a days
 * reward with no subscription to extend becomes a promocode, and a traffic
 * reward with no subscription at all becomes nothing.
 */
export interface RewardApplication {
  readonly kind: RewardKind;
  readonly points?: number;
  readonly days?: number;
  readonly trafficGb?: number;
  readonly discountPercent?: number;
  readonly promoCode?: string;
  readonly subscriptionId?: string;
  /**
   * The subscription whose panel profile has to be re-synced AFTER the
   * caller's transaction commits. `null` when nothing panel-visible moved.
   *
   * It is returned rather than enqueued here on purpose: a sync job enqueued
   * inside the transaction announces a change that a rollback then undoes.
   */
  readonly syncSubscriptionId: string | null;
}
