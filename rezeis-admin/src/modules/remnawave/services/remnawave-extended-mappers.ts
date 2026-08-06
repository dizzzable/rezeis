/**
 * Mappers for the "extended" Remnawave surface (live, costs, catalog, users
 * search, subscription history). All of them are defensive: they accept
 * `unknown`, never throw, and fall back to empty/zero values when fields
 * are missing — different Remnawave versions ship subtly different shapes
 * across the same endpoints.
 */
import {
  RemnawaveHwidTopUserInterface,
  RemnawaveInfraBillingNodeInterface,
  RemnawaveInfraProviderInterface,
  RemnawaveNodePluginInterface,
  RemnawaveSnippetInterface,
  RemnawaveSubpageConfigInterface,
  RemnawaveSubscriptionRequestEntryInterface,
  RemnawaveUserSummaryInterface,
} from '../interfaces/remnawave-extended.interface';

export function mapHwidTopUser(raw: unknown): RemnawaveHwidTopUserInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  // 2.7.x ships `{ userUuid, id, username, devicesCount }` flat at the row
  // level, no nested `user` block. We still tolerate the older nested shape.
  const user = (r['user'] ?? r) as Record<string, unknown>;
  return {
    // 2.8 renamed the row id `userUuid` → `userId`; accept both.
    userUuid: toString(r['userUuid'] ?? r['userId'] ?? user['uuid']),
    username: toString(r['username'] ?? user['username']),
    telegramId: toNullableString(r['telegramId'] ?? user['telegramId']),
    devicesCount: toNumber(r['devicesCount'] ?? r['count'] ?? r['hwidDevicesCount']),
    lastSeenAt: toNullableString(r['lastSeenAt'] ?? r['lastUsedAt'] ?? user['lastSeenAt']),
  };
}

/**
 * Client family from the UA's leading product token: `v2rayNG/1.8.5 (Android)`
 * → `v2rayNG`. The panel sends no client field on either supported build, so
 * this is derived rather than read — the alternative, which shipped before,
 * was a column that was blank for every row on every version.
 *
 * Deliberately dumb: the first `Product` of `Product/Version` per RFC 9110. No
 * allow-list, because an allow-list would silently label every client it has
 * not heard of as unknown, and this value is display-only.
 */
function deriveClientType(userAgent: string | null): string | null {
  if (userAgent === null) return null;
  const token = userAgent.trim().split(/[\s/]/, 1)[0];
  return token !== undefined && token.length > 0 ? token.slice(0, 40) : null;
}

/**
 * One subscription-request row.
 *
 * The owner field is split by version rather than merged — see
 * {@link RemnawaveSubscriptionRequestEntryInterface} for why merging them was
 * a silent misattribution on 2.8.0. Field names below are the ones the 2.7.4
 * and 2.8.0 specs actually declare (`requestIp`, `requestAt`); the previously
 * accepted `ipAddress`/`requestedAt`/`createdAt`/`user.*` spellings appear in
 * neither and have been dropped rather than left as reassuring dead branches.
 */
export function mapSubscriptionRequestEntry(raw: unknown): RemnawaveSubscriptionRequestEntryInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  const userAgent = toNullableString(r['userAgent']);
  // 2.7.4 sends a uuid string here and 2.8.0 sends nothing; a numeric value
  // would be 2.8.0's `userId` arriving under the wrong key, which is precisely
  // the confusion this split exists to prevent — so it is refused, not coerced.
  const rawUuid = r['userUuid'];
  const userUuid =
    typeof rawUuid === 'string' && rawUuid.trim().length > 0 ? rawUuid.trim() : null;
  // 2.8.0's panel-internal integer. Accepted as a number or as a numeric
  // string (JSON bigint transports vary), never as a uuid.
  const rawPanelId = r['userId'];
  const panelUserId =
    typeof rawPanelId === 'number' && Number.isFinite(rawPanelId)
      ? rawPanelId
      : typeof rawPanelId === 'string' && /^\d+$/.test(rawPanelId.trim())
        ? Number(rawPanelId.trim())
        : null;
  return {
    // `id` is `{"type": "number"}` on BOTH builds, and the shared `toString`
    // helper returns '' for anything that is not already a string — so the
    // previous `toString(r['id'])` produced an empty id for every row on every
    // version, which the admin table then used as its React key. Stringify the
    // number explicitly.
    id: typeof r['id'] === 'number' && Number.isFinite(r['id']) ? String(r['id']) : toString(r['id']),
    userUuid,
    panelUserId,
    userAgent,
    clientType: deriveClientType(userAgent),
    ipAddress: toNullableString(r['requestIp']),
    requestedAt: toString(r['requestAt']),
  };
}

