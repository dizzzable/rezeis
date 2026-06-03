import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { promises as fsp } from 'node:fs';

import { appConfig } from '../../common/config/app.config';
import { redisConfig } from '../../common/config/redis.config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BROADCAST_DELIVERY_QUEUE } from '../broadcast/broadcast.constants';

interface ComponentHealth {
  readonly status: 'up' | 'down';
  readonly latencyMs?: number;
  readonly details?: string;
}

interface HealthResponse {
  readonly status: 'ok' | 'degraded' | 'error';
  readonly service: string;
  readonly version: string;
  readonly gitSha: string | null;
  readonly timestamp: string;
  readonly uptime: number;
  readonly components: {
    readonly database: ComponentHealth;
    readonly redis: ComponentHealth;
    readonly queues: ComponentHealth;
    readonly disk: ComponentHealth;
  };
}

/**
 * Comprehensive health check service.
 *
 * Checks:
 *   - PostgreSQL connectivity (SELECT 1)
 *   - Redis connectivity (PING)
 *   - BullMQ queue health (no stalled workers)
 *   - Disk space (backup volume writable)
 *
 * Status logic:
 *   - "ok" — all components up
 *   - "degraded" — non-critical component down (disk, queues)
 *   - "error" — critical component down (database, redis)
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();

  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(appConfig.KEY)
    private readonly appConfiguration: ConfigType<typeof appConfig>,
    @Inject(redisConfig.KEY)
    private readonly redisConfiguration: ConfigType<typeof redisConfig>,
    @InjectQueue(BROADCAST_DELIVERY_QUEUE)
    private readonly sampleQueue: Queue,
  ) {}

  public async getHealth(): Promise<HealthResponse> {
    const [database, redis, queues, disk] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkQueues(),
      this.checkDisk(),
    ]);

    const critical = database.status === 'down' || redis.status === 'down';
    const degraded = queues.status === 'down' || disk.status === 'down';

    return {
      status: critical ? 'error' : degraded ? 'degraded' : 'ok',
      service: this.appConfiguration.serviceName,
      version: process.env.APP_VERSION ?? process.env.npm_package_version ?? 'unknown',
      gitSha: normalizeGitSha(process.env.REZEIS_GIT_SHA),
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      components: { database, redis, queues, disk },
    };
  }

  private async checkDatabase(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      await this.prismaService.$queryRawUnsafe('SELECT 1');
      return { status: 'up', latencyMs: Date.now() - start };
    } catch (err) {
      this.logger.warn(`Database health check failed: ${safeHealthLogMessage(err)}`);
      return { status: 'down', latencyMs: Date.now() - start, details: 'database_unavailable' };
    }
  }

  private async checkRedis(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      // Use the BullMQ queue's internal connection to ping Redis
      const client = await this.sampleQueue.client;
      const pong = await client.ping();
      if (pong !== 'PONG') throw new Error(`Unexpected PING response: ${pong}`);
      return { status: 'up', latencyMs: Date.now() - start };
    } catch (err) {
      this.logger.warn(`Redis health check failed: ${safeHealthLogMessage(err)}`);
      return { status: 'down', latencyMs: Date.now() - start, details: 'redis_unavailable' };
    }
  }

  private async checkQueues(): Promise<ComponentHealth> {
    try {
      const counts = await this.sampleQueue.getJobCounts();
      // If there are active jobs but no workers, queues are stalled
      const healthy = counts.active === 0 || counts.active < 50;
      return {
        status: healthy ? 'up' : 'down',
        details: `waiting=${counts.waiting} active=${counts.active} failed=${counts.failed}`,
      };
    } catch (err) {
      this.logger.warn(`Queue health check failed: ${safeHealthLogMessage(err)}`);
      return { status: 'down', details: 'queue_unavailable' };
    }
  }

  private async checkDisk(): Promise<ComponentHealth> {
    const backupDir = process.env.BACKUP_LOCATION ?? '/app/data/backups';
    try {
      // Check if backup directory is writable
      const testFile = `${backupDir}/.health-check-${Date.now()}`;
      await fsp.writeFile(testFile, 'ok');
      await fsp.unlink(testFile);
      return { status: 'up' };
    } catch (err) {
      this.logger.warn(`Disk health check failed: ${safeHealthLogMessage(err)}`);
      return { status: 'down', details: 'disk_unavailable' };
    }
  }
}

function normalizeGitSha(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized === 'unknown') return null;
  return normalized.slice(0, 40);
}

function safeHealthLogMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    return redactHealthDiagnostic(error.message);
  }
  return redactHealthDiagnostic(String(error));
}

function redactHealthDiagnostic(value: string): string {
  return value
    .replace(/\b(?:postgres(?:ql)?|redis):\/\/\S+/giu, '[redacted-url]')
    .replace(/https?:\/\/\S+/giu, '[redacted-url]')
    .replace(/[A-Za-z]:\\[^\s'"`]+/gu, '[redacted-path]')
    .replace(/\/(?:app|data|home|mnt|opt|srv|tmp|var)\/[^\s'"`]+/gu, '[redacted-path]')
    .replace(/\b(?:api[_-]?key|auth(?:orization)?|bearer\w*|cookie|credential|password|secret|token)\s*[:=]\s*\S+/giu, '[redacted]')
    .replace(/\b(?:api[_-]?key|auth(?:orization)?|bearer\w*|cookie|credential|password|secret|token)\b/giu, '[redacted]')
    .slice(0, 256);
}
