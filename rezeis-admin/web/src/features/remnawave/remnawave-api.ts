import { z } from "zod";
import { api } from "@/lib/api";
import { expectArray } from '@/lib/api-utils';

// ── Types ───────────────────────────────────────────────────────────────────

export interface RemnawaveStatus {
  isConfigured: boolean;
  isReachable: boolean;
  isLoginAllowed: boolean | null;
  isRegisterAllowed: boolean | null;
  authentication: {
    passwordEnabled: boolean;
    passkeyEnabled: boolean;
    oauth2Providers: Record<string, boolean>;
  } | null;
  branding: { title: string | null; logoUrl: string | null } | null;
}

export interface RemnawaveNode {
  uuid: string;
  name: string;
  address: string;
  port: number | null;
  isConnected: boolean;
  isDisabled: boolean;
  isConnecting: boolean;
  isTrafficTrackingActive: boolean;
  trafficLimitBytes: number | null;
  trafficUsedBytes: number | null;
  notifyPercent: number | null;
  viewPosition: number;
  countryCode: string;
  consumptionMultiplier: number;
  tags: string[];
  lastStatusChange: string | null;
  lastStatusMessage: string | null;
  createdAt: string;
  updatedAt: string;
  xrayUptime: number;
  usersOnline: number;
  activeConfigProfileUuid: string | null;
}

export interface RemnawaveHost {
  uuid: string;
  viewPosition: number;
  remark: string;
  address: string;
  port: number;
  isDisabled: boolean;
  isHidden: boolean;
  securityLayer: string;
  tag: string | null;
  tags: string[];
  configProfileUuid: string | null;
  configProfileInboundUuid: string | null;
  nodes: string[];
}

export interface RemnawaveSystemStats {
  users: {
    totalUsers: number;
    statusCounts: Record<string, number>;
    onlineStats: {
      lastDay: number;
      lastWeek: number;
      neverOnline: number;
      onlineNow: number;
    };
  };
  nodes: { totalOnline: number; totalBytesLifetime: number };
  cpu: { cores: number };
  memory: { total: number; free: number; used: number };
  uptime: number;
  timestamp: number;
}

export interface RemnawaveSystemRecap {
  thisMonth: { users: number; traffic: number };
  total: {
    users: number;
    nodes: number;
    traffic: number;
    nodesRam: number;
    nodesCpuCores: number;
    distinctCountries: number;
  };
  version: string;
  initDate: string;
}

export interface RemnawaveBandwidthStats {
  bandwidthLastTwoDays: {
    current: number;
    previous: number;
    difference: number;
  };
  bandwidthLastSevenDays: {
    current: number;
    previous: number;
    difference: number;
  };
  bandwidthLast30Days: {
    current: number;
    previous: number;
    difference: number;
  };
  bandwidthCalendarMonth: {
    current: number;
    previous: number;
    difference: number;
  };
  bandwidthCurrentYear: {
    current: number;
    previous: number;
    difference: number;
  };
}

