/**
 * System health snapshot exposed by `GET /admin/dashboard/system-health`.
 *
 * Provides real-time VPS and process metrics for the admin dashboard
 * monitoring widgets. No sensitive paths or environment variables are
 * exposed — only numeric gauges and safe labels.
 */

export interface CpuCoreInfo {
  readonly core: number;
  readonly usagePercent: number;
}

export interface VpsHealthSnapshot {
  /** Overall CPU usage percentage (0–100). */
  readonly cpuUsagePercent: number;
  /** Per-core CPU usage. */
  readonly cpuCores: readonly CpuCoreInfo[];
  /** Total number of logical CPU cores. */
  readonly cpuCoreCount: number;
  /** CPU model name. */
  readonly cpuModel: string;
  /** Used RAM in bytes. */
  readonly ramUsedBytes: number;
  /** Total RAM in bytes. */
  readonly ramTotalBytes: number;
  /** RAM usage percentage (0–100). */
  readonly ramUsagePercent: number;
  /** Used disk space in bytes. */
  readonly diskUsedBytes: number;
  /** Total disk space in bytes. */
  readonly diskTotalBytes: number;
  /** Disk usage percentage (0–100). */
  readonly diskUsagePercent: number;
  /** System uptime in seconds. */
  readonly uptimeSeconds: number;
  /** Load average [1m, 5m, 15m] (Linux only, zeros on Windows). */
  readonly loadAverage: readonly [number, number, number];
  /** Network interfaces with bytes in/out since boot. */
  readonly network: readonly NetworkInterfaceSnapshot[];
}

export interface NetworkInterfaceSnapshot {
  readonly name: string;
  readonly rxBytes: number;
  readonly txBytes: number;
}

export interface ProcessHealthSnapshot {
  /** Process CPU usage percentage (0–100). */
  readonly cpuUsagePercent: number;
  /** Resident Set Size in bytes. */
  readonly rssBytes: number;
  /** V8 heap used in bytes. */
  readonly heapUsedBytes: number;
  /** V8 heap total in bytes. */
  readonly heapTotalBytes: number;
  /** External memory in bytes. */
  readonly externalBytes: number;
  /** Process uptime in seconds. */
  readonly uptimeSeconds: number;
  /** Node.js version string. */
  readonly nodeVersion: string;
  /** Process PID. */
  readonly pid: number;
  /** Event loop lag in milliseconds (approximate). */
  readonly eventLoopLagMs: number;
}

export interface SystemHealthResponse {
  readonly timestamp: string;
  readonly vps: VpsHealthSnapshot;
  readonly process: ProcessHealthSnapshot;
}