/**
 * One entry of a provider's `billingNodes`. The two supported builds nest this
 * differently and BOTH are read, per the house rule of absorbing version drift
 * in the mapper rather than in the caller:
 *
 *   - 2.7.4 → `{ nodeUuid, name, countryCode }` (all three required)
 *   - 2.8.0 → `{ name, details: { nodeUuid, countryCode } | null }`
 *
 * A 2.8.0 row with `details: null` still has a name — it is a billing line
 * whose node is gone — so it is kept with a null uuid rather than dropped,
 * because dropping it would quietly shrink the billed-node count the operator
 * is being asked to reconcile against an invoice.
 */
function mapInfraBillingNode(raw: unknown): RemnawaveInfraBillingNodeInterface {
  const n = (raw ?? {}) as Record<string, unknown>;
  const details = (n['details'] ?? {}) as Record<string, unknown>;
  return {
    nodeUuid: toNullableString(n['nodeUuid'] ?? details['nodeUuid']),
    name: toString(n['name']),
    countryCode: toNullableString(n['countryCode'] ?? details['countryCode']),
  };
}

/**
 * `GET /api/infra-billing/providers` → one provider.
 *
 * Reads only fields both specs declare. See
 * {@link RemnawaveInfraProviderInterface} for the four that were being read
 * and exist upstream in neither version, and for why the amount carries no
 * currency.
 */
export function mapInfraProvider(raw: unknown): RemnawaveInfraProviderInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  const billingHistory = (r['billingHistory'] ?? {}) as Record<string, unknown>;
  const billingNodes = r['billingNodes'];
  return {
    uuid: toString(r['uuid']),
    name: toString(r['name']),
    faviconLink: toNullableString(r['faviconLink']),
    loginUrl: toNullableString(r['loginUrl']),
    billedTotalAmount: toNumber(billingHistory['totalAmount']),
    billsCount: toNumber(billingHistory['totalBills']),
    billingNodes: Array.isArray(billingNodes) ? billingNodes.map(mapInfraBillingNode) : [],
    createdAt: toString(r['createdAt']),
    updatedAt: toString(r['updatedAt']),
  };
}

/**
 * `GET /api/snippets` → one snippet. The record is `{ name, snippet }` and
 * nothing else; see {@link RemnawaveSnippetInterface}.
 */
export function mapSnippet(raw: unknown): RemnawaveSnippetInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  const snippet = r['snippet'];
  return {
    name: toString(r['name']),
    entriesCount: Array.isArray(snippet) ? snippet.length : null,
  };
}

/**
 * `GET /api/subscription-page-configs` → one page config. Rows are
 * `{ uuid, viewPosition, name, config }`; see
 * {@link RemnawaveSubpageConfigInterface}.
 */
export function mapSubpageConfig(raw: unknown): RemnawaveSubpageConfigInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    uuid: toString(r['uuid']),
    name: toString(r['name']),
    viewPosition: toNumber(r['viewPosition']),
    // `config` is declared `{"nullable": true}` with no type on either build,
    // so presence is the only honest thing to report about it. `undefined`
    // (key absent) and `null` (key present, empty) both mean "not configured".
    hasConfig: r['config'] !== null && r['config'] !== undefined,
  };
}

/**
 * `GET /api/node-plugins` → one plugin. Rows are
 * `{ uuid, viewPosition, name, pluginConfig }`; see
 * {@link RemnawaveNodePluginInterface} for why `enabled` is gone rather than
 * defaulted.
 */
export function mapNodePlugin(raw: unknown): RemnawaveNodePluginInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    uuid: toString(r['uuid']),
    name: toString(r['name']),
    viewPosition: toNumber(r['viewPosition']),
    hasConfig: r['pluginConfig'] !== null && r['pluginConfig'] !== undefined,
  };
}

