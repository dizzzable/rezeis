/**
 * Account-merge contracts.
 *
 * The merge consolidates a SOURCE `User` into a TARGET `User` (source is
 * deleted). Identity is the canonical reiwa_id (`User.id`). `AccountSummary`
 * powers the side-by-side admin preview; `MergeChoices` captures the operator's
 * per-conflict decisions.
 */

export interface AccountSubscriptionStats {
  readonly total: number;
  readonly active: number;
  readonly trial: number;
}

export interface AccountPartnerStats {
  readonly isPartner: boolean;
  /** Balance in minor units (kopecks). 0 when not a partner. */
  readonly balanceMinor: number;
}

/** One side of the merge preview. */
export interface AccountSummary {
  readonly userId: string;
  readonly login: string | null;
  /** Stringified Telegram id (BigInt) or null. */
  readonly telegramId: string | null;
  readonly email: string | null;
  readonly name: string;
  readonly isBlocked: boolean;
  readonly hasWebAccount: boolean;
  readonly hasTrialGrant: boolean;
  readonly subscriptions: AccountSubscriptionStats;
  readonly transactionsCount: number;
  readonly partner: AccountPartnerStats;
  readonly createdAt: string;
}

/**
 * Conflicts that need an operator decision before merging. Each entry is a
 * stable code the SPA renders into a choice control.
 */
export type AccountMergeConflict =
  | 'login'
  | 'telegram'
  | 'email'
  | 'partner'
  | 'trial'
  | 'referredBy';

export interface AccountMergePreview {
  /** The account whose detail page the operator opened (the `:id`). */
  readonly current: AccountSummary;
  /** The counterpart resolved from the reference (login/tgid/reiwa/email). */
  readonly counterpart: AccountSummary;
  readonly conflicts: readonly AccountMergeConflict[];
}

/** Per-conflict operator choices. Partner balances are always summed. */
export interface MergeChoices {
  readonly keepLogin?: 'source' | 'target';
  readonly keepTelegram?: 'source' | 'target';
  readonly keepEmail?: 'source' | 'target';
  /** Subscription id (must belong to either side) to mark current on target. */
  readonly currentSubscriptionId?: string | null;
}

export interface AccountMergeInput {
  readonly sourceId: string;
  readonly targetId: string;
  readonly choices: MergeChoices;
  readonly confirm: boolean;
  readonly actorAdminId: string;
}

export interface AccountMergeResult {
  readonly mergedUserId: string;
  readonly movedCounts: {
    readonly subscriptions: number;
    readonly transactions: number;
    readonly partnerTransactions: number;
  };
  /** Subscription ids with a live Remnawave profile that need a re-sync. */
  readonly remnawaveSubscriptionIds: readonly string[];
}
