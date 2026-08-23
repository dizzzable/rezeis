import type { RemnawavePanelUser } from './remnawave-api.service';

/**
 * WHO OWNS EACH `Subscription` COLUMN when rezeis and a Remnawave panel
 * disagree about it.
 *
 * This exists because two writers pull the SAME panel row into the SAME table
 * for two different reasons, and copying one into the other is a data-loss bug
 * rather than a consistency win:
 *
 *   • `RemnawaveImporterService.syncSubscription` ADOPTS a customer who
 *     already exists on the panel and has no local record at all. The panel is
 *     the only source there is, so it writes the whole row — limits, squads,
 *     status, expiry. Correct: there is nothing local to lose.
 *
 *   • `POST /admin/users/subscriptions/:id/sync` REFRESHES a row rezeis
 *     already owns and provisions. Here rezeis is UPSTREAM of the panel:
 *     `ProfileSyncProcessor` PUSHES the plan's limits and squads INTO the
 *     panel on every subscription mutation. Pulling those same columns back
 *     lets panel drift overwrite the plan an operator assigned, and the next
 *     push then fights the pull.
 *
 * The split below is derived from the push path, not asserted:
 *
 *   `ProfileSyncProcessor` sends rezeis → panel
 *     `expireAt`              ← `subscription.expiresAt`        (create + update)
 *     `trafficLimitBytes`     ← `subscription.trafficLimit`     (create + update + desired-state PATCH)
 *     `hwidDeviceLimit`       ← `subscription.deviceLimit`      (create + update + desired-state PATCH)
 *     `activeInternalSquads`  ← `subscription.internalSquads`   (create + update + desired-state PATCH)
 *     `externalSquadUuid`     ← `subscription.externalSquad`    (create + update + desired-state PATCH)
 *     `status`                ← `subscription.status`, and ONLY under an
 *                               explicit admin toggle — see the comment above
 *                               `propagateStatus`, which says in so many words
 *                               that derived local states must not overwrite
 *                               the panel during routine syncs.
 *     `tag` / `trafficLimitStrategy` ← `subscription.planSnapshot`
 *
 *   and writes back panel → rezeis, in `persistProfileLink` and in the panel
 *   identity back-fill, exactly and only:
 *     `remnawaveId`, `remnawavePanelId`, `remnawavePanelUsername`, `configUrl`
 *
 * A column rezeis pushes is a column rezeis decides. A column rezeis can only
 * learn by asking is a column the panel decides. That is the whole rule.
 *
 * `RemnawaveWebhookService.reconcileSubscriptionFromEvent` looks like a
 * counter-example and is not: it mirrors status/expiry/limits back on a
 * user-scoped panel EVENT — the panel announcing a change it just made — and
 * it writes each field ONLY when that event's payload actually carried it.
 * Nothing there adopts a value the panel did not state. Squads it never
 * touches at all, in either direction, which is why they are unambiguous
 * below.
 */

/**
 * Columns only the panel can know, and which rezeis therefore adopts.
 *
 * `remnawavePanelId` / `remnawavePanelUsername` are NOT cosmetic:
 * `ProfileSyncProcessor.panelProfileClaimedByAnother` — the one guard between
 * a DELETE and somebody else's live panel profile — can only see a claimant
 * through these two columns.
 */
export const PANEL_AUTHORITATIVE_SUBSCRIPTION_FIELDS = [
  'configUrl',
  'remnawavePanelId',
  'remnawavePanelUsername',
] as const;

/**
 * Columns rezeis provisions and pushes into the panel. A refresh must never
 * write one of these from a panel answer.
 *
 * `status` sits here rather than in the contested set for a reason beyond the
 * push: the only panel→local status mapping in the repo
 * (`RemnawaveImporterService.mapStatus`) answers `ACTIVE` for anything it does
 * not recognise, and `parsePanelUserRow` hands it the literal `'UNKNOWN'` for
 * a row whose status field was missing or of the wrong type. Adopting that on
 * an owned row silently REACTIVATES a subscription an operator disabled. It is
 * still a contested column — see the note on {@link CONTESTED_SUBSCRIPTION_FIELDS}.
 *
 * `planSnapshot` is here for a second, independent reason: Prisma writes a
 * `Json` column wholesale, so any writer that builds it from panel facts alone
 * drops every key the row already carried — `name` among them, which is what
 * the cabinet, the bot and every invoice render as the customer's plan.
 */