export function mapUserSummary(raw: unknown): RemnawaveUserSummaryInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  // Consumption lives in a nested block on BOTH builds. The row-level
  // `trafficUsedBytes` this used to read belongs to the node dtos, not to any
  // of the four user lookups that feed this mapper — see the interface note.
  const userTraffic = (r['userTraffic'] ?? {}) as Record<string, unknown>;
  return {
    uuid: toString(r['uuid']),
    shortUuid: toNullableString(r['shortUuid']),
    username: toString(r['username']),
    status: toNullableString(r['status']),
    trafficLimitBytes: toNullableNumber(r['trafficLimitBytes']),
    trafficUsedBytes: toNullableNumber(userTraffic['usedTrafficBytes']),
    hwidDeviceLimit: toNullableNumber(r['hwidDeviceLimit']),
    expireAt: toNullableString(r['expireAt']),
    // The panel sends a number here; the string-only helper this used to call
    // discarded every one of them.
    telegramId: toNullableIdString(r['telegramId']),
    email: toNullableString(r['email']),
    tag: toNullableString(r['tag']),
    createdAt: toNullableString(r['createdAt']),
    updatedAt: toNullableString(r['updatedAt']),
    subscriptionUrl: toNullableString(r['subscriptionUrl']),
  };
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A panel identifier that arrives as a NUMBER but is only ever displayed.
 *
 * Rendered as its decimal string. Non-integers and values outside the exact
 * integer range are refused rather than printed, because a Telegram id that
 * has already lost precision is worse than an absent one. A string is passed
 * through unchanged: a bigint-safe transport may have stringified it upstream.
 */
function toNullableIdString(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(value) : null;
  }
  return toNullableString(value);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}


export function mapSubscriptionTemplate(raw: unknown): {
  readonly uuid: string;
  readonly name: string;
  readonly viewPosition: number;
  readonly templateType: string;
  readonly hasYaml: boolean;
} {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    uuid: toString(r['uuid']),
    name: toString(r['name']),
    viewPosition: toNumber(r['viewPosition']),
    templateType: toString(r['templateType']),
    hasYaml: typeof r['encodedTemplateYaml'] === 'string' && (r['encodedTemplateYaml'] as string).length > 0,
  };
}

/**
 * Subscription settings come back from Remnawave as a hefty mixed payload.
 * We surface only the fields safe to display in the admin UI:
 *   • toggles + display strings,
 *   • boolean "is configured" flags for response rules / Happ-specific
 *     payloads (those carry raw config blobs we don't want to leak through
 *     the admin SPA).
 */
export function mapSubscriptionSettings(raw: unknown): {
  readonly uuid: string;
  readonly profileTitle: string;
  readonly supportLink: string | null;
  readonly profileUpdateInterval: number;
  readonly serveJsonAtBaseSubscription: boolean;
  readonly isProfileWebpageUrlEnabled: boolean;
  readonly isShowCustomRemarks: boolean;
  readonly randomizeHosts: boolean;
  readonly hasHappAnnounce: boolean;
  readonly hasHappRouting: boolean;
  readonly hasResponseRules: boolean;
  readonly hasCustomRemarks: boolean;
} {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    uuid: toString(r['uuid']),
    profileTitle: toString(r['profileTitle']),
    supportLink: toNullableString(r['supportLink']),
    profileUpdateInterval: toNumber(r['profileUpdateInterval']),
    serveJsonAtBaseSubscription: Boolean(r['serveJsonAtBaseSubscription']),
    isProfileWebpageUrlEnabled: Boolean(r['isProfileWebpageUrlEnabled']),
    isShowCustomRemarks: Boolean(r['isShowCustomRemarks']),
    randomizeHosts: Boolean(r['randomizeHosts']),
    hasHappAnnounce: typeof r['happAnnounce'] === 'string' && (r['happAnnounce'] as string).length > 0,
    hasHappRouting: typeof r['happRouting'] === 'string' && (r['happRouting'] as string).length > 0,
    hasResponseRules:
      typeof r['responseRules'] === 'object' && r['responseRules'] !== null,
    hasCustomRemarks:
      typeof r['customRemarks'] === 'object' && r['customRemarks'] !== null,
  };
}
