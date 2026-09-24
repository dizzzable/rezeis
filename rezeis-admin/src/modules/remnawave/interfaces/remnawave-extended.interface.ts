/**
 * Extended interface bag for the redesigned Remnawave page. We keep them in
 * one file because each shape is small and they share the same versioning
 * concerns: shape-tolerant parsers in `remnawave-api.service.ts` mappers
 * are the source of truth — these `interface` declarations are just a
 * documentation surface for the admin SPA.
 */

export interface RemnawaveHealthInterface {
  readonly status?: string;
  readonly message?: string | null;
  readonly uptime?: number;
  readonly db?: { readonly status?: string };
  readonly redis?: { readonly status?: string };
  readonly version?: string;
}

export interface RemnawaveHwidTopUserInterface {
  /**
   * The row's numeric panel id, in decimal (`''` when the row has none). The
   * name is the admin SPA's, which reads it; no supported panel has a uuid for
   * a user.
   */
  readonly userUuid: string;
  readonly username: string;
  readonly telegramId: string | null;
  readonly devicesCount: number;
  readonly lastSeenAt: string | null;
}

/**
 * One row of the panel's subscription-request log (a hit on `/sub/<shortUuid>`).
 *
 * Per the 3.3.2 and 3.4.3 specs a record carries `id`, `userId`,
 * `srrResponseType`, `srrRuleName`, `requestIp`, `userAgent` and `requestAt`.
 * The owner is `userId`, `{ "type": "number" }` — the panel-internal row id,
 * the same integer `RemnawavePanelUser.panelId` carries — and it arrives here
 * as `panelUserId`.
 *
 * `userUuid` stays on the wire, always `null`, because the admin SPA still
 * reads it: 2.7.4 named the owner by a uuid there, and no supported panel
 * does. The two are separate fields on purpose. An earlier mapper folded
 * `userId` into `userUuid`, which put a stringified integer into a
 * uuid-shaped field: every consumer keyed by a uuid silently missed, and the
 * admin request log rendered `12345…` as though it were the first octet of a
 * uuid.
 *
 * `username` and `clientType` used to be declared here and existed in no
 * spec, so both were unconditionally `null` — the admin table's "client"
 * column was permanently blank. `clientType` is now derived from the UA
 * instead of imagined; `username` is simply not in the payload and is gone.
 */
export interface RemnawaveSubscriptionRequestEntryInterface {
  readonly id: string;
  /** Always `null` — kept for the SPA; see the note above. */
  readonly userUuid: string | null;
  /** The panel's `userId`. Maps to `RemnawavePanelUser.panelId`. */
  readonly panelUserId: number | null;
  readonly userAgent: string | null;
  /**
   * Client family DERIVED from {@link userAgent} (the panel sends no such
   * field). `null` when the UA is absent or unrecognisable.
   */
  readonly clientType: string | null;
  readonly ipAddress: string | null;
  readonly requestedAt: string;
}

/** One node a provider bills for. See {@link RemnawaveInfraProviderInterface}. */
export interface RemnawaveInfraBillingNodeInterface {
  /**
   * `null` on a row whose `details` block is null — the panel keeps the
   * billing line after the node it referenced is gone, and reports the orphan
   * by nulling `details` rather than by dropping the row.
   */
  readonly nodeUuid: string | null;
  readonly name: string;
  readonly countryCode: string | null;
}

/**
 * One infra-billing provider, as `GET /api/infra-billing/providers` really
 * ships it (the 3.3.2 and 3.4.3 specs, identical here):
 *
 *   `{ uuid, name, faviconLink, loginUrl, createdAt, updatedAt,
 *      billingHistory: { totalAmount, totalBills }, billingNodes: [...] }`
 *
 * WHAT IS NOT HERE, AND WHY. `type`, `currency`, `monthlyCost` and
 * `nodesCount` were declared here and exist in no spec. Every one of them
 * therefore resolved to `null`/`0` on every panel, and the Costs tab rendered
 * a provider type of `—`, a node count of `0` and a blank monthly cost for
 * every row — a screen that looked like data and was not. They are removed
 * rather than remapped, because there is nothing upstream to map them to.
 *
 * A cost figure IS available, just not per month and not per currency:
 * `billingHistory` is the provider's lifetime bill tally. **The panel reports
 * no currency anywhere in any spec** (`grep currency` over every dump: zero
 * hits), so the amount is deliberately carried as a bare number and must
 * never be rendered next to a currency symbol the panel did not send.
 *
 * `billingNodes[]` is `{ name, details: { nodeUuid, countryCode } | null }`,
 * flattened by {@link RemnawaveInfraBillingNodeInterface}.
 */