export const REZEIS_AUTHORITATIVE_SUBSCRIPTION_FIELDS = [
  'status',
  'trafficLimit',
  'deviceLimit',
  'internalSquads',
  'externalSquad',
  'planSnapshot',
] as const;

/**
 * Columns with a real claim on both sides, listed so the choice each writer
 * makes is a visible one rather than an accident.
 *
 * `expiresAt` — rezeis is the billing authority and pushes the expiry it sold;
 * but operators do extend profiles directly in the panel, and the panel is
 * what actually enforces the date the customer experiences. This endpoint
 * adopts a panel expiry ONLY when the panel stated a parseable one, which is
 * the same presence-guarded rule the webhook reconcile already uses, and never
 * erases a stored expiry with a blank answer.
 */
export const CONTESTED_SUBSCRIPTION_FIELDS = ['expiresAt'] as const;

export type PanelAuthoritativeSubscriptionField =
  (typeof PANEL_AUTHORITATIVE_SUBSCRIPTION_FIELDS)[number];
export type RezeisAuthoritativeSubscriptionField =
  (typeof REZEIS_AUTHORITATIVE_SUBSCRIPTION_FIELDS)[number];

/**
 * The columns a REFRESH of an owned row may write, and their values.
 *
 * Every key is optional and every one is omitted rather than nulled when the
 * panel did not state it. Prisma reads an absent key as "leave this column
 * alone" and `null` as "set it to null", and on a row we already own those are
 * opposite facts: the row's stored value is the last thing anybody positively
 * knew, and a panel that answered without a field has not contradicted it.
 *
 * This is the same `?? undefined` rule `ProfileSyncProcessor.persistProfileLink`
 * applies to the identity columns, and the same one `linkRemnawaveProfile`
 * applies to `configUrl` a few hundred lines above the caller.
 */
export interface PanelRefreshWrites {
  configUrl?: string;
  remnawavePanelId?: number;
  remnawavePanelUsername?: string;
  expiresAt?: Date;
}

/**
 * Builds {@link PanelRefreshWrites} from a panel row.
 *
 * Note what `parsePanelUserRow` hands back for a field the panel omitted: `''`
 * for `subscriptionUrl` and `expireAt`, `null` for `panelId`. None of those is
 * a statement about the profile, so none of them reaches the row.
 */
export function panelRefreshWrites(panelUser: RemnawavePanelUser): PanelRefreshWrites {
  const writes: PanelRefreshWrites = {};

  if (panelUser.subscriptionUrl.length > 0) {
    writes.configUrl = panelUser.subscriptionUrl;
  }
  if (panelUser.panelId !== null && Number.isSafeInteger(panelUser.panelId)) {
    writes.remnawavePanelId = panelUser.panelId;
  }
  if (panelUser.username.length > 0) {
    writes.remnawavePanelUsername = panelUser.username;
  }
  // `new Date('')` is an Invalid Date, and Prisma rejects one with a
  // `RangeError` at the driver rather than storing anything — the unguarded
  // `new Date(panelUser.expireAt)` this replaces turned a panel row with no
  // expiry into a 500 on an endpoint whose whole job is to be reassuring.
  if (panelUser.expireAt.length > 0) {
    const parsed = new Date(panelUser.expireAt);
    if (!Number.isNaN(parsed.getTime())) writes.expiresAt = parsed;
  }

  return writes;
}

/**
 * The panel's own reading of the columns rezeis owns, echoed verbatim so an
 * operator can SEE the drift the refresh deliberately did not adopt.
 *
 * Echoed, never converted: the panel counts traffic in bytes and rezeis stores
 * gigabytes, and a conversion here would be a second copy of a rule that
 * already exists in the two writers that legitimately perform it.
 */
export interface PanelReportedRezeisOwnedFields {
  readonly status: string;
  readonly trafficLimitBytes: number;
  readonly hwidDeviceLimit: number;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
}

export function panelReportedRezeisOwnedFields(
  panelUser: RemnawavePanelUser,
): PanelReportedRezeisOwnedFields {
  return {
    status: panelUser.status,
    trafficLimitBytes: panelUser.trafficLimitBytes,
    hwidDeviceLimit: panelUser.hwidDeviceLimit,
    internalSquads: panelUser.activeInternalSquads?.map((squad) => squad.uuid) ?? [],
    externalSquad: panelUser.externalSquadUuid ?? null,
  };
}
