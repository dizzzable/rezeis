import { HttpService } from '@nestjs/axios';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

import { remnawaveConfig } from '../../../common/config/remnawave.config';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import {
  asStoredIdentity,
  isNumericPanelIdentity,
  panelDeviceOwnerKey,
  panelUserAddress,
  panelUserPatchKey,
  type PanelUserRef,
} from './panel-user-address';
import { resolvePanelBaseUrl } from './panel-base-url';
import {
  decodePanelAuthStatus,
  decodeSquadOptionList,
  type PanelSquadListKey,
} from './panel-response-decoders';
import { PANEL_ROUTES, PANEL_USER_NOT_FOUND_ERROR_CODES } from './panel-routes';
import {
  addressingForVersion,
  CAPABILITIES_CACHE_TTL_MS,
  CAPABILITIES_NEGATIVE_CACHE_TTL_MS,
  connectionsApiForVersion,
  parseSemver,
  readPanelVersionFrom,
  type PanelEraObservation,
  type RemnawaveConnectionsApi,
  type RemnawaveUserAddressing,
} from './panel-version.util';
import {
  RemnawavePanelExpirySnapshot,
  RemnawaveStrictDevice,
  RemnawaveStrictDeviceList,
  RemnawaveStrictOutcome,
  RemnawaveStrictUser,
  strictInvalidContract,
  strictNotFound,
  strictOk,
  strictUnavailable,
  strictUnsupported,
} from '../interfaces/remnawave-strict-outcome.interface';
import { RemnawaveSquadOptionInterface } from '../interfaces/remnawave-squad-option.interface';
import {
  RemnawaveExternalSquadDetailInterface,
  RemnawaveInternalSquadDetailInterface,
} from '../interfaces/remnawave-squad-detail.interface';
import { RemnawaveStatusInterface } from '../interfaces/remnawave-status.interface';
import {
  RemnawaveBandwidthStatsInterface,
  RemnawaveSystemRecapInterface,
  RemnawaveSystemStatsInterface,
} from '../interfaces/remnawave-system-stats.interface';
import { normalizeBandwidthStats } from './remnawave-bandwidth-stats.normalizer';
import { RemnawaveNodeInterface } from '../interfaces/remnawave-node.interface';
import { RemnawaveHostInterface } from '../interfaces/remnawave-host.interface';
import { RemnawaveHwidStatsInterface } from '../interfaces/remnawave-hwid-stats.interface';
import { RemnawaveConfigProfileInterface } from '../interfaces/remnawave-config-profile.interface';
import {
  RemnawaveHealthInterface,
  RemnawaveHwidTopUserInterface,
  RemnawaveInfraProviderInterface,
  RemnawaveNodePluginInterface,
  RemnawaveSnippetInterface,
  RemnawaveSubpageConfigInterface,
  RemnawaveSubscriptionRequestEntryInterface,
  RemnawaveSubscriptionSettingsInterface,
  RemnawaveSubscriptionTemplateInterface,
  RemnawaveUserResolveQuery,
  RemnawaveUserSummaryInterface,
} from '../interfaces/remnawave-extended.interface';
import { normalizeSystemStats } from './remnawave-system-stats.normalizer';
import {
  mapExternalSquadDetails,
  mapInternalSquadDetails,
} from './remnawave-squad-mappers';
import { mapNode } from './remnawave-node-mapper';
import { mapHost } from './remnawave-host-mapper';
import {
  mapHwidTopUser,
  mapInfraProvider,
  mapNodePlugin,
  mapSnippet,
  mapSubpageConfig,
  mapSubscriptionRequestEntry,
  mapSubscriptionSettings,
  mapSubscriptionTemplate,
  mapUserSummary,
} from './remnawave-extended-mappers';

/**
 * Thrown by `updatePanelUser` when the panel reports the target profile does
 * not exist (HTTP 404). Distinct from the generic `ServiceUnavailableException`
 * (panel down / transient) so the profile-sync UPDATE path can react: a missing
 * profile is re-provisioned (UPDATE → CREATE) instead of being retried forever.
 *
 * This happens for imported subscriptions whose `remnawaveId` came from a donor
 * dump (e.g. STEALTHNET) but whose profile no longer exists in the currently
 * connected panel.
 */
export class RemnawaveProfileNotFoundError extends Error {
  public constructor(public readonly uuid: string) {
    super(`Remnawave profile ${uuid} not found`);
    this.name = 'RemnawaveProfileNotFoundError';
  }
}

/**
 * Thrown when the panel ANSWERED and refused the request on its merits — a
 * contract/auth rejection (400, 401, 403, 409, 422, …) or an endpoint this
 * build does not serve (405/501). Retrying byte-identical bytes cannot change
 * the answer, so this is the terminal counterpart of the transient
 * `ServiceUnavailableException`.
 *
 * Why a distinct type at all: every legacy transport failure used to collapse
 * into `ServiceUnavailableException`, and `ProfileSyncProcessor.classifyRecovery`
 * reads that exception as TRANSIENT. A single malformed field therefore
 * produced a job the 5-minute recovery sweep reset to PENDING forever, with no
 * operator alert and a customer whose subscription never provisioned. Carrying
 * the status out of the transport is what lets the caller tell "the panel is
 * down" from "the panel said no".
 *
 * Extends `HttpException` (502 Bad Gateway) rather than `Error` so the ~20
 * admin endpoints that let this bubble keep answering a 5xx instead of turning
 * an upstream refusal into an unhandled 500. 502 — not 503 — because there is
 * nothing to wait for: a `Retry-After`-shaped answer would be a lie.
 */
export class RemnawaveUpstreamRejectionError extends HttpException {
  public constructor(
    public readonly upstreamStatus: number,
    public readonly upstreamMethod: string,
    public readonly upstreamUrl: string,
  ) {
    super(
      `Remnawave rejected ${upstreamMethod.toUpperCase()} ${upstreamUrl} with HTTP ${upstreamStatus}`,
      HttpStatus.BAD_GATEWAY,
    );
    this.name = 'RemnawaveUpstreamRejectionError';
  }
}

/**
 * The ONE upstream-status taxonomy in this adapter, shared by the strict
 * outcomes ({@link RemnawaveApiService.mapStrictTransport}) and the legacy
 * throwing transport. Two taxonomies would drift, and the drift is precisely
 * the bug: the strict path already called a 400 a terminal rejection while the
 * legacy path called the same 400 "unavailable".
 *
 *  - `notFound`    — 404. Only the callers that own a "the thing is gone"
 *                    semantic (profile PATCH, profile DELETE) act on it; for
 *                    everyone else it stays retryable, because a bare 404 from
 *                    a reverse proxy with no healthy backend is an outage.
 *  - `unsupported` — 405/501. The build does not serve this endpoint.
 *  - `unavailable` — 408/429/5xx. Retryable; a panel restart lands here.
 *  - `rejected`    — every other 4xx. The panel read the request and refused it.
 */
type UpstreamStatusClass = 'notFound' | 'unsupported' | 'unavailable' | 'rejected';

function classifyUpstreamStatus(status: number): UpstreamStatusClass {
  if (status === 404) return 'notFound';
  if (status === 405 || status === 501) return 'unsupported';
  if (status === 408 || status === 429 || status >= 500) return 'unavailable';
  return 'rejected';
}

/**
 * True only when a 404 body is one of Remnawave's own "no such user" envelopes
 * — i.e. the panel itself says the profile is gone. A generic 404 from a
 * proxy/gateway carries no envelope and returns false, so it is treated as a
 * transient outage rather than a missing profile (which would trigger a
 * destructive detach).
 *
 * The panel uses TWO codes, and which one it picks depends on the ENDPOINT, not
 * on the meaning. Measured against a live 2.8.1 and a live 3.2.1, identically
 * on both:
 *
 *   A063  GET /api/users/{id|uuid}, /api/users/by-username/…, /api/users/by-short-uuid/…
 *         message: "User with specified params not found"
 *   A025  everything else — PATCH /api/users, DELETE /api/users/{…},
 *         POST /api/users/resolve, GET /api/hwid/devices/{…},
 *         POST /api/hwid/devices/delete-all, POST /api/connections/by-user/{…}
 *         message: "User not found"
 *
 * Only A025 was recognised here before, and A063's message does NOT contain the
 * substring "user not found" ("User **with specified params** not found"), so
 * the message fallback did not save it either. The consequence was not
 * destructive — an unrecognised 404 degrades to `unavailable`, the safe
 * direction — but it meant the one read that can confirm "this profile is
 * really gone" could never confirm it, and the jobs that wait on that
 * confirmation retried forever. This is a defect on 2.8.x today, not a 3.x
 * regression: `A063` is `GET_USER_BY_UNIQUE_FIELDS_NOT_FOUND` in the vendored
 * `@remnawave/backend-contract@2.7.3`.
 *
 * WHAT THIS PREDICATE MAY BE ASKED, AND WHAT IT MAY NOT. Both codes confirm
 * absence only for a request that named the profile BY ITS OWN IDENTITY (the
 * uuid on 2.x, the numeric id on 3.x) — which is every call site below, because
 * `segmentFor` / `patchKeyFor` resolve an identity BEFORE the request and answer
 * `null` ("cannot act", never "gone") when they cannot. It must NOT be asked of
 * a body produced by an ATTRIBUTE lookup — `/api/users/by-username/…`,
 * `by-short-uuid`, `by-email`, `by-telegram-id`, `POST /api/users/resolve` —
 * because A063 there says "no user carries that attribute RIGHT NOW", which an
 * operator renaming a live profile in the panel satisfies; reading it as "the
 * profile is gone" would retire a running subscription. Those lookups all fail
 * soft to `null` on purpose (`resolvePanelIdentity`, `getPanelUserByUsername`,
 * `readUserSummary`) and none of them consults this function. Keeping it that
 * way is the invariant, not an accident — see the attribute-lookup case in
 * `test/remnawave-user-absence-codes.spec.ts`.
 *
 * THE RECOGNISED SET IS THE PINNED ONE, not a literal restated here. It used to
 * be a second copy, and the copy is exactly what made the guard spec's "rezeis
 * recognises exactly those two" assertion vacuous: that spec pins
 * `PANEL_USER_NOT_FOUND_ERROR_CODES` in `panel-routes.ts`, which no production
 * code read, so deleting `A063` from THIS set left all 336 tests green.
 */
const PANEL_USER_NOT_FOUND_CODES: ReadonlySet<string> = new Set(PANEL_USER_NOT_FOUND_ERROR_CODES);