export interface RemnawaveInfraProviderInterface {
  readonly uuid: string;
  readonly name: string;
  readonly faviconLink: string | null;
  readonly loginUrl: string | null;
  /** `billingHistory.totalAmount` — lifetime, CURRENCY-LESS. See the note above. */
  readonly billedTotalAmount: number;
  /** `billingHistory.totalBills` — how many bills that total is made of. */
  readonly billsCount: number;
  readonly billingNodes: readonly RemnawaveInfraBillingNodeInterface[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One row of `GET /api/snippets`.
 *
 * A snippet record is `{ name, snippet }` and NOTHING ELSE on every build —
 * there is no `uuid`, no `description`, no `type` and no timestamps. All four
 * were declared, all four were unconditionally empty, and `uuid` in particular
 * was `''` for every row, which the catalog table then used as its React key:
 * two snippets were enough to collide.
 *
 * `name` is the record's only identity and is the key the SPA now uses. The
 * write DTO types `snippet` as `{"type": "array", "items": {"type": "object"}}`
 * while the read DTO leaves it untyped, so only its length is trustworthy.
 */
export interface RemnawaveSnippetInterface {
  readonly name: string;
  /** `snippet.length`; `null` when the panel sent something that is not an array. */
  readonly entriesCount: number | null;
}

/**
 * One row of `GET /api/subscription-page-configs`.
 *
 * Spec rows are `{ uuid, viewPosition, name, config }` (3.3.2; 3.4 adds a
 * `tags` list, not surfaced). `title`, `description`, `logoUrl`, `faviconUrl`
 * and `customCss` were declared here and exist in no spec — the catalog
 * card's per-page subtitle read `title` and so never rendered on any panel.
 * Whatever branding the page carries lives inside the opaque `config` blob,
 * which the panel does not describe, so only its presence is reported.
 */
export interface RemnawaveSubpageConfigInterface {
  readonly uuid: string;
  readonly name: string;
  readonly viewPosition: number;
  /** `config !== null` — the blob itself is untyped upstream and is not surfaced. */
  readonly hasConfig: boolean;
}

/**
 * One row of `GET /api/node-plugins`.
 *
 * Spec rows are `{ uuid, viewPosition, name, pluginConfig }` (3.3.2; 3.4 adds a
 * `tags` list, not surfaced). `version`, `nodeUuid`, `createdAt` and
 * `updatedAt` exist in no spec. Worse,
 * `enabled` did not either: `Boolean(undefined)` is `false`, so the settings
 * tab rendered EVERY registered plugin as disabled — the one reading an
 * operator would act on, and it was false by construction. There is no
 * enablement flag upstream to replace it with, so the column is gone.
 */
export interface RemnawaveNodePluginInterface {
  readonly uuid: string;
  readonly name: string;
  readonly viewPosition: number;
  /** `pluginConfig !== null` — the blob itself is untyped upstream. */
  readonly hasConfig: boolean;
}

export interface RemnawaveUserResolveQuery {
  readonly telegramId?: string;
  readonly username?: string;
  readonly email?: string;
  readonly subscriptionUuid?: string;
}

/**
 * The profile the "Resolve user" panel renders, built from whichever
 * `GET /api/users/by-{short-uuid,username,email,telegram-id}/…` answered.
 *
 * TWO FIELDS USED TO BE READ FROM PLACES THE PANEL NEVER WRITES.
 *
 *   - `trafficUsedBytes` was read at the row level. Every spec puts consumption
 *     in a nested block: `userTraffic: { usedTrafficBytes, … }`. A row-level
 *     `trafficUsedBytes` does exist in these files, but only on the NODE dtos
 *     and on the subscription-info `user` sub-object (where it is a string) —
 *     never on the user lookups this summary is built from. The panel
 *     therefore showed `0 B` used for every user on every version.
 *   - `telegramId` is `{"type": "number", "nullable": true}` — a NUMBER.
 *     It was read with a string-only helper, so it was `null` for every user
 *     that had one. It is kept as a string here (Telegram ids exceed the safe
 *     integer range in principle and the SPA only ever prints it) but is now
 *     converted from the number the panel actually sends.
 */
export interface RemnawaveUserSummaryInterface {
  /**
   * The panel's identity for this row, as a string: the numeric id in decimal
   * (`''` when the row has no usable id) — a 3.x user has no uuid at all. The
   * form `Subscription.remnawaveId` holds on 3.x, so the two compare without
   * translation. The name is the admin SPA's; it is an identity string, not a
   * UUID.
   */
  readonly uuid: string;
  /** The panel's numeric id, when it exposes one. What 3.x routes address by. */
  readonly panelId: number | null;
  readonly shortUuid: string | null;
  readonly username: string;
  readonly status: string | null;
  readonly trafficLimitBytes: number | null;
  /** From `userTraffic.usedTrafficBytes`, NOT from a row-level field. */
  readonly trafficUsedBytes: number | null;
  readonly hwidDeviceLimit: number | null;
  readonly expireAt: string | null;
  /** Stringified from the panel's numeric `telegramId`. */
  readonly telegramId: string | null;
  readonly email: string | null;
  readonly tag: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly subscriptionUrl: string | null;
}


export interface RemnawaveSubscriptionTemplateInterface {
  readonly uuid: string;
  readonly name: string;
  readonly viewPosition: number;
  readonly templateType: string;
  readonly hasYaml: boolean;
}

export interface RemnawaveSubscriptionSettingsInterface {
  readonly uuid: string;
  readonly profileTitle: string;
  readonly supportLink: string | null;
  readonly profileUpdateInterval: number;
  readonly serveJsonAtBaseSubscription: boolean;
  readonly isProfileWebpageUrlEnabled: boolean;
  readonly isShowCustomRemarks: boolean;
  readonly randomizeHosts: boolean;
  /** Booleans summarising whether the panel exposes the corresponding payload. */
  readonly hasHappAnnounce: boolean;
  readonly hasHappRouting: boolean;
  readonly hasResponseRules: boolean;
  readonly hasCustomRemarks: boolean;
}
