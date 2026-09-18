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

/**
 * How long one probe may take before its component is reported down.
 *
 * `/api/health` answers the compose healthcheck, whose `wget` docker kills
 * after 10 s in production (`docker-compose.yml`) and after 5 s in the e2e and
 * demo stacks. The four probes run side by side, so bounding each one at 3 s
 * bounds the whole answer at about 3 s — inside the tighter budget, with room
 * left for the response itself.
 *
 * Without it a stalled dependency made the endpoint hang instead of answering.
 * A paused Valkey keeps its TCP connection open and simply never replies, and
 * ioredis has no command timeout unless one is configured, so PING — and
 * `getJobCounts` on the same connection — stayed pending until docker gave up
 * on the probe, and nothing said which component was down.
 */
const HEALTH_PROBE_TIMEOUT_MS = 3_000;

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
      await withinProbeBudget(this.prismaService.$queryRawUnsafe('SELECT 1'), 'Database SELECT 1');
      return { status: 'up', latencyMs: Date.now() - start };
    } catch (err) {
      this.logger.warn(`Database health check failed: ${safeHealthLogMessage(err)}`);
      return { status: 'down', latencyMs: Date.now() - start, details: 'database_unavailable' };
    }
  }

  private async checkRedis(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const pong = await withinProbeBudget(this.pingQueueConnection(), 'Redis PING');
      if (pong !== 'PONG') throw new Error(`Unexpected PING response: ${String(pong)}`);
      return { status: 'up', latencyMs: Date.now() - start };
    } catch (err) {
      this.logger.warn(`Redis health check failed: ${safeHealthLogMessage(err)}`);
      return { status: 'down', latencyMs: Date.now() - start, details: 'redis_unavailable' };
    }
  }

  /**
   * PING on the BullMQ queue's own connection. Since bullmq 5.77.0 that
   * connection is typed as BullMQ's `IRedisClient`, which declares only the
   * commands BullMQ itself sends, and PING is not one of them. The object is a
   * Proxy over the ioredis client BullMQ built, and it forwards PING to it
   * (probed on 5.81.5), so the method is looked for rather than cast to. Any
   * client that has it will do: PING means the same on every client, and the
   * reply is checked. The undelivered-alert gate insists on ioredis itself
   * (`gateRedisOf`) because its SET … NX is not portable; this is.
   *
   * Reaching the connection is inside the probe budget too: `client` waits for
   * BullMQ to finish connecting, and that wait is as unbounded as the PING.
   */
  private async pingQueueConnection(): Promise<unknown> {
    const client: unknown = await this.sampleQueue.client;
    if (!answersPing(client)) throw new Error('The queue connection has no PING');
    return client.ping();
  }

  private async checkQueues(): Promise<ComponentHealth> {
    try {
      const counts = await withinProbeBudget(this.sampleQueue.getJobCounts(), 'Queue job counts');
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
      await withinProbeBudget(writeAndRemove(testFile), 'Backup directory write');
      return { status: 'up' };
    } catch (err) {
      this.logger.warn(`Disk health check failed: ${safeHealthLogMessage(err)}`);
      return { status: 'down', details: 'disk_unavailable' };
    }
  }
}

/**
 * `probe`, or a rejection once {@link HEALTH_PROBE_TIMEOUT_MS} has passed —
 * whichever comes first.
 *
 * The timer is cleared on either outcome, so a probe that answers leaves
 * nothing armed behind it. A probe that never answers is abandoned rather than
 * awaited: `Promise.race` has already attached its handlers, so a late
 * rejection from it is handled and cannot surface as an unhandled one.
 */
async function withinProbeBudget<T>(probe: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not answer within ${HEALTH_PROBE_TIMEOUT_MS} ms`)),
      HEALTH_PROBE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([probe, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeAndRemove(file: string): Promise<void> {
  await fsp.writeFile(file, 'ok');
  await fsp.unlink(file);
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

/** Whether a connection answers PING: looked for, because its declared type does not promise it. */
function answersPing(client: unknown): client is { ping(): Promise<unknown> } {
  return (
    typeof client === 'object' &&
    client !== null &&
    typeof (client as { ping?: unknown }).ping === 'function'
  );
}
