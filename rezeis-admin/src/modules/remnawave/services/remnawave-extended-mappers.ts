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
    // The identity, under whichever name this panel gives it.
    //
    // 2.7.4 and 2.8.x both send `userUuid` beside a numeric `id` (verified in
    // the vendored contracts — the older comment here claimed 2.8 renamed it to
    // `userId`, and no supported version declares that field on this row). 3.x
    // sends NEITHER uuid form: its row is `{ id, username, devicesCount }` and
    // the identity is the numeric `id`. `userId` is still accepted below in case
    // a build does spell it that way; it costs nothing to read.
    //
    // The 3.x branch has to be here, and it has to render the id as its decimal
    // string, because the ONLY consumer — the HWID-overage detector — looks the
    // row up in a map keyed by what rezeis stored in `remnawaveId`, which on 3.x
    // is exactly that decimal string. Without it every 3.x row mapped to `''`,
    // missed the map, took the `?? 0` limit and was filtered out: the detector
    // returned "nobody is over their device limit" for every panel, and logged
    // nothing on the way.
    // Absence means 3.x; EMPTINESS means a damaged 2.x row. Tested with
    // `in`, not with `??`: 2.7.4 and 2.8.x both send `userUuid` alongside a
    // numeric `id`, so a row whose uuid came back empty would otherwise decode
    // to the id and be silently attributed, when the honest answer is "this row
    // cannot be read". The overage detector then drops it from its join instead
    // of reporting an unreadable row — the same collapse this codebase has
    // fixed twice elsewhere.
    userUuid:
      'userUuid' in r
        ? toString(r['userUuid'])
        : 'userId' in r
          ? toString(r['userId'])
          : 'uuid' in user
            ? toString(user['uuid'])
            : (toNullableIdString(r['id'] ?? user['id']) ?? ''),
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
  // A 3.x row has no `uuid` field at all, and `toString` yields `''` for a
  // missing one — so every 3.x user came out of here with the SAME empty
  // identity. Downstream that is a React key collision in the search results and
  // an identifier the operator cannot act on. The row's own numeric `id` is the
  // identity on that era; it is carried as its decimal string here for the same
  // reason `RemnawavePanelUser.uuid` does — so the value can be compared with a
  // stored `remnawaveId` without a translation step.
  //
  // Keyed on ABSENCE of the field, not on emptiness. A 2.x row whose `uuid`
  // came back as `''` is DAMAGED, and falling through to its numeric id would
  // attribute it anyway — the same collapse `parsePanelUserRow` and
  // `parseStrictUser` refuse. An empty identity is the honest answer there.
  const identity =
    r['uuid'] === undefined
      ? typeof r['id'] === 'number' && Number.isSafeInteger(r['id'])
        ? String(r['id'])
        : ''
      : typeof r['uuid'] === 'string'
        ? r['uuid']
        : '';
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
  // configured-but-empty rather than one that reports a problem. Reading the
  // header map as a fallback is what keeps both shapes honest; the 2.x fields
  // still win when present, so no 2.x behaviour moves.
  const headers = readResponseHeaders(r['customResponseHeaders']);
  const header = (name: string): string | null => headers[name] ?? null;
  return {
    uuid: toString(r['uuid']),
    profileTitle: toString(r['profileTitle'] ?? decodePanelHeaderValue(header('profile-title'))),
    supportLink: toNullableString(r['supportLink'] ?? header('support-url')),
    profileUpdateInterval: toNumber(r['profileUpdateInterval'] ?? header('profile-update-interval')),
    serveJsonAtBaseSubscription: Boolean(r['serveJsonAtBaseSubscription']),
    isProfileWebpageUrlEnabled:
      r['isProfileWebpageUrlEnabled'] === undefined
        ? header('profile-web-page-url') !== null
        : Boolean(r['isProfileWebpageUrlEnabled']),
    isShowCustomRemarks: Boolean(r['isShowCustomRemarks']),
    randomizeHosts: Boolean(r['randomizeHosts']),
    hasHappAnnounce: hasPanelText(r['happAnnounce']) || hasPanelText(header('announce')),
    hasHappRouting: hasPanelText(r['happRouting']) || hasPanelText(header('routing')),
    hasResponseRules:
      typeof r['responseRules'] === 'object' && r['responseRules'] !== null,
    hasCustomRemarks:
      typeof r['customRemarks'] === 'object' && r['customRemarks'] !== null,
  };
}