function isPanelUserNotFound(data: unknown): boolean {
  if (data === null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  const errorCode = record['errorCode'] ?? record['code'];
  if (typeof errorCode === 'string' && PANEL_USER_NOT_FOUND_CODES.has(errorCode)) return true;
  const message = record['message'];
  if (typeof message !== 'string') return false;
  const lower = message.toLowerCase();
  // Both spellings, since the codes and the prose can drift independently.
  return lower.includes('user not found') || lower.includes('user with specified params not found');
}

/**
 * A non-`ok` result of {@link RemnawaveApiService.strictHttp}.
 *
 * `data` is the upstream response BODY, and it is carried this far for one
 * reason: a status alone cannot say who answered. Remnawave's own refusals come
 * with an error envelope; a proxy's do not. Dropping the body here is what left
 * {@link isPanelUserNotFound} unusable on the strict path, so every 404 — the
 * panel's and the gateway's — arrived at the callers as the same `notFound`.
 */
type StrictTransportFailure =
  | {
      readonly kind: 'status';
      readonly status: number;
      readonly retryAfterMs: number | null;
      readonly data: unknown;
      /**
       * The panel refused this request AND a forced version re-read, taken right
       * then, came back with a DIFFERENT addressing than the one the request was
       * built with. See {@link RemnawaveApiService.panelShapeMovedUnderUs}.
       */
      readonly addressingChanged?: boolean;
    }
  | { readonly kind: 'network' };

/**
 * Which era of the panel API this deployment is talking to, as read from the
 * panel itself. `version` is kept alongside the two derived fields so a log line
 * or an error can say WHICH build produced the shape, rather than only that the
 * shape was one of two.
 */
export interface RemnawavePanelShape {
  readonly version: string | null;
  readonly addressing: RemnawaveUserAddressing;
  readonly connectionsApi: RemnawaveConnectionsApi;
  /**
   * Which by-selector user lookups this panel still serves.
   *
   * 2.7.4 and 2.8.x expose `GET /api/users/by-email/{email}` and
   * `/api/users/by-telegram-id/{id}`. 3.x deleted both — measured, not inferred:
   * on a live 3.2.1 they answer `404 Cannot GET`. The replacement is
   * `GET /api/users/stream`, which on 3.2.x (and ONLY on 3.2.x — the 2.8 stream
   * takes `cursor` and `size` and nothing else) accepts `email` and `telegramId`
   * as filters.
   *
   * `false` therefore means "take the stream route", not "this lookup is
   * impossible". An unknown panel reads TRUE here — i.e. on 2.x terms — which is
   * the opposite of how the rest of this file treats "unknown"; the reason for
   * the asymmetry is stated on {@link lookupsForVersion}, which is the function
   * that decides it. (This sentence used to claim the opposite. Both branches
   * here are pure reads, so a wrong guess costs one 404 rather than a wrong
   * answer — but a cleanup driven by the wrong sentence would have flipped it.)
   */
  readonly userLookups: { readonly byTelegramId: boolean; readonly byEmail: boolean };
  /**
   * `GET /api/users/stream` — keyset pagination over the whole-panel user list,
   * present from 2.8 onward (measured on live 2.8.1 and 3.2.1; 2.7.4 has no such
   * route). The offset walk it replaces silently LOSES a row whenever the list
   * shrinks mid-walk, and the arithmetic still reconciles, so the loss is
   * invisible — see {@link RemnawavePanelUserList}.
   *
   * An unknown version reads `false`: the offset route exists on every supported
   * version, so the conservative choice is the one that always answers.
   */
  readonly usersStream: boolean;
}

/**
 * `GET /api/users/stream`, per version. 2.8 and newer, including all of 3.x.
 * Spelled out rather than `major > 2 || (major === 2 && minor >= 8)` collapsed
 * into a range, because an unparseable version has to land on `false`.
 */
function usersStreamFor(version: string | null): boolean {
  const parsed = parseSemver(version);
  if (parsed === null) return false;
  return parsed.major > 2 || (parsed.major === 2 && parsed.minor >= 8);
}

/**
 * The by-selector shortcuts, per major.
 *
 * `major === 2` and nothing else. An UNKNOWN version deliberately reads `true`
 * here, which is the opposite of how the rest of this file treats "unknown" —
 * and the asymmetry is the point. Everywhere else an unknown is dangerous
 * because a guessed identifier addresses somebody; here both branches are pure
 * reads that either find the right user or find nobody. So the tie goes to the
 * route every panel this integration has ever run against actually serves, and a
 * wrong guess costs one 404 rather than a wrong answer.
 */
/**
 * Does the row the panel returned actually answer the question we asked?
 *
 * The filtered `stream` lookup is only safe with this check. `GET /api/users/stream`
 * accepts `email` / `telegramId` on 3.2.x and NOT on 2.8.x, where the query
 * object declares only `cursor` and `size` — an unknown key is stripped, the
 * panel serves the first keyset page, and `users[0]` is an arbitrary customer.
 * Handing that back as "the match" would show an operator somebody else's
 * profile and invite them to act on it. Verifying costs nothing and removes the
 * whole class.
 */
function matchesUserSelector(
  summary: RemnawaveUserSummaryInterface,
  selector: { readonly key: 'email' | 'telegramId'; readonly value: string },
): boolean {
  if (selector.key === 'email') {
    return (
      summary.email !== null &&
      summary.email.trim().toLowerCase() === selector.value.trim().toLowerCase()
    );
  }
  return summary.telegramId !== null && summary.telegramId.trim() === selector.value.trim();
}

function lookupsForVersion(version: string | null): RemnawavePanelShape['userLookups'] {
  const parsed = parseSemver(version);
  const legacy = parsed === null || parsed.major === 2;
  return { byTelegramId: legacy, byEmail: legacy };
}

/**
 * Remnawave panel user — shape returned by the panel API.
 */
export interface RemnawavePanelUser {
  /**
   * The panel's own identity for this row, as a string — the SAME dual meaning
   * `Subscription.remnawaveId` carries, deliberately, so the two can be compared
   * without a translation step:
   *
   *   2.7.4 / 2.8.x  the profile UUID
   *   3.x            the numeric `id` in decimal, because 3.0 removed the uuid
   *                  column from the users table outright
   *
   * The field keeps the name `uuid` because it is a map key in a dozen places
   * (the import overlay, both anti-fraud bridges, the offender fingerprints) and
   * renaming it is a change of its own. It is an identity string, not a UUID —
   * do not validate it as one, and do not show it to an operator as one.
   */
  uuid: string;
  username: string;
  status: string;
  subscriptionUrl: string;
  telegramId: number | null;
  /**
   * The panel's numeric user id. Present on every supported version — 2.x
   * carries it alongside the uuid, 3.x keys everything by it. On 3.x this is the
   * same value as {@link uuid}, parsed.
   */
  panelId: number | null;
  email: string | null;
  expireAt: string;
  /** Authoritative profile creation timestamp used by MONTH_ROLLING resets. */
  createdAt: string;
  /** Most recent panel traffic-reset boundary (nullable on Remnawave 2.7.4). */
  lastTrafficResetAt: string | null;
  trafficLimitBytes: number;
  hwidDeviceLimit: number;
  trafficLimitStrategy: string | null;
  tag: string | null;
  description: string | null;
  activeInternalSquads: Array<{ uuid: string; name: string }>;
  externalSquadUuid: string | null;
}

/**
 * A whole-panel user list, carried together with what the adapter can actually
 * vouch for about it.
 *
 * Only ever produced inside a `strictOk` by
 * {@link RemnawaveApiService.strictGetAllPanelUsers}. What that read PROVES is
 * narrow, and a consumer must not read more into it than this:
 *
 *   • every page it asked for arrived — none was skipped or lost;
 *   • every row that arrived decoded to a usable `uuid` — none was dropped
 *     silently — and, where the panel reported a row count, the decoded rows
 *     matched it;
 *   • `complete` says whether the walk reached the end of the list or stopped
 *     at the page ceiling.
 *
 * What it does NOT prove — ON 2.7.4 — is that these rows are a consistent
 * SNAPSHOT of the panel. There the walk uses `/api/users`, paginated by numeric
 * OFFSET over a list that keeps mutating: delete one user between page 0 and
 * page 1 and every later row shifts one place left, so one live user is never
 * served to us — and the arithmetic still reconciles, because the panel's own
 * `total` fell by exactly the same one. The count check cannot see that; it is
 * self-fulfilling.
 *
 * From 2.8 onward the walk uses `GET /api/users/stream`, which pages by a stable
 * cursor and cannot shift, so the hazard above is gone on those panels. It is
 * NOT gone on 2.7.4 — the route does not exist there — and 2.7.4 is the paying
 * production panel, so nothing downstream may assume otherwise.
 *
 * So a MISS in this list is strong EVIDENCE that the panel no longer has the
 * profile — it is not proof. Anything destructive keyed off a miss (writing
 * EXPIRED, deleting) needs a second signal that does not come from this page
 * walk. The cheap one, deliberately NOT built here: re-read that single profile
 * (`GET /api/users/{id}`) and require a 404 before acting — the same
 * confirmation an incomplete read already forces, just applied to a complete
 * one too.
 */
export interface RemnawavePanelUserList {
  readonly users: readonly RemnawavePanelUser[];
  /**
   * The panel's own row count when it reported a usable one, else the decoded
   * row count — the same fallback the device-list readers use, so a build that
   * reports `total` differently degrades this number instead of the whole read.
   */
  readonly total: number;
  /**
   * `false` when the walk stopped at the page ceiling. `users` is then a valid
   * PREFIX of the panel rather than the whole of it, so a miss carries no
   * information at all until it is confirmed one uuid at a time.
   */
  readonly complete: boolean;
}

/** One page of the whole-panel subscription-request log. */
export interface RemnawaveSubscriptionRequestPage {
  /** Newest-first, as the panel orders them. */
  readonly records: readonly RemnawaveSubscriptionRequestEntryInterface[];
  /** The panel's own count of the ENTIRE log, not of this page. */
  readonly total: number;
  /** The `size` that was asked for — `records.length < requestedSize` proves the log is exhausted. */
  readonly requestedSize: number;
}

/**
 * The `records` array out of a subscription-request-history response.
 *
 * Both supported specs wrap it as `{ response: { records, total } }`. The bare
 * array and the `response.records`-less shapes are tolerated only because this
 * feeds the best-effort UI reader; the strict reader refuses anything that is
 * not the documented envelope instead.
 */
function readSubscriptionRequestRecords(response: unknown): readonly unknown[] {
  const root = (response as { response?: unknown })?.response ?? response;
  if (Array.isArray(root)) return root;
  const records = (root as { records?: unknown })?.records;
  return Array.isArray(records) ? records : [];
}

/**
 * How many rows to ask `POST /api/bandwidth-stats/nodes/users` for.
 *
 * `topUsersLimit` is a REQUIRED query parameter on 2.8.0 ("Limit of top users
 * to return", `type: number`, no maximum) and optional on 3.2.1 (`minimum: 1`,
 * `default: 100`). Omitting it 400s every 2.8.0 request.
 *
 * The value is sized from how `detectPerUserNodeTrafficAbuse` consumes the
 * list, not from the 3.2.1 default. That detector derives its baseline FROM
 * the returned rows: it takes the cohort `median` and the `sum` of the list,
 * then flags a user at `total >= median * medianMultiplier` (default 4×) or at
 * `>= sharePercent` (default 35%) of the sum. Because the panel returns the
 * TOP N by traffic, a small N truncates the light tail — which is exactly the
 * part that makes the median a baseline. Ask for 100 on a panel with thousands
 * of users and the median is computed over heavy users only, so it lands near
 * the offender's own magnitude, `total >= median * 4` stops being satisfiable,
 * and a genuine offender is silently dropped from the result. (Truncation cuts
 * the other threshold the opposite way — a smaller `sum` inflates every
 * `sharePercent` — so a short list does not merely lose signal, it makes both
 * configured thresholds mean something other than what the operator set.)
 *
 * 25 000 is the repo's own upper bound on "the whole panel": the full-panel
 * walk in `strictGetAllPanelUsers` pages 500 rows × 50 pages and treats
 * reaching that as bigger than any expected deployment. Sized this way the
 * returned list is the whole population with traffic on the selected nodes
 * rather than a top slice, so the median is a real baseline and no offender
 * can fall off the end. Rows are `{username, total}`, so even a full response
 * is ~1 MB on a 5-minute cron.
 */
export const NODE_USERS_BANDWIDTH_TOP_LIMIT = 25_000;

export function buildNodeUsersBandwidthPath(now = new Date()): string {
  const end = now.toISOString().slice(0, 10);
  const startDate = new Date(now);
  startDate.setUTCDate(startDate.getUTCDate() - 1);
  const start = startDate.toISOString().slice(0, 10);
  return (
    `/api/bandwidth-stats/nodes/users?start=${start}&end=${end}` +
    `&topUsersLimit=${NODE_USERS_BANDWIDTH_TOP_LIMIT}`
  );
}

/**
 * WHAT A PANEL 3.3.2 USER ROW CONTAINS, per the vendor's own OpenAPI document
 * for that exact build (`icon/Remnawave API v3.3.2.json`, `UserResponseDto`).
 * All 24 are declared REQUIRED there; none of them is `uuid`.
 *
 * This list is the single source of truth for BOTH the runtime drift detector
 * below and `test/remnawave-user-row-era-conformance.spec.ts`, which pins it
 * against the vendor SDK (`@remnawave/contract-v34` → 3.4.2) and against the
 * OpenAPI document itself. Sharing the constant is deliberate: if the test and
 * the detector each kept their own copy, the detector would eventually report
 * drift that was only our own staleness, and the operator would learn to ignore
 * it — which is the failure mode this whole mechanism exists to prevent.
 */
export const PANEL_USER_SPEC_REQUIRED_KEYS_3X: readonly string[] = [
  'activeInternalSquads',
  'createdAt',
  'description',
  'email',
  'expireAt',
  'externalSquadUuid',
  'hwidDeviceLimit',
  'id',
  'lastTrafficResetAt',
  'lastTriggeredThreshold',
  'shortUuid',
  'ssPassword',
  'status',
  'subRevokedAt',
  'subscriptionUrl',
  'tag',
  'telegramId',
  'trafficLimitBytes',
  'trafficLimitStrategy',
  'trojanPassword',
  'updatedAt',
  'userTraffic',
  'username',
  'vlessUuid',
];

/**
 * Fields the decoder RECOGNISES that panel 3.x does not declare.
 *
 *   uuid         the 2.x identity spelling. Remnawave 3.0 dropped the column
 *                outright, but our own database still stores uuids recorded in
 *                that era, and rows carrying one must keep decoding until the
 *                reconciliation sweep reports zero stranded rows in production.
 *                Seeing `uuid` on a row is therefore NOT drift.
 *   telegram_id  the snake_case spelling {@link parsePanelUserRow} accepts as a
 *                fallback when `telegramId` is absent or not a number.
 */
export const PANEL_USER_LEGACY_ROW_KEYS: readonly string[] = ['uuid', 'telegram_id'];

/** Every key the decoder knows about, from either era. */
export const PANEL_USER_KNOWN_ROW_KEYS: readonly string[] = [
  ...PANEL_USER_SPEC_REQUIRED_KEYS_3X,
  ...PANEL_USER_LEGACY_ROW_KEYS,
];

/** One panel row whose key set does not match what we know about. */
export interface PanelUserShapeDrift {
  /** Keys the panel sent that no era of our decoder recognises. */
  readonly unknownFields: readonly string[];
  /** Keys panel 3.3.2 declares REQUIRED that this row did not carry. */
  readonly missingFields: readonly string[];
  /**
   * Stable identity of this drift. Every row of a drifted panel produces the
   * SAME signature, which is what lets the reporter emit one operator-visible
   * event per distinct drift instead of one per row.
   */
  readonly signature: string;
}

/**
 * Compares one raw panel row's key set against what we know, in BOTH directions.
 *
 * WHY THIS EXISTS AND WHY IT ONLY REPORTS. The defect this file is scarred by
 * was not a wrong decision — it was a panel that changed shape in production
 * and a codebase that could not tell. CI was green throughout, because CI only
 * ever sees the shapes we thought to write down. A conformance test catches
 * drift when WE bump a pin; this catches it when the OPERATOR upgrades a panel.
 *
 * It DETECTS, it does NOT reject. A panel patch release that adds a field is a
 * routine, harmless event, and a decoder that refused unknown keys would turn
 * it into a total outage — trading a silent defect for a loud one is not an
 * improvement when the loud one takes the product down. So this returns a
 * description and changes nothing about what {@link parsePanelUserRow} returns.
 *
 * Returns `null` for a row that matches exactly, which is the common case and
 * costs one `Object.keys` and two membership scans over ~26 strings.
 */
export function describePanelUserShapeDrift(candidate: object): PanelUserShapeDrift | null {
  const present = Object.keys(candidate);
  const unknownFields: string[] = [];
  for (const key of present) {
    if (!PANEL_USER_KNOWN_ROW_KEYS.includes(key)) unknownFields.push(key);
  }
  const missingFields: string[] = [];
  for (const key of PANEL_USER_SPEC_REQUIRED_KEYS_3X) {
    if (!present.includes(key)) missingFields.push(key);
  }
  if (unknownFields.length === 0 && missingFields.length === 0) return null;
  // Sorted, so that a panel which merely reorders its JSON keys does not mint a
  // second signature for the same drift and defeat the deduplication.
  const sortedUnknown = [...unknownFields].sort();
  const sortedMissing = [...missingFields].sort();
  return {
    unknownFields: sortedUnknown,
    missingFields: sortedMissing,
    signature: `unknown=${sortedUnknown.join(',')}|missing=${sortedMissing.join(',')}`,
  };
}

/**
 * Decodes one `/api/users` row into a {@link RemnawavePanelUser}.
 *
 * Returns `null` for a row we cannot key — the identity is the row's handle
 * everywhere downstream (`Subscription.remnawaveId`, the sharing-detector
 * fingerprint, the overlay map key), and an empty one collapses every such
 * row onto a single bucket. Callers MUST NOT quietly shorten a list by the
 * nulls: {@link strictGetAllPanelUsers} counts them and refuses instead.
 *
 * WHICH FIELD IS THE IDENTITY depends on the panel era, and the row itself
 * says which: 2.x rows carry `uuid`, 3.x rows have no such field and are keyed
 * by the numeric `id`. Reading the row rather than asking `getPanelShape()`
 * keeps this decoder synchronous and — more importantly — correct even when
 * version detection is momentarily unavailable, because a row that HAS a uuid
 * came from a panel that uses them.
 *
 * Before this, a 3.x row decoded to `null` for want of a `uuid`, and
 * `strictGetAllPanelUsers` escalated a page of them to "none carried a usable
 * uuid" — a whole-read refusal. Safe, but it took the bulk list, the import
 * overlay and both anti-fraud bridges dark at once.
 *
 * MODULE-LEVEL, NOT A METHOD, because the WRITE path needs it too. It reads
 * nothing off `this`, and `unwrapPanelUser` — the create/update response
 * decoder — is a module function that used to cast instead of decode. Lifting
 * this one out is what lets both directions share a single answer to "which
 * field is the identity on this row".
 */
function parsePanelUserRow(
  candidate: unknown,
  onShapeDrift?: (drift: PanelUserShapeDrift) => void,
): RemnawavePanelUser | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  // Observed BEFORE decoding and independently of whether decoding succeeds: a
  // row we cannot key is exactly the row whose shape an operator most needs to
  // see. Deliberately NOT wrapped in a try/catch — the comparison is a pure key
  // scan that cannot throw, and a swallow here would make "the detector broke"
  // indistinguishable from "the panel matches", which is the same blindness
  // this mechanism was added to remove.
  if (onShapeDrift !== undefined) {
    const drift = describePanelUserShapeDrift(candidate);
    if (drift !== null) onShapeDrift(drift);
  }
  const value = candidate as Record<string, unknown>;
  const panelId =
    typeof value.id === 'number' && Number.isSafeInteger(value.id) ? value.id : null;
  // The test is ABSENCE of the field, not emptiness of it, and the difference
  // matters:
  //   • no `uuid` key at all  → a 3.x row. Key it by the numeric id.
  //   • `uuid` present but unusable (empty, wrong type) → a 2.x row that
  //     arrived damaged. It must stay UNDECODABLE. Keying it by its numeric id
  //     would mint a key that matches no `remnawaveId` stored from that era,
  //     quietly turning "we could not read this row" into "this user is
  //     unknown to us" — and the callers that act on absence would act.
  const uuid =
    value.uuid === undefined
      ? panelId !== null
        ? String(panelId)
        : ''
      : typeof value.uuid === 'string'
        ? value.uuid
        : '';
  if (uuid.length === 0) return null;
  return {
    uuid,
    username: typeof value.username === 'string' ? value.username : '',
    status: typeof value.status === 'string' ? value.status : 'UNKNOWN',
    subscriptionUrl: typeof value.subscriptionUrl === 'string' ? value.subscriptionUrl : '',
    telegramId:
      typeof value.telegramId === 'number'
        ? value.telegramId
        : typeof value.telegram_id === 'number'
          ? (value.telegram_id as number)
          : null,
    panelId,
    email: typeof value.email === 'string' ? value.email : null,
    expireAt:
      typeof value.expireAt === 'string'
        ? value.expireAt
        : value.expireAt instanceof Date
          ? value.expireAt.toISOString()
          : '',
    createdAt:
      typeof value.createdAt === 'string'
        ? value.createdAt
        : value.createdAt instanceof Date
          ? value.createdAt.toISOString()
          : '',
    lastTrafficResetAt:
      typeof value.lastTrafficResetAt === 'string'
        ? value.lastTrafficResetAt
        : value.lastTrafficResetAt instanceof Date
          ? value.lastTrafficResetAt.toISOString()
          : null,
    trafficLimitBytes:
      typeof value.trafficLimitBytes === 'number' ? value.trafficLimitBytes : 0,
    hwidDeviceLimit:
      typeof value.hwidDeviceLimit === 'number' ? value.hwidDeviceLimit : 0,
    trafficLimitStrategy:
      typeof value.trafficLimitStrategy === 'string'
        ? value.trafficLimitStrategy
        : null,
    tag: typeof value.tag === 'string' ? value.tag : null,
    description: typeof value.description === 'string' ? value.description : null,
    activeInternalSquads: Array.isArray(value.activeInternalSquads)
      ? (value.activeInternalSquads as Array<{ uuid: string; name: string }>).filter(
          (squad) => typeof squad?.uuid === 'string' && typeof squad?.name === 'string',
        )
      : [],
    externalSquadUuid:
      typeof value.externalSquadUuid === 'string' ? value.externalSquadUuid : null,
  };
}

/**
 * Decodes the body of a create/update user write into a {@link RemnawavePanelUser}.
 *
 * A DECODER, NOT A CAST — and that distinction is the whole defect. The panel
 * wraps the user object under `response`; unwrapping that envelope and then
 * ASSERTING the inner object into the type is what this used to do, and on a
 * 3.x panel it handed back an object whose `uuid` was `undefined` while its
 * type said `string`. `persistProfileLink` wrote that `undefined` into
 * `remnawaveId`, Prisma reads `undefined` as "leave this column alone", and the
 * sync job COMPLETED having recorded no link at all: the profile existed on the
 * panel, `remnawave_id` stayed NULL forever, and nothing retried because
 * nothing had failed. Every READING path already went through
 * {@link parsePanelUserRow}, which keys a 3.x row by its numeric `id` precisely
 * because 3.x rows carry no `uuid` at all. Only the write path did not.
 *
 * THROWS rather than returning a half-decoded object. A 2xx whose body cannot
 * be keyed is a contract problem, and the caller's very next act is to persist
 * an identity — so "we could not read the answer" has to arrive there as a
 * failure, not as an object full of `undefined`. The error is deliberately
 * plain and unclassified, which `ProfileSyncProcessor.classifyRecovery` reads
 * as TERMINAL: the same bytes will not decode on the next attempt either, and
 * TERMINAL is the outcome that alerts an operator instead of being reset to
 * PENDING every five minutes in silence.
 */
function unwrapPanelUser(
  raw: unknown,
  route: string,
  onShapeDrift?: (drift: PanelUserShapeDrift) => void,
): RemnawavePanelUser {
  const root = (raw as { response?: unknown } | null)?.response ?? raw;
  const user = parsePanelUserRow(root, onShapeDrift);
  if (user === null) {
    throw new Error(
      `Remnawave ${route} answered with a user body carrying no usable identity ` +
        '(neither a 2.x `uuid` nor a numeric 3.x `id`); refusing to record a profile link from it',
    );
  }
  return user;
}

