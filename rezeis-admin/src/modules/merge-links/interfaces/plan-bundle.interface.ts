/**
 * What the admin panel's plan page needs to draw a bundle: its name, which
 * plans are in it, and the plan it is issued as. Prices, durations and limits
 * belong to the plans themselves — a bundle is a grouping first.
 */
export interface PlanBundleInterface {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly orderIndex: number;
  readonly planIds: readonly string[];
  /**
   * The `Plan` row this grouping is issued as («объединённая подписка»), or
   * `null` for a grouping that predates this release and has not been saved
   * since. The row is created with the grouping and retired with it.
   */
  readonly planId: string | null;
  /**
   * The device limit of that plan — ONE number for the whole merged
   * subscription, carried to both member profiles. `null` when the grouping has
   * no plan row yet.
   */
  readonly deviceLimit: number | null;
  /**
   * The member plan whose face the app shows on this bundle's merged link —
   * always one of `planIds`, ALWAYS a plan with a traffic limit while the
   * bundle has one. The operator's explicit choice when it is still valid,
   * otherwise the bundle's default: its first limited plan (a merged link that
   * showed «unlimited» would hide the limit the customer needs to watch), and a
   * bundle of unlimited-only plans falls back to its first plan.
   */
  readonly visiblePlanId: string | null;
  /**
   * The LIMITED member plan whose traffic the cabinet card prints on its second
   * line, under the card's own traffic row («0.01/50 ГБ»). `null` — the card
   * shows no second line. Chosen in the bundle card, not in the plan editor.
   */
  readonly secondaryPlanId: string | null;
  /**
   * The operator's own captions for the «Трафик доп.» lines of the merged
   * subscription, one per member plan that has one. At most `planIds.length - 2`
   * entries: the first two traffic lines are the main plan and the default
   * «Трафик доп.» row, both named by the bot's own texts. A member absent from
   * this list is captioned by the bot's `profile.traffic_extra` text.
   */
  readonly memberTrafficLabels: readonly { readonly planId: string; readonly label: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One profile inside a merged link, as the merging service consumes it. */
export interface MergeLinkSourceInterface {
  /** The panel's own public subscription URL for this profile. */
  readonly url: string;
  /** Plan name, so the client can label the merged nodes it receives. */
  readonly label: string;
}

/**
 * The answer to `GET /api/internal/merge-links/:token/sources`: which profiles
 * a merge token stands for.
 *
 * `remnawave-subscription-merge` fetches this on cache miss, so the shape is a
 * contract with another service — see `src/resolve.py` there. It treats fewer
 * than two sources as "not a merge" rather than serving a one-line config.
 */
export interface MergeLinkSourcesInterface {
  readonly label: string;
  readonly sources: readonly MergeLinkSourceInterface[];
}

/**
 * One bundle a customer's live subscriptions qualify for: the link every one of
 * its cards gets, and the plan the app must show.
 *
 * Served on the internal subscription payload as `merge`, so the cabinet and
 * the bot can draw ONE block for a grouped set of subscriptions instead of two
 * cards that happen to share a URL.
 */
export interface MergeLinkGroupInterface {
  readonly bundleId: string;
  readonly bundleName: string;
  /**
   * The grouping's own plan row carries at least one duration, so a renewal can
   * be PRICED as the merged tariff. `false` while the operator has not set the
   * time and price yet: the sale (and the one-payment renewal) cannot happen, so
   * the cabinet must keep the two profiles as two ordinary rows.
   */
  readonly renewalAsOneProduct: boolean;
  /**
   * The plan whose `profile-title` and traffic counters the merged link
   * reports. Always a plan THIS customer holds, so the app never names a plan
   * the customer does not have.
   */
  readonly visiblePlanId: string | null;
  /**
   * The member plan the cabinet card must print on its second line
   * («0.01/50 ГБ»), already checked against the plans THIS customer holds: a
   * chosen plan the customer does not have resolves to `null`, so the card
   * never prints traffic of a subscription that is not his.
   */
  readonly secondaryPlanId: string | null;
  /**
   * The captions the bot must print on the extra traffic lines of THIS
   * customer's merged subscription, keyed by member plan id. Filled from the
   * bundle's member rows and limited to the plans the customer HOLDS; a plan
   * without a caption is simply absent, which the bot reads as "use
   * `profile.traffic_extra`".
   *
   * A record rather than a list: the reader is a per-subscription mapper that
   * already knows its own plan id, and a list would make every card search.
   */
  readonly trafficLabelByPlanId: Readonly<Record<string, string>>;
  readonly url: string;
}
