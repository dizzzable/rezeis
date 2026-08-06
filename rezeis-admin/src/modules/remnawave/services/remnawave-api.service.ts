import { HttpService } from '@nestjs/axios';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { GetExternalSquadsCommand, GetInternalSquadsCommand, GetStatusCommand } from '@remnawave/backend-contract';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

import { remnawaveConfig } from '../../../common/config/remnawave.config';
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
 * True only when a 404 body is Remnawave's own USER_NOT_FOUND error envelope
 * (`code: 'A025'`, or the literal "User not found" message) — i.e. the panel
 * itself says the profile is gone. A generic 404 from a proxy/gateway carries
 * no such envelope and returns false, so it is treated as a transient outage
 * rather than a missing profile (which would trigger a destructive detach).
 */
function isPanelUserNotFound(data: unknown): boolean {
  if (data === null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  if (record['errorCode'] === 'A025' || record['code'] === 'A025') return true;
  const message = record['message'];
  return typeof message === 'string' && message.toLowerCase().includes('user not found');
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
    }
  | { readonly kind: 'network' };

/**
 * Remnawave panel user — shape returned by the panel API.
 */
export interface RemnawavePanelUser {
  uuid: string;
  username: string;
  status: string;
  subscriptionUrl: string;
  telegramId: number | null;
  /** Panel-internal numeric id (BigInt). `ip-control` keys users by this. */
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
 * What it does NOT prove is that these rows are a consistent SNAPSHOT of the
 * panel. `/api/users` is paginated by numeric OFFSET over a list that keeps
 * mutating: delete one user between page 0 and page 1 and every later row
 * shifts one place left, so one live user is never served to us — and the
 * arithmetic still reconciles, because the panel's own `total` fell by exactly
 * the same one. The count check cannot see that; it is self-fulfilling.
 *
 * So a MISS in this list is strong EVIDENCE that the panel no longer has the
 * profile — it is not proof. Anything destructive keyed off a miss (writing
 * EXPIRED, deleting) needs a second signal that does not come from this page
 * walk. The cheap one, deliberately NOT built here: re-read that single uuid
 * (`GET /api/users/{uuid}`) and require a 404 before acting — the same
 * confirmation an incomplete read already forces, just applied to a complete
 * one too. (Keyset pagination over a stable key would remove the shift at the
 * source, but the panel API is offset-based.)
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
 * Unwraps the Remnawave `{ response: {...} }` envelope returned by the
 * create/update user endpoints. The panel wraps the user object under
 * `response`; callers need the inner object so `uuid` / `subscriptionUrl`
 * are read correctly (otherwise the profile link is silently lost — the
 * sync job "completes" but `remnawaveId` is never persisted).
 */
function unwrapPanelUser(raw: unknown): RemnawavePanelUser {
  const root = (raw as { response?: unknown } | null)?.response ?? raw;
  return root as RemnawavePanelUser;
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
    const userId = typeof r['userId'] === 'string' ? r['userId'] : null;
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

  public constructor(
    private readonly httpService: HttpService,
    @Inject(remnawaveConfig.KEY)
    private readonly configuration: ConfigType<typeof remnawaveConfig>,
  ) {}

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
    return unwrapPanelUser(raw);
  }

  /**
   * Updates a user on the Remnawave panel.
   * Donor: `remnawave_sync_crud.updated_user`.
   */
  public async updatePanelUser(
    uuid: string,
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
    const body: Record<string, unknown> = { uuid };
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
      return unwrapPanelUser(response.data);
    } catch (err: unknown) {
      // Only a 404 that carries Remnawave's own USER_NOT_FOUND envelope (code
      // A025 / "User not found") means the profile is genuinely gone. A bare 404
      // from a reverse proxy / gateway during a deploy, a wrong host, or an
      // upstream with no healthy backends must NOT be read as "profile missing"
      // — otherwise a host outage would mass-detach valid remnawaveIds. Those
      // fall through to ServiceUnavailableException and retry harmlessly.
      if (isAxiosError(err) && err.response?.status === 404 && isPanelUserNotFound(err.response.data)) {
        this.logger.warn(`Remnawave PATCH /api/users: profile ${uuid} not found (404 A025)`);
        throw new RemnawaveProfileNotFoundError(uuid);
      }
      this.logger.error(`Remnawave PATCH /api/users failed: ${(err as Error).message}`);
      // A 400 here is a rejected body (a status the panel does not accept, a
      // field it does not allow), not an outage — see `upstreamFailure`.
      throw this.upstreamFailure(err, 'patch', '/api/users');
    }
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
   */
  public async deletePanelUser(uuid: string): Promise<{ isDeleted: boolean }> {
    const baseUrl = this.getBaseUrl();
    const token = this.configuration.token;
    if (baseUrl === null || token === null) {
      throw new ServiceUnavailableException('Remnawave integration is not configured');
    }
    try {
      const response = await firstValueFrom(
        this.httpService.request<{ response?: { isDeleted?: boolean }; isDeleted?: boolean }>({
          method: 'delete',
          url: `/api/users/${uuid}`,
          baseURL: baseUrl,
          headers: {
            Authorization: `Bearer ${token}`,
            'x-forwarded-for': '127.0.0.1',
            'x-forwarded-proto': 'https',
          },
        }),
      );
      const data = response.data;
      const isDeleted = data?.response?.isDeleted ?? data?.isDeleted ?? true;
      return { isDeleted };
    } catch (err: unknown) {
      if (isAxiosError(err) && err.response?.status === 404) {
        this.logger.warn(`Remnawave profile ${uuid} already absent (404) — treating delete as success`);
        return { isDeleted: true };
      }
      this.logger.error(`Remnawave DELETE /api/users/${uuid} failed: ${(err as Error).message}`);
      throw this.upstreamFailure(err, 'delete', `/api/users/${uuid}`);
    }
  }

  /**
   * Resets traffic counter for a user on the panel.
   */
  public async resetPanelUserTraffic(uuid: string): Promise<void> {
    await this.requestJson({ method: 'post', url: `/api/users/${uuid}/actions/reset-traffic` });
  }

  /**
   * Gets a user by UUID from the panel.
   *
   * Tolerates both the modern Remnawave shape `{ response: {...} }` and
   * the older flat layout. Falls through to `null` on any upstream error
   * so the caller can render a graceful placeholder rather than crash.
   */
  public async getPanelUser(uuid: string): Promise<RemnawavePanelUser | null> {
    try {
      const result = await this.requestJson<unknown>({ method: 'get', url: `/api/users/${uuid}` });
      const root = (result as { response?: unknown })?.response ?? result;
      if (root === null || typeof root !== 'object') return null;
      return root as RemnawavePanelUser;
    } catch {
      return null;
    }
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
        url: `/api/users/by-username/${encodeURIComponent(username)}`,
      });
      const root = (result as { response?: unknown })?.response ?? result;
      if (root === null || typeof root !== 'object') return null;
      const record = root as Record<string, unknown>;
      if (typeof record['uuid'] !== 'string') return null;
      return record as unknown as RemnawavePanelUser;
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
    uuid: string,
  ): Promise<{
    username: string | null;
    usedTrafficBytes: number | null;
    status: string | null;
    expireAt: string | null;
    trafficLimitBytes: number | null;
    hwidDeviceLimit: number | null;
  } | null> {
    try {
      const result = await this.requestJson<unknown>({ method: 'get', url: `/api/users/${uuid}` });
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
    uuid: string,
  ): Promise<RemnawaveStrictOutcome<RemnawaveHwidDeviceList>> {
    const transport = await this.strictHttp('get', `/api/hwid/devices/${uuid}`);
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
   */
  public async deletePanelUserDevice(userUuid: string, hwid: string): Promise<{ total: number }> {
    const result = await this.requestJsonWithBody<unknown>('post', '/api/hwid/devices/delete', {
      userUuid,
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
   */
  public async deleteAllPanelUserDevices(userUuid: string): Promise<{ total: number }> {
    const result = await this.requestJsonWithBody<unknown>('post', '/api/hwid/devices/delete-all', {
      userUuid,
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
   * Regenerates (revokes) a user's subscription link on the panel — the old
   * short UUID is invalidated and a brand-new subscription URL is issued, so
   * every previously-distributed link stops working.
   *
   * Remnawave 2.7.x contract: `POST /api/users/{uuid}/actions/revoke`. Passing
   * no body (or an empty one) rotates the short UUID; the response carries the
   * fresh `subscriptionUrl`. Returns the new URL (or `null` if the panel
   * omitted it).
   */
  public async regeneratePanelUserSubscription(uuid: string): Promise<{ subscriptionUrl: string | null }> {
    const result = await this.requestJsonWithBody<unknown>(
      'post',
      `/api/users/${uuid}/actions/revoke`,
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

  /**
   * Decodes one `/api/users` row into a {@link RemnawavePanelUser}.
   *
   * Returns `null` for a row we cannot key — the `uuid` is the row's identity
   * everywhere downstream (`Subscription.remnawaveId`, the sharing-detector
   * fingerprint, the overlay map key), and an empty one collapses every such
   * row onto a single bucket. Callers MUST NOT quietly shorten a list by the
   * nulls: {@link strictGetAllPanelUsers} counts them and refuses instead.
   */
  private parsePanelUserRow(candidate: unknown): RemnawavePanelUser | null {
    if (typeof candidate !== 'object' || candidate === null) return null;
    const value = candidate as Record<string, unknown>;
    const uuid = typeof value.uuid === 'string' ? value.uuid : '';
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
      panelId: typeof value.id === 'number' ? value.id : null,
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
   * Top users by HWID device count — fastest fraud signal in the panel.
   * 2.7.x wraps the list under `users`, older builds used `topUsers`.
   */
  public async getHwidTopUsers(): Promise<readonly RemnawaveHwidTopUserInterface[]> {
    try {
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: '/api/hwid/devices/top-users',
      });
      const root = (response as { response?: unknown })?.response ?? response;
      const list = Array.isArray(root)
        ? root
        : Array.isArray((root as { users?: unknown })?.users)
          ? ((root as { users: unknown[] }).users)
          : Array.isArray((root as { topUsers?: unknown })?.topUsers)
            ? ((root as { topUsers: unknown[] }).topUsers)
            : [];
      return list.map(mapHwidTopUser);
    } catch {
      return [];
    }
  }

  // ── ip-control: active sessions / source IPs ──────────────────────────────

  /**
   * Fetches online users and their source IPs for a single node — the data
   * behind the panel's "Active sessions" view. Async on the panel side:
   * `POST fetch-users-ips/{nodeUuid}` returns a `jobId` we then poll.
   * Returns `[]` on any failure/timeout (fail-soft for the detector).
   */
  public async fetchUsersIpsForNode(nodeUuid: string): Promise<readonly RemnawaveNodeUserIps[]> {
    try {
      const started = await this.requestJsonWithBody<{ response?: { jobId?: string } }>(
        'post',
        `/api/ip-control/fetch-users-ips/${nodeUuid}`,
        {},
      );
      const jobId = started?.response?.jobId;
      if (typeof jobId !== 'string' || jobId.length === 0) return [];
      const users = await this.pollIpControlJob(
        (id) => `/api/ip-control/fetch-users-ips/result/${id}`,
        jobId,
        mapNodeUsersIps,
      );
      return users ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Per-user IP drilldown across nodes (`POST fetch-ips/{uuid}` → poll).
   * Used for on-demand inspection of one flagged user. Fail-soft → `[]`.
   */
  public async fetchUserIps(userUuid: string): Promise<readonly RemnawaveUserNodeIps[]> {
    try {
      const started = await this.requestJsonWithBody<{ response?: { jobId?: string } }>(
        'post',
        `/api/ip-control/fetch-ips/${userUuid}`,
        {},
      );
      const jobId = started?.response?.jobId;
      if (typeof jobId !== 'string' || jobId.length === 0) return [];
      const nodes = await this.pollIpControlJob(
        (id) => `/api/ip-control/fetch-ips/result/${id}`,
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
    await this.requestJsonWithBody(
      'post',
      '/api/ip-control/drop-connections',
      input as unknown as Record<string, unknown>,
    );
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
        if (resp?.isCompleted === true) return extract(resp.result);
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
    readonly userUuid?: string;
    /** Page size. Ignored on the per-user route, which is fixed at 24 upstream. */
    readonly limit?: number;
  } = {}): Promise<readonly RemnawaveSubscriptionRequestEntryInterface[]> {
    try {
      let url: string;
      if (input.userUuid !== undefined && input.userUuid.length > 0) {
        url = `/api/users/${encodeURIComponent(input.userUuid)}/subscription-request-history`;
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
    try {
      let url: string | null = null;
      if (input.subscriptionUuid) {
        url = `/api/users/by-short-uuid/${encodeURIComponent(input.subscriptionUuid)}`;
      } else if (input.username) {
        url = `/api/users/by-username/${encodeURIComponent(input.username)}`;
      } else if (input.email) {
        url = `/api/users/by-email/${encodeURIComponent(input.email)}`;
      } else if (input.telegramId) {
        url = `/api/users/by-telegram-id/${encodeURIComponent(input.telegramId)}`;
      }
      if (url === null) return null;
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

  public async getInternalSquadOptions(): Promise<readonly RemnawaveSquadOptionInterface[]> {
    const payload = await this.requestJson<GetInternalSquadsCommand.Response>({
      method: GetInternalSquadsCommand.endpointDetails.REQUEST_METHOD,
      url: GetInternalSquadsCommand.url,
    });
    const parsedPayload = GetInternalSquadsCommand.ResponseSchema.safeParse(payload);
    if (!parsedPayload.success) {
      throw new ServiceUnavailableException('Remnawave internal squads are unavailable');
    }
    return parsedPayload.data.response.internalSquads.map((squad) => ({
      uuid: squad.uuid,
      name: squad.name,
    }));
  }

  /**
   * Returns full-shape internal squads with `membersCount` / `inboundsCount`
   * counters, used by the admin "Remnawave → Squads" tab. Falls back to the
   * Zod-validated option payload when the upstream omits the `info` block
   * (older panels), so the call always returns sane numbers.
   */
  public async getInternalSquadDetails(): Promise<readonly RemnawaveInternalSquadDetailInterface[]> {
    const payload = await this.requestJson<unknown>({
      method: GetInternalSquadsCommand.endpointDetails.REQUEST_METHOD,
      url: GetInternalSquadsCommand.url,
    });
    return mapInternalSquadDetails(payload);
  }

  public async getExternalSquadOptions(): Promise<readonly RemnawaveSquadOptionInterface[]> {
    const payload = await this.requestJson<GetExternalSquadsCommand.Response>({
      method: GetExternalSquadsCommand.endpointDetails.REQUEST_METHOD,
      url: GetExternalSquadsCommand.url,
    });
    const parsedPayload = GetExternalSquadsCommand.ResponseSchema.safeParse(payload);
    if (!parsedPayload.success) {
      throw new ServiceUnavailableException('Remnawave external squads are unavailable');
    }
    return parsedPayload.data.response.externalSquads.map((squad) => ({
      uuid: squad.uuid,
      name: squad.name,
    }));
  }

  /**
   * Returns full-shape external squads with the `membersCount` counter,
   * used by the admin "Remnawave → Squads" tab.
   */
  public async getExternalSquadDetails(): Promise<readonly RemnawaveExternalSquadDetailInterface[]> {
    const payload = await this.requestJson<unknown>({
      method: GetExternalSquadsCommand.endpointDetails.REQUEST_METHOD,
      url: GetExternalSquadsCommand.url,
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
      const payload = await this.requestJson<GetStatusCommand.Response>({
        method: GetStatusCommand.endpointDetails.REQUEST_METHOD,
        url: GetStatusCommand.url,
      });
      const parsedPayload = GetStatusCommand.ResponseSchema.safeParse(payload);
      if (!parsedPayload.success) {
        throw new ServiceUnavailableException('Remnawave auth status is unavailable');
      }
      const { response } = parsedPayload.data;
      return {
        isConfigured: true,
        isReachable: true,
        isLoginAllowed: response.isLoginAllowed,
        isRegisterAllowed: response.isRegisterAllowed,
        authentication: response.authentication === null
          ? null
          : {
              passwordEnabled: response.authentication.password.enabled,
              passkeyEnabled: response.authentication.passkey.enabled,
              oauth2Providers: response.authentication.oauth2.providers,
            },
        branding: response.branding,
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
  public async strictGetPanelUser(uuid: string): Promise<RemnawaveStrictOutcome<RemnawaveStrictUser>> {
    const transport = await this.strictHttp('get', `/api/users/${uuid}`);
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
    uuid: string,
  ): Promise<RemnawaveStrictOutcome<RemnawavePanelExpirySnapshot>> {
    const transport = await this.strictHttp('get', `/api/users/${uuid}`);
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
    uuid: string,
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
    const body: Record<string, unknown> = {
      uuid,
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
   */
  public async strictListUserDevices(
    uuid: string,
  ): Promise<RemnawaveStrictOutcome<RemnawaveStrictDeviceList>> {
    const transport = await this.strictHttp('get', `/api/hwid/devices/${uuid}`);
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
      if (hwid.length === 0) return strictInvalidContract('device row has an empty hwid');
      if (createdAt.length === 0) return strictInvalidContract(`device ${hwid} has no createdAt`);
      if (seen.has(hwid)) return strictInvalidContract(`duplicate hwid ${hwid} in device list`);
      seen.add(hwid);
      devices.push({ hwid, createdAt });
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

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      // The cursor is the number of rows we actually hold — NOT
      // `pageIndex * pageSize`. A panel that serves fewer rows than we asked
      // for would otherwise leave a hole the size of the shortfall in every
      // page, and those users would then MISS in the overlay map and be
      // written EXPIRED.
      const transport = await this.strictHttp(
        'get',
        `/api/users/?start=${rawRowsSeen}&size=${pageSize}`,
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
        response?: { users?: unknown; total?: unknown };
        users?: unknown;
        total?: unknown;
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
        const user = this.parsePanelUserRow(candidate);
        if (user !== null) decoded.push(user);
      }

      // End of list, strongest signal first:
      //   • the panel served nothing more;
      //   • we already hold every row the panel says it has;
      //   • the page came up short against the panel's OWN page size. Measuring
      //     that against the size we ASKED for instead would read a
      //     server-side clamp (250, 100) as the end of the list and bless a
      //     quarter of the panel as all of it — the rest would then miss in the
      //     overlay map and be expired.
      if (
        usersPayload.length === 0 ||
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
      return strictInvalidContract(
        totalReported === null
          ? 'panel served no user rows and reported no usable total'
          : `panel served no user rows but reported a total of ${totalReported}`,
      );
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
    userUuid: string,
    hwid: string,
  ): Promise<RemnawaveStrictOutcome<{ readonly total: number }>> {
    const transport = await this.strictHttp('post', '/api/hwid/devices/delete', { userUuid, hwid });
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
    const uuid = r['uuid'];
    const status = r['status'];
    const createdAt = r['createdAt'];
    const traffic = r['trafficLimitBytes'];
    const devices = r['hwidDeviceLimit'];
    const tag = r['tag'];
    const trafficLimitStrategy = r['trafficLimitStrategy'];
    const activeInternalSquads = r['activeInternalSquads'];
    const externalSquadUuid = r['externalSquadUuid'];
    if (typeof uuid !== 'string' || uuid.length === 0) {
      return strictInvalidContract('user missing uuid');
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
   * user with its own USER_NOT_FOUND envelope (`A025` / "User not found" — see
   * the vendored `@remnawave/backend-contract`). A bare 404 carries no envelope
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
    switch (classifyUpstreamStatus(status)) {
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
   */
  private upstreamFailure(err: unknown, method: string, url: string): Error {
    if (isAxiosError(err) && err.response !== undefined) {
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
        return { kind: 'status', status, retryAfterMs, data: err.response.data };
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
      throw this.upstreamFailure(err, input.method, input.url);
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
      throw this.upstreamFailure(err, method, url);
    }
  }

  /**
   * Builds the upstream Remnawave base URL.
   *
   * Resolution mirrors reiwa's `resolveRezeisAdminUrl()` so the same env vars
   * work the same way on both ends of the integration:
   *
   *   • `REMNAWAVE_HOST` looks like a docker service name (no dots, e.g.
   *     `remnawave`, `panel`, `remna-staging`) → `http://${host}:${port}`.
   *     Plain HTTP is fine because traffic stays inside the compose network.
   *   • `REMNAWAVE_HOST` contains a dot (treated as a public domain, e.g.
   *     `panel.example.com`) → `https://${host}` and `REMNAWAVE_PORT` is
   *     ignored — public domains terminate TLS at the standard 443.
   */
  private getBaseUrl(): string | null {
    if (this.configuration.host === null) {
      return null;
    }
    // Heuristic: docker service names never contain a dot. Dotted values are
    // public DNS names (e.g. `panel.example.com`) and always reachable via
    // HTTPS — Remnawave behind any modern reverse proxy redirects HTTP → HTTPS
    // anyway, so we save a round-trip and avoid 301 follow-up edge cases.
    const looksLikeDockerService = !this.configuration.host.includes('.');
    if (looksLikeDockerService) {
      if (this.configuration.port === null) {
        return null;
      }
      return `http://${this.configuration.host}:${this.configuration.port}`;
    }
    return `https://${this.configuration.host}`;
  }

  private isConfigured(): boolean {
    return this.getBaseUrl() !== null && this.configuration.token !== null;
  }
}
