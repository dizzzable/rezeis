import { PlanType, SubscriptionStatus } from '@prisma/client';

interface InternalUserSubscriptionPlanInterface {
  readonly id: string | null;
  readonly name: string | null;
  readonly type: PlanType | null;
  /**
   * Plan icon identifier frozen in the subscription's `planSnapshot` (lucide
   * key, `custom:<id>`, or a `:emoji:` shortcode). The cabinet renders it beside
   * the plan name; `null` when the plan had no icon → the card falls back to a
   * status glyph. Frozen at snapshot time, so it does not track later plan edits.
   */
  readonly icon: string | null;
}

/**
 * The operator's grouping a subscription belongs to, when the customer holds two
 * or more of its plans at once.
 *
 * Every subscription of the group carries the SAME merged `url`, so a client that
 * only looked at URLs could not tell whether two cards are "one link" or a copy.
 * This says it: `bundleId` groups them, `visiblePlanId` is the plan whose name,
 * limits and expiry the VPN app shows (the merge link reports that profile's
 * `profile-title` and traffic counters).
 */
export interface InternalUserSubscriptionMergeInterface {
  readonly bundleId: string;
  readonly bundleName: string;
  readonly visiblePlanId: string | null;
  /**
   * The LIMITED member plan whose traffic the cabinet card prints on its second
   * line («0.01/50 ГБ»), or `null` for "no second line". Already checked
   * against the plans this customer holds.
   */
  readonly secondaryPlanId: string | null;
  /**
   * The operator's own caption for THIS subscription's «Трафик доп.» line — the
   * words the bundle card set for this very plan, so reordering the bundle's
   * plans cannot move a caption onto another plan's line. `null` when the
   * bundle has none for it: the bot then prints its `profile.traffic_extra`
   * text.
   */
  readonly trafficLabel: string | null;
  /**
   * The bundle's OWN plan row — the tariff the customer bought and renews. The
   * cabinet compares it with the plan a renewal option prices onto: same id
   * means "renewing the same product", which is what autopay needs to know
   * before offering a card to save. `null` for a subscription that carries no
   * sale marker (grouped by accident, not sold as one product).
   */
  readonly bundlePlanId: string | null;
  /**
   * This subscription was SOLD as the bundle's own tariff (`bundle-snapshot
   * .util.ts` writes the marker), so the whole set is ONE product: one price in
   * the shop, one renewal, one refund. The cabinet draws a single renewal row
   * for it instead of one row per profile.
   *
   * `false` for a customer who happens to hold two plans of one bundle bought (or
   * granted) separately: those are still two products and renew one by one.
   */
  readonly bundleRenewal: boolean;
}

/**
 * Describes the current read-only subscription payload exposed to internal user clients.
 *
 * Used by reiwa SPA to render the subscription card (bank-card style):
 *   - plan.name → card title
 *   - userRemnaId → profile ID displayed on card face
 *   - url → "Connect" button copies this URL
 *   - expiresAt → expiry date on card
 *   - trafficLimit → traffic progress bar
 *   - deviceLimit → device count
 */
export interface InternalUserSubscriptionInterface {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly isTrial: boolean;
  /**
   * True only for a FREE trial (availability `TRIAL` + `trialSettings.free`).
   * This distinguishes a zero-cost grant from a paid trial checkout. All trial
   * subscriptions are non-renewable and must be upgraded.
   */
  readonly trialFree: boolean;
  readonly plan: InternalUserSubscriptionPlanInterface | null;
  readonly trafficLimit: number | null;
  /**
   * Traffic consumed so far, in GB (best-effort from the Remnawave
   * panel). `null` when the panel is unreachable, the subscription has
   * no upstream profile, or usage tracking is unavailable — the SPA
   * then hides the progress bar rather than showing a wrong value.
   */
  readonly trafficUsed: number | null;
  readonly deviceLimit: number;
  /** Remnawave profile UUID — the stable upstream identifier (not shown on the card). */
  readonly userRemnaId: string | null;
  /**
   * Human-readable Remnawave profile name (e.g. `rz_login_sub`) — this is
   * what the panels display and what the SPA shows on the card face instead
   * of the opaque UUID. `null` when the panel is unreachable or the
   * subscription has no upstream profile yet.
   */
  readonly profileName: string | null;
  /** Subscription/config URL from Remnawave — used by "Connect" button. */
  readonly url: string | null;
  /** Legacy alias for url (backwards compatibility with older SPA builds). */
  readonly configUrl: string | null;
  readonly startedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * The plan grouping behind this card's merged `url`, or `null` when the card
   * serves its own panel URL. Present only while the customer holds two or more
   * of the bundle's live plans.
   */
  readonly merge: InternalUserSubscriptionMergeInterface | null;
  /**
   * «Не получилось подключиться?» for this subscription, or `null` when no help
   * is pending on it.
   *
   *   pending — help was given (bot, push, e-mail, the banner or a broadcast),
   *             the subscription is ACTIVE or LIMITED, and its profile has
   *             still never connected — neither by the stored state nor by the
   *             panel read this same request made. What `/dashboard?connect=help`
   *             picks when it names no subscription.
   *   banner  — pending, the help reached the customer no other way (the ladder
   *             ended at the banner), not dismissed, and not switched off in the
   *             customer's notification settings.
   *
   * A panel without the feature sends no field; the cabinet reads that, `null`
   * and `pending: false` alike.
   */
  readonly connectHelp: { readonly pending: boolean; readonly banner: boolean } | null;
}
