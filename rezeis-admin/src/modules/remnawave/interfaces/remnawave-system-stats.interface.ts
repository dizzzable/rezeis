export interface RemnawaveSystemStatsInterface {
  readonly users: {
    readonly totalUsers: number;
    readonly statusCounts: Record<string, number>;
    readonly onlineStats: {
      readonly lastDay: number;
      readonly lastWeek: number;
      readonly neverOnline: number;
      readonly onlineNow: number;
    };
  };
  readonly nodes: {
    readonly totalOnline: number;
    readonly totalBytesLifetime: number;
  };
  readonly cpu: { readonly cores: number };
  readonly memory: { readonly total: number; readonly free: number; readonly used: number };
  readonly uptime: number;
  readonly timestamp: number;
}

export interface RemnawaveSystemRecapInterface {
  readonly thisMonth: { readonly users: number; readonly traffic: number };
  readonly total: {
    readonly users: number;
    readonly nodes: number;
    readonly traffic: number;
    readonly nodesRam: number;
    readonly nodesCpuCores: number;
    readonly distinctCountries: number;
  };
  readonly version: string;
  readonly initDate: string;
}

export interface RemnawaveBandwidthStatsInterface {
  readonly bandwidthLastTwoDays: { readonly current: number; readonly previous: number; readonly difference: number };
  readonly bandwidthLastSevenDays: { readonly current: number; readonly previous: number; readonly difference: number };
  readonly bandwidthLast30Days: { readonly current: number; readonly previous: number; readonly difference: number };
  readonly bandwidthCalendarMonth: { readonly current: number; readonly previous: number; readonly difference: number };
  readonly bandwidthCurrentYear: { readonly current: number; readonly previous: number; readonly difference: number };
}
