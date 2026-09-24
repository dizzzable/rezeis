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
  return {
    // The identity is the row's numeric `id`, rendered as its decimal string.
    // Every supported panel sends this row as `{ id, username, devicesCount }`
    // and nothing else (the 3.3.2 and 3.4.3 specs); the field keeps its old
    // name, `userUuid`, because the admin SPA's HWID card reads it by that name.
    //
    // The decimal string, because that is what rezeis stores in `remnawaveId`
    // on 3.x, so a row can be matched to a subscription without a translation
    // step. When this mapper read only the uuid spellings 2.x used, every 3.x
    // row mapped to `''` — a card of identical blank identities. An id that is
    // not a safe integer still maps to `''` rather than to a number that has
    // lost precision.
    userUuid: toNullableIdString(r['id']) ?? '',
    username: toString(r['username']),
    telegramId: toNullableString(r['telegramId']),
    devicesCount: toNumber(r['devicesCount'] ?? r['count'] ?? r['hwidDevicesCount']),
    lastSeenAt: toNullableString(r['lastSeenAt'] ?? r['lastUsedAt']),
  };
}

/**
 * Client family from the UA's leading product token: `v2rayNG/1.8.5 (Android)`
 * → `v2rayNG`. No contract from 3.2 through 3.4.4 puts a client field on a
 * request-log row, so this is derived rather than read — the alternative,
 * which shipped before, was a column that was blank for every row on every
 * version.
 *
 * Deliberately dumb: the first `Product` of `Product/Version` per RFC 9110. No
 * allow-list, because an allow-list would silently label every client it has
 * not heard of as unknown, and this value is display-only.
 */
export function deriveClientType(userAgent: string | null): string | null {
  if (userAgent === null) return null;
  const token = userAgent.trim().split(/[\s/]/, 1)[0];
  return token !== undefined && token.length > 0 ? token.slice(0, 40) : null;
}

/**
 * One subscription-request row.
 *
 * Field names below are the ones every supported panel's spec declares
 * (`userId`, `requestIp`, `requestAt` — 3.3.2 and 3.4.3); the previously
 * accepted `ipAddress`/`requestedAt`/`createdAt`/`user.*` spellings appear in
 * none and have been dropped rather than left as reassuring dead branches. The
 * owner is `userId`, carried as `panelUserId`; see
 * {@link RemnawaveSubscriptionRequestEntryInterface} for why it is never
 * folded into `userUuid`.
 */
export function mapSubscriptionRequestEntry(raw: unknown): RemnawaveSubscriptionRequestEntryInterface {
  const r = (raw ?? {}) as Record<string, unknown>;
  const userAgent = toNullableString(r['userAgent']);
  // The panel-internal integer. Accepted as a number or as a numeric string
  // (JSON bigint transports vary), never as a uuid.
  const rawPanelId = r['userId'];
  const panelUserId =
    typeof rawPanelId === 'number' && Number.isFinite(rawPanelId)
      ? rawPanelId
      : typeof rawPanelId === 'string' && /^\d+$/.test(rawPanelId.trim())
        ? Number(rawPanelId.trim())
        : null;
  return {
    // `id` is a number in every contract, 3.2 through 3.4.4, and the shared
    // `toString` helper returns '' for anything that is not already a string —
    // so the previous `toString(r['id'])` produced an empty id for every row on
    // every version, which the admin table then used as its React key.
    // Stringify the number explicitly.
    id: typeof r['id'] === 'number' && Number.isFinite(r['id']) ? String(r['id']) : toString(r['id']),
    // No supported panel names the owner by a uuid; see the interface note.
    userUuid: null,
    panelUserId,
    userAgent,
    clientType: deriveClientType(userAgent),
    ipAddress: toNullableString(r['requestIp']),
    requestedAt: toString(r['requestAt']),
  };
}

/**
 * One entry of a provider's `billingNodes`. Every supported panel nests the
 * node under `details`: `{ name, details: { nodeUuid, countryCode } | null }`
 * (the 3.3.2 and 3.4.3 specs, and every 3.x contract through 3.4.4). The flat
 * `{ nodeUuid, name, countryCode }` row was 2.7's, and is not read.
 *
 * A row with `details: null` still has a name — it is a billing line
 * whose node is gone — so it is kept with a null uuid rather than dropped,
 * because dropping it would quietly shrink the billed-node count the operator
 * is being asked to reconcile against an invoice.
 */
function mapInfraBillingNode(raw: unknown): RemnawaveInfraBillingNodeInterface {
  const n = (raw ?? {}) as Record<string, unknown>;
  const details = (n['details'] ?? {}) as Record<string, unknown>;
  return {
    nodeUuid: toNullableString(details['nodeUuid']),
    name: toString(n['name']),
    countryCode: toNullableString(details['countryCode']),
  };
}