export interface RemnawaveHwidDevice {
  hwid: string;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

/**
 * A user's HWID device list as the UI renders it — full display projection,
 * unlike the saga's {@link RemnawaveStrictDeviceList} (hwid + createdAt only).
 */
export interface RemnawaveHwidDeviceList {
  readonly devices: readonly RemnawaveHwidDevice[];
  readonly total: number;
}

/** Per-user bandwidth row from `bandwidth-stats/nodes/users` (2.8+). */
export interface RemnawaveNodeUserBandwidth {
  readonly username: string;
  readonly total: number;
}

/**
 * Normalises a raw Remnawave HWID device row into `RemnawaveHwidDevice`.
 *
 * Remnawave 2.7.x returns
 *   `{ hwid, userUuid, platform, osVersion, deviceModel, userAgent,
 *      createdAt, updatedAt }`
 * — note `updatedAt` (last activity), not `lastSeenAt`. We map it to
 * `lastSeenAt` so the cabinet's "last seen" label keeps working, and tolerate
 * either field name across versions.
 */
function mapHwidDevice(raw: unknown): RemnawaveHwidDevice {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;
  return {
    hwid: str(r['hwid']) ?? '',
    platform: str(r['platform']),
    osVersion: str(r['osVersion']),
    deviceModel: str(r['deviceModel']),
    userAgent: str(r['userAgent']),
    createdAt: str(r['createdAt']) ?? '',
    lastSeenAt: str(r['lastSeenAt']) ?? str(r['updatedAt']),
  };
}

// ── ip-control (active sessions / source IPs) ──────────────────────────────

/** A single source IP a user was seen connecting from, with its last activity. */
export interface RemnawaveIpSample {
  ip: string;
  lastSeen: string;
}

/** Online users + their source IPs on a single node (fetch-users-ips result). */
export interface RemnawaveNodeUserIps {
  userId: string;
  ips: RemnawaveIpSample[];
}

/** Per-node IP breakdown for a single user (fetch-ips result). */
export interface RemnawaveUserNodeIps {
  nodeUuid: string;
  nodeName: string;
  countryCode: string | null;
  ips: RemnawaveIpSample[];
}

/** Discriminated input for `drop-connections` mirroring `DropConnectionsRequestDto`. */
export type RemnawaveDropConnectionsInput = {
  dropBy:
    | { by: 'userUuids'; userUuids: string[] }
    | { by: 'ipAddresses'; ipAddresses: string[] };
  targetNodes:
    | { target: 'allNodes' }
    | { target: 'specificNodes'; nodeUuids: string[] };
};

function mapIpSamples(raw: unknown): RemnawaveIpSample[] {
  if (!Array.isArray(raw)) return [];
  const out: RemnawaveIpSample[] = [];
  for (const entry of raw) {
    const r = (entry ?? {}) as Record<string, unknown>;
    const ip = typeof r['ip'] === 'string' ? r['ip'] : null;
    const lastSeen = typeof r['lastSeen'] === 'string' ? r['lastSeen'] : null;
    if (ip !== null && lastSeen !== null) out.push({ ip, lastSeen });
  }
  return out;
}

function mapNodeUsersIps(result: unknown): RemnawaveNodeUserIps[] {
  const users = (result as { users?: unknown } | null)?.users;
  if (!Array.isArray(users)) return [];
  const out: RemnawaveNodeUserIps[] = [];
  for (const entry of users) {
    const r = (entry ?? {}) as Record<string, unknown>;
    // 2.x sends the panel's numeric user id as a STRING here; 3.x sends it as a
    // number. Accepting only the string quietly dropped every row on 3.x — an
    // empty snapshot, which the sharing detector reads as "nobody online" and
    // never as "we could not read this". Both spellings are the same value.
    const raw = r['userId'];
    const userId =
      typeof raw === 'string' && raw.length > 0
        ? raw
        : typeof raw === 'number' && Number.isSafeInteger(raw)
          ? String(raw)
          : null;
    if (userId === null) continue;
    out.push({ userId, ips: mapIpSamples(r['ips']) });
  }
  return out;
}

function mapUserNodeIps(result: unknown): RemnawaveUserNodeIps[] {
  const nodes = (result as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: RemnawaveUserNodeIps[] = [];
  for (const entry of nodes) {
    const r = (entry ?? {}) as Record<string, unknown>;
    out.push({
      nodeUuid: typeof r['nodeUuid'] === 'string' ? r['nodeUuid'] : '',
      nodeName: typeof r['nodeName'] === 'string' ? r['nodeName'] : '',
      countryCode: typeof r['countryCode'] === 'string' ? r['countryCode'] : null,
      ips: mapIpSamples(r['ips']),
    });
  }
  return out;
}

/**
 * Parses a `Retry-After` header (seconds or HTTP-date) into milliseconds.
 * Returns `null` when absent or unparseable.
 */
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isUpstreamTag(value: string): boolean {
  return value.length <= 16 && /^[A-Z0-9_]+$/.test(value);
}

function isUpstreamTrafficLimitStrategy(value: string): boolean {
  return ['NO_RESET', 'DAY', 'WEEK', 'MONTH', 'MONTH_ROLLING'].includes(value);
}

function validateStrictUserWrite(desired: {
  readonly tag?: string | null;
  readonly trafficLimitStrategy?: string | null;
  readonly activeInternalSquads?: readonly string[];
  readonly externalSquadUuid?: string | null;
}): string | null {
  if (desired.tag !== undefined && desired.tag !== null && !isUpstreamTag(desired.tag)) {
    return 'tag is not upstream-compatible';
  }
  if (
    desired.trafficLimitStrategy !== undefined &&
    desired.trafficLimitStrategy !== null &&
    !isUpstreamTrafficLimitStrategy(desired.trafficLimitStrategy)
  ) {
    return 'trafficLimitStrategy is not upstream-compatible';
  }
  if (desired.activeInternalSquads !== undefined && !desired.activeInternalSquads.every(isUuid)) {
    return 'activeInternalSquads must contain UUIDs';
  }
  if (
    desired.externalSquadUuid !== undefined &&
    desired.externalSquadUuid !== null &&
    !isUuid(desired.externalSquadUuid)
  ) {
    return 'externalSquadUuid must be a UUID or null';
  }
  return null;
}

function parseRetryAfterMs(headers: unknown): number | null {
  if (headers === null || typeof headers !== 'object') return null;
  const raw = (headers as Record<string, unknown>)['retry-after'];
  const value = typeof raw === 'string' ? raw : Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : null;
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

@Injectable()
export class RemnawaveApiService {
  private readonly logger = new Logger(RemnawaveApiService.name);

  /**
   * Latch for the base-URL warning. `getBaseUrl()` runs on every single request,
   * and the condition it warns about is a static configuration fact — so it is
   * said once and then shut up about, rather than a thousand times an hour.
   */
  private baseUrlWarningIssued = false;

  public constructor(
    private readonly httpService: HttpService,
    @Inject(remnawaveConfig.KEY)
    private readonly configuration: ConfigType<typeof remnawaveConfig>,
    // OPTIONAL on purpose. `SystemEventsModule` is @Global so the running app
    // always supplies it, but ~a dozen specs construct this adapter directly
    // with two arguments, and a drift REPORTER that made the adapter
    // unconstructable would be a poor trade for a diagnostic.
    @Optional()
    private readonly systemEvents?: SystemEventsService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  //  PANEL USER ROW SHAPE DRIFT (detect and report — never reject)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * One entry per distinct drift signature seen since the process started.
   *
   * WHY THIS IS BOUNDED AND WHY THAT MATTERS. The detector runs on EVERY decoded
   * row, and `strictGetAllPanelUsers` walks the entire panel — 5000 rows on a
   * real deployment. A drifted panel produces the same signature on every one of
   * those rows, so without a gate the operator's event feed would receive 5000
   * identical events at precisely the moment it needs to be readable. The feed
   * going unusable when it matters most is the same class of failure as the feed
   * being silent, so this is part of the mechanism, not an optimisation.
   */
  private readonly shapeDriftSeen = new Map<
    string,
    { lastReportedAt: number; suppressed: number }
  >();

  /** One operator-visible event per distinct signature per hour. */
  private static readonly SHAPE_DRIFT_REPEAT_MS = 60 * 60 * 1000;

  /**
   * Ceiling on DISTINCT signatures tracked at once. Realistically a panel emits
   * one shape, so this is never approached; it exists so that a panel returning
   * garbage of ever-changing shape cannot grow this map without limit.
   */
  private static readonly SHAPE_DRIFT_MAX_SIGNATURES = 64;

  /**
   * Reports one row's shape drift, at most once per signature per hour.
   *
   * An arrow property rather than a method because it is handed to
   * {@link parsePanelUserRow} as a callback and must keep its `this`.
   */
  /**
   * Which panel era this adapter believes it is talking to, read from the SHAPE
   * CACHE rather than probed.
   *
   * SYNCHRONOUS ON PURPOSE. The detector runs inside the row decoder, which is
   * sync and must stay sync; awaiting `getPanelShape()` here would put a network
   * read in the middle of decoding 5000 rows. The cache is populated by the
   * ordinary request path, so by the time any row is decoded it is warm.
   *
   * `unknown` is a real, expected answer and is NOT treated as a problem — the
   * version read fails for the same reasons requests fail, and this is a
   * diagnostic, not a gate. It is reported as-is so an operator can tell "2.x
   * panel drifted" from "3.x panel drifted" from "we could not tell".
   */
  private detectedPanelEra(): string {
    const cached = this.panelShapeCache?.value;
    if (cached === undefined) return 'unprobed';
    if (cached.version === null) return 'unknown';
    const parsed = parseSemver(cached.version);
    return parsed === null ? 'unknown' : `${parsed.major}.x`;
  }

  private readonly reportPanelUserShapeDrift = (drift: PanelUserShapeDrift): void => {
    const now = Date.now();
    // The era is part of the identity of a drift. rezeis ships to deployments on
    // 2.x panels and to deployments on 3.x panels; the SAME missing field means
    // different things on each, and two operators reporting it must not produce
    // indistinguishable events.
    const signature = `era=${this.detectedPanelEra()}|${drift.signature}`;
    const seen = this.shapeDriftSeen.get(signature);
    if (seen !== undefined) {
      if (now - seen.lastReportedAt < RemnawaveApiService.SHAPE_DRIFT_REPEAT_MS) {
        seen.suppressed += 1;
        return;
      }
      this.emitPanelUserShapeDrift(drift, signature, seen.suppressed);
      seen.lastReportedAt = now;
      seen.suppressed = 0;
      return;
    }
    if (this.shapeDriftSeen.size >= RemnawaveApiService.SHAPE_DRIFT_MAX_SIGNATURES) {
      // Evict the least recently reported so the map stays bounded. Reached only
      // by a panel emitting 64+ distinct shapes, which is itself the story.
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.shapeDriftSeen) {
        if (entry.lastReportedAt < oldestAt) {
          oldestAt = entry.lastReportedAt;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) this.shapeDriftSeen.delete(oldestKey);
    }
    this.shapeDriftSeen.set(signature, { lastReportedAt: now, suppressed: 0 });
    this.emitPanelUserShapeDrift(drift, signature, 0);
  };

  private emitPanelUserShapeDrift(
    drift: PanelUserShapeDrift,
    signature: string,
    suppressed: number,
  ): void {
    const parts: string[] = [];
    if (drift.unknownFields.length > 0) {
      parts.push(`${drift.unknownFields.length} unrecognised field(s): ${drift.unknownFields.join(', ')}`);
    }
    if (drift.missingFields.length > 0) {
      parts.push(`${drift.missingFields.length} declared field(s) absent: ${drift.missingFields.join(', ')}`);
    }
    const era = this.detectedPanelEra();
    const message = `Remnawave user row shape drift on a ${era} panel — ${parts.join('; ')}`;
    this.logger.warn(message);
    // A log line alone is not enough. The whole lesson of the identity defect is
    // that silence in the logs is indistinguishable from health, so this has to
    // reach the surface an operator actually watches.
    this.systemEvents?.warn(EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC, 'SYSTEM', message, {
      unknownFields: drift.unknownFields,
      missingFields: drift.missingFields,
      // Which era the panel was detected as, and the exact build string it
      // reported. Without these, an operator on 2.8 and an operator on 3.3
      // filing the same drift are indistinguishable in the feed.
      panelEra: era,
      panelVersion: this.panelShapeCache?.value.version ?? null,
      signature,
      // How many further rows carried this same drift while the signal was
      // deduplicated — so "one event" never reads as "one row".
      suppressedSinceLastReport: suppressed,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PANEL SHAPE (which era of the API are we talking to?)
  // ═══════════════════════════════════════════════════════════════════════════

  private panelShapeCache: {
    readonly value: RemnawavePanelShape;
    readonly at: number;
    readonly ttlMs: number;
  } | null = null;

  /**
   * Which era of the panel API this deployment is pointed at.
   *
   * WHY THE ADAPTER OWNS THIS RATHER THAN ASKING `RemnawaveVersionService`: that
   * service is constructed WITH this one, so injecting it back would be a
   * dependency cycle — and this is the layer that builds paths, so it is the
   * layer that has to know. The two caches are independent by design; they cost
   * one extra `GET /api/system/stats/recap` per five minutes and share both the
   * TTL discipline and the source ORDER through `panel-version.util`, so they
   * cannot drift on the answer, only on the moment they refresh it.
   *
   * A failed read yields `'unknown'` on both fields and is cached for the SHORT
   * window. `'unknown'` is not a default to fall back on: every caller refuses
   * rather than guessing, because a guessed identifier addresses somebody.
   */
  public async getPanelShape(force = false): Promise<RemnawavePanelShape> {
    const now = Date.now();
    if (!force && this.panelShapeCache !== null && now - this.panelShapeCache.at < this.panelShapeCache.ttlMs) {
      return this.panelShapeCache.value;
    }
    // Latched for the duration of the version read, not just around the
    // re-probe: the read goes out over the same transport as everything else, so
    // a panel that refuses IT would otherwise ask "has the version moved?" and
    // answer by reading the version again. See `panelShapeMovedUnderUs`.
    this.shapeReprobeInFlight = true;
    let version: string | null;
    try {
      version = await readPanelVersionFrom(
        () => this.getSystemRecap(),
        () => this.getSystemMetadata(),
        (source, error) => this.logger.debug(`${source} version read failed: ${error.message}`),
      );
    } finally {
      this.shapeReprobeInFlight = false;
    }
    const value: RemnawavePanelShape = {
      version,
      addressing: addressingForVersion(version),
      connectionsApi: connectionsApiForVersion(version),
      userLookups: lookupsForVersion(version),
      usersStream: usersStreamFor(version),
    };
    this.panelShapeCache = {
      value,
      at: now,
      ttlMs: version === null ? CAPABILITIES_NEGATIVE_CACHE_TTL_MS : CAPABILITIES_CACHE_TTL_MS,
    };
    return value;
  }

  /** How often a refusal may force a version re-read. */
  private static readonly SHAPE_REPROBE_MIN_INTERVAL_MS = CAPABILITIES_NEGATIVE_CACHE_TTL_MS;

  /**
   * How long after a CONFIRMED shape change every refusal keeps counting as one
   * built with the old shape.
   *
   * Only requests already in flight, or built in the same tick, can still carry
   * it — everything issued after the re-read uses the new one — so this is
   * measured in seconds, not in cache windows.
   */
  private static readonly SHAPE_CHANGE_GRACE_MS = CAPABILITIES_NEGATIVE_CACHE_TTL_MS * 2;

  private shapeReprobeAt = 0;
  private shapeChangedAt = 0;
  private shapeReprobeInFlight = false;

  /**
   * "Did the panel change era underneath this request?" — asked when, and only
   * when, the panel has just REFUSED one.
   *
   * THE HOLE THIS CLOSES. The shape is cached for five minutes, and every
   * user-scoped path is built from it. During an operator's 2.x → 3.x upgrade
   * there is therefore a window in which every request is addressed the old way
   * and the panel answers `400 expected number, received NaN`. A 400 is a
   * terminal refusal by {@link classifyUpstreamStatus} — correctly, for its
   * usual causes — so `ProfileSyncProcessor.classifyRecovery` marked those jobs
   * TERMINAL and the recovery sweep never touched them again. The upgrade was
   * over in a minute; the dead jobs were permanent, and each one is a customer
   * whose subscription silently stopped syncing.
   *
   * Re-reading the version is only half a fix — the job that already failed is
   * still terminal. So the answer here also decides the CLASS of that failure:
   * a refusal whose addressing has provably moved is retryable, because the next
   * attempt is built differently. Provably is the operative word. This does not
   * guess from the status or from the error text; it re-reads the panel's own
   * version and compares. A refusal on the merits — a bad body, a rejected
   * status value, a bad token — re-reads the SAME addressing and stays terminal,
   * so the forever-retry-with-no-alert hole the taxonomy was built to close
   * stays closed.
   *
   * Cost when nothing has moved: one `GET /api/system/stats/recap`, at most once
   * per {@link SHAPE_REPROBE_MIN_INTERVAL_MS}, and only after a request has
   * already failed. The re-entrancy latch matters as much as the interval: the
   * version read goes through this same transport, so without it a panel
   * refusing the recap itself would re-probe forever.
   */
  private async panelShapeMovedUnderUs(): Promise<boolean> {
    const now = Date.now();
    // A change confirmed moments ago still explains this refusal: the requests
    // that were in flight when it flipped all carry the old shape.
    if (now - this.shapeChangedAt < RemnawaveApiService.SHAPE_CHANGE_GRACE_MS) return true;
    if (this.shapeReprobeInFlight) return false;
    if (now - this.shapeReprobeAt < RemnawaveApiService.SHAPE_REPROBE_MIN_INTERVAL_MS) return false;
    // Nothing cached means nothing was built from a stale shape — the very first
    // request cannot have been addressed the old way.
    const before = this.panelShapeCache?.value ?? null;
    if (before === null) return false;
    this.shapeReprobeAt = now;
    const after = await this.getPanelShape(true);
    // `'unknown'` is not an era, it is a failed read — and version detection
    // fails for exactly the reasons a request fails: a revoked token, a dead
    // upstream. Accepting it as "the addressing moved" would turn every 401
    // after a token revocation into a retryable failure, which is the
    // forever-retry-with-no-alert hole reopened from the other side. Only a
    // KNOWN era that differs from the one we addressed with counts.
    if (after.addressing === 'unknown' || after.addressing === before.addressing) return false;
    this.shapeChangedAt = Date.now();
    this.logger.warn(
      `Remnawave: the panel changed era under us — addressing was '${before.addressing}' ` +
        `(version ${before.version ?? 'unknown'}), is now '${after.addressing}' ` +
        `(version ${after.version ?? 'unknown'}). Requests refused while the old shape was ` +
        'cached are retryable, not terminal.',
    );
    return true;
  }

  /**
   * {@link panelShapeMovedUnderUs}, asked only for the statuses that a stale
   * shape can actually produce: a refused request (`400 expected number,
   * received NaN`) or a route this era does not serve (`connections/*` replaced
   * `ip-control/*` on 3.x). A 404, a timeout and a 5xx are already retryable and
   * do not need the question asked.
   */
  private async shapeMovedFor(err: unknown): Promise<boolean> {
    if (!isAxiosError(err) || err.response === undefined) return false;
    const statusClass = classifyUpstreamStatus(err.response.status);
    if (statusClass !== 'rejected' && statusClass !== 'unsupported') return false;
    return this.panelShapeMovedUnderUs();
  }

  /**
   * Turns what we stored about a profile into the path segment this panel wants,
   * performing the one extra round-trip when the stored identity is from the
   * other era.
   *
   * The resolve step exists for exactly one situation: a profile created on 2.x
   * whose panel has since been upgraded to 3.x, and which nothing has touched
   * since — so no numeric id was ever recorded, and the panel's own migration
   * dropped the uuid without preserving it anywhere. `POST /api/users/resolve`
   * by the stored username is the only way back, and it exists on every
   * supported version (2.7.3's contract declares it too).
   *
   * Returns `null` when the profile cannot be named on this panel at all.
   * Callers must treat that as "cannot act", never as "the profile is gone".
   *
   * `era` IS THE CALLER'S ALREADY-TAKEN OBSERVATION, and passing one is how a
   * guarded path proves the era it decided on is the era the address is built
   * from. Omitting it keeps the old behaviour — this method reads the shape for
   * itself — which is correct for the reads and the non-destructive writes that
   * have nothing to agree with. The DESTRUCTIVE methods below do not offer that
   * choice: they require an observation, so it is not possible to build a
   * deletion address from a second, independent reading of the era.
   */
  public async resolvePanelSegment(
    ref: PanelUserRef,
    era?: PanelEraObservation,
  ): Promise<{ readonly segment: string; readonly panelId: number | null } | null> {
    const identity = asStoredIdentity(ref);
    const { addressing } = era ?? (await this.getPanelShape());
    const address = panelUserAddress(identity, addressing);
    if (address.kind === 'ready') {
      return {
        segment: address.segment,
        panelId: isNumericPanelIdentity(address.segment) ? Number.parseInt(address.segment, 10) : null,
      };
    }
    if (address.kind === 'impossible') {
      this.logger.warn(`Remnawave: cannot address panel profile — ${address.reason}`);
      return null;
    }
    const resolved = await this.resolvePanelIdentity(address.selector);
    if (resolved === null) {
      const selectorLabel = 'username' in address.selector
        ? `username "${address.selector.username}"`
        : `shortUuid "${address.selector.shortUuid}"`;
      this.logger.warn(
        `Remnawave: profile "${identity.remnawaveId}" could not be resolved by ${selectorLabel} on this panel`,
      );
      return null;
    }
    return {
      segment: addressing === 'id' ? String(resolved.id) : (resolved.uuid ?? String(resolved.id)),
      panelId: resolved.id,
    };
  }

  /**
   * The path segment for a user-scoped route, or `null` when this profile
   * cannot be named on this panel.
   *
   * `null` means "cannot act" and NEVER "the profile is gone". Every caller has
   * to keep those apart: one leaves a job to retry, the other detaches a live
   * subscription. The refusal is logged here once, with the operation name, so
   * an operator reading the log can see which feature went quiet and why.
   */
  private async segmentFor(
    ref: PanelUserRef,
    operation: string,
    era?: PanelEraObservation,
  ): Promise<string | null> {
    const resolved = await this.resolvePanelSegment(ref, era);
    if (resolved === null) {
      const identity = asStoredIdentity(ref);
      this.logger.warn(
        `Remnawave ${operation}: profile "${identity.remnawaveId}" cannot be addressed on this ` +
          'panel version — treating as unavailable, NOT as missing',
      );
      return null;
    }
    return resolved.segment;
  }

  private async patchKeyFor(
    ref: PanelUserRef,
  ): Promise<{ readonly uuid: string } | { readonly id: number } | { readonly username: string } | null> {
    const identity = asStoredIdentity(ref);
    const { addressing } = await this.getPanelShape();
    const key = panelUserPatchKey(identity, addressing);
    if (key !== null) return key;

    const address = panelUserAddress(identity, addressing);
    if (address.kind !== 'needsResolve' || !('shortUuid' in address.selector)) return null;
    const resolved = await this.resolvePanelIdentity(address.selector);
    if (resolved === null) {
      this.logger.warn(
        `Remnawave PATCH /api/users: profile "${identity.remnawaveId}" could not be resolved by shortUuid "${address.selector.shortUuid}"`,
      );
      return null;
    }
    return { id: resolved.id };
  }

  /**
   * `POST /api/users/resolve` — maps any ONE of id / shortUuid / username onto
   * the others. Present on 2.7.x, 2.8.x and 3.2.x alike; 2.x additionally
   * returns the uuid, 3.x has none to return.
   *
   * The panel refuses a body carrying more than one key ("Exactly one of id,
   * shortUuid, or username must be provided"), so this takes exactly one.
   */
  public async resolvePanelIdentity(
    selector:
      | { readonly id: number }
      | { readonly shortUuid: string }
      | { readonly username: string },
  ): Promise<{
    readonly id: number;
    readonly shortUuid: string | null;
    readonly username: string | null;
    readonly uuid: string | null;
  } | null> {
    try {
      const raw = await this.requestJsonWithBody<unknown>('post', PANEL_ROUTES.resolveUser, selector);
      const root = (raw as { response?: unknown })?.response ?? raw;
      if (root === null || typeof root !== 'object') return null;
      const record = root as Record<string, unknown>;
      const id = record['id'];
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
      return {
        id,
        shortUuid: typeof record['shortUuid'] === 'string' ? record['shortUuid'] : null,
        username: typeof record['username'] === 'string' ? record['username'] : null,
        uuid: typeof record['uuid'] === 'string' ? record['uuid'] : null,
      };
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  USER CRUD (Remnawave Panel)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Creates a user on the Remnawave panel.
   * Donor: `remnawave_sync_crud.create_user`.
   */
  public async createPanelUser(input: {
    username: string;
    telegramId: number | null;
    email: string | null;
    description: string;
    tag: string | null;
    expireAt: string; // ISO datetime
    trafficLimitBytes: number;
    hwidDeviceLimit: number;
    trafficLimitStrategy: string | null;
    activeInternalSquads: string[];
    externalSquadUuid: string | null;
  }): Promise<RemnawavePanelUser> {
    const raw = await this.requestJsonWithBody<unknown>('post', '/api/users', {
      username: input.username,
      telegramId: input.telegramId,
      email: input.email,
      description: input.description,
      tag: input.tag,
      expireAt: input.expireAt,
      trafficLimitBytes: input.trafficLimitBytes,
      hwidDeviceLimit: input.hwidDeviceLimit,
      // `trafficLimitStrategy` is OPTIONAL and NEVER nullable on 2.7.4 and
      // 2.8.0 alike (`{"type":"string","enum":[...],"default":"NO_RESET"}`), so
      // an explicit `null` is a validation failure, not "use the default".
      // Callers legitimately have no opinion — a plan snapshot without the key
      // (every 3x-ui import) reads as `null` — and for them the field must be
      // absent so the panel applies its own default.
      ...(input.trafficLimitStrategy !== null && input.trafficLimitStrategy !== undefined
        ? { trafficLimitStrategy: input.trafficLimitStrategy }
        : {}),
      activeInternalSquads: input.activeInternalSquads,
      externalSquadUuid: input.externalSquadUuid,
    });
    return unwrapPanelUser(raw, 'POST /api/users', this.reportPanelUserShapeDrift);
  }

  /**
   * Updates a user on the Remnawave panel.
   * Donor: `remnawave_sync_crud.updated_user`.
   */
  public async updatePanelUser(
    ref: PanelUserRef,
    input: {
      status?: string;
      telegramId?: number | null;
      email?: string | null;
      description?: string;
      tag?: string | null;
      expireAt?: string;
      trafficLimitBytes?: number;
      hwidDeviceLimit?: number;
      trafficLimitStrategy?: string | null;
      activeInternalSquads?: string[];
      externalSquadUuid?: string | null;
    },
  ): Promise<RemnawavePanelUser> {
    // Remnawave 2.7.x contract: PATCH /api/users (no UUID in URL!) — the
    // UUID lives in the request body. Field names are camelCase, not the
    // snake_case shape we used pre-v0.3.5; sending snake_case results in
    // a 200 OK with the description applied but every other field
    // silently ignored, which is why writeBackReiwaId silently no-op'd
    // for every imported user.
    //
    // 3.x keeps the identifier in the body too, but names it `id` and wants the
    // number. `panelUserPatchKey` picks the key this panel accepts — including
    // the `username` fallback, which every supported version honours and which
    // is the only key that works when version detection is down.
    const identity = asStoredIdentity(ref);
    const key = await this.patchKeyFor(identity);
    if (key === null) {
      // NOT a silent return: the caller advances an applied revision on success,
      // so a quiet no-op would record limits the panel never received.
      throw new ServiceUnavailableException('Remnawave profile cannot be addressed on this panel');
    }
    const body: Record<string, unknown> = { ...key };
    if (input.status !== undefined) body['status'] = input.status;
    if (input.telegramId !== undefined) body['telegramId'] = input.telegramId;
    if (input.email !== undefined) body['email'] = input.email;
    if (input.description !== undefined) body['description'] = input.description;
    if (input.tag !== undefined) body['tag'] = input.tag;
    if (input.expireAt !== undefined) body['expireAt'] = input.expireAt;
    if (input.trafficLimitBytes !== undefined) body['trafficLimitBytes'] = input.trafficLimitBytes;
    if (input.hwidDeviceLimit !== undefined) body['hwidDeviceLimit'] = input.hwidDeviceLimit;
    // Never nullable upstream (see `createPanelUser`). On a PATCH, omitting it
    // means "leave the panel's current strategy alone" — which is exactly what
    // a caller with no opinion wants, and the only encoding the panel accepts.
    if (input.trafficLimitStrategy !== undefined && input.trafficLimitStrategy !== null) {
      body['trafficLimitStrategy'] = input.trafficLimitStrategy;
    }
    if (input.activeInternalSquads !== undefined) body['activeInternalSquads'] = input.activeInternalSquads;
    if (input.externalSquadUuid !== undefined) body['externalSquadUuid'] = input.externalSquadUuid;

    // Distinguish "profile does not exist" (404) from "panel unavailable"
    // (transient). A generic `requestJsonWithBody` masks every failure as
    // ServiceUnavailableException, which would make the sync job retry a
    // permanently-missing profile forever. Surfacing 404 as a typed error lets
    // the UPDATE handler re-provision the profile (UPDATE → CREATE). Same
    // transport shape as `deletePanelUser` for its own 404 handling.
    const baseUrl = this.getBaseUrl();
    const token = this.configuration.token;
    if (baseUrl === null || token === null) {
      throw new ServiceUnavailableException('Remnawave integration is not configured');
    }
    let raw: unknown;
    try {
      const response = await firstValueFrom(
        this.httpService.request<unknown>({
          method: 'patch',
          url: '/api/users',
          baseURL: baseUrl,
          data: body,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-forwarded-for': '127.0.0.1',
            'x-forwarded-proto': 'https',
          },
        }),
      );
      raw = response.data;
    } catch (err: unknown) {
      // Only a 404 that carries Remnawave's own USER_NOT_FOUND envelope (code
      // A025 / "User not found") means the profile is genuinely gone. A bare 404
      // from a reverse proxy / gateway during a deploy, a wrong host, or an
      // upstream with no healthy backends must NOT be read as "profile missing"
      // — otherwise a host outage would mass-detach valid remnawaveIds. Those
      // fall through to ServiceUnavailableException and retry harmlessly.
      if (isAxiosError(err) && err.response?.status === 404 && isPanelUserNotFound(err.response.data)) {
        // The STORED id, not the key we happened to address by: the caller's
        // re-provision writes `where: { remnawaveId: <this> }`, and a username
        // fallback here would make that WHERE match nothing.
        this.logger.warn(
          `Remnawave PATCH /api/users: profile ${identity.remnawaveId} not found (404 A025/A063)`,
        );
        throw new RemnawaveProfileNotFoundError(identity.remnawaveId);
      }
      this.logger.error(`Remnawave PATCH /api/users failed: ${(err as Error).message}`);
      // A 400 here is a rejected body (a status the panel does not accept, a
      // field it does not allow), not an outage — see `upstreamFailure`. Unless
      // the panel changed era while this body was being built, in which case the
      // rejected field is the KEY and the next attempt will send the other one.
      throw this.upstreamFailure(err, 'patch', '/api/users', await this.shapeMovedFor(err));
    }
    // DECODED OUTSIDE THE CATCH, deliberately. Inside it, the "body carries no
    // identity" error would be swallowed by the transport handler above and
    // re-thrown as `upstreamFailure` — a ServiceUnavailableException, which
    // `classifyRecovery` calls TRANSIENT — and would additionally fire a version
    // re-probe (`shapeMovedFor`) for a panel that answered perfectly well. The
    // transport succeeded; only our reading of it failed, and the two must not
    // be reported as the same thing.
    return unwrapPanelUser(raw, 'PATCH /api/users', this.reportPanelUserShapeDrift);
  }

  /**
   * Deletes a user from the Remnawave panel.
   *
   * A `404` from the panel means the profile is already gone — which is
   * exactly the post-condition cleanup wants — so it is mapped to
   * `{ isDeleted: true }` instead of bubbling up as an error that would make
   * the `DELETE` sync job loop forever (the profile can never be re-found).
   * Any other upstream failure throws so BullMQ retries. See
   * `.kiro/specs/trial-aware-profile-cleanup`.
   *
   * `era` IS REQUIRED, AND THAT IS THE POINT. Every caller of this method is
   * guarded by `assessObservedPanelLink`, and the guard's answer is only worth
   * anything if the address is built from the SAME reading of the panel era —
   * `getPanelShape()` is cached for fifteen seconds on a failure, so two
   * adjacent reads can legitimately disagree, and the disagreement that matters
   * runs "guard saw `'unknown'`, so proceed" straight into "builder saw `'id'`,
   * so fall back through `panelId` to whatever is live at that address". Taking
   * the observation as an argument makes it impossible to write that call: the
   * era cannot be re-read here, and a caller cannot produce one without going
   * through `observePanelEra`.
   */
  public async deletePanelUser(
    ref: PanelUserRef,
    era: PanelEraObservation,
  ): Promise<{ isDeleted: boolean }> {
    const baseUrl = this.getBaseUrl();
    const token = this.configuration.token;
    if (baseUrl === null || token === null) {
      throw new ServiceUnavailableException('Remnawave integration is not configured');
    }
    const segment = await this.segmentFor(ref, 'DELETE user', era);
    if (segment === null) {
      // NOT `{isDeleted: true}`. The caller writes status DELETED and clears the
      // profile link on a true, so answering true here would detach a live
      // subscription from a profile that is still running.
      throw new ServiceUnavailableException('Remnawave profile cannot be addressed on this panel');
    }
    const url = PANEL_ROUTES.deleteUser(segment);
    try {
      const response = await firstValueFrom(
        // 3.x answers `204 No Content` with an EMPTY body where 2.x answered
        // `200 {"response":{"isDeleted":true}}`. The type below therefore
        // describes 2.x only, and the `?? true` fallback is what carries 3.x:
        // axios gives `''` for a 204, both optional chains yield undefined, and
        // a 2xx from this route means the profile is gone either way.
        this.httpService.request<
          { response?: { isDeleted?: boolean }; isDeleted?: boolean } | '' | undefined
        >({
          method: 'delete',
          url,
          baseURL: baseUrl,
          headers: {
            Authorization: `Bearer ${token}`,
            'x-forwarded-for': '127.0.0.1',
            'x-forwarded-proto': 'https',
          },
        }),
      );
      const data = response.data;
      const body = typeof data === 'object' && data !== null ? data : undefined;
      const isDeleted = body?.response?.isDeleted ?? body?.isDeleted ?? true;
      return { isDeleted };
    } catch (err: unknown) {
      // Only a 404 the PANEL sent may mean "already gone". A bare 404 carries no
      // USER_NOT_FOUND envelope and is what a reverse proxy answers to every
      // request while it has no healthy backend — and the caller acts on
      // `isDeleted: true` by writing status DELETED and clearing the profile
      // link, so reading a proxy outage that way detaches every subscription
      // whose DELETE job happens to run during it. Same rule as
      // `mapStrictProfileTransport`, which exists three functions down for
      // exactly this reason; this path had been left behind.
      if (isAxiosError(err) && err.response?.status === 404) {
        if (isPanelUserNotFound(err.response.data)) {
          this.logger.warn(
            `Remnawave profile ${segment} already absent (404 A025/A063) — treating delete as success`,
          );
          return { isDeleted: true };
        }
        this.logger.warn(
          `Remnawave DELETE ${url}: a bare 404 with no USER_NOT_FOUND envelope is a gateway answer, ` +
            'not a missing profile — retrying rather than detaching the subscription',
        );
      }
      this.logger.error(`Remnawave DELETE ${url} failed: ${(err as Error).message}`);
      throw this.upstreamFailure(err, 'delete', url, await this.shapeMovedFor(err));
    }
  }

  /**
   * Resets traffic counter for a user on the panel.
   */
  public async resetPanelUserTraffic(ref: PanelUserRef): Promise<void> {
    const segment = await this.segmentFor(ref, 'reset traffic');
    if (segment === null) {
      // Throwing rather than returning quietly: callers of this one treat a
      // silent return as "the counter was zeroed", and it was not.
      throw new ServiceUnavailableException('Remnawave profile cannot be addressed on this panel');
    }
    await this.requestJson({ method: 'post', url: PANEL_ROUTES.resetUserTraffic(segment) });
  }

  /**
   * Gets a user by UUID from the panel.
   *
   * Tolerates both the modern Remnawave shape `{ response: {...} }` and
   * the older flat layout. Falls through to `null` on any upstream error
   * so the caller can render a graceful placeholder rather than crash.
   */
  public async getPanelUser(ref: PanelUserRef): Promise<RemnawavePanelUser | null> {
    // The catch stays even though `getPanelUserOutcome` is written not to
    // throw. This method's contract — relied on by every card render — is
    // "never throws, worst case null", and a hot read path is the wrong place
    // to discover that some layer below acquired a throw.
    try {
      const outcome = await this.getPanelUserOutcome(ref);
      return outcome.kind === 'ok' ? outcome.user : null;
    } catch {
      return null;
    }
  }

  /**
   * The same read as {@link getPanelUser}, keeping apart the two answers it
   * collapses.
   *
   * `getPanelUser` returns `null` for a missing profile, an outage, an expired
   * token, a 5xx, a timeout and an unconfigured integration alike. That is fine
   * for a card that renders a placeholder, and wrong for anything that reports
   * the result to a human: the manual link-repair endpoint told an operator
   * "profile was not found" — i.e. "your identifier is wrong" — whenever the
   * panel merely happened to be down, which is exactly when someone is most
   * likely to be repairing a link.
   *
   * `missing` is reserved for a 404 the PANEL sent, carrying its own
   * USER_NOT_FOUND envelope. A bare 404 is what a reverse proxy answers to
   * everything while it has no healthy backend, so it maps to `unavailable`.
   * Same rule as {@link mapStrictProfileTransport}, reused rather than restated.
   *
   * The BODY parsing stays tolerant — `parsePanelUserRow`, not the strict
   * decoder. The strict one fails closed on nine fields, which is right for the
   * device-reduction saga and wrong here: a profile that exists but is missing a
   * `tag` must still be linkable, not turned into an incident.
   */
  public async getPanelUserOutcome(
    ref: PanelUserRef,
  ): Promise<
    | { readonly kind: 'ok'; readonly user: RemnawavePanelUser }
    | { readonly kind: 'missing' }
    | { readonly kind: 'unavailable' }
  > {
    const segment = await this.segmentFor(ref, 'GET user');
    // Unaddressable is NOT missing. The profile may be perfectly alive on a
    // panel whose era we cannot name it in.
    if (segment === null) return { kind: 'unavailable' };
    const transport = await this.strictHttp('get', PANEL_ROUTES.user(segment));
    if (transport.kind !== 'ok') {
      const mapped = this.mapStrictProfileTransport<never>(transport);
      return mapped.kind === 'notFound' ? { kind: 'missing' } : { kind: 'unavailable' };
    }
    const root = (transport.data as { response?: unknown })?.response ?? transport.data;
    if (root === null || typeof root !== 'object') return { kind: 'unavailable' };
    // Through the row decoder, not a bare cast: a 3.x row has no `uuid`, and
    // the cast used to hand callers an object whose `uuid` was `undefined`
    // while its type said `string`.
    const user = parsePanelUserRow(root, this.reportPanelUserShapeDrift);
    // A 200 whose body we cannot decode is a contract problem, not a missing
    // profile. Answering `missing` here would let a shape change read as
    // "every profile disappeared".
    return user === null ? { kind: 'unavailable' } : { kind: 'ok', user };
  }

  /**
   * Looks up a panel user by username. Returns `null` when not found
   * (404) or on any upstream error. Used by the profile-sync CREATE path
   * for idempotency: if a previous attempt already created the profile
   * (but failed to persist the link, or the row was reset), we reuse the
   * existing profile instead of trying to create a duplicate — which the
   * panel rejects with `400 "username already exists"`.
   */
  public async getPanelUserByUsername(username: string): Promise<RemnawavePanelUser | null> {
    try {
      const result = await this.requestJson<unknown>({
        method: 'get',
        url: PANEL_ROUTES.userByUsername(username),
      });
      const root = (result as { response?: unknown })?.response ?? result;
      if (root === null || typeof root !== 'object') return null;
      // Decoded through the same row decoder as the bulk list, rather than a
      // local `typeof record['uuid'] === 'string'` gate. That gate rejected
      // EVERY 3.x row — 3.x rows have no `uuid` — and this method is the CREATE
      // path's idempotency check, so on a 3.x panel it answered "no such
      // profile" for a profile that exists and the sync would try to create a
      // duplicate, which the panel refuses with `400 username already exists`.
      // A stuck create loop, from one field name.
      return parsePanelUserRow(root, this.reportPanelUserShapeDrift);
    } catch {
      return null;
    }
  }

  /**
   * Single-call fetch of the panel profile's display username AND used
   * traffic (bytes). The subscription card needs both — the human-readable
   * profile name (e.g. `rz_login_sub`) to display instead of the raw UUID,
   * and the usage counter for the progress bar. Doing it in one
   * `GET /api/users/{uuid}` avoids a second round-trip per card.
   *
   * Returns `null` when the panel is unreachable or the profile is missing,
   * so callers fall back to the local data (UUID hidden, bar hidden).
   */
  public async getPanelUserUsage(
    ref: PanelUserRef,
  ): Promise<{
    username: string | null;
    usedTrafficBytes: number | null;
    status: string | null;
    expireAt: string | null;
    trafficLimitBytes: number | null;
    hwidDeviceLimit: number | null;
  } | null> {
    const segment = await this.segmentFor(ref, 'GET user usage');
    if (segment === null) return null;
    try {
      const result = await this.requestJson<unknown>({ method: 'get', url: PANEL_ROUTES.user(segment) });
      const root = (result as { response?: unknown })?.response ?? result;
      if (root === null || typeof root !== 'object') return null;
      const record = root as Record<string, unknown>;

      const username =
        typeof record['username'] === 'string' && record['username'].length > 0
          ? (record['username'] as string)
          : null;

      let usedTrafficBytes: number | null = null;
      const nested = record['userTraffic'];
      if (nested !== null && typeof nested === 'object') {
        usedTrafficBytes = this.coerceTrafficNumber(
          (nested as Record<string, unknown>)['usedTrafficBytes'],
        );
      }
      if (usedTrafficBytes === null) {
        usedTrafficBytes =
          this.coerceTrafficNumber(record['usedTrafficBytes']) ??
          this.coerceTrafficNumber(record['trafficUsedBytes']);
      }

      // Authoritative runtime state for read-time overlay (so manual panel
      // edits surface in the bot + cabinet without waiting for a webhook).
      const status =
        typeof record['status'] === 'string' && record['status'].length > 0
          ? (record['status'] as string)
          : null;
      const expireAt =
        typeof record['expireAt'] === 'string' && record['expireAt'].length > 0
          ? (record['expireAt'] as string)
          : null;
      const trafficLimitBytes = this.coerceTrafficNumber(record['trafficLimitBytes']);
      const hwidDeviceLimit =
        typeof record['hwidDeviceLimit'] === 'number' && Number.isFinite(record['hwidDeviceLimit'])
          ? (record['hwidDeviceLimit'] as number)
          : null;

      return { username, usedTrafficBytes, status, expireAt, trafficLimitBytes, hwidDeviceLimit };
    } catch {
      return null;
    }
  }

  private coerceTrafficNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  /**
   * Gets the HWID devices bound to a user's panel profile, for DISPLAY (the
   * customer cabinet and the admin user panel).
   *
   * Returns a normalized outcome rather than a list, because the two answers
   * this endpoint can give — "the panel says this profile has no devices" and
   * "the panel did not answer" — are opposite facts for a reader whose next
   * action is "so I have free slots". The previous best-effort version
   * collapsed both into `{ devices: [], total: 0 }`; a customer whose slots
   * were full then saw "0 devices" during an outage, tried to add another, and
   * the panel refused with nothing on our side to explain it. Callers MUST
   * branch on the kind (see `requirePanelDeviceList`) — a caller that renders
   * a non-`ok` outcome as an empty list has re-created that bug.
   *
   * Distinct from {@link strictListUserDevices}, which serves the device
   * reduction saga: that one returns the minimal `{ hwid, createdAt }`
   * projection and FAILS CLOSED on a row it cannot fully validate (a plan must
   * never be built on an inconsistent list). This one keeps the whole display
   * projection and tolerates thin rows — a device missing a `deviceModel` must
   * still be listed and revocable, not turn the whole panel into an incident.
   *
   * Wire contract (identical on 2.7.4 and 2.8.0, verified against both specs):
   * `GET /api/hwid/devices/{userUuid}` → `{ response: { total, devices: [...] } }`.
   * The 2.8.0 row adds `requestIp` and renames `userUuid`→`userId`; neither is
   * read here (the user is addressed by URL UUID, never by a row field).
   */
  public async strictGetPanelUserDevices(
    ref: PanelUserRef,
  ): Promise<RemnawaveStrictOutcome<RemnawaveHwidDeviceList>> {
    const segment = await this.segmentFor(ref, 'list devices');
    if (segment === null) return strictUnavailable();
    const transport = await this.strictHttp('get', PANEL_ROUTES.userHwidDevices(segment));
    if (transport.kind !== 'ok') return this.mapStrictTransport(transport);

    // Remnawave wraps payloads in `{ response: ... }`. Unwrap it (every other
    // call here does) — without this `devices`/`total` were read off the
    // envelope and came back undefined.
    const root = (transport.data as { response?: unknown })?.response ?? transport.data;
    if (root === null || typeof root !== 'object') {
      return strictInvalidContract('device list envelope is not an object');
    }
    const record = root as { devices?: unknown; total?: unknown };
    if (!Array.isArray(record.devices)) {
      // Not an empty list: a payload with no `devices` array is a payload we
      // did not understand, and "we did not understand it" must not render as
      // "you have no devices".
      return strictInvalidContract('device list "devices" is not an array');
    }
    const devices = record.devices.map((d) => mapHwidDevice(d));
    return strictOk(
      {
        devices,
        // `total` is read DEFENSIVELY, like every other `total` in this file:
        // the rows are the payload, the count is a cross-check the panel may
        // omit. Failing the read over a missing count would blank a list we
        // hold in full.
        total: typeof record.total === 'number' ? record.total : devices.length,
      },
      this.readEnvelopeVersion(transport.data),
    );
  }

  /**
   * Deletes a specific HWID device from a user.
   *
   * Remnawave 2.7.x contract: `POST /api/hwid/devices/delete` with a JSON
   * body `{ userUuid, hwid }` — NOT a `DELETE` verb and NOT the old
   * `/api/hwid/user` path (both 404 now). Returns `{ total }` (remaining
   * device count) inside the usual `{ response: ... }` envelope.
   *
   * `era` IS REQUIRED for the reason {@link deletePanelUser} states, and this
   * method had the defect TWICE OVER: it read the shape for the body's owner
   * key and `segmentFor` read it again for the path, so even the owner key and
   * the segment inside one request were built from two readings. One
   * observation now serves the guard, the key and the segment alike.
   *
   * Different verb, same address mechanism, same loss: on an unrepaired
   * duplicate pair the fallback resolves the stale row's identity to the LIVE
   * customer, and this revokes a device they are using.
   */
  public async deletePanelUserDevice(
    ref: PanelUserRef,
    hwid: string,
    era: PanelEraObservation,
  ): Promise<{ total: number }> {
    const { addressing } = era;
    const segment = await this.segmentFor(ref, 'delete device', era);
    if (segment === null) {
      throw new ServiceUnavailableException('Remnawave profile cannot be addressed on this panel');
    }
    // The owner key is `userUuid` on 2.x and `userId` (a NUMBER) on 3.x.
    const result = await this.requestJsonWithBody<unknown>('post', PANEL_ROUTES.deleteHwidDevice, {
      ...panelDeviceOwnerKey(segment, addressing),
      hwid,
    });
    const root = (result as { response?: unknown })?.response ?? result;
    const record = (root ?? {}) as { total?: number; devices?: unknown };
    return {
      total:
        typeof record.total === 'number'
          ? record.total
          : Array.isArray(record.devices)
            ? record.devices.length
            : 0,
    };
  }

  /**
   * Deletes ALL HWID devices bound to a user's Remnawave profile.
   *
   * Remnawave 2.7.x contract: `POST /api/hwid/devices/delete-all` with body
   * `{ userUuid }`. Returns `{ total }` (should be 0) in the `{ response }`
   * envelope. Used when regenerating a subscription so stale clients can't
   * keep a slot.
   *
   * `era` IS REQUIRED for the reason {@link deletePanelUser} states, and this
   * method carried the same double read as its single-device sibling.
   */
  public async deleteAllPanelUserDevices(
    ref: PanelUserRef,
    era: PanelEraObservation,
  ): Promise<{ total: number }> {
    const { addressing } = era;
    const segment = await this.segmentFor(ref, 'delete all devices', era);
    if (segment === null) {
      throw new ServiceUnavailableException('Remnawave profile cannot be addressed on this panel');
    }
    const result = await this.requestJsonWithBody<unknown>(
      'post',
      PANEL_ROUTES.deleteAllHwidDevices,
      panelDeviceOwnerKey(segment, addressing),
    );
    const root = (result as { response?: unknown })?.response ?? result;
    const record = (root ?? {}) as { total?: number; devices?: unknown };
    return {
      total:
        typeof record.total === 'number'
          ? record.total
          : Array.isArray(record.devices)
            ? record.devices.length
            : 0,
    };
  }

  /**
   * Regenerates (revokes) a user's subscription link on the panel — the old
   * short UUID is invalidated and a brand-new subscription URL is issued, so
   * every previously-distributed link stops working.
   *
   * Remnawave 2.7.x contract: `POST /api/users/{uuid}/actions/revoke`. Passing
   * no body (or an empty one) rotates the short UUID; the response carries the
   * fresh `subscriptionUrl`. Returns the new URL (or `null` if the panel
   * omitted it).
   *
   * `era` IS REQUIRED, for the reason {@link deletePanelUser} states and with
   * more at stake here than on any of the three deletions. This call is
   * DESTRUCTIVE and its effect is IRREVERSIBLE: the panel discards the old
   * short uuid, so every client link already in the customer's hands dies the
   * instant it returns and no later call can put the old value back.
   *
   * It used to read the shape for itself inside {@link segmentFor}, one await
   * after its caller's guard had read it — and the fifteen-second negative
   * cache ({@link CAPABILITIES_NEGATIVE_CACHE_TTL_MS}) lets two such reads
   * legitimately disagree, so "the guard saw `'unknown'`, therefore proceed"
   * ran straight into "the builder saw `'id'`, therefore fall back through
   * `panelId` — or the short uuid, or the username — to whatever is live at
   * that address", and rotated a paying customer's link. Taking the observation
   * as an argument makes that call impossible to write.
   */
  public async regeneratePanelUserSubscription(
    ref: PanelUserRef,
    era: PanelEraObservation,
  ): Promise<{ subscriptionUrl: string | null }> {
    const segment = await this.segmentFor(ref, 'revoke subscription', era);
    if (segment === null) {
      throw new ServiceUnavailableException('Remnawave profile cannot be addressed on this panel');
    }
    const result = await this.requestJsonWithBody<unknown>(
      'post',
      PANEL_ROUTES.revokeUserSubscription(segment),
      {},
    );
    const root = (result as { response?: unknown })?.response ?? result;
    const record = (root ?? {}) as { subscriptionUrl?: unknown };
    return {
      subscriptionUrl:
        typeof record.subscriptionUrl === 'string' && record.subscriptionUrl.length > 0
          ? record.subscriptionUrl
          : null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SYSTEM STATS, NODES, HOSTS (panel proxy)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns system-wide statistics from the Remnawave panel.
   *
   * Normalises two upstream shape quirks observed on real panels:
   *   • `onlineStats` may live next to `users` (newer Remnawave) instead
   *     of nested under `users` — we always nest it under `users` for
   *     consumers.
   *   • `nodes.totalBytesLifetime` is sometimes serialized as a string
   *     because it can exceed Number.MAX_SAFE_INTEGER — we cast it
   *     defensively so the typed contract stays `number`.
   */
  public async getSystemStats(): Promise<RemnawaveSystemStatsInterface | null> {
    try {
      const response = await this.requestJson<{ response: unknown }>({
        method: 'get',
        url: '/api/system/stats',
      });
      const raw = (response as { response?: unknown })?.response ?? response;
      return normalizeSystemStats(raw);
    } catch {
      return null;
    }
  }

  /**
   * Returns system recap (version, totals, this month).
   */
  public async getSystemRecap(): Promise<RemnawaveSystemRecapInterface | null> {
    try {
      const response = await this.requestJson<{ response: RemnawaveSystemRecapInterface }>({
        method: 'get',
        url: '/api/system/stats/recap',
      });
      return response.response ?? (response as unknown as RemnawaveSystemRecapInterface);
    } catch {
      return null;
    }
  }

  /**
   * Returns bandwidth comparison stats.
   */
  public async getBandwidthStats(): Promise<RemnawaveBandwidthStatsInterface | null> {
    try {
      const response = await this.requestJson<{ response: unknown }>({
        method: 'get',
        url: '/api/system/stats/bandwidth',
      });
      return normalizeBandwidthStats(response.response ?? response);
    } catch {
      return null;
    }
  }

  /**
   * Returns all nodes from the panel.
   *
   * Tolerates both `{ response: [...] }` and `{ response: { total, nodes } }`
   * shapes seen across Remnawave versions.
   */
  public async getAllNodes(): Promise<RemnawaveNodeInterface[]> {
    try {
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: '/api/nodes',
      });
      const root = (response as { response?: unknown })?.response ?? response;
      const list = Array.isArray(root)
        ? root
        : Array.isArray((root as { nodes?: unknown })?.nodes)
          ? ((root as { nodes: unknown[] }).nodes)
          : [];
      return list.map(mapNode);
    } catch {
      return [];
    }
  }

  /**
   * Enables a node by UUID.
   */
  public async enableNode(uuid: string): Promise<void> {
    await this.requestJsonWithBody('post', `/api/nodes/${uuid}/actions/enable`, {});
  }

  /**
   * Disables a node by UUID.
   */
  public async disableNode(uuid: string): Promise<void> {
    await this.requestJsonWithBody('post', `/api/nodes/${uuid}/actions/disable`, {});
  }

  /**
   * Restarts a node's xray core by UUID.
   *
   * `forceRestart` is sent UNCONDITIONALLY, on every panel version:
   *
   *   • 2.8.0 and 3.2.1 declare `requestBody.required: true` with
   *     `required: ["forceRestart"]`. Omitting it is a 400, which
   *     `requestJsonWithBody` turns into `ServiceUnavailableException` — the
   *     operator gets "Remnawave integration is unavailable" from a healthy
   *     panel. That was the live defect.
   *   • 2.7.4 declares no `requestBody` for this endpoint at all, and its own
   *     contract (`@remnawave/backend-contract` → `RestartNodeCommand`) has no
   *     `RequestBodySchema` — only the `uuid` path param. Nothing on that
   *     version binds or validates a body, so an extra property is discarded
   *     exactly like the `{}` we have always posted here. (Even where 2.7.4
   *     does bind one — `RestartAllNodesCommand` — the schema is a plain
   *     non-strict `z.object`, which strips unknown keys rather than
   *     rejecting them.) So there is nothing to suppress.
   *
   * Deliberately NOT gated on `RemnawaveVersionService.getCapabilities()`:
   *   1. `RemnawaveVersionService` injects THIS service to read the version,
   *      so a gate here would be a circular dependency needing `forwardRef`.
   *   2. Version detection collapses every failure into `'unknown'` and caches
   *      it. A gate that reads "not confirmed ≥ 2.8 ⇒ omit the field" would
   *      re-send the empty body to a 2.8.0 panel during any detection blip and
   *      reproduce the exact 400 this fixes — the flag would be most likely to
   *      fail precisely when it matters.
   *   3. A flag only pays for itself when the two branches are both needed.
   *      Here one branch (always send) is correct on all three versions.
   *
   * `true` rather than `false` — note the specs give the field NO description
   * on any version, so the value is chosen from the caller, not from prose:
   *   • The only caller is a permissioned, explicit operator action
   *     (`admin-remnawave.controller.ts` → `POST nodes/:uuid/restart`, behind
   *     `@RequirePermission('remnawave', 'edit')`, driven by the per-row
   *     "Restart" menu item). No cron or sync job restarts nodes, so nothing
   *     is surprised by the stronger variant.
   *   • The SPA reports success on any 2xx (`infra-nodes-section.tsx` fires
   *     `toast.success(...restarted)` in `onSuccess`). If the non-forced
   *     variant is a panel-side no-op, the operator is told the node restarted
   *     when it did not. `force` is the variant whose meaning cannot be
   *     conditional on a panel heuristic, so it is the one that makes the
   *     operator's intent and the toast agree.
   *   • Blast radius is one node the operator picked by hand.
   *
   * 3.2.1 answers 202 with NO body where 2.x answers 200 with
   * `{ response: { eventSent } }`. Safe on this path: axios leaves an empty
   * body as `''` (it only attempts `JSON.parse` on a non-empty string), and
   * this method returns `void` — the response value is discarded either way.
   */
  public async restartNode(uuid: string): Promise<void> {
    await this.requestJsonWithBody('post', `/api/nodes/${uuid}/actions/restart`, {
      forceRestart: true,
    });
  }

  /**
   * Resets traffic counter for a node.
   */
  public async resetNodeTraffic(uuid: string): Promise<void> {
    await this.requestJsonWithBody('post', `/api/nodes/${uuid}/actions/reset-traffic`, {});
  }

  /**
   * Per-user bandwidth across the given nodes (Remnawave 2.8+
   * `POST /api/bandwidth-stats/nodes/users`). Returns the panel's "top users
   * by traffic" list — `{ username, total }` (total = bytes over the panel's
   * window). Used by the per-user node-traffic-abuse detector.
   *
   * Returns `null` when the panel did not answer — unreachable, unconfigured,
   * 4xx/5xx, or a build that does not serve the endpoint at all (pre-2.8).
   * `[]` therefore means the panel answered and reported no users, which is a
   * genuinely different fact. Collapsing both into `[]` is what let a malformed
   * request (the missing `topUsersLimit`) 400 on every run since 2.8 shipped
   * while the detector reported a clean panel: the caller could not tell "no
   * offenders" from "never asked successfully". Callers must branch.
   */
  public async getNodeUsersBandwidth(
    nodeUuids: readonly string[],
  ): Promise<readonly RemnawaveNodeUserBandwidth[] | null> {
    try {
      const result = await this.requestJsonWithBody<unknown>(
        'post',
        buildNodeUsersBandwidthPath(),
        { nodesUuids: [...nodeUuids] },
      );
      const root = (result as { response?: unknown })?.response ?? result;
      const top = (root as { topUsers?: unknown })?.topUsers;
      if (!Array.isArray(top)) return [];
      const out: RemnawaveNodeUserBandwidth[] = [];
      for (const entry of top) {
        const r = (entry ?? {}) as Record<string, unknown>;
        const username = typeof r['username'] === 'string' ? r['username'] : null;
        const total = this.coerceTrafficNumber(r['total']);
        if (username !== null && total !== null) out.push({ username, total });
      }
      return out;
    } catch {
      // `requestJsonWithBody` has already logged the transport failure once;
      // the caller decides how loudly a blind detector should complain.
      return null;
    }
  }

  /**
   * Returns all hosts from the panel.
   */
  public async getAllHosts(): Promise<RemnawaveHostInterface[]> {
    try {
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: '/api/hosts',
      });
      const root = (response as { response?: unknown })?.response ?? response;
      if (Array.isArray(root)) {
        return root.map(mapHost);
      }
      const wrapped = (root as { hosts?: unknown })?.hosts;
      if (Array.isArray(wrapped)) {
        return wrapped.map(mapHost);
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Returns HWID statistics.
   *
   * Modern Remnawave (2.7.x+) exposes `/api/hwid/devices/stats`. Earlier
   * builds had `/api/hwid/stats`. We try the modern path first and fall
   * through to the legacy URL — both shapes are tolerated by the consumer.
   */
  public async getHwidStats(): Promise<RemnawaveHwidStatsInterface | null> {
    for (const path of ['/api/hwid/devices/stats', '/api/hwid/stats']) {
      try {
        const response = await this.requestJson<{ response: RemnawaveHwidStatsInterface }>({
          method: 'get',
          url: path,
        });
        return response.response ?? (response as unknown as RemnawaveHwidStatsInterface);
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * One page of `/api/hwid/devices/top-users`. Not a preference — the contract's
   * own `size … .max(100, 'Size (limit) must be less than 100')`, identical in
   * all three vendored versions. Asking for more is a 400.
   */
  private static readonly HWID_TOP_USERS_PAGE_SIZE = 100;

  /**
   * How far the top-users walk will go before it stops and says it stopped.
   *
   * Ten pages. The list is ordered by device count, so the tail is users with
   * one or two devices — nobody a device-limit detector can act on — and a panel
   * with more than a thousand device-registering users has a fraud problem that
   * is not going to be found in row 1001.
   */
  private static readonly HWID_TOP_USERS_CEILING = 1000;

  /**
   * Top users by HWID device count — fastest fraud signal in the panel.
   * 2.7.x wraps the list under `users`, older builds used `topUsers`.
   *
   * THE PAGE SIZE IS SENT, AND THAT IS THE WHOLE POINT OF THE WALK BELOW. All
   * three vendored contracts declare `size` as `z.coerce.number().min(1).max(100)
   * .default(5)`, so omitting it did not mean "give me everything" — it meant
   * FIVE ROWS. The one consumer that matters is the HWID-overage detector, which
   * joins this list against each subscriber's device limit and reports whoever
   * is over it; on any panel with more than five device-registering users it was
   * judging a five-row sample and calling everyone else clean. Nothing said so:
   * five rows is a perfectly ordinary answer.
   *
   * `total` comes back on every version, so the walk knows when it is done
   * rather than guessing. Offset paging over a list ordered by device count is
   * not a stable cursor — a device registered mid-walk can shift a row across a
   * page boundary — but the cost of that is one offender missed until the next
   * run, and the endpoint offers no cursor to do better.
   *
   * `limit` is what the CALLER can use, not what the panel holds: the fraud
   * detector wants coverage, the dashboard card wants a card's worth. Both are
   * clamped to {@link HWID_TOP_USERS_CEILING} so neither can walk a huge panel
   * forever, and a walk that stops at the ceiling with rows still unread SAYS SO
   * — a silent truncation here reads exactly like a clean panel.
   */
  public async getHwidTopUsers(
    limit: number = RemnawaveApiService.HWID_TOP_USERS_CEILING,
  ): Promise<readonly RemnawaveHwidTopUserInterface[]> {
    const ceiling = Math.max(
      1,
      Math.min(Math.trunc(limit), RemnawaveApiService.HWID_TOP_USERS_CEILING),
    );
    const rows: RemnawaveHwidTopUserInterface[] = [];
    let total: number | null = null;
    try {
      while (rows.length < ceiling) {
        const size = Math.min(RemnawaveApiService.HWID_TOP_USERS_PAGE_SIZE, ceiling - rows.length);
        const response = await this.requestJson<unknown>({
          method: 'get',
          url: `/api/hwid/devices/top-users?start=${rows.length}&size=${size}`,
        });
        const root = (response as { response?: unknown })?.response ?? response;
        const list = Array.isArray(root)
          ? root
          : Array.isArray((root as { users?: unknown })?.users)
            ? ((root as { users: unknown[] }).users)
            : Array.isArray((root as { topUsers?: unknown })?.topUsers)
              ? ((root as { topUsers: unknown[] }).topUsers)
              : [];
        const reported = (root as { total?: unknown })?.total;
        if (typeof reported === 'number' && Number.isFinite(reported)) total = reported;
        if (list.length === 0) return rows;
        rows.push(...list.map(mapHwidTopUser));
        // A short page is the end of the list on every build that honours
        // `size`, and the stop that saves us from an endless walk against one
        // that ignores it and re-serves the same first page forever.
        if (list.length < size) return rows;
        if (total !== null && rows.length >= total) return rows;
      }
      // The only way out of the loop that is not a `return`: the row budget ran
      // out with the panel still offering more. A caller that asked for a card's
      // worth got exactly what it asked for and is not warned about it; hitting
      // the SAFETY ceiling is the case nobody chose, so that one is said out
      // loud rather than passed off as a complete read.
      if (rows.length >= RemnawaveApiService.HWID_TOP_USERS_CEILING) {
        this.logger.warn(
          `Remnawave HWID top users: stopped at the ${rows.length}-row ceiling` +
            (total === null ? '' : ` with ${total} reported`) +
            ' — device-overage detection is INCOMPLETE for this run, not clean',
        );
      }
      return rows;
    } catch (err: unknown) {
      // Fail-soft stays, but not silently. The only consumer is the
      // HWID-overage detector, and `[]` there means "nobody is over their
      // limit" — the same value a clean panel produces. Without this line an
      // outage, a bad token or a route that moved all read as a clean panel,
      // which is precisely the failure this codebase keeps re-learning.
      this.logger.warn(
        `Remnawave GET /api/hwid/devices/top-users failed: ${(err as Error).message} — ` +
          'HWID overage detection is BLIND for this run, not clean',
      );
      return [];
    }
  }

  // ── ip-control: active sessions / source IPs ──────────────────────────────

  /**
   * Fetches online users and their source IPs for a single node — the data
   * behind the panel's "Active sessions" view. Async on the panel side:
   * `POST fetch-users-ips/{nodeUuid}` returns a `jobId` we then poll.
   *
   * `null` means THIS NODE COULD NOT BE READ — the job failed, or the poll ran
   * out of budget. `[]` means the node was read and nobody was online. The
   * caller must keep those apart: they are the difference between "no sharing
   * here" and "no idea", and this detector's whole purpose is to accuse people.
   */
  public async fetchUsersIpsForNode(
    nodeUuid: string,
  ): Promise<readonly RemnawaveNodeUserIps[] | null> {
    const { connectionsApi } = await this.getPanelShape();
    // `'unknown'` deliberately takes the 2.x paths rather than refusing: they
    // are what every panel this integration has ever run against serves, and a
    // wrong guess here costs a 404, not a wrong answer.
    const is3x = connectionsApi === 'connections';
    try {
      const started = await this.requestJsonWithBody<{ response?: { jobId?: string } }>(
        'post',
        is3x ? PANEL_ROUTES.connectionsByNodeStart(nodeUuid) : PANEL_ROUTES.ipControlNodeStart(nodeUuid),
        {},
      );
      const jobId = started?.response?.jobId;
      if (typeof jobId !== 'string' || jobId.length === 0) return null;
      // `null` straight through, NOT `?? []`. `pollIpControlJob` returns null
      // for a job that completed with `success: false`, for `isFailed`, and for
      // the poll timeout — and flattening those to an empty array threw away the
      // exact distinction the guard inside it was added to preserve. The one
      // consumer, the concurrent-IP detector, reads `[]` as "nobody was online
      // on this node", so a node whose collection job failed or simply answered
      // slower than the 6-second budget was counted as clean. The big nodes are
      // both the slowest and the ones sharers live on.
      return this.pollIpControlJob(
        is3x ? PANEL_ROUTES.connectionsByNodeResult : PANEL_ROUTES.ipControlNodeResult,
        jobId,
        mapNodeUsersIps,
      );
    } catch {
      return null;
    }
  }

  /**
   * Per-user IP drilldown across nodes (`POST fetch-ips/{uuid}` → poll).
   * Used for on-demand inspection of one flagged user. Fail-soft → `[]`.
   */
  public async fetchUserIps(ref: PanelUserRef): Promise<readonly RemnawaveUserNodeIps[]> {
    const { connectionsApi } = await this.getPanelShape();
    const is3x = connectionsApi === 'connections';
    const segment = await this.segmentFor(ref, 'live connections by user');
    if (segment === null) return [];
    try {
      const started = await this.requestJsonWithBody<{ response?: { jobId?: string } }>(
        'post',
        is3x ? PANEL_ROUTES.connectionsByUserStart(segment) : PANEL_ROUTES.ipControlUserStart(segment),
        {},
      );
      const jobId = started?.response?.jobId;
      if (typeof jobId !== 'string' || jobId.length === 0) return [];
      const nodes = await this.pollIpControlJob(
        is3x ? PANEL_ROUTES.connectionsByUserResult : PANEL_ROUTES.ipControlUserResult,
        jobId,
        mapUserNodeIps,
      );
      return nodes ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Drops live connections for the given users or IPs across the targeted
   * nodes (`POST drop-connections`). Used by the anti-fraud enforcement path.
   */
  public async dropConnections(input: RemnawaveDropConnectionsInput): Promise<{ ok: boolean }> {
    const { connectionsApi } = await this.getPanelShape();
    if (connectionsApi !== 'connections') {
      await this.requestJsonWithBody(
        'post',
        PANEL_ROUTES.ipControlDrop,
        input as unknown as Record<string, unknown>,
      );
      return { ok: true };
    }
    // 3.x renamed the discriminator's user arm from `userUuids: string[]` to
    // `userIds: number[]`. The values the caller holds come from stored
    // `remnawaveId`s, which on a 3.x panel ARE the numeric ids as strings — so
    // this is a parse, not a lookup. Anything that does not parse is dropped
    // rather than sent: the panel would reject the whole request over one bad
    // element, taking the enforcement action for every other user with it.
    let body: Record<string, unknown>;
    if (input.dropBy.by === 'userUuids') {
      // `isNumericPanelIdentity` and NOT `Number.parseInt`. `parseInt` reads a
      // LEADING run of digits and stops: a 2.x uuid like
      // `330f2b38-1362-46ab-…` parses to `330`, a perfectly valid-looking id
      // belonging to somebody else entirely — and this request DROPS THEIR
      // CONNECTIONS. The whole string has to be digits or the value is not an
      // id at all.
      const userIds = input.dropBy.userUuids
        .filter((value) => isNumericPanelIdentity(value))
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isSafeInteger(value));
      if (userIds.length === 0) {
        this.logger.warn(
          'Remnawave drop connections: no stored identity parsed as a 3.x numeric user id — nothing to drop',
        );
        return { ok: false };
      }
      if (userIds.length !== input.dropBy.userUuids.length) {
        this.logger.warn(
          `Remnawave drop connections: ${input.dropBy.userUuids.length - userIds.length} of ` +
            `${input.dropBy.userUuids.length} identities are not 3.x numeric ids and were skipped`,
        );
      }
      body = { dropBy: { by: 'userIds', userIds }, targetNodes: input.targetNodes };
    } else {
      body = { dropBy: input.dropBy, targetNodes: input.targetNodes };
    }
    // Answers `202 Accepted` with an empty body; there is nothing to parse and
    // nothing that confirms the drop actually happened.
    await this.requestJsonWithBody('post', PANEL_ROUTES.connectionsDrop, body);
    return { ok: true };
  }

  /**
   * Polls an `ip-control` result endpoint until the job is completed or
   * failed, or a bounded number of attempts elapse. Returns the extracted
   * payload on completion, or `null` on failure/timeout.
   */
  private async pollIpControlJob<T>(
    resultPath: (jobId: string) => string,
    jobId: string,
    extract: (result: unknown) => T,
    options: { attempts?: number; intervalMs?: number } = {},
  ): Promise<T | null> {
    const attempts = options.attempts ?? 12;
    const intervalMs = options.intervalMs ?? 500;
    for (let i = 0; i < attempts; i++) {
      try {
        const raw = await this.requestJson<unknown>({
          method: 'get',
          url: resultPath(jobId),
        });
        const resp = (raw as { response?: unknown })?.response as
          | { isCompleted?: boolean; isFailed?: boolean; result?: unknown }
          | undefined;
        if (resp?.isFailed === true) return null;
        if (resp?.isCompleted === true) {
          // 3.x puts a `success` flag inside the completed result. Without this
          // check a job that completed but failed upstream extracts to an empty
          // array — indistinguishable from "this node has no live connections",
          // which for the sharing detector is the difference between "could not
          // look" and "looked and found nobody".
          const result = resp.result as { success?: unknown } | null | undefined;
          if (result !== null && typeof result === 'object' && result.success === false) {
            return null;
          }
          return extract(resp.result);
        }
      } catch {
        return null;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  }

  /**
   * Health probe for the admin Dashboard. Remnawave 2.8 changed
   * `/api/system/health` to `{ runtimeMetrics: [...] }` (no status/version),
   * while older builds returned `{ status, db, redis, version, uptime }`. A
   * 2xx means the panel is reachable, so we default the status to "ok" and
   * enrich the version from `/api/system/metadata` (the canonical 2.8 version
   * source). Returns null when the panel is unreachable.
   */
  public async getRemnawaveHealth(): Promise<RemnawaveHealthInterface | null> {
    try {
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: '/api/system/health',
      });
      const root = (response as { response?: unknown })?.response ?? response;
      const record = (root ?? {}) as Record<string, unknown>;
      const legacyStatus =
        typeof record['status'] === 'string' && record['status'].length > 0
          ? (record['status'] as string)
          : null;
      const metadata = await this.getSystemMetadata();
      const version =
        metadata?.version ??
        (typeof record['version'] === 'string' && record['version'].length > 0
          ? (record['version'] as string)
          : undefined);
      return {
        status: legacyStatus ?? 'ok',
        version,
        uptime: typeof record['uptime'] === 'number' ? (record['uptime'] as number) : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Panel build metadata (`/api/system/metadata`) — the canonical version
   * source on Remnawave 2.8 (also carries build number / git commit). Returns
   * null when unreachable or the endpoint is absent.
   */
  public async getSystemMetadata(): Promise<{ readonly version: string | null } | null> {
    try {
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: '/api/system/metadata',
      });
      const root = (response as { response?: unknown })?.response ?? response;
      const record = (root ?? {}) as Record<string, unknown>;
      const version =
        typeof record['version'] === 'string' && record['version'].length > 0
          ? (record['version'] as string)
          : null;
      return { version };
    } catch {
      return null;
    }
  }

  // `getSubscriptionRequestHistoryStats()` used to sit here, reading
  // `/api/subscription-request-history/stats` and CASTING the body — unread
  // and unvalidated — to a declared shape of
  // `{ totalRequests, uniqueUsers, perClient[], perDay[] }`. The panel answers
  // `{ byParsedApp: [{app, count}], hourlyRequestStats: [{dateTime,
  // requestCount}] }` on 2.7.4 and 2.8.0 alike, so all four declared fields
  // were `undefined` behind a type that promised numbers. Nothing called it:
  // no backend caller, no test, and the SPA's `getSubscriptionRequestStats`
  // was exported but never invoked by any screen. Deleted with its route and
  // its SPA half rather than given a mapper nobody would read.

  /**
   * Cost-side providers — first slice of `infra-billing`. The deeper
   * billing-nodes / bill-records branches are 404 on 2.7.4 and intentionally
   * not wired here; callers degrade gracefully via the empty array.
   */
  public async getInfraProviders(): Promise<readonly RemnawaveInfraProviderInterface[]> {
    try {
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: '/api/infra-billing/providers',
      });
      const root = (response as { response?: unknown })?.response ?? response;
      const list = Array.isArray(root)
        ? root
        : Array.isArray((root as { providers?: unknown })?.providers)
          ? ((root as { providers: unknown[] }).providers)
          : [];
      return list.map(mapInfraProvider);
    } catch {
      return [];
    }
  }

  /**
   * Reusable snippets used by subscription templates — RO list for the
   * Catalog tab.
   */
  public async getSnippets(): Promise<readonly RemnawaveSnippetInterface[]> {
    try {
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: '/api/snippets',
      });
      const root = (response as { response?: unknown })?.response ?? response;
      const list = Array.isArray(root)
        ? root
        : Array.isArray((root as { snippets?: unknown })?.snippets)
          ? ((root as { snippets: unknown[] }).snippets)
          : [];
      return list.map(mapSnippet);
    } catch {
      return [];
    }
  }

  /**
   * Subscription templates that drive the per-client config rendering.
   * Read-only on this iteration — editing requires a separate JSON/YAML
   * editor with validation we'll wire up later.
   */
  public async getSubscriptionTemplates(): Promise<readonly RemnawaveSubscriptionTemplateInterface[]> {
    try {
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: '/api/subscription-templates',
      });
      const root = (response as { response?: unknown })?.response ?? response;
      const list = Array.isArray(root)
        ? root
        : Array.isArray((root as { templates?: unknown })?.templates)
          ? ((root as { templates: unknown[] }).templates)
          : [];
      return list.map(mapSubscriptionTemplate);
    } catch {
      return [];
    }
  }

  /**
   * The single Remnawave-wide subscription settings object — branding,
   * profile titles, response rules, etc. We surface the safe fields and
   * intentionally hide raw `happAnnounce` / `happRouting` payloads.
   */
  public async getSubscriptionSettings(): Promise<RemnawaveSubscriptionSettingsInterface | null> {
    try {
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: '/api/subscription-settings',
      });
      const root = (response as { response?: unknown })?.response ?? response;
      if (root === null || typeof root !== 'object') return null;
      return mapSubscriptionSettings(root);
    } catch {
      return null;
    }
  }

  /**
   * Public landing pages users see when opening their /sub/<short-uuid> URL
   * in a browser. 2.7.x wraps under `configs`.
   */
  public async getSubscriptionPageConfigs(): Promise<readonly RemnawaveSubpageConfigInterface[]> {
    try {
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: '/api/subscription-page-configs',
      });
      const root = (response as { response?: unknown })?.response ?? response;
      const list = Array.isArray(root)
        ? root
        : Array.isArray((root as { configs?: unknown })?.configs)
          ? ((root as { configs: unknown[] }).configs)
          : [];
      return list.map(mapSubpageConfig);
    } catch {
      return [];
    }
  }

  /**
   * Plugins registered against Remnawave nodes — we surface them read-only.
   * 2.7.x wraps under `nodePlugins`.
   */
  public async getNodePlugins(): Promise<readonly RemnawaveNodePluginInterface[]> {
    try {
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: '/api/node-plugins',
      });
      const root = (response as { response?: unknown })?.response ?? response;
      const list = Array.isArray(root)
        ? root
        : Array.isArray((root as { nodePlugins?: unknown })?.nodePlugins)
          ? ((root as { nodePlugins: unknown[] }).nodePlugins)
          : Array.isArray((root as { plugins?: unknown })?.plugins)
            ? ((root as { plugins: unknown[] }).plugins)
            : [];
      return list.map(mapNodePlugin);
    } catch {
      return [];
    }
  }

  /**
   * Subscription request history — the "who's pulling /sub/xxx" log.
   *
   * TWO ENDPOINTS, NOT ONE, AND THE DIFFERENCE IS THE WHOLE POINT.
   * The panel exposes a whole-log reader and a per-user reader, and only the
   * per-user one can answer "what did THIS user fetch with":
   *
   *   - `GET /api/subscription-request-history` — parameters are exactly
   *     `size` ("Page size for pagination") and `start` ("Offset for
   *     pagination") on both 2.7.4 and 2.8.0. There is no user filter and no
   *     time filter.
   *   - `GET /api/users/{uuid}/subscription-request-history` — "Get user
   *     subscription request history, recent 24 records" on both builds. The
   *     uuid is in the PATH, so attribution holds on 2.8.0 even though its
   *     records carry a numeric `userId` instead of a uuid.
   *
   * This method previously sent `userUuid` and `limit` as query parameters to
   * the whole-log endpoint. NEITHER PARAMETER EXISTS IN EITHER SPEC, so a
   * caller asking for one user's trail was served an unfiltered page of the
   * entire panel's log and had no way to tell. Passing `userUuid` now routes
   * to the per-user endpoint, and the page bound is sent under its real name.
   */
  public async getSubscriptionRequestHistory(input: {
    /**
     * The profile whose trail to read. Omit for the whole-panel log. A
     * profile that cannot be addressed on this panel yields `[]` — the same
     * fail-soft this whole method uses, and the refusal is logged by
     * `segmentFor` so the gap is visible.
     */
    readonly user?: PanelUserRef;
    /** Page size. Ignored on the per-user route, which is fixed at 24 upstream. */
    readonly limit?: number;
  } = {}): Promise<readonly RemnawaveSubscriptionRequestEntryInterface[]> {
    try {
      let url: string;
      if (input.user !== undefined) {
        const segment = await this.segmentFor(input.user, 'subscription request history');
        if (segment === null) return [];
        url = PANEL_ROUTES.userSubscriptionRequestHistory(segment);
      } else {
        const params = new URLSearchParams();
        // `size`, not `limit` — see the note above.
        if (input.limit !== undefined) params.set('size', String(input.limit));
        const qs = params.toString();
        url = `/api/subscription-request-history${qs.length > 0 ? `?${qs}` : ''}`;
      }
      const response = await this.requestJson<unknown>({ method: 'get', url });
      return readSubscriptionRequestRecords(response).map(mapSubscriptionRequestEntry);
    } catch {
      return [];
    }
  }

  /**
   * The most recent page of the whole-panel subscription-request log, as a
   * strict outcome.
   *
   * The best-effort reader above answers `[]` for "the panel is down", "the
   * token is wrong" and "nobody fetched anything" alike. A detector that
   * accuses customers on the strength of this log cannot use that: an empty
   * array has to mean the log was read and was clean, or the run must be
   * abandoned and said so out loud. Hence the strict variant.
   *
   * SCOPE OF WHAT THIS CAN SEE. There is no time filter on the endpoint, so
   * "the last N minutes" is not expressible — the caller gets the newest
   * `size` rows and must window them itself by `requestAt`, and must treat a
   * page that is entirely newer than its window as evidence that the window
   * was NOT fully covered. {@link RemnawaveSubscriptionRequestPage.total} is
   * the panel's own count of the whole log, carried so a caller can say how
   * small a slice it looked at.
   */
  public async strictGetSubscriptionRequestHistory(
    size: number,
  ): Promise<RemnawaveStrictOutcome<RemnawaveSubscriptionRequestPage>> {
    const transport = await this.strictHttp(
      'get',
      `/api/subscription-request-history?start=0&size=${encodeURIComponent(String(size))}`,
    );
    if (transport.kind !== 'ok') return this.mapStrictTransport(transport);

    const envelope = (transport.data ?? {}) as { response?: unknown };
    const root = (envelope.response ?? transport.data) as { records?: unknown; total?: unknown };
    if (!Array.isArray(root?.records)) {
      // A 2xx whose body is not the documented envelope is a contract
      // violation, NOT an empty log. Reporting it as "no records" would let a
      // panel that changed shape read as a panel where nothing happened.
      return strictInvalidContract('subscription-request-history response has no "records" array');
    }
    const rawTotal = root.total;
    const records = root.records.map(mapSubscriptionRequestEntry);
    return strictOk(
      {
        records,
        total:
          typeof rawTotal === 'number' && Number.isInteger(rawTotal) && rawTotal >= 0
            ? rawTotal
            : records.length,
        requestedSize: size,
      },
      this.readEnvelopeVersion(transport.data),
    );
  }

  /**
   * Resolve a user by Telegram id, username, email, or short subscription
   * uuid. Returns null when nothing matches — the upstream returns 400 for
   * an empty query, so the caller MUST pass at least one selector.
   */
  public async resolveRemnawaveUser(input: RemnawaveUserResolveQuery): Promise<RemnawaveUserSummaryInterface | null> {
    if (!input.telegramId && !input.username && !input.email && !input.subscriptionUuid) {
      return null;
    }
    // Remnawave 2.8 dropped the catch-all `GET /api/users/resolve` in favour of
    // dedicated by-selector lookups (the POST /resolve only accepts uuid/
    // username/shortUuid). We branch to the matching `by-*` endpoint so all
    // four admin selectors keep working on 2.7.4 and 2.8.0.
    //
    // On 3.x two of those four are gone — `by-email` and `by-telegram-id` answer
    // `404 Cannot GET` on a live 3.2.1 — and the replacement is `stream` with a
    // filter. Without this branch an operator searching a real customer by email
    // on a 3.x panel is told "no such user", because the 404 lands in the
    // catch-all below and comes back as `null`. Name lookups and short-uuid
    // lookups need no branch: those two routes survive on every version.
    // The `unknown` case is NOT a coin flip between the two. Guessing legacy on
    // a 3.x panel yields a 404 that surfaces to the operator as "no such user";
    // guessing the stream on a 2.8 panel is WORSE, because 2.8's stream declares
    // only `cursor` and `size`, silently drops the filter and returns the first
    // keyset page — an ARBITRARY customer presented as the match. So an
    // unidentified panel tries the legacy route first and falls back to the
    // stream, and every stream answer is checked against the selector that was
    // asked for. That check is what makes the fallback safe on a panel that
    // ignored the filter.
    const { userLookups } = await this.getPanelShape();
    const legacyFirst = userLookups.byEmail || userLookups.byTelegramId;

    if (input.subscriptionUuid) {
      return this.readUserSummary(
        `/api/users/by-short-uuid/${encodeURIComponent(input.subscriptionUuid)}`,
      );
    }
    if (input.username) {
      return this.readUserSummary(`/api/users/by-username/${encodeURIComponent(input.username)}`);
    }

    const selector = input.email
      ? { key: 'email' as const, value: input.email }
      : { key: 'telegramId' as const, value: input.telegramId ?? '' };
    if (selector.value.length === 0) return null;

    const legacyUrl =
      selector.key === 'email'
        ? `/api/users/by-email/${encodeURIComponent(selector.value)}`
        : `/api/users/by-telegram-id/${encodeURIComponent(selector.value)}`;
    // `size=1`: this is a lookup, not a walk.
    const streamUrl = `/api/users/stream?size=1&${selector.key}=${encodeURIComponent(selector.value)}`;

    if (legacyFirst) {
      const found = await this.readUserSummary(legacyUrl);
      if (found !== null) return found;
      // A confident 2.x reading means the route exists and genuinely has no
      // match; only an UNIDENTIFIED panel earns the second attempt.
      if (userLookups.byEmail && userLookups.byTelegramId) return null;
    }
    const streamed = await this.readUserSummary(streamUrl);
    if (streamed === null) return null;
    return matchesUserSelector(streamed, selector) ? streamed : null;
  }

  /** One user-lookup GET, decoded, fail-soft to `null`. */
  private async readUserSummary(url: string): Promise<RemnawaveUserSummaryInterface | null> {
    try {
      const response = await this.requestJson<unknown>({ method: 'get', url });
      const root = (response as { response?: unknown })?.response ?? response;
      if (root === null || typeof root !== 'object') return null;
      // by-telegram-id returns a collection (a Telegram id can map to several
      // profiles); the rest return a single user. Take the first match.
      const collection =
        (root as { users?: unknown }).users ?? (Array.isArray(root) ? root : null);
      const user = Array.isArray(collection) ? collection[0] : root;
      if (user === null || user === undefined || typeof user !== 'object') return null;
      return mapUserSummary(user);
    } catch {
      return null;
    }
  }

  /**
   * Reorders hosts — accepts an array of UUIDs in the desired top→bottom
   * order. Forwarded to the Remnawave panel verbatim. URL matches the
   * official `ReorderHostCommand.url` from `@remnawave/backend-contract`.
   */
  public async reorderHosts(uuids: readonly string[]): Promise<void> {
    await this.requestJsonWithBody('post', '/api/hosts/actions/reorder', {
      hosts: uuids.map((uuid, index) => ({ uuid, viewPosition: index + 1 })),
    });
  }

  /**
   * Returns config profiles from the panel.
   *
   * Modern Remnawave wraps the list in `{ response: { total, configProfiles } }`,
   * older builds return `{ response: [...] }` directly. Both shapes are
   * accepted here so the admin SPA never sees `[object Object]` instead of
   * an array.
   */
  public async getConfigProfiles(): Promise<RemnawaveConfigProfileInterface[]> {
    try {
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: '/api/config-profiles',
      });
      const root = (response as { response?: unknown })?.response ?? response;
      if (Array.isArray(root)) {
        return root as RemnawaveConfigProfileInterface[];
      }
      const wrapped = (root as { configProfiles?: unknown })?.configProfiles;
      if (Array.isArray(wrapped)) {
        return wrapped as RemnawaveConfigProfileInterface[];
      }
      return [];
    } catch {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SQUADS & STATUS (existing)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Shared tail of both `*Options` reads: decode, or refuse OUT LOUD.
   *
   * The refusal is deliberately not an empty list, because the caller can tell
   * the difference and acts on it. `PlansAdminValidators.assertSquadsAreValid`
   * catches a throw as "the panel could not be asked" and blocks a squad change;
   * it reads `[]` as "the panel serves no such squad" and answers the operator
   * `External squad not found: <uuid>`. A decoder that returned `[]` when it
   * could not read the panel would produce that confident wrong answer about a
   * squad that exists — the exact conflation this adapter keeps being bitten by.
   *
   * The operator-facing message is unchanged. The REASON goes to the log, where
   * it names the field that actually failed, so "squads are unavailable" stops
   * being the end of the investigation.
   */
  private readSquadOptions(
    payload: unknown,
    listKey: PanelSquadListKey,
    label: 'internal' | 'external',
  ): readonly RemnawaveSquadOptionInterface[] {
    const decoded = decodeSquadOptionList(payload, listKey);
    if (!decoded.ok) {
      this.logger.error(`Remnawave ${label} squads could not be read — ${decoded.reason}`);
      throw new ServiceUnavailableException(`Remnawave ${label} squads are unavailable`);
    }
    return decoded.value;
  }

  /**
   * `{ uuid, name }` for every internal squad, for the plan squad selectors.
   *
   * Decoded by our own {@link decodeSquadOptionList}, never by a vendor zod
   * schema. `getInternalSquadDetails` below already read this same endpoint
   * tolerantly and never broke; the option read did not, and its external-squad
   * twin took every 3.x installation down. See `panel-response-decoders.ts`.
   */
  public async getInternalSquadOptions(): Promise<readonly RemnawaveSquadOptionInterface[]> {
    const payload = await this.requestJson<unknown>({
      method: 'get',
      url: PANEL_ROUTES.internalSquads,
    });
    return this.readSquadOptions(payload, 'internalSquads', 'internal');
  }

  /**
   * Returns full-shape internal squads with `membersCount` / `inboundsCount`
   * counters, used by the admin "Remnawave → Squads" tab.
   *
   * Older panels omit the `info` block that carries the counters, so
   * `mapInternalSquadDetails` falls back to the length of the row's own
   * `inbounds` array (and zero members) rather than handing `undefined` to the
   * table. That mapper never executed a vendor zod schema, which is exactly why
   * this read survived the 3.x field rename that broke the external-squad
   * OPTION read — same endpoint, same panel, opposite outcome.
   */
  public async getInternalSquadDetails(): Promise<readonly RemnawaveInternalSquadDetailInterface[]> {
    const payload = await this.requestJson<unknown>({
      method: 'get',
      url: PANEL_ROUTES.internalSquads,
    });
    return mapInternalSquadDetails(payload);
  }

  /**
   * `{ uuid, name }` for every external squad, for the plan squad selectors.
   *
   * THE LIVE DEFECT THIS REPLACED. This method used to `safeParse` the response
   * with `GetExternalSquadsCommand` from `@remnawave/backend-contract@2.7.3`.
   * That schema requires `responseHeaders` on every row; panel 3.x renamed the
   * field to `responseHeadersAdd` + `responseHeadersRemove` and stopped sending
   * `responseHeaders` at all, so the parse failed DETERMINISTICALLY and this
   * threw `ServiceUnavailableException` against a perfectly healthy 3.x panel —
   * but only once that panel had at least one external squad, since an empty
   * list satisfies the schema trivially. Hence "intermittent".
   *
   * `getExternalSquadDetails`, four lines below, reads the SAME endpoint and
   * never broke, because it decodes through our own tolerant mapper. That
   * asymmetry was the shape of the fix.
   */
  public async getExternalSquadOptions(): Promise<readonly RemnawaveSquadOptionInterface[]> {
    const payload = await this.requestJson<unknown>({
      method: 'get',
      url: PANEL_ROUTES.externalSquads,
    });
    return this.readSquadOptions(payload, 'externalSquads', 'external');
  }

  /**
   * Returns full-shape external squads with the `membersCount` counter,
   * used by the admin "Remnawave → Squads" tab.
   */
  public async getExternalSquadDetails(): Promise<readonly RemnawaveExternalSquadDetailInterface[]> {
    const payload = await this.requestJson<unknown>({
      method: 'get',
      url: PANEL_ROUTES.externalSquads,
    });
    return mapExternalSquadDetails(payload);
  }

  public async getStatus(): Promise<RemnawaveStatusInterface> {
    if (!this.isConfigured()) {
      return {
        isConfigured: false,
        isReachable: false,
        isLoginAllowed: null,
        isRegisterAllowed: null,
        authentication: null,
        branding: null,
      };
    }
    try {
      const payload = await this.requestJson<unknown>({
        method: 'get',
        url: PANEL_ROUTES.authStatus,
      });
      const decoded = decodePanelAuthStatus(payload);
      if (!decoded.ok) {
        this.logger.error(`Remnawave auth status could not be read — ${decoded.reason}`);
        throw new ServiceUnavailableException('Remnawave auth status is unavailable');
      }
      return {
        isConfigured: true,
        isReachable: true,
        isLoginAllowed: decoded.value.isLoginAllowed,
        isRegisterAllowed: decoded.value.isRegisterAllowed,
        authentication: decoded.value.authentication,
        branding: decoded.value.branding,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ServiceUnavailableException('Remnawave auth status is unavailable');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  STRICT ADAPTER (T-010) — paid/destructive operations with normalized
  //  outcomes for the fulfillment/device sagas. These do NOT swallow errors
  //  into null/[] like the best-effort UI reads above.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Strictly reads a panel user for read-back verification. Validates the
   * envelope + required fields and decodes the canonical nullable-unlimited
   * (`0` upstream → `null`). 404 → `notFound`; malformed 2xx →
   * `invalidContract`; transport/5xx → `unavailable`.
   */
  public async strictGetPanelUser(ref: PanelUserRef): Promise<RemnawaveStrictOutcome<RemnawaveStrictUser>> {
    const segment = await this.segmentFor(ref, 'strict GET user');
    if (segment === null) return strictUnavailable();
    const transport = await this.strictHttp('get', PANEL_ROUTES.user(segment));
    if (transport.kind !== 'ok') return this.mapStrictTransport(transport);
    return this.parseStrictUser(transport.data);
  }

  /**
   * Strictly reads the panel's canonical expiry for the expired-profile sweep.
   *
   * The sweep DELETES subscriptions, so it has to tell "this profile is gone"
   * from "the panel did not answer". {@link getPanelUser} cannot: it collapses
   * every failure — outage, expired token, 5xx, timeout, unconfigured
   * integration — into `null`, and the sweep reads `null` as "gone, nothing to
   * protect". Only a 404 may mean gone.
   *
   * Narrower than {@link strictGetPanelUser} on purpose: validating fields the
   * sweep never reads would turn an unrelated contract drift into a permanent
   * deferral of every deletion. A missing or unparseable `expireAt` IS
   * `invalidContract` though — the caller must not fall back to deleting on a
   * date it could not read.
   *
   * And "only a 404 may mean gone" is itself too loose: only a 404 the PANEL
   * sent may mean gone. This read maps through
   * {@link mapStrictProfileTransport}, so a bare 404 — the answer a reverse
   * proxy gives for every request while it has no healthy backend — comes back
   * `unavailable` and the caller defers instead of destroying.
   */
  public async strictGetPanelUserExpiry(
    ref: PanelUserRef,
  ): Promise<RemnawaveStrictOutcome<RemnawavePanelExpirySnapshot>> {
    const segment = await this.segmentFor(ref, 'strict GET expiry');
    if (segment === null) return strictUnavailable();
    const transport = await this.strictHttp('get', PANEL_ROUTES.user(segment));
    if (transport.kind !== 'ok') return this.mapStrictProfileTransport(transport);
    const root = (transport.data as { response?: unknown })?.response ?? transport.data;
    if (root === null || typeof root !== 'object') {
      return strictInvalidContract('user response envelope missing');
    }
    const record = root as Record<string, unknown>;
    const rawExpireAt = record['expireAt'];
    if (typeof rawExpireAt !== 'string' || rawExpireAt.length === 0) {
      return strictInvalidContract('user missing expireAt');
    }
    const expireAtMs = new Date(rawExpireAt).getTime();
    if (Number.isNaN(expireAtMs)) {
      return strictInvalidContract(`user expireAt is unparseable: ${rawExpireAt}`);
    }
    const rawUrl = record['subscriptionUrl'];
    return strictOk(
      {
        expireAtMs,
        subscriptionUrl: typeof rawUrl === 'string' && rawUrl.length > 0 ? rawUrl : null,
      },
      this.readEnvelopeVersion(transport.data),
    );
  }

  /**
   * Absolute desired-limit PATCH. UUID travels in the BODY (2.7.x/2.8.x
   * contract), canonical unlimited (`null`) is encoded as upstream `0`. Returns
   * the panel's post-write user so the caller can compare, but callers MUST
   * still `strictGetPanelUser` for an independent read-back before advancing
   * the applied revision.
   */
  public async strictSetUserLimits(
    ref: PanelUserRef,
    desired: {
      readonly trafficLimitBytes: bigint | null;
      readonly hwidDeviceLimit: number | null;
      readonly tag?: string | null;
      readonly trafficLimitStrategy?: string | null;
      readonly activeInternalSquads?: readonly string[];
      readonly externalSquadUuid?: string | null;
    },
  ): Promise<RemnawaveStrictOutcome<RemnawaveStrictUser>> {
    const preflight = validateStrictUserWrite(desired);
    if (preflight !== null) return strictInvalidContract(preflight);
    // `unavailable`, not `invalidContract`: the contract is fine, we just cannot
    // name this profile right now. The saga defers on the former and gives up on
    // the latter, and a profile we could address after a version re-detect must
    // not be given up on.
    const key = await this.patchKeyFor(ref);
    if (key === null) return strictUnavailable();
    const body: Record<string, unknown> = {
      ...key,
      trafficLimitBytes:
        desired.trafficLimitBytes === null ? 0 : Number(desired.trafficLimitBytes),
      hwidDeviceLimit: desired.hwidDeviceLimit === null ? 0 : desired.hwidDeviceLimit,
      ...(desired.tag !== undefined ? { tag: desired.tag } : {}),
      // Never nullable upstream (see `createPanelUser`); `null` here means the
      // desired state has no opinion, which on a PATCH is expressed by absence.
      ...(desired.trafficLimitStrategy !== undefined && desired.trafficLimitStrategy !== null
        ? { trafficLimitStrategy: desired.trafficLimitStrategy }
        : {}),
      ...(desired.activeInternalSquads !== undefined
        ? { activeInternalSquads: desired.activeInternalSquads }
        : {}),
      ...(desired.externalSquadUuid !== undefined
        ? { externalSquadUuid: desired.externalSquadUuid }
        : {}),
    };
    const transport = await this.strictHttp('patch', '/api/users', body);
    if (transport.kind !== 'ok') return this.mapStrictTransport(transport);
    return this.parseStrictUser(transport.data);
  }

  /**
   * Strictly lists a user's HWID devices for the device-reduction saga.
   * Validates the envelope, that `total` matches the row count, that every
   * `hwid` is unique + non-empty and every `createdAt` is present — a device
   * plan must never be built on an inconsistent list. Row owner fields are
   * ignored (the user is addressed by URL UUID, never by a trusted row field).
   *
   * `era` IS OPTIONAL HERE AND REQUIRED ON THE DELETE, and the split is the one
   * {@link resolvePanelSegment} already draws: a destructive verb may not build
   * its address from a second, independent reading of the era, while a read has
   * nothing to agree with and keeps its old behaviour when nothing is passed.
   *
   * A GUARDED CALLER SHOULD STILL PASS ONE. This read is not destructive, but
   * both of its callers act on it: the planner turns it into the persisted
   * target list, and the executor turns the final one into the post-condition
   * written to `postconditionMetadata` before a plan certifies itself APPLIED.
   * Read off a profile the guard did not clear, that certificate describes
   * somebody else's device list.
   */
  public async strictListUserDevices(
    ref: PanelUserRef,
    era?: PanelEraObservation,
  ): Promise<RemnawaveStrictOutcome<RemnawaveStrictDeviceList>> {
    const segment = await this.segmentFor(ref, 'strict list devices', era);
    if (segment === null) return strictUnavailable();
    const transport = await this.strictHttp('get', PANEL_ROUTES.userHwidDevices(segment));
    if (transport.kind !== 'ok') return this.mapStrictTransport(transport);

    const root = (transport.data as { response?: unknown })?.response ?? transport.data;
    if (root === null || typeof root !== 'object') {
      return strictInvalidContract('device list envelope is not an object');
    }
    const record = root as { devices?: unknown; total?: unknown };
    if (!Array.isArray(record.devices)) {
      return strictInvalidContract('device list "devices" is not an array');
    }
    const devices: RemnawaveStrictDevice[] = [];
    const seen = new Set<string>();
    for (const raw of record.devices) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const hwid = typeof r['hwid'] === 'string' ? r['hwid'] : '';
      const createdAt = typeof r['createdAt'] === 'string' ? r['createdAt'] : '';
      // Last activity, read the SAME way `mapHwidDevice` reads it for the
      // cabinet: Remnawave 2.7.x names the field `updatedAt`, later shapes name
      // it `lastSeenAt`, and both mean "when this registration was last used".
      // It was already on the wire and was being dropped here, which is what
      // left the reduction saga choosing a victim by registration date alone.
      //
      // NOT fail-closed, unlike `hwid` and `createdAt` above, and deliberately:
      // a panel that reports no activity for a row is not a panel we
      // misunderstood, and refusing the whole list over it would strand every
      // reduction on a version that never sends the field. Absent reads as
      // `null` - "we do not know" - which the consumer treats as no evidence in
      // either direction rather than as evidence of disuse.
      const rawLastSeen = r['lastSeenAt'] ?? r['updatedAt'];
      const lastSeenAt =
        typeof rawLastSeen === 'string' && rawLastSeen.length > 0 ? rawLastSeen : null;
      if (hwid.length === 0) return strictInvalidContract('device row has an empty hwid');
      if (createdAt.length === 0) return strictInvalidContract(`device ${hwid} has no createdAt`);
      if (seen.has(hwid)) return strictInvalidContract(`duplicate hwid ${hwid} in device list`);
      seen.add(hwid);
      devices.push({ hwid, createdAt, lastSeenAt });
    }
    if (typeof record.total !== 'number' || !Number.isInteger(record.total)) {
      return strictInvalidContract('device list "total" is not an integer');
    }
    if (record.total !== devices.length) {
      return strictInvalidContract(
        `device list total ${record.total} != rows ${devices.length}`,
      );
    }
    return strictOk({ devices, total: record.total }, this.readEnvelopeVersion(transport.data));
  }

  /**
   * Strictly lists EVERY user on the panel, paginating `/api/users`.
   *
   * Bulk counterpart of {@link strictListUserDevices}, and strict for the same
   * reason: the import overlay reads a MISS in this list as "the profile is
   * gone" and writes EXPIRED. A bare array cannot tell those apart —
   *
   *   • the panel genuinely has no users,
   *   • the panel had users but we could not decode a single row,
   *   • the read stopped early (a page errored, or the ceiling cut it),
   *
   * — they all arrive as `[]`, and a short list arrives as a plausible one. So
   * this returns a normalized outcome that keeps them apart, because they need
   * different handling:
   *
   *   ok, complete    — the walk reached the end of the list: every page
   *                     arrived, every row decoded, and any row count the panel
   *                     reported agreed (incl. the genuinely empty panel: no
   *                     rows, `total: 0`)
   *   ok, INCOMPLETE  — TRUNCATED at the page ceiling. Not a contract
   *                     violation: the rows are real, there are just more of
   *                     them. The caller keeps the prefix and confirms a miss
   *                     per-uuid (see `resolvePanelProfile`). Refusing here
   *                     instead would switch the whole live-panel overlay off
   *                     on exactly the biggest panels — every backup import
   *                     would silently keep its stale values and report success.
   *   unavailable /   — a page never arrived (mapped from the transport)
   *    unsupported /
   *    notFound
   *   invalidContract — we could not PARSE what arrived: a page with no `users`
   *                     array, rows of which none carried a uuid, rows we had
   *                     to drop, an empty read the panel would not confirm, or
   *                     a row count the panel reported and then contradicted
   *
   * Rows without a usable `uuid` are STILL dropped (see
   * {@link parsePanelUserRow} — letting one through corrupts identity
   * downstream). What changed is that dropping one is no longer free: decoded ≠
   * rows received is `invalidContract`, so the caller decides.
   *
   * `total` is read DEFENSIVELY, like every other `total` in this file (see the
   * device-list readers, which all fall back to an array length): it bounds the
   * walk and cross-checks the result when the panel reports a usable one, but
   * an absent or non-integer `total` must NOT fail a read whose rows all
   * arrived and all decoded. The vendored `@remnawave/backend-contract` does
   * declare it (`GetAllUsersCommand.ResponseSchema`, `total: z.number()` — note:
   * not `.int()`), but that package is pinned at 2.7.3 and says nothing about
   * the build actually answering us; making the whole read hinge on it means a
   * single wire difference stops every backup import overlaying live panel
   * state on one version while the other works, silently and successfully. A
   * page shorter than the panel's own page size is the end-of-list signal that
   * remains. The single place the panel must speak up is the EMPTY read: zero
   * rows tell us nothing by themselves, so `[]` is believed only when the panel
   * itself says `total: 0`.
   *
   * Pagination walks by ROWS ACTUALLY RECEIVED, never `pageIndex × size`: a
   * dropped row must not shift the cursor (the read would end early), and a
   * panel that clamps `size` server-side must not make us skip the rows it
   * chose not to send.
   */
  public async strictGetAllPanelUsers(): Promise<RemnawaveStrictOutcome<RemnawavePanelUserList>> {
    const pageSize = 500;
    const maxPages = 50;
    const decoded: RemnawavePanelUser[] = [];
    let rawRowsSeen = 0;
    /** The largest page the panel actually served — its OWN page size. */
    let longestPage = 0;
    let totalReported: number | null = null;
    let detectedVersion: string | null = null;
    let reachedEnd = false;

    // Keyset where the panel offers it. Offset paging over a list that keeps
    // mutating loses rows at the source: delete one user between page 0 and
    // page 1 and every later row shifts one place left, so one live user is
    // never served — and the arithmetic still reconciles, because the panel's
    // own `total` fell by the same one. That user then MISSES in the overlay map
    // and gets written EXPIRED. `/api/users/stream` pages by a stable cursor and
    // cannot do that. It exists from 2.8 onward (measured on live 2.8.1 and
    // 3.2.1); 2.7.4 has no such route and keeps the offset walk.
    const { usersStream } = await this.getPanelShape();
    let cursor: string | null = null;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      // On the offset path the start is the number of rows we actually hold —
      // NOT `pageIndex * pageSize`. A panel that serves fewer rows than we asked
      // for would otherwise leave a hole the size of the shortfall in every
      // page, and those users would then MISS in the overlay map and be
      // written EXPIRED.
      const transport = await this.strictHttp(
        'get',
        usersStream
          ? `/api/users/stream?size=${pageSize}` +
              (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`)
          : `/api/users/?start=${rawRowsSeen}&size=${pageSize}`,
      );
      if (transport.kind !== 'ok') {
        // Half a panel is not a smaller panel. A page we never received makes
        // every later "missing" verdict unsound, so the whole read is refused.
        this.logger.warn(
          `strictGetAllPanelUsers page ${pageIndex} failed: ${
            transport.kind === 'network' ? 'network/timeout' : `HTTP ${transport.status}`
          }`,
        );
        return this.mapStrictTransport(transport);
      }
      detectedVersion = this.readEnvelopeVersion(transport.data) ?? detectedVersion;

      const envelope = (transport.data ?? {}) as {
        response?: { users?: unknown; total?: unknown; nextCursor?: unknown; hasMore?: unknown };
        users?: unknown;
        total?: unknown;
        nextCursor?: unknown;
        hasMore?: unknown;
      };
      const usersPayload = envelope.response?.users ?? envelope.users;
      if (!Array.isArray(usersPayload)) {
        return strictInvalidContract(`user page ${pageIndex} has no "users" array`);
      }
      // A usable `total` is taken as the panel's own row count; anything else
      // (absent, a string, a float, negative) is simply not usable evidence and
      // is ignored — never a reason to throw away rows that did arrive.
      const pageTotal = envelope.response?.total ?? envelope.total;
      if (typeof pageTotal === 'number' && Number.isInteger(pageTotal) && pageTotal >= 0) {
        totalReported = pageTotal;
      }
      rawRowsSeen += usersPayload.length;
      longestPage = Math.max(longestPage, usersPayload.length);

      for (const candidate of usersPayload) {
        const user = parsePanelUserRow(candidate, this.reportPanelUserShapeDrift);
        if (user !== null) decoded.push(user);
      }

      if (usersPayload.length === 0) {
        reachedEnd = true;
        break;
      }

      if (usersStream) {
        // `hasMore` is authoritative here and the short-page heuristic below
        // must NOT be applied: a keyset page is allowed to come up short
        // without being the last one, so reading a short page as the end would
        // bless a prefix of the panel as all of it.
        const stream = envelope.response ?? envelope;
        const next = stream.nextCursor;
        if (stream.hasMore !== true) {
          reachedEnd = true;
          break;
        }
        // `hasMore` says there is more and the cursor to fetch it is missing or
        // unusable. That is NOT the end of the list — treating it as one would
        // hand back a PREFIX flagged `complete: true`, and `complete` is exactly
        // what licenses a caller to read a miss as "the profile is gone". The
        // contract declares `nextCursor` nullable independently of `hasMore`, so
        // this combination is reachable on a build that gets it wrong; stop, and
        // say the list is short.
        if (typeof next !== 'string' || next.length === 0) {
          this.logger.warn(
            `strictGetAllPanelUsers: the stream reported more rows at page ${pageIndex} but gave ` +
              'no cursor to fetch them — the list is a PREFIX, not the whole panel',
          );
          break;
        }
        // A cursor that does not advance would spin until `maxPages` and then
        // report an INCOMPLETE list built from the same page fifty times. That
        // is a contract failure, not a short read, and has to say so.
        if (next === cursor) {
          return strictInvalidContract(
            `user stream returned the same cursor twice at page ${pageIndex} — the walk cannot advance`,
          );
        }
        cursor = next;
        continue;
      }

      // Offset path. End of list, strongest signal first:
      //   • we already hold every row the panel says it has;
      //   • the page came up short against the panel's OWN page size. Measuring
      //     that against the size we ASKED for instead would read a
      //     server-side clamp (250, 100) as the end of the list and bless a
      //     quarter of the panel as all of it — the rest would then miss in the
      //     overlay map and be expired.
      if (
        (totalReported !== null && rawRowsSeen >= totalReported) ||
        usersPayload.length < longestPage
      ) {
        reachedEnd = true;
        break;
      }
    }

    // Parse failures first: they are the case that destroys data, and they are
    // a different thing from a read that is merely short.
    if (rawRowsSeen > 0 && decoded.length === 0) {
      return strictInvalidContract(
        `panel returned ${rawRowsSeen} user rows and none carried a usable uuid`,
      );
    }
    if (decoded.length !== rawRowsSeen) {
      // A row we could not key is a row that will MISS in the overlay map, and
      // a miss is written EXPIRED. Never hand out a list we know is short.
      return strictInvalidContract(
        `panel user list decoded ${decoded.length} of ${rawRowsSeen} rows`,
      );
    }
    if (!reachedEnd) {
      // Truncated, not broken. Every row we hold is real; there are simply more
      // of them than the page budget allows. Handing this back as `ok` with
      // `complete: false` is what keeps the per-uuid confirmation path alive.
      this.logger.warn(
        `strictGetAllPanelUsers stopped at the ${maxPages}-page ceiling holding ${rawRowsSeen} rows ` +
          `(panel total ${totalReported ?? 'unreported'}); the list is a PREFIX — a miss must be confirmed per-uuid`,
      );
      return strictOk(
        { users: decoded, total: totalReported ?? decoded.length, complete: false },
        detectedVersion,
      );
    }
    if (rawRowsSeen === 0 && totalReported !== 0) {
      // Zero rows carry no information on their own: "the panel has no users"
      // and "this build answered the query with an empty page" look identical,
      // and reading the first as the second mass-expires a whole customer base.
      // The one empty list we may trust is the one the panel confirms.
      //
      // The KEYSET response has no `total` to confirm with — neither 2.8.35 nor
      // 3.2.2 puts one on `/api/users/stream` — so a genuinely empty panel would
      // be permanently unreadable on those versions if `total` were the only
      // accepted proof. There the confirmation is `hasMore: false`, which the
      // walk turns into `reachedEnd`: the panel said "that is all of them", and
      // that is the same statement `total: 0` makes on the offset route.
      const confirmedEmpty = usersStream ? reachedEnd : totalReported === 0;
      if (!confirmedEmpty) {
        return strictInvalidContract(
          totalReported === null
            ? 'panel served no user rows and reported no usable total'
            : `panel served no user rows but reported a total of ${totalReported}`,
        );
      }
    }
    if (totalReported !== null && decoded.length !== totalReported) {
      return strictInvalidContract(
        `panel user list decoded ${decoded.length} of ${totalReported} rows`,
      );
    }
    return strictOk(
      { users: decoded, total: totalReported ?? decoded.length, complete: true },
      detectedVersion,
    );
  }

  /**
   * Exact single-HWID delete with a STABLE body `{ userUuid, hwid }` (never a
   * row-owner field). Returns the remaining `total` on success; 404 → the row
   * was already absent (`notFound`) — the caller treats that as idempotent
   * success only after a strict read-back.
   */
  public async strictDeleteUserDevice(
    ref: PanelUserRef,
    hwid: string,
    era: PanelEraObservation,
  ): Promise<RemnawaveStrictOutcome<{ readonly total: number }>> {
    // THE CALLER'S OBSERVATION, REQUIRED — the last destructive method that
    // took its own. It already collapsed the two readings INSIDE this method
    // into one (the owner key in the body and the segment in the path must at
    // minimum describe the same panel), but that left the reading its GUARD
    // decided on and the reading this address is built from as two separate
    // reads of a value that caches failure for fifteen seconds. The guard
    // seeing `'unknown'` — the deliberate fail-open, which stays — while this
    // method saw `'id'` a moment later is the whole hazard: the `'id'` branch
    // falls back through `remnawavePanelId` → the short uuid from `config_url`
    // → `remnawavePanelUsername` and unbinds a device from whatever profile is
    // LIVE at that address.
    //
    // REQUIRED rather than optional, matching `deletePanelUser`,
    // `deletePanelUserDevice`, `deleteAllPanelUserDevices` and
    // `regeneratePanelUserSubscription`: with exactly one caller the ripple is
    // contained, and required is what makes "this cannot re-read the era" a
    // property of the type rather than of a convention.
    const { addressing } = era;
    const segment = await this.segmentFor(ref, 'strict delete device', era);
    if (segment === null) return strictUnavailable();
    const transport = await this.strictHttp('post', PANEL_ROUTES.deleteHwidDevice, {
      ...panelDeviceOwnerKey(segment, addressing),
      hwid,
    });
    if (transport.kind !== 'ok') return this.mapStrictTransport(transport);
    const root = (transport.data as { response?: unknown })?.response ?? transport.data;
    const record = (root ?? {}) as { total?: unknown; devices?: unknown };
    const total =
      typeof record.total === 'number' && Number.isInteger(record.total)
        ? record.total
        : Array.isArray(record.devices)
          ? record.devices.length
          : null;
    if (total === null) {
      return strictInvalidContract('device delete response missing a numeric total');
    }
    return strictOk({ total }, this.readEnvelopeVersion(transport.data));
  }

  /** Validates + decodes a strict user object from a `{ response }` envelope. */
  private parseStrictUser(data: unknown): RemnawaveStrictOutcome<RemnawaveStrictUser> {
    const root = (data as { response?: unknown })?.response ?? data;
    if (root === null || typeof root !== 'object') {
      return strictInvalidContract('user envelope is not an object');
    }
    const r = root as Record<string, unknown>;
    // Same rule as `parsePanelUserRow`, and for the same reason: the ROW says
    // which era it came from. A 2.x row carries `uuid`; a 3.x row has no such
    // key and is named by the numeric `id`. Reading the row rather than asking
    // `getPanelShape()` keeps this decoder synchronous and correct even while
    // version detection is momentarily down.
    //
    // Test ABSENCE (`=== undefined`), not emptiness. A 2.x row whose uuid came
    // back as `''` is DAMAGED and must stay undecodable — falling back to the id
    // there would quietly accept a row this parser exists to reject.
    const panelId =
      typeof r['id'] === 'number' && Number.isSafeInteger(r['id']) ? (r['id'] as number) : null;
    const uuid =
      r['uuid'] === undefined ? (panelId !== null ? String(panelId) : undefined) : r['uuid'];
    const status = r['status'];
    const createdAt = r['createdAt'];
    const traffic = r['trafficLimitBytes'];
    const devices = r['hwidDeviceLimit'];
    const tag = r['tag'];
    const trafficLimitStrategy = r['trafficLimitStrategy'];
    const activeInternalSquads = r['activeInternalSquads'];
    const externalSquadUuid = r['externalSquadUuid'];
    if (typeof uuid !== 'string' || uuid.length === 0) {
      return strictInvalidContract('user has neither a uuid nor a numeric id');
    }
    if (typeof status !== 'string' || status.length === 0) {
      return strictInvalidContract('user missing status');
    }
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
      return strictInvalidContract('user createdAt is not a valid timestamp');
    }
    if (typeof traffic !== 'number' || !Number.isFinite(traffic) || traffic < 0) {
      return strictInvalidContract('user trafficLimitBytes is not a non-negative number');
    }
    if (devices !== null && (typeof devices !== 'number' || !Number.isInteger(devices) || devices < 0)) {
      return strictInvalidContract('user hwidDeviceLimit is not a non-negative integer or null');
    }
    const normalizedTag = tag === null ? null : typeof tag === 'string' ? tag : null;
    if (tag !== null && normalizedTag === null) {
      return strictInvalidContract('user tag is not a string or null');
    }
    if (normalizedTag !== null && !isUpstreamTag(normalizedTag)) {
      return strictInvalidContract('user tag is not upstream-compatible');
    }
    if (typeof trafficLimitStrategy !== 'string' || !isUpstreamTrafficLimitStrategy(trafficLimitStrategy)) {
      return strictInvalidContract('user trafficLimitStrategy is not upstream-compatible');
    }
    if (!Array.isArray(activeInternalSquads)) {
      return strictInvalidContract('user activeInternalSquads is not an array');
    }
    const normalizedActiveInternalSquads: string[] = [];
    for (const rawSquad of activeInternalSquads) {
      const squadUuid =
        typeof rawSquad === 'string'
          ? rawSquad
          : rawSquad !== null && typeof rawSquad === 'object'
            ? (rawSquad as Record<string, unknown>)['uuid']
            : null;
      if (!isUuid(squadUuid)) {
        return strictInvalidContract('user activeInternalSquads is not an array of UUIDs');
      }
      normalizedActiveInternalSquads.push(squadUuid);
    }
    const normalizedExternalSquadUuid =
      externalSquadUuid === null
        ? null
        : typeof externalSquadUuid === 'string'
          ? externalSquadUuid
          : null;
    if (externalSquadUuid !== null && normalizedExternalSquadUuid === null) {
      return strictInvalidContract('user externalSquadUuid is not a UUID or null');
    }
    if (normalizedExternalSquadUuid !== null && !isUuid(normalizedExternalSquadUuid)) {
      return strictInvalidContract('user externalSquadUuid is not a UUID or null');
    }
    const normalizedDeviceLimit = devices === null ? null : devices as number;
    return strictOk(
      {
        uuid,
        panelId,
        status,
        createdAt,
        tag: normalizedTag,
        trafficLimitStrategy,
        activeInternalSquads: normalizedActiveInternalSquads,
        externalSquadUuid: normalizedExternalSquadUuid,
        // Canonical unlimited: upstream 0 decodes to null.
        trafficLimitBytes: traffic === 0 ? null : BigInt(Math.trunc(traffic)),
        hwidDeviceLimit: normalizedDeviceLimit === 0 ? null : normalizedDeviceLimit,
      },
      this.readEnvelopeVersion(data),
    );
  }

  /** Best-effort panel-version read from a response envelope (else null). */
  private readEnvelopeVersion(data: unknown): string | null {
    const version = (data as { version?: unknown })?.version;
    return typeof version === 'string' && version.length > 0 ? version : null;
  }

  /**
   * The mapping used by the reads whose `notFound` LICENSES DESTRUCTION.
   *
   * {@link strictGetPanelUserExpiry} answers exactly one question — "is this
   * profile still on the panel?" — and every caller acts on `notFound` by
   * destroying state: the expired-profile sweep deletes the subscription
   * (terminates entitlements, closes terms, `status = DELETED`, enqueues a panel
   * DELETE), and the backup importers write EXPIRED over a live row. So here a
   * 404 only means "gone" when the PANEL said so: Remnawave answers a missing
   * user with its own no-such-user envelope — and on THIS route that envelope is
   * `A063` / "User with specified params not found", not the `A025` the write
   * endpoints answer with; both are pinned in `PANEL_USER_NOT_FOUND_ERROR_CODES`. A bare 404 carries no envelope
   * — a reverse proxy mid-deploy, a wrong host, an upstream with no healthy
   * backend — and during one of those EVERY request 404s, so reading it as
   * "gone" deletes a whole batch of live subscriptions per sweep: precisely the
   * population (renewed on the panel, stale locally) the re-check exists to
   * protect. Those map to `unavailable`, so the callers defer and re-ask.
   *
   * Deliberately NOT folded into {@link mapStrictTransport}:
   *   • the device endpoints ({@link strictListUserDevices},
   *     {@link strictDeleteUserDevice}) raise their own 404s under different
   *     codes, and demanding A025 there would stop an already-absent HWID delete
   *     from being idempotent on a healthy panel;
   *   • {@link strictGetPanelUser} keeps the plain mapping — its only `notFound`
   *     consumer (the profile-sync read-back) already fails closed, and softening
   *     that 404 to `unavailable` would turn a terminal job into a retrying one.
   */
  private mapStrictProfileTransport<T>(
    transport: StrictTransportFailure,
  ): RemnawaveStrictOutcome<T> {
    if (
      transport.kind === 'status' &&
      transport.status === 404 &&
      !isPanelUserNotFound(transport.data)
    ) {
      this.logger.warn(
        'Remnawave strict profile read: a bare 404 with no USER_NOT_FOUND envelope is a gateway/proxy answer, ' +
          'not a missing profile — reported as unavailable so the caller defers instead of deleting',
      );
      return strictUnavailable(transport.retryAfterMs);
    }
    return this.mapStrictTransport(transport);
  }

  /** Maps a non-ok transport result onto a normalized strict outcome. */
  private mapStrictTransport<T>(transport: StrictTransportFailure): RemnawaveStrictOutcome<T> {
    if (transport.kind === 'network') return strictUnavailable();
    const { status, retryAfterMs } = transport;
    const statusClass = classifyUpstreamStatus(status);
    // The panel changed era between the moment this request was addressed and
    // the moment it was refused — proven by a forced version re-read, not
    // guessed from the status. The request was built wrong, the next one will
    // not be, so the caller must defer rather than give up. See
    // `panelShapeMovedUnderUs`.
    if (
      transport.addressingChanged === true &&
      (statusClass === 'rejected' || statusClass === 'unsupported')
    ) {
      return strictUnavailable(retryAfterMs);
    }
    switch (statusClass) {
      case 'notFound':
        return strictNotFound();
      case 'unsupported':
        return strictUnsupported();
      case 'unavailable':
        return strictUnavailable(retryAfterMs);
      case 'rejected':
        // 400/401/403/409/... — a terminal contract/auth rejection. Non-retryable
        // by hot-loop; the caller raises an incident.
        return strictInvalidContract(`upstream rejected with status ${status}`);
    }
  }

  /**
   * The legacy (throwing) counterpart of {@link mapStrictTransport}: turns a
   * caught transport error into the exception whose recovery class matches what
   * actually happened upstream.
   *
   *  - the panel refused the request on its merits (`rejected`) or does not
   *    serve the endpoint (`unsupported`) → {@link RemnawaveUpstreamRejectionError},
   *    which callers classify TERMINAL: retrying identical bytes cannot help,
   *    and someone must be told.
   *  - anything else — a network error, a timeout, 408/429/5xx, and a bare 404
   *    (a proxy with no healthy backend answers that way) →
   *    `ServiceUnavailableException`, i.e. unchanged, still retryable. A panel
   *    restart must never become a dead job.
   *
   * `addressingChanged` is the one thing that moves a refusal back into the
   * retryable arm, and it is never inferred here: the caller obtains it from
   * {@link shapeMovedFor}, which re-reads the panel's own version and finds it
   * has moved. Neither an upgrade nor a rollback should leave dead jobs behind.
   */
  private upstreamFailure(
    err: unknown,
    method: string,
    url: string,
    addressingChanged = false,
  ): Error {
    if (isAxiosError(err) && err.response !== undefined && !addressingChanged) {
      const statusClass = classifyUpstreamStatus(err.response.status);
      if (statusClass === 'rejected' || statusClass === 'unsupported') {
        return new RemnawaveUpstreamRejectionError(err.response.status, method, url);
      }
    }
    return new ServiceUnavailableException('Remnawave integration is unavailable');
  }

  /**
   * Raw transport for strict operations. Unlike {@link requestJson} it does
   * NOT collapse failures into a single exception: it distinguishes an HTTP
   * status response (with a parsed `Retry-After`) from a network/timeout error
   * and from a not-configured integration, so the strict mappers can classify
   * the outcome.
   */
  private async strictHttp(
    method: 'get' | 'post' | 'patch' | 'delete',
    url: string,
    body?: Record<string, unknown>,
  ): Promise<{ readonly kind: 'ok'; readonly data: unknown } | StrictTransportFailure> {
    const baseUrl = this.getBaseUrl();
    const token = this.configuration.token;
    if (baseUrl === null || token === null) {
      return { kind: 'network' };
    }
    try {
      const response = await firstValueFrom(
        this.httpService.request<unknown>({
          method,
          url,
          baseURL: baseUrl,
          data: body,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            'x-forwarded-for': '127.0.0.1',
            'x-forwarded-proto': 'https',
          },
        }),
      );
      return { kind: 'ok', data: response.data };
    } catch (err: unknown) {
      if (isAxiosError(err) && err.response !== undefined) {
        const status = err.response.status;
        const retryAfterMs = parseRetryAfterMs(err.response.headers);
        this.logger.warn(`Remnawave strict ${method.toUpperCase()} ${url} → HTTP ${status}`);
        return {
          kind: 'status',
          status,
          retryAfterMs,
          data: err.response.data,
          addressingChanged: await this.shapeMovedFor(err),
        };
      }
      this.logger.warn(
        `Remnawave strict ${method.toUpperCase()} ${url} transport error: ${(err as Error).message}`,
      );
      return { kind: 'network' };
    }
  }

  private async requestJson<TResponse>(input: {
    readonly method: 'post' | 'get' | 'put' | 'delete' | 'patch';
    readonly url: string;
  }): Promise<TResponse> {
    const baseUrl = this.getBaseUrl();
    const token = this.configuration.token;
    if (baseUrl === null || token === null) {
      throw new ServiceUnavailableException('Remnawave integration is not configured');
    }
    try {
      const response = await firstValueFrom(
        this.httpService.request<TResponse>({
          method: input.method,
          url: input.url,
          baseURL: baseUrl,
          headers: {
            Authorization: `Bearer ${token}`,
            'x-forwarded-for': '127.0.0.1',
            'x-forwarded-proto': 'https',
          },
        }),
      );
      return response.data;
    } catch (err: unknown) {
      // Log once at the transport layer so the ~30 read methods that swallow
      // this into a null/[]/{} fallback are still observable (a panel outage
      // is otherwise indistinguishable from "no data").
      this.logger.warn(
        `Remnawave ${input.method.toUpperCase()} ${input.url} failed: ${(err as Error).message}`,
      );
      throw this.upstreamFailure(err, input.method, input.url, await this.shapeMovedFor(err));
    }
  }

  private async requestJsonWithBody<TResponse>(
    method: 'post' | 'put' | 'patch' | 'delete',
    url: string,
    body: Record<string, unknown>,
  ): Promise<TResponse> {
    const baseUrl = this.getBaseUrl();
    const token = this.configuration.token;
    if (baseUrl === null || token === null) {
      throw new ServiceUnavailableException('Remnawave integration is not configured');
    }
    try {
      const response = await firstValueFrom(
        this.httpService.request<TResponse>({
          method,
          url,
          baseURL: baseUrl,
          data: body,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-forwarded-for': '127.0.0.1',
            'x-forwarded-proto': 'https',
          },
        }),
      );
      return response.data;
    } catch (err: unknown) {
      this.logger.error(`Remnawave ${method.toUpperCase()} ${url} failed: ${(err as Error).message}`);
      throw this.upstreamFailure(err, method, url, await this.shapeMovedFor(err));
    }
  }

  /**
   * Builds the upstream Remnawave base URL. The rules, and why each one exists,
   * live in `panel-base-url.ts`; the host classification there is shared with
   * reiwa's `resolveRezeisAdminUrl()` so the same host works the same way on
   * both ends of the integration.
   *
   * The only asymmetry between the two: `REMNAWAVE_PORT` has no default here,
   * so "the operator set a port" is a signal this side can read and reiwa's
   * cannot (`REZEIS_PORT` defaults to 8000).
   */
  private getBaseUrl(): string | null {
    const resolved = resolvePanelBaseUrl(this.configuration.host, this.configuration.port);
    // Once per service instance, not once per request: this runs on every call,
    // and a line repeated a thousand times an hour is a line nobody reads.
    if (resolved.warning !== null && !this.baseUrlWarningIssued) {
      this.baseUrlWarningIssued = true;
      this.logger.warn(resolved.warning);
    }
    return resolved.url;
  }

  private isConfigured(): boolean {
    return this.getBaseUrl() !== null && this.configuration.token !== null;
  }
}
