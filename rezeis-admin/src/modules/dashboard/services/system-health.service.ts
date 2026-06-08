import { Injectable, Logger } from '@nestjs/common';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  CpuCoreInfo,
  NetworkInterfaceSnapshot,
  ProcessHealthSnapshot,
  SystemHealthResponse,
  VpsHealthSnapshot,
} from '../interfaces/system-health.interface';

/**
 * Collects real-time system metrics for the admin dashboard.
 *
 * Uses Node.js `os` module and `/proc` filesystem (Linux) to gather
 * CPU, RAM, disk, and network statistics. Falls back gracefully on
 * non-Linux systems (Windows/macOS) where `/proc` is unavailable.
 *
 * CPU usage is computed by comparing two snapshots separated in time
 * to get an accurate instantaneous reading rather than a boot-time average.
 */
@Injectable()
export class SystemHealthService {
  private readonly logger = new Logger(SystemHealthService.name);

  /** Previous CPU times snapshot for delta calculation. */
  private previousCpuTimes: { idle: number; total: number }[] = [];
  private previousCpuTimestamp = 0;

  public async getSystemHealth(): Promise<SystemHealthResponse> {
    const [vps, processHealth] = await Promise.all([
      this.getVpsHealth(),
      this.getProcessHealth(),
    ]);

    return {
      timestamp: new Date().toISOString(),
      vps,
      process: processHealth,
    };
  }

