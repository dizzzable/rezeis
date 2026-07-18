import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { GetExternalSquadsCommand, GetInternalSquadsCommand, GetStatusCommand } from '@remnawave/backend-contract';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

import { remnawaveConfig } from '../../../common/config/remnawave.config';
import {
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
  RemnawaveSubscriptionRequestStatsInterface,
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
      trafficLimitStrategy: input.trafficLimitStrategy,
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
    if (input.trafficLimitStrategy !== undefined) body['trafficLimitStrategy'] = input.trafficLimitStrategy;
    if (input.activeInternalSquads !== undefined) body['activeInternalSquads'] = input.activeInternalSquads;
    if (input.externalSquadUuid !== undefined) body['externalSquadUuid'] = input.externalSquadUuid;
    const raw = await this.requestJsonWithBody<unknown>('patch', '/api/users', body);
    return unwrapPanelUser(raw);
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
      throw new ServiceUnavailableException('Remnawave integration is unavailable');
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
   * Best-effort read of a user's *used* traffic (bytes) by UUID.
   *
   * Remnawave moved the counter around between versions: newer panels
   * nest it under `userTraffic.usedTrafficBytes`, older flat layouts
   * exposed `usedTrafficBytes` / `trafficUsedBytes` at the top level.
   * We probe all known shapes and return `null` on any miss or upstream
   * error so callers can render a graceful placeholder rather than
   * crash a hot read path.
   */
  public async getPanelUserUsedTrafficBytes(uuid: string): Promise<number | null> {
    try {
      const result = await this.requestJson<unknown>({ method: 'get', url: `/api/users/${uuid}` });
      const root = (result as { response?: unknown })?.response ?? result;
      if (root === null || typeof root !== 'object') return null;
      const record = root as Record<string, unknown>;
      const nested = record['userTraffic'];
      if (nested !== null && typeof nested === 'object') {
        const used = (nested as Record<string, unknown>)['usedTrafficBytes'];
        const parsed = this.coerceTrafficNumber(used);
        if (parsed !== null) return parsed;
      }
      return (
        this.coerceTrafficNumber(record['usedTrafficBytes']) ??
        this.coerceTrafficNumber(record['trafficUsedBytes'])
      );
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
   * Gets all users by telegram_id from the panel.
   */
  public async getPanelUsersByTelegramId(telegramId: string): Promise<RemnawavePanelUser[]> {
    try {
      const result = await this.requestJson<unknown>({
        method: 'get',
        url: `/api/users/by-telegram-id/${telegramId}`,
      });
      // 2.8 wraps the list under `{ response: { users: [...] } }`; older
      // builds returned a bare array or `{ root: [...] }`. Accept all shapes.
      const root = (result as { response?: unknown })?.response ?? result;
      if (Array.isArray(root)) return root as RemnawavePanelUser[];
      const wrapped =
        (root as { users?: unknown })?.users ?? (root as { root?: unknown })?.root;
      return Array.isArray(wrapped) ? (wrapped as RemnawavePanelUser[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Gets HWID devices for a user by UUID.
   */
  public async getPanelUserDevices(uuid: string): Promise<{ devices: RemnawaveHwidDevice[]; total: number }> {
    try {
      // Remnawave 2.7.x moved the per-user HWID list to
      // `GET /api/hwid/devices/{userUuid}` (matching the `stats`/`top-users`
      // moves). The old `/api/hwid/user/{uuid}` now 404s, which the catch
      // below swallowed — so the cabinet showed "no devices" even when the
      // panel had one bound. Verified shape: `{ total, devices: [...] }`.
      const result = await this.requestJson<unknown>({
        method: 'get',
        url: `/api/hwid/devices/${uuid}`,
      });
      // Remnawave wraps payloads in `{ response: ... }`. Unwrap it (every
      // other call here does) — without this `devices`/`total` were read off
      // the envelope and came back undefined.
      const root = (result as { response?: unknown })?.response ?? result;
      const record = (root ?? {}) as { devices?: unknown; total?: number };
      const devices = Array.isArray(record.devices)
        ? record.devices.map((d) => mapHwidDevice(d))
        : [];
      return {
        devices,
        total: typeof record.total === 'number' ? record.total : devices.length,
      };
    } catch {
      return { devices: [], total: 0 };
    }
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
   * Lists all users on the Remnawave panel, paginating through `/api/users`.
   *
   * Donor: altshop's `RemnawaveSDK.users.get_all` — but since we're inside
   * a Nest project we go via the same HTTP client used everywhere else.
   * The panel returns at most `pageSize` rows per call so we keep
   * iterating until the total is reached. A safety cap of 50 pages
   * (50 × 500 = 25 000 users) protects against runaway responses.
   */
  public async getAllPanelUsers(): Promise<RemnawavePanelUser[]> {
    const pageSize = 500
    const maxPages = 50
    const collected: RemnawavePanelUser[] = []

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const start = pageIndex * pageSize
      let response: { response?: { users?: unknown[]; total?: number }; users?: unknown[]; total?: number } | null = null
      try {
        response = await this.requestJson<typeof response>({
          method: 'get',
          url: `/api/users/?start=${start}&size=${pageSize}`,
        })
      } catch (err) {
        this.logger.warn(`getAllPanelUsers page ${pageIndex} failed: ${(err as Error).message}`)
        break
      }
      if (response === null) break

      const usersPayload = response.response?.users ?? response.users ?? []
      if (!Array.isArray(usersPayload) || usersPayload.length === 0) break

      for (const candidate of usersPayload) {
        if (typeof candidate !== 'object' || candidate === null) continue
        const value = candidate as Record<string, unknown>
        const uuid = typeof value.uuid === 'string' ? value.uuid : ''
        if (uuid.length === 0) continue
        collected.push({
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
        })
      }


      const totalReported = response.response?.total ?? response.total ?? null
      if (typeof totalReported === 'number' && collected.length >= totalReported) break
      if (usersPayload.length < pageSize) break
    }

    return collected
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
   */
  public async restartNode(uuid: string): Promise<void> {
    await this.requestJsonWithBody('post', `/api/nodes/${uuid}/actions/restart`, {});
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
   * window). Used by the per-user node-traffic-abuse detector. Returns `[]` on
   * any failure or on panels that don't expose the endpoint (pre-2.8).
   */
  public async getNodeUsersBandwidth(
    nodeUuids: readonly string[],
  ): Promise<readonly RemnawaveNodeUserBandwidth[]> {
    try {
      const result = await this.requestJsonWithBody<unknown>(
        'post',
        '/api/bandwidth-stats/nodes/users',
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
      return [];
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

  /**
   * Aggregate stats over the subscription request log (who's pulling
   * subscription URLs, broken down by client type / period).
   * Returns null when the panel doesn't expose the endpoint yet.
   */
  public async getSubscriptionRequestHistoryStats(): Promise<RemnawaveSubscriptionRequestStatsInterface | null> {
    try {
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: '/api/subscription-request-history/stats',
      });
      const root = (response as { response?: unknown })?.response ?? response;
      return root as RemnawaveSubscriptionRequestStatsInterface;
    } catch {
      return null;
    }
  }

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
   * Subscription request history — "who's pulling /sub/xxx" log. Used by
   * the Users tab as the per-user click trail.
   * 2.7.x wraps under `records`, newer builds use `entries`.
   */
  public async getSubscriptionRequestHistory(input: {
    readonly userUuid?: string;
    readonly limit?: number;
  } = {}): Promise<readonly RemnawaveSubscriptionRequestEntryInterface[]> {
    try {
      const params = new URLSearchParams();
      if (input.userUuid) params.set('userUuid', input.userUuid);
      if (input.limit !== undefined) params.set('limit', String(input.limit));
      const qs = params.toString();
      const response = await this.requestJson<unknown>({
        method: 'get',
        url: `/api/subscription-request-history${qs.length > 0 ? `?${qs}` : ''}`,
      });
      const root = (response as { response?: unknown })?.response ?? response;
      const list = Array.isArray(root)
        ? root
        : Array.isArray((root as { records?: unknown })?.records)
          ? ((root as { records: unknown[] }).records)
          : Array.isArray((root as { entries?: unknown })?.entries)
            ? ((root as { entries: unknown[] }).entries)
            : [];
      return list.map(mapSubscriptionRequestEntry);
    } catch {
      return [];
    }
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
      ...(desired.trafficLimitStrategy !== undefined
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

  /** Maps a non-ok transport result onto a normalized strict outcome. */
  private mapStrictTransport<T>(
    transport: { readonly kind: 'status'; readonly status: number; readonly retryAfterMs: number | null } | { readonly kind: 'network' },
  ): RemnawaveStrictOutcome<T> {
    if (transport.kind === 'network') return strictUnavailable();
    const { status, retryAfterMs } = transport;
    if (status === 404) return strictNotFound();
    if (status === 405 || status === 501) return strictUnsupported();
    if (status === 408 || status === 429 || status >= 500) return strictUnavailable(retryAfterMs);
    // 400/401/403/409/... — a terminal contract/auth rejection. Non-retryable
    // by hot-loop; the caller raises an incident.
    return strictInvalidContract(`upstream rejected with status ${status}`);
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
  ): Promise<
    | { readonly kind: 'ok'; readonly data: unknown }
    | { readonly kind: 'status'; readonly status: number; readonly retryAfterMs: number | null }
    | { readonly kind: 'network' }
  > {
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
        return { kind: 'status', status, retryAfterMs };
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
      throw new ServiceUnavailableException('Remnawave integration is unavailable');
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
      throw new ServiceUnavailableException('Remnawave integration is unavailable');
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
