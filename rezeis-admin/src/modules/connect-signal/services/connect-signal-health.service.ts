import { Injectable, Logger } from '@nestjs/common';

import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  coverageSql,
  firstPassHours,
  lastUserWebhookSql,
  type ConnectCoverageRow,
} from '../connect-probe.sql';
import {
  CONNECT_HEALTH_CACHE_MS,
  CONNECT_PROBE_BATCH,
  CONNECT_PROBE_STALE_MS,
  CONNECT_PROBE_STATUS_KEY,
  CONNECT_WEBHOOK_FRESH_MS,
} from '../connect-signal.constants';
import type { ConnectProbeStatus } from './connect-signal-probe.service';

/**
 * Whether the panel can currently tell who connected.
 *
 *   live           the probe read the panel within the last 30 minutes and has
 *                  been through its backlog once;
 *   starting       the probe has not been through its backlog yet (or has not
 *                  run at all) and is not failing — counts show verified only;
 *   webhooks_only  the probe has read nothing for 30 minutes, but a `user.*`
 *                  webhook arrived within 24 hours — connections are still
 *                  learned, only from webhooks;
 *   blind          the probe has read nothing for 30 minutes and no `user.*`
 *                  webhook arrived within 24 hours.
 *
 * Codes only: the sentences an operator reads belong to the screens that show
 * them («Помощь с подключением», «Рассылки»).
 */
export type ConnectSignalState = 'live' | 'starting' | 'webhooks_only' | 'blind';

/** `ConnectSignalHealthService.current()`. Instants are ISO strings. */
export interface ConnectSignalHealth {
  readonly state: ConnectSignalState;
  /**
   * The share of the 30-day horizon whose state is known: connected, or
   * verified not connected within 24 hours. 1 when the horizon is empty.
   */
  readonly checkedCoverage: number;
  /** The probe's last cycle in which the panel answered (or had nothing to be asked). */
  readonly lastOkAt: string | null;
  /** The newest `user.*` webhook of the last 24 hours. */
  readonly lastUserWebhookAt: string | null;
  readonly coverage: {
    /** Live subscriptions with a profile, created or paid for in the last 30 days. */
    readonly total: number;
    readonly connected: number;
    /** Verified NOT connected within the last 24 hours. */
    readonly verified: number;
    /** Neither — «не проверено». */
    readonly unverified: number;
  };
  readonly probe: {
    readonly lastCycleAt: string | null;
    readonly lastFailAt: string | null;
    readonly lastReason: string | null;
    readonly failingSince: string | null;
    readonly firstPassCompletedAt: string | null;
    /** Eligible subscriptions never tried yet. */
    readonly backlog: number;
    /** Hours the first pass still needs at the probe's pace. */
    readonly firstPassHours: number;
  };
}

function ageMs(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : now.getTime() - at;
}

/**
 * The state from its three inputs — pure, so every branch is tested without a
 * database or a clock.
 */
export function connectSignalStateOf(input: {
  readonly probe: ConnectProbeStatus | null;
  readonly lastUserWebhookAt: string | null;
  readonly now: Date;
}): ConnectSignalState {
  const { probe, now } = input;
  if (probe === null) return 'starting';
  const okAge = ageMs(probe.lastOkAt, now);
  const failingAge = ageMs(probe.failingSince, now);
  const degraded =
    okAge === null ? failingAge !== null && failingAge >= CONNECT_PROBE_STALE_MS : okAge >= CONNECT_PROBE_STALE_MS;
  if (degraded) {
    const webhookAge = ageMs(input.lastUserWebhookAt, now);
    return webhookAge !== null && webhookAge < CONNECT_WEBHOOK_FRESH_MS ? 'webhooks_only' : 'blind';
  }
  return probe.firstPassCompletedAt === null ? 'starting' : 'live';
}

/**
 * THE SIGNAL'S HEALTH — what the connection signal can currently vouch for.
 *
 * Combines the probe's last cycle (mirrored into Redis by the worker), the
 * newest `user.*` webhook (from `remnawave_webhook_events`, which the webhook
 * writes for every event it accepts) and the coverage of the 30-day horizon.
 * Reused for 60 seconds per process; a failed read of any input degrades that
 * input alone.
 */
@Injectable()
export class ConnectSignalHealthService {
  private readonly logger = new Logger(ConnectSignalHealthService.name);

  private cached: { readonly at: number; readonly value: ConnectSignalHealth } | null = null;

  private inFlight: Promise<ConnectSignalHealth> | null = null;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly rawCacheService: RawCacheService,
  ) {}

  public async current(now: Date = new Date()): Promise<ConnectSignalHealth> {
    if (this.cached !== null && now.getTime() - this.cached.at < CONNECT_HEALTH_CACHE_MS) {
      return this.cached.value;
    }
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.compute(now)
      .then((value) => {
        this.cached = { at: now.getTime(), value };
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async compute(now: Date): Promise<ConnectSignalHealth> {
    const [probe, lastUserWebhookAt, coverage] = await Promise.all([
      this.readProbe(),
      this.readLastUserWebhook(now),
      this.readCoverage(now),
    ]);
    // An unreadable coverage vouches for nothing: 0, never the "empty horizon" 1.
    const counted = coverage ?? { total: 0, connected: 0, verified: 0 };
    const known = counted.connected + counted.verified;
    return {
      state: connectSignalStateOf({ probe, lastUserWebhookAt, now }),
      checkedCoverage: coverage === null ? 0 : counted.total === 0 ? 1 : known / counted.total,
      lastOkAt: probe?.lastOkAt ?? null,
      lastUserWebhookAt,
      coverage: {
        total: counted.total,
        connected: counted.connected,
        verified: counted.verified,
        unverified: Math.max(counted.total - known, 0),
      },
      probe: {
        lastCycleAt: probe?.lastCycleAt ?? null,
        lastFailAt: probe?.lastFailAt ?? null,
        lastReason: probe?.lastReason ?? null,
        failingSince: probe?.failingSince ?? null,
        firstPassCompletedAt: probe?.firstPassCompletedAt ?? null,
        backlog: probe?.backlog ?? 0,
        firstPassHours: firstPassHours(probe?.backlog ?? 0, CONNECT_PROBE_BATCH, 10 * 60 * 1000),
      },
    };
  }

  private async readProbe(): Promise<ConnectProbeStatus | null> {
    try {
      return await this.rawCacheService.get<ConnectProbeStatus>(CONNECT_PROBE_STATUS_KEY);
    } catch (error) {
      this.logger.warn(`Could not read the probe status: ${(error as Error).message}`);
      return null;
    }
  }

  private async readLastUserWebhook(now: Date): Promise<string | null> {
    try {
      const rows = await this.prismaService.$queryRaw<Array<{ readonly at: Date }>>(
        lastUserWebhookSql(now, CONNECT_WEBHOOK_FRESH_MS),
      );
      const at = rows[0]?.at;
      return at instanceof Date ? at.toISOString() : null;
    } catch (error) {
      this.logger.warn(`Could not read the last user webhook: ${(error as Error).message}`);
      return null;
    }
  }

  private async readCoverage(now: Date): Promise<ConnectCoverageRow | null> {
    try {
      const rows = await this.prismaService.$queryRaw<ConnectCoverageRow[]>(coverageSql(now));
      const row = rows[0];
      return {
        total: Number(row?.total ?? 0),
        connected: Number(row?.connected ?? 0),
        verified: Number(row?.verified ?? 0),
      };
    } catch (error) {
      this.logger.warn(`Could not read the connection coverage: ${(error as Error).message}`);
      return null;
    }
  }
}
