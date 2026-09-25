/**
 * The wire shapes of «Подписки» → «Инструменты» → «Подписки без привязки к
 * Remnawave» and «Лишние профили в Remnawave», served by
 * `AdminPanelLinkCheckController` and mirrored by the admin SPA
 * (`web/src/features/subscriptions/tools/`). Codes, not sentences: the SPA
 * says each reason in the operator's language.
 */

import type { AutoLinkOutcome } from './panel-profile-comparison.service';

export type PanelLinkCheckTrigger = 'boot' | 'import' | 'retry' | 'daily';

export interface PanelLinkCheckStatus {
  /** When the last automatic run FINISHED; `null` = no run recorded yet. */
  readonly lastRunAt: string | null;
  readonly lastRunTrigger: PanelLinkCheckTrigger | null;
  /**
   * `complete`: every row walked and the whole Remnawave list read;
   * `incomplete`: something is left for the retry an hour later.
   */
  readonly lastRunOutcome: 'complete' | 'incomplete' | null;
  /** The retry after an incomplete run, else the next daily run. */
  readonly nextRunAt: string | null;
  /** A run is in progress right now (on any process). */
  readonly running: boolean;
}

export type UnlinkedReasonCode =
  | 'notCheckedYet'
  | 'noRoute'
  | 'notFound'
  | 'panelUnavailable'
  | 'profileUnreadable'
  | 'ownedByOther'
  | 'noOwnerProof'
  | 'markedForOtherSubscription'
  | 'profileTaken'
  | 'duplicatePair'
  | 'changedDuringCheck'
  | 'panelAgrees';

export interface UnlinkedSubscriptionRow {
  readonly subscriptionId: string;
  readonly userId: string;
  readonly userName: string | null;
  readonly userTelegramId: string | null;
  readonly status: string;
  readonly planName: string | null;
  readonly createdAt: string;
  /** What the row holds now: `null` (empty link) or the non-decimal value. */
  readonly storedRemnawaveId: string | null;
  readonly linkKind: 'empty' | 'nonNumeric';
  readonly reason: UnlinkedReasonCode;
  readonly profileId: string | null;
  readonly otherSubscriptionId: string | null;
  readonly otherUserId: string | null;
  readonly lookedUpBy: 'shortUuid' | 'username' | null;
  readonly checkedAt: string | null;
}

export interface UnlinkedSubscriptionsResponse {
  readonly check: PanelLinkCheckStatus;
  readonly total: number;
  readonly rows: readonly UnlinkedSubscriptionRow[];
  readonly truncated: boolean;
}

export interface ExtraProfile {
  readonly profileId: string;
  readonly username: string;
  readonly status: string | null;
  readonly createdAt: string | null;
  readonly usedTrafficBytes: number | null;
  readonly subscriptionMarker: string | null;
  readonly linkedBySubscriptionId: string | null;
  readonly autoLink: AutoLinkOutcome;
  readonly autoLinkedSubscriptionId: string | null;
  readonly autoLinkedAt: string | null;
  /** As the database stands now, a live subscription links this profile. */
  readonly linkedNow: boolean;
}

export interface SubscriptionWithoutLink {
  readonly subscriptionId: string;
  readonly status: string;
  readonly planName: string | null;
  readonly createdAt: string;
  readonly storedRemnawaveId: string | null;
}

export interface ExtraProfileCustomer {
  readonly userId: string;
  readonly userExists: boolean;
  readonly userName: string | null;
  readonly userTelegramId: string | null;
  readonly profiles: readonly ExtraProfile[];
  readonly subscriptionsWithoutLink: readonly SubscriptionWithoutLink[];
}

/**
 * Extra profiles whose `reiwa_id` names nobody this install has: a customer
 * deleted here, or another install's (`ComparedUnknownOwner`). Nothing to link.
 */
export interface ExtraProfileUnknownOwner {
  readonly userId: string;
  /** When the audit says an operator deleted that user here; `null` proves nothing. */
  readonly deletedAt: string | null;
  readonly profiles: readonly ExtraProfile[];
}

export interface ExtraProfilesResponse {
  readonly check: PanelLinkCheckStatus;
  readonly comparedAt: string | null;
  readonly readOutcome: 'complete' | 'partial' | null;
  readonly profilesRead: number;
  readonly profilesWithoutOwner: number;
  readonly autoLinked: number;
  readonly customers: readonly ExtraProfileCustomer[];
  readonly truncated: boolean;
  /** Apart from the customers, at most `PANEL_PROFILE_COMPARISON_MAX_UNKNOWN_OWNERS`. */
  readonly unknownOwners: readonly ExtraProfileUnknownOwner[];
  /** All such owners the comparison found; more than `unknownOwners.length` when the cap cut them. */
  readonly unknownOwnersTotal: number;
}