/**
 * `GET /api/infra-billing/providers` → one provider.
 *
 * Reads only fields every contract from 3.2 through 3.4.4 declares. See
 * {@link RemnawaveInfraProviderInterface} for the four that were being read
 * and exist upstream in none of them, and for why the amount carries no
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
    // `config` is declared nullable with no type in every contract, 3.2 through
    // 3.4.4, so presence is the only honest thing to report about it.
    // `undefined` (key absent) and `null` (key present, empty) both mean "not
    // configured".
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
  // Consumption lives in a nested block in every contract, 3.2 through 3.4.4.
  // The row-level `trafficUsedBytes` this used to read belongs to the node
  // dtos, not to any of the four user lookups that feed this mapper — see the
  // interface note.
  const userTraffic = (r['userTraffic'] ?? {}) as Record<string, unknown>;
  // The row's identity is its numeric `id` — a 3.x user row has no `uuid`
  // field at all. When this read `r['uuid']` through `toString`, which yields
  // `''` for a missing field, every 3.x user came out of here with the SAME
  // empty identity: a React key collision in the search results and an
  // identifier the operator cannot act on. It is carried as its decimal string,
  // the form `Subscription.remnawaveId` holds on 3.x, so the value compares
  // with a stored link without a translation step. A `uuid` key beside it is
  // not read. An id that is not a safe integer yields `''`.
  const identity = typeof r['id'] === 'number' && Number.isSafeInteger(r['id']) ? String(r['id']) : '';
  return {
    uuid: identity,
    /** The panel's numeric id when it has one — what every 3.x route addresses by. */
    panelId: typeof r['id'] === 'number' && Number.isSafeInteger(r['id']) ? r['id'] : null,
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

/**
 * Remnawave 3.x's `customResponseHeaders`: a flat `name -> value` map, or null
 * when the operator set none. Values that are not strings are dropped rather
 * than coerced — a header is a string by definition, and a number here would
 * mean we are reading something else.
 */
function readResponseHeaders(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[name.toLowerCase()] = raw;
  }
  return out;
}

/**
 * Undoes the panel's `rwEncodeBase64:` marker, which it puts on header values
 * that must reach the client base64'd (`profile-title` carries it by default).
 * A value that claims the prefix but does not decode to valid UTF-8 is returned
 * as-is: showing the operator the raw string beats showing them mojibake.
 */
function decodePanelHeaderValue(value: string | null): string | null {
  if (value === null) return null;
  const marker = 'rwEncodeBase64:';
  if (!value.startsWith(marker)) return value;
  const encoded = value.slice(marker.length);
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return decoded.length > 0 ? decoded : value;
  } catch {
    return value;
  }
}

/** True when a panel field carries actual text rather than null / '' / a non-string. */
function hasPanelText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
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
  // Remnawave 3.x removed six top-level fields from this object and moved the
  // same information into `customResponseHeaders`, a free-form header map:
  //
  //   profileTitle               -> "profile-title"          (may be prefixed
  //                                 `rwEncodeBase64:` when the panel wants the
  //                                 value base64'd on the wire)
  //   supportLink                -> "support-url"
  //   profileUpdateInterval      -> "profile-update-interval" (a STRING now)
  //   isProfileWebpageUrlEnabled -> presence of "profile-web-page-url"
  //   happAnnounce / happRouting -> "announce" / "routing"
  //
  // Nothing here throws when a field is missing, so on a 3.x panel the six
  // readouts silently became "", null, 0 and off — a Settings screen that looks
  // configured-but-empty rather than one that reports a problem. The header
  // map is what every supported panel sends, and the only place they are read:
  // the old top-level fields were 2.x's, and a 2.x panel is refused before this
  // read goes out.
  const headers = readResponseHeaders(r['customResponseHeaders']);
  const header = (name: string): string | null => headers[name] ?? null;
  return {
    uuid: toString(r['uuid']),
    profileTitle: toString(decodePanelHeaderValue(header('profile-title'))),
    supportLink: toNullableString(header('support-url')),
    profileUpdateInterval: toNumber(header('profile-update-interval')),
    serveJsonAtBaseSubscription: Boolean(r['serveJsonAtBaseSubscription']),
    isProfileWebpageUrlEnabled: header('profile-web-page-url') !== null,
    isShowCustomRemarks: Boolean(r['isShowCustomRemarks']),
    randomizeHosts: Boolean(r['randomizeHosts']),
    hasHappAnnounce: hasPanelText(header('announce')),
    hasHappRouting: hasPanelText(header('routing')),
    hasResponseRules:
      typeof r['responseRules'] === 'object' && r['responseRules'] !== null,
    hasCustomRemarks:
      typeof r['customRemarks'] === 'object' && r['customRemarks'] !== null,
  };
}