export interface RemnawaveInternalSquad {
  uuid: string;
  name: string;
  viewPosition: number;
  membersCount: number;
  inboundsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RemnawaveExternalSquad {
  uuid: string;
  name: string;
  viewPosition: number;
  membersCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RemnawaveConfigProfile {
  uuid: string;
  name: string;
  viewPosition: number;
  inbounds: {
    uuid: string;
    tag: string;
    type: string;
    network: string | null;
    security: string | null;
    port: number | null;
  }[];
  nodes: { uuid: string; name: string; countryCode: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface RemnawaveSubscriptionSettings {
  uuid: string;
  profileTitle: string;
  supportLink: string | null;
  profileUpdateInterval: number;
  isProfileWebpageUrlEnabled: boolean;
  serveJsonAtBaseSubscription: boolean;
  isShowCustomRemarks: boolean;
  randomizeHosts: boolean;
  // Booleans summarising whether the panel exposes the corresponding payload.
  // Raw config blobs are intentionally hidden — the admin SPA shouldn't see
  // private subscription-rule internals.
  hasHappAnnounce: boolean;
  hasHappRouting: boolean;
  hasResponseRules: boolean;
  hasCustomRemarks: boolean;
}

export interface RemnawaveSubscriptionTemplate {
  uuid: string;
  name: string;
  viewPosition: number;
  templateType: string;
  hasYaml: boolean;
}

export interface RemnawaveHwidStats {
  byPlatform: { platform: string; count: number }[];
  stats: {
    totalUniqueDevices: number;
    totalHwidDevices: number;
    averageHwidDevicesPerUser: number;
  };
}

// ── API calls ────────────────────────────────────────────────────────────────

async function getStatus(): Promise<RemnawaveStatus> {
  const res = await api.get<RemnawaveStatus>("/admin/remnawave/status");
  return res.data;
}

async function getSystemStats(): Promise<RemnawaveSystemStats> {
  const res = await api.get<RemnawaveSystemStats>(
    "/admin/remnawave/system/stats",
  );
  return res.data;
}

async function getSystemRecap(): Promise<RemnawaveSystemRecap> {
  const res = await api.get<RemnawaveSystemRecap>(
    "/admin/remnawave/system/recap",
  );
  return res.data;
}

async function getBandwidthStats(): Promise<RemnawaveBandwidthStats> {
  const res = await api.get<RemnawaveBandwidthStats>(
    "/admin/remnawave/system/bandwidth",
  );
  return res.data;
}

async function getAllNodes(): Promise<RemnawaveNode[]> {
  const res = await api.get("/admin/remnawave/nodes");
  return expectArray<RemnawaveNode>(res.data);
}

async function enableNode(uuid: string): Promise<void> {
  await api.post(`/admin/remnawave/nodes/${encodeURIComponent(uuid)}/enable`);
}

async function disableNode(uuid: string): Promise<void> {
  await api.post(`/admin/remnawave/nodes/${encodeURIComponent(uuid)}/disable`);
}

async function restartNode(uuid: string): Promise<void> {
  await api.post(`/admin/remnawave/nodes/${encodeURIComponent(uuid)}/restart`);
}

async function resetNodeTraffic(uuid: string): Promise<void> {
  await api.post(
    `/admin/remnawave/nodes/${encodeURIComponent(uuid)}/reset-traffic`,
  );
}

async function getAllHosts(): Promise<RemnawaveHost[]> {
  const res = await api.get("/admin/remnawave/hosts");
  return expectArray<RemnawaveHost>(res.data);
}

async function getInternalSquads(): Promise<RemnawaveInternalSquad[]> {
  const res = await api.get("/admin/remnawave/internal-squads");
  return expectArray<RemnawaveInternalSquad>(res.data);
}

async function getExternalSquads(): Promise<RemnawaveExternalSquad[]> {
  const res = await api.get("/admin/remnawave/external-squads");
  return expectArray<RemnawaveExternalSquad>(res.data);
}

async function getConfigProfiles(): Promise<RemnawaveConfigProfile[]> {
  const res = await api.get("/admin/remnawave/config-profiles");
  return expectArray<RemnawaveConfigProfile>(res.data);
}

async function getSubscriptionSettings(): Promise<RemnawaveSubscriptionSettings | null> {
  const res = await api.get<RemnawaveSubscriptionSettings | null>(
    "/admin/remnawave/subscription-settings",
  );
  return res.data;
}

async function getSubscriptionTemplates(): Promise<RemnawaveSubscriptionTemplate[]> {
  const res = await api.get("/admin/remnawave/subscription-templates");
  return expectArray<RemnawaveSubscriptionTemplate>(res.data);
}

async function getHwidStats(): Promise<RemnawaveHwidStats | null> {
  const res = await api.get<RemnawaveHwidStats | null>("/admin/remnawave/hwid/stats");
  return res.data;
}

export interface RemnawaveHwidTopUser {
  userId: number | null
  userUuid: string | null
  username: string
  telegramId: string | null
  devicesCount: number
  lastSeenAt: string | null
}

async function getHwidTopUsers(): Promise<RemnawaveHwidTopUser[]> {
  const res = await api.get("/admin/remnawave/hwid/top-users");
  return expectArray<RemnawaveHwidTopUser>(res.data);
}

export interface RemnawaveHealth {
  status?: string
  message?: string | null
  uptime?: number
  db?: { status?: string }
  redis?: { status?: string }
  version?: string
}

async function getHealth(): Promise<RemnawaveHealth | null> {
  const res = await api.get<RemnawaveHealth | null>("/admin/remnawave/system/health");
  return res.data;
}

// `RemnawaveSubRequestStats` / `getSubscriptionRequestStats()` used to sit
// here. The declared shape (`totalRequests`, `uniqueUsers`, `perClient`,
// `perDay`) is sent by neither 2.7.4 nor 2.8.0 — the panel answers
// `{ byParsedApp, hourlyRequestStats }` — and no screen ever called the
// function. Deleted here and on the backend rather than retyped.

/**
 * One row of the panel's subscription-request log.
 *
 * The owner identifier is version-dependent and exactly one side is populated:
 * Remnawave 2.7.4 records carry `userUuid`, 2.8.0 records carry the
 * panel-internal integer instead. `username` used to be declared here and is
 * sent by neither panel version, so it was always absent.
 */
export interface RemnawaveSubRequestEntry {
  id: string
  /** 2.7.4 only. */
  userUuid: string | null
  /** 2.8.0 only — panel-internal numeric id, NOT a uuid. */
  panelUserId: number | null
  userAgent: string | null
  /** Derived server-side from `userAgent`; the panel sends no client field. */
  clientType: string | null
  ipAddress: string | null
  requestedAt: string
}

async function getSubscriptionRequestHistory(params?: { userUuid?: string; limit?: number }): Promise<RemnawaveSubRequestEntry[]> {
  const search = new URLSearchParams()
  if (params?.userUuid) search.set('userUuid', params.userUuid)
  if (params?.limit !== undefined) search.set('limit', String(params.limit))
  const qs = search.toString()
  const res = await api.get(`/admin/remnawave/subscription-request-history${qs.length > 0 ? `?${qs}` : ''}`)
  return expectArray<RemnawaveSubRequestEntry>(res.data)
}

/** One node a provider bills for. `nodeUuid` is null for an orphaned 2.8.0 line. */
export interface RemnawaveInfraBillingNode {
  nodeUuid: string | null
  name: string
  countryCode: string | null
}

/**
 * An infra-billing provider.
 *
 * `type`, `currency`, `monthlyCost` and `nodesCount` used to be declared here
 * and are sent by neither 2.7.4 nor 2.8.0, so the Costs table rendered `—`,
 * `0` and a blank cost for every provider. What the panel does send is a
 * lifetime bill tally plus the nodes the provider bills for.
 *
 * `billedTotalAmount` HAS NO CURRENCY — neither spec mentions one anywhere —
 * so it must never be rendered beside a currency symbol.
 */
export interface RemnawaveInfraProvider {
  uuid: string
  name: string
  faviconLink: string | null
  loginUrl: string | null
  billedTotalAmount: number
  billsCount: number
  billingNodes: RemnawaveInfraBillingNode[]
  createdAt: string
  updatedAt: string
}

async function getInfraProviders(): Promise<RemnawaveInfraProvider[]> {
  const res = await api.get("/admin/remnawave/infra/providers");
  return expectArray<RemnawaveInfraProvider>(res.data);
}

/**
 * A snippet record is `{ name, snippet }` upstream and nothing else. `uuid`,
 * `description`, `type` and the timestamps were declared and never sent —
 * `uuid` in particular was `''` for every row and was used as the React key,
 * so any two snippets collided. `name` is the record's only identity.
 */
export interface RemnawaveSnippet {
  name: string
  /** `snippet.length`; null when the panel sent a non-array. */
  entriesCount: number | null
}

async function getSnippets(): Promise<RemnawaveSnippet[]> {
  const res = await api.get("/admin/remnawave/snippets");
  return expectArray<RemnawaveSnippet>(res.data);
}

/**
 * Rows are `{ uuid, viewPosition, name, config }`. The branding fields that
 * used to be declared (`title`, `description`, `logoUrl`, `faviconUrl`,
 * `customCss`) live inside the opaque `config` blob the panel does not
 * describe, so only its presence is reported.
 */
export interface RemnawaveSubpageConfig {
  uuid: string
  name: string
  viewPosition: number
  hasConfig: boolean
}

async function getSubscriptionPageConfigs(): Promise<RemnawaveSubpageConfig[]> {
  const res = await api.get("/admin/remnawave/subscription-page-configs");
  return expectArray<RemnawaveSubpageConfig>(res.data);
}

/**
 * Rows are `{ uuid, viewPosition, name, pluginConfig }`. `version`, `nodeUuid`
 * and the timestamps were never sent — and neither was `enabled`, which meant
 * the settings table showed EVERY plugin as disabled. There is no enablement
 * flag upstream, so the column is gone rather than defaulted.
 */
export interface RemnawaveNodePlugin {
  uuid: string
  name: string
  viewPosition: number
  hasConfig: boolean
}

async function getNodePlugins(): Promise<RemnawaveNodePlugin[]> {
  const res = await api.get("/admin/remnawave/node-plugins");
  return expectArray<RemnawaveNodePlugin>(res.data);
}

export interface RemnawaveUserSummary {
  uuid: string
  shortUuid: string | null
  username: string
  status: string | null
  trafficLimitBytes: number | null
  trafficUsedBytes: number | null
  hwidDeviceLimit: number | null
  expireAt: string | null
  telegramId: string | null
  email: string | null
  tag: string | null
  createdAt: string | null
  updatedAt: string | null
  subscriptionUrl: string | null
}

async function resolveUser(query: { telegramId?: string; username?: string; email?: string; subscriptionUuid?: string }): Promise<RemnawaveUserSummary | null> {
  const search = new URLSearchParams()
  if (query.telegramId) search.set('telegramId', query.telegramId)
  if (query.username) search.set('username', query.username)
  if (query.email) search.set('email', query.email)
  if (query.subscriptionUuid) search.set('subscriptionUuid', query.subscriptionUuid)
  const res = await api.get<RemnawaveUserSummary | null>(`/admin/remnawave/users/resolve?${search.toString()}`)
  return res.data
}

async function reorderHosts(uuids: string[]): Promise<void> {
  await api.post("/admin/remnawave/hosts/reorder", { uuids });
}

export interface RemnawaveGeoDistribution {
  country: string
  usersOnline: number
  nodesCount: number
  percentage: number
}

async function getGeoDistribution(): Promise<RemnawaveGeoDistribution[]> {
  const res = await api.get("/admin/remnawave/metrics/geo-distribution");
  return expectArray<RemnawaveGeoDistribution>(res.data);
}

// ── Expired-profile cleanup policy (panel-managed; stored in Settings) ────────

export interface RemnawaveCleanupSettings {
  /** When false, the panel never deletes Remnawave profiles on expiry. */
  deleteEnabled: boolean;
  /** Days after expiry before a profile is deleted (0–365). */
  graceDays: number;
}

async function getCleanupSettings(): Promise<RemnawaveCleanupSettings> {
  const res = await api.get<RemnawaveCleanupSettings>("/admin/settings/remnawave-cleanup");
  return res.data;
}

async function updateCleanupSettings(
  patch: Partial<RemnawaveCleanupSettings>,
): Promise<RemnawaveCleanupSettings> {
  const res = await api.patch<RemnawaveCleanupSettings>(
    "/admin/settings/remnawave-cleanup",
    patch,
  );
  return res.data;
}

// ── Panel version & capabilities (auto-detected; drives version-gated UI) ─────
//
// Hand-mirrored from `src/modules/remnawave/services/remnawave-version.service.ts`.
// Keep the unions three-valued in both places: the backend really does send
// `'unknown'` whenever version detection fails, and a two-valued mirror would
// make every `=== 'uuid'` comparison here silently take a branch that talks to
// a live panel the wrong way.

/** Mirrors `RemnawaveUserAddressing`. `'unknown'` = detection failed. */
export type RemnawaveUserAddressing = "uuid" | "id" | "unknown";
/** Mirrors `RemnawaveConnectionsApi`. `'unknown'` = detection failed. */
export type RemnawaveConnectionsApi = "ip-control" | "connections" | "unknown";

export interface RemnawaveCapabilities {
  version: string | null;
  major: number | null;
  minor: number | null;
  patch: number | null;
  supported: boolean;
  reachable: boolean;
  liveIpControl: boolean;
  bandwidthNodesUsers: boolean;
  userAddressing: RemnawaveUserAddressing;
  connectionsApi: RemnawaveConnectionsApi;
  userLookups: { byTelegramId: boolean; byEmail: boolean };
}

const USER_ADDRESSING_VALUES: readonly RemnawaveUserAddressing[] = ["uuid", "id", "unknown"];
const CONNECTIONS_API_VALUES: readonly RemnawaveConnectionsApi[] = [
  "ip-control",
  "connections",
  "unknown",
];

/** What an absent/malformed payload degrades to: nothing known, nothing enabled. */
const UNKNOWN_CAPABILITIES: RemnawaveCapabilities = {
  version: null,
  major: null,
  minor: null,
  patch: null,
  supported: false,
  reachable: false,
  liveIpControl: false,
  bandwidthNodesUsers: false,
  userAddressing: "unknown",
  connectionsApi: "unknown",
  userLookups: { byTelegramId: false, byEmail: false },
};

function pickUnion<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function pickNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Narrow runtime guard over `/admin/remnawave/version`.
 *
 * This mirror is hand-maintained, so a bare `res.data as RemnawaveCapabilities`
 * would let a backend/SPA drift (a renamed field, a union value the SPA has
 * never heard of) through as a lie the type system then vouches for. Anything
 * unrecognised degrades to the "unknown / disabled" value rather than being
 * trusted — the safe direction for every current consumer.
 */
export function normalizeCapabilities(raw: unknown): RemnawaveCapabilities {
  // A fresh copy, never the shared constant: callers hold on to this object.
  if (raw === null || typeof raw !== "object") {
    return { ...UNKNOWN_CAPABILITIES, userLookups: { ...UNKNOWN_CAPABILITIES.userLookups } };
  }
  const record = raw as Record<string, unknown>;
  const lookups =
    typeof record.userLookups === "object" && record.userLookups !== null
      ? (record.userLookups as Record<string, unknown>)
      : {};
  return {
    version: typeof record.version === "string" ? record.version : null,
    major: pickNumber(record.major),
    minor: pickNumber(record.minor),
    patch: pickNumber(record.patch),
    supported: record.supported === true,
    reachable: record.reachable === true,
    liveIpControl: record.liveIpControl === true,
    bandwidthNodesUsers: record.bandwidthNodesUsers === true,
    userAddressing: pickUnion(record.userAddressing, USER_ADDRESSING_VALUES, "unknown"),
    connectionsApi: pickUnion(record.connectionsApi, CONNECTIONS_API_VALUES, "unknown"),
    userLookups: {
      byTelegramId: lookups.byTelegramId === true,
      byEmail: lookups.byEmail === true,
    },
  };
}

async function getCapabilities(): Promise<RemnawaveCapabilities> {
  const res = await api.get<unknown>("/admin/remnawave/version");
  return normalizeCapabilities(res.data);
}

// ── Live (ip-control: active sessions / source IPs) ───────────────────────────

export interface RemnawaveIpSample {
  ip: string;
  lastSeen: string;
}

/**
 * Live-session payloads are the one place on this surface where proving the
 * container is not enough: both views reduce over `session.ips.length`, so a
 * well-formed array of malformed elements throws just as hard as a `{}` body.
 * `lastSeen` / `countryCode` are declared by the contract but read by neither
 * view, so they are tolerated rather than enforced — a panel build that omits
 * one should not take the whole card down.
 */
const ipSampleSchema = z.object({
  ip: z.string(),
  lastSeen: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
});

const nodeUserIpsListSchema = z.array(
  z.object({ userId: z.string(), ips: z.array(ipSampleSchema) }),
);

const userNodeIpsListSchema = z.array(
  z.object({
    nodeUuid: z.string(),
    nodeName: z.string(),
    countryCode: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    ips: z.array(ipSampleSchema),
  }),
);

export interface RemnawaveNodeUserIps {
  userId: string;
  ips: RemnawaveIpSample[];
}

export interface RemnawaveUserNodeIps {
  nodeUuid: string;
  nodeName: string;
  countryCode: string | null;
  ips: RemnawaveIpSample[];
}

async function getNodeLiveSessions(nodeUuid: string): Promise<RemnawaveNodeUserIps[]> {
  const res = await api.get(
    `/admin/remnawave/live/node/${encodeURIComponent(nodeUuid)}`,
  );
  return nodeUserIpsListSchema.parse(res.data);
}

async function getUserLiveSessions(userUuid: string): Promise<RemnawaveUserNodeIps[]> {
  const res = await api.get(
    `/admin/remnawave/live/user/${encodeURIComponent(userUuid)}`,
  );
  return userNodeIpsListSchema.parse(res.data);
}

export const remnawaveApi = {
  getStatus,
  getCapabilities,
  getSystemStats,
  getSystemRecap,
  getBandwidthStats,
  getHealth,
  getAllNodes,
  enableNode,
  disableNode,
  restartNode,
  resetNodeTraffic,
  getAllHosts,
  reorderHosts,
  getInternalSquads,
  getExternalSquads,
  getConfigProfiles,
  getSubscriptionSettings,
  getSubscriptionTemplates,
  getSubscriptionPageConfigs,
  getSnippets,
  getHwidStats,
  getHwidTopUsers,
  getSubscriptionRequestHistory,
  getInfraProviders,
  getNodePlugins,
  resolveUser,
  getGeoDistribution,
  getCleanupSettings,
  updateCleanupSettings,
  getNodeLiveSessions,
  getUserLiveSessions,
};
