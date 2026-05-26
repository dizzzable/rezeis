import { api } from "@/lib/api";

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
  const res = await api.get<RemnawaveNode[]>("/admin/remnawave/nodes");
  return res.data;
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
  const res = await api.get<RemnawaveHost[]>("/admin/remnawave/hosts");
  return res.data;
}

async function getInternalSquads(): Promise<RemnawaveInternalSquad[]> {
  const res = await api.get<RemnawaveInternalSquad[]>(
    "/admin/remnawave/internal-squads",
  );
  return res.data;
}

async function getExternalSquads(): Promise<RemnawaveExternalSquad[]> {
  const res = await api.get<RemnawaveExternalSquad[]>(
    "/admin/remnawave/external-squads",
  );
  return res.data;
}

async function getConfigProfiles(): Promise<RemnawaveConfigProfile[]> {
  const res = await api.get<RemnawaveConfigProfile[]>(
    "/admin/remnawave/config-profiles",
  );
  return res.data;
}

async function getSubscriptionSettings(): Promise<RemnawaveSubscriptionSettings | null> {
  const res = await api.get<RemnawaveSubscriptionSettings | null>(
    "/admin/remnawave/subscription-settings",
  );
  return res.data;
}

async function getSubscriptionTemplates(): Promise<RemnawaveSubscriptionTemplate[]> {
  const res = await api.get<RemnawaveSubscriptionTemplate[]>("/admin/remnawave/subscription-templates");
  return res.data;
}

async function getHwidStats(): Promise<RemnawaveHwidStats | null> {
  const res = await api.get<RemnawaveHwidStats | null>("/admin/remnawave/hwid/stats");
  return res.data;
}

export interface RemnawaveHwidTopUser {
  userUuid: string
  username: string
  telegramId: string | null
  devicesCount: number
  lastSeenAt: string | null
}

async function getHwidTopUsers(): Promise<RemnawaveHwidTopUser[]> {
  const res = await api.get<RemnawaveHwidTopUser[]>("/admin/remnawave/hwid/top-users");
  return res.data;
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

export interface RemnawaveSubRequestStats {
  totalRequests: number
  uniqueUsers: number
  perClient: { clientType: string; count: number }[]
  perDay: { date: string; count: number }[]
}

async function getSubscriptionRequestStats(): Promise<RemnawaveSubRequestStats | null> {
  const res = await api.get<RemnawaveSubRequestStats | null>("/admin/remnawave/subscription-request-history/stats");
  return res.data;
}

export interface RemnawaveSubRequestEntry {
  id: string
  userUuid: string | null
  username: string | null
  clientType: string | null
  userAgent: string | null
  ipAddress: string | null
  requestedAt: string
}

async function getSubscriptionRequestHistory(params?: { userUuid?: string; limit?: number }): Promise<RemnawaveSubRequestEntry[]> {
  const search = new URLSearchParams()
  if (params?.userUuid) search.set('userUuid', params.userUuid)
  if (params?.limit !== undefined) search.set('limit', String(params.limit))
  const qs = search.toString()
  const res = await api.get<RemnawaveSubRequestEntry[]>(`/admin/remnawave/subscription-request-history${qs.length > 0 ? `?${qs}` : ''}`)
  return res.data
}

export interface RemnawaveInfraProvider {
  uuid: string
  name: string
  type: string | null
  currency: string | null
  nodesCount: number
  monthlyCost: number | null
  createdAt: string
}

async function getInfraProviders(): Promise<RemnawaveInfraProvider[]> {
  const res = await api.get<RemnawaveInfraProvider[]>("/admin/remnawave/infra/providers");
  return res.data;
}

export interface RemnawaveSnippet {
  uuid: string
  name: string
  description: string | null
  type: string | null
  createdAt: string
  updatedAt: string
}

async function getSnippets(): Promise<RemnawaveSnippet[]> {
  const res = await api.get<RemnawaveSnippet[]>("/admin/remnawave/snippets");
  return res.data;
}

export interface RemnawaveSubpageConfig {
  uuid: string
  name: string
  title: string | null
  description: string | null
  logoUrl: string | null
  faviconUrl: string | null
  customCss: string | null
  createdAt: string
  updatedAt: string
}

async function getSubscriptionPageConfigs(): Promise<RemnawaveSubpageConfig[]> {
  const res = await api.get<RemnawaveSubpageConfig[]>("/admin/remnawave/subscription-page-configs");
  return res.data;
}

export interface RemnawaveNodePlugin {
  uuid: string
  name: string
  version: string | null
  nodeUuid: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

async function getNodePlugins(): Promise<RemnawaveNodePlugin[]> {
  const res = await api.get<RemnawaveNodePlugin[]>("/admin/remnawave/node-plugins");
  return res.data;
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
  const res = await api.get<RemnawaveGeoDistribution[]>("/admin/remnawave/metrics/geo-distribution");
  return res.data;
}

export const remnawaveApi = {
  getStatus,
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
  getSubscriptionRequestStats,
  getSubscriptionRequestHistory,
  getInfraProviders,
  getNodePlugins,
  resolveUser,
  getGeoDistribution,
};