  /**
   * Fetches reiwa's host + process metrics from its internal endpoint so the
   * dashboard can show the reiwa server alongside this one (split-VPS aware).
   * Returns `null` when `REIWA_URL` / `WEBHOOK_SECRET_HEADER` are unset or
   * reiwa is unreachable — the UI then shows a "not available" state.
   * Same-VPS default targets the docker service name.
   */
  public async getReiwaSystemHealth(): Promise<SystemHealthResponse | null> {
    const baseUrl = (process.env.REIWA_URL ?? 'http://reiwa:5000').trim().replace(/\/+$/, '');
    const secret = (process.env.WEBHOOK_SECRET_HEADER ?? '').trim();
    if (!baseUrl || !secret) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${baseUrl}/api/v1/internal/metrics`, {
        headers: { 'x-internal-token': secret },
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(`reiwa metrics returned HTTP ${response.status}`);
        return null;
      }
      return (await response.json()) as SystemHealthResponse;
    } catch (error) {
      this.logger.warn(`Failed to fetch reiwa metrics: ${(error as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async getVpsHealth(): Promise<VpsHealthSnapshot> {
    const cpuCores = this.getCpuUsage();
    const cpuUsagePercent =
      cpuCores.length > 0
        ? Math.round(
            (cpuCores.reduce((sum, c) => sum + c.usagePercent, 0) / cpuCores.length) * 10,
          ) / 10
        : 0;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const disk = this.getDiskUsage();
    const loadAvg = os.loadavg() as [number, number, number];
    const network = this.getNetworkStats();
    const cpuInfo = os.cpus();

    return {
      cpuUsagePercent,
      cpuCores,
      cpuCoreCount: cpuInfo.length,
      cpuModel: cpuInfo[0]?.model ?? 'Unknown',
      ramUsedBytes: usedMem,
      ramTotalBytes: totalMem,
      ramUsagePercent: Math.round((usedMem / totalMem) * 1000) / 10,
      diskUsedBytes: disk.used,
      diskTotalBytes: disk.total,
      diskUsagePercent: disk.total > 0 ? Math.round((disk.used / disk.total) * 1000) / 10 : 0,
      uptimeSeconds: Math.floor(os.uptime()),
      loadAverage: [
        Math.round(loadAvg[0] * 100) / 100,
        Math.round(loadAvg[1] * 100) / 100,
        Math.round(loadAvg[2] * 100) / 100,
      ],
      network,
    };
  }

  private async getProcessHealth(): Promise<ProcessHealthSnapshot> {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    // Approximate event loop lag by measuring setImmediate drift
    const eventLoopLagMs = await this.measureEventLoopLag();

    // Process CPU usage as percentage of one core
    const totalCpuMicroseconds = cpuUsage.user + cpuUsage.system;
    const uptimeMs = process.uptime() * 1000;
    const cpuPercent =
      uptimeMs > 0 ? Math.round((totalCpuMicroseconds / 1000 / uptimeMs) * 1000) / 10 : 0;

    return {
      cpuUsagePercent: Math.min(cpuPercent, 100),
      rssBytes: memUsage.rss,
      heapUsedBytes: memUsage.heapUsed,
      heapTotalBytes: memUsage.heapTotal,
      externalBytes: memUsage.external,
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      pid: process.pid,
      eventLoopLagMs,
    };
  }

  /**
   * Computes per-core CPU usage by comparing current CPU times with
   * the previous snapshot. On first call, returns zeros.
   */
  private getCpuUsage(): CpuCoreInfo[] {
    const cpus = os.cpus();
    const now = Date.now();
    const currentTimes = cpus.map((cpu) => {
      const times = cpu.times;
      const idle = times.idle;
      const total = times.user + times.nice + times.sys + times.idle + times.irq;
      return { idle, total };
    });

    if (this.previousCpuTimes.length === 0 || now - this.previousCpuTimestamp < 50) {
      // First call or too soon — store and return zeros
      this.previousCpuTimes = currentTimes;
      this.previousCpuTimestamp = now;
      return cpus.map((_, i) => ({ core: i, usagePercent: 0 }));
    }

    const result: CpuCoreInfo[] = cpus.map((_, i) => {
      const prev = this.previousCpuTimes[i];
      const curr = currentTimes[i];
      if (!prev || !curr) return { core: i, usagePercent: 0 };

      const totalDelta = curr.total - prev.total;
      const idleDelta = curr.idle - prev.idle;

      if (totalDelta === 0) return { core: i, usagePercent: 0 };

      const usage = ((totalDelta - idleDelta) / totalDelta) * 100;
      return { core: i, usagePercent: Math.round(usage * 10) / 10 };
    });

    this.previousCpuTimes = currentTimes;
    this.previousCpuTimestamp = now;

    return result;
  }

  /**
   * Gets disk usage for the root partition. Uses `df` on Linux/macOS,
   * `wmic` on Windows. Falls back to zeros on failure.
   */
  private getDiskUsage(): { used: number; total: number } {
    try {
      if (process.platform === 'win32') {
        const output = execSync('wmic logicaldisk get size,freespace /format:csv', {
          encoding: 'utf-8',
          timeout: 5000,
        });
        const lines = output
          .trim()
          .split('\n')
          .filter((l) => l.trim().length > 0);
        let totalSize = 0;
        let totalFree = 0;
        for (const line of lines.slice(1)) {
          const parts = line.trim().split(',');
          if (parts.length >= 3) {
            const free = parseInt(parts[1], 10);
            const size = parseInt(parts[2], 10);
            if (!isNaN(free) && !isNaN(size) && size > 0) {
              totalFree += free;
              totalSize += size;
            }
          }
        }
        return { used: totalSize - totalFree, total: totalSize };
      }

      // Linux/macOS: use df
      const output = execSync('df -B1 / | tail -1', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const parts = output.trim().split(/\s+/);
      const total = parseInt(parts[1], 10);
      const used = parseInt(parts[2], 10);
      if (!isNaN(total) && !isNaN(used)) {
        return { used, total };
      }
    } catch (error) {
      this.logger.warn('Failed to read disk usage', error);
    }
    return { used: 0, total: 0 };
  }

  /**
   * Reads network interface statistics. On Linux reads from /proc/net/dev,
   * on other platforms uses os.networkInterfaces() (limited info).
   */
  private getNetworkStats(): NetworkInterfaceSnapshot[] {
    try {
      if (process.platform === 'linux') {
        const content = readFileSync('/proc/net/dev', 'utf-8');
        const lines = content.split('\n').slice(2); // skip headers
        const interfaces: NetworkInterfaceSnapshot[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const [name, ...stats] = trimmed.split(/[:\s]+/);
          if (!name || name === 'lo') continue; // skip loopback
          const rxBytes = parseInt(stats[0], 10);
          const txBytes = parseInt(stats[8], 10);
          if (!isNaN(rxBytes) && !isNaN(txBytes)) {
            interfaces.push({ name, rxBytes, txBytes });
          }
        }
        return interfaces;
      }
    } catch (error) {
      this.logger.warn('Failed to read network stats', error);
    }

    // Fallback: return interface names without byte counts
    const netInterfaces = os.networkInterfaces();
    return Object.keys(netInterfaces)
      .filter((name) => name !== 'lo')
      .map((name) => ({ name, rxBytes: 0, txBytes: 0 }));
  }

  /**
   * Measures event loop lag by scheduling a timer and checking drift.
   * Returns lag in milliseconds.
   */
  private measureEventLoopLag(): Promise<number> {
    return new Promise((resolve) => {
      const start = process.hrtime.bigint();
      setImmediate(() => {
        const end = process.hrtime.bigint();
        const lagNs = Number(end - start);
        const lagMs = Math.round((lagNs / 1_000_000) * 100) / 100;
        resolve(lagMs);
      });
    });
  }
}
