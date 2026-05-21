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
  info: { membersCount: number; inboundsCount: number };
  createdAt: string;
  updatedAt: string;
}

export interface RemnawaveExternalSquad {
  uuid: string;
  name: string;
  viewPosition: number;
  info: { membersCount: number };
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
  supportLink: string;
  profileUpdateInterval: number;
  isProfileWebpageUrlEnabled: boolean;
  serveJsonAtBaseSubscription: boolean;
  isShowCustomRemarks: boolean;
  randomizeHosts: boolean;
  happAnnounce: string | null;
  happRouting: string | null;
  updatedAt: string;
}

export interface RemnawaveSubscriptionTemplate {
  uuid: string;
  name: string;
  viewPosition: number;
  templateType: string;
  templateJson: unknown | null;
  encodedTemplateYaml: string | null;
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

async function getSubscriptionTemplates(): Promise<
  RemnawaveSubscriptionTemplate[]
> {
  const res = await api.get<RemnawaveSubscriptionTemplate[]>(
    "/admin/remnawave/subscription-templates",
  );
  return res.data;
}

async function getHwidStats(): Promise<RemnawaveHwidStats> {
  const res = await api.get<RemnawaveHwidStats>("/admin/remnawave/hwid/stats");
  return res.data;
}

export const remnawaveApi = {
  getStatus,
  getSystemStats,
  getSystemRecap,
  getBandwidthStats,
  getAllNodes,
  enableNode,
  disableNode,
  restartNode,
  resetNodeTraffic,
  getAllHosts,
  getInternalSquads,
  getExternalSquads,
  getConfigProfiles,
  getSubscriptionSettings,
  getSubscriptionTemplates,
  getHwidStats,
};
