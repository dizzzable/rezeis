import { Injectable, Logger } from '@nestjs/common';

import { RawCacheService } from '../../../common/cache/raw-cache.service';
import {
  CONFIG_DELIVERY_STATE_TTL_SECONDS,
  CONFIG_VERSION_CONSUMERS,
  configHintOutcomeKey,
  configLatestSaveKey,
  configReportKey,
  type ConfigHintEvent,
  type ConfigVersionConsumer,
  type ConfigVersionKey,
} from './config-versions.constants';

/** What one cabinet process said it holds, at its last poll. */
export interface ConfigDeliveryReport {
  /** Per group: the version held, or `null` for "nothing held — the next read asks". */
  readonly held: Readonly<Partial<Record<ConfigVersionKey, string | null>>>;
  /** Epoch ms of the poll. */
  readonly reportedAt: number;
}

/** The relay's final word on a hint. */
export interface ConfigHintOutcome {
  readonly delivered: boolean;
  /** The relay status it ended on (`unconfirmed`, `timeout`, `failed`, …). */
  readonly status: string;
  /** Epoch ms it was settled. */
  readonly at: number;
}

/**
 * ConfigDeliveryState
 * ═══════════════════
 * What the delivery check reads, in the panel's Redis: the cabinet's latest
 * report per process, when each group was last saved, and how the relay's last
 * hint of each kind ended. In Redis rather than in memory because the API
 * container takes the polls and either container may run the check.
 *
 * Best-effort, like every other record the relay keeps: a Redis problem reads
 * as "no record" and is logged, and never fails a poll or a save. An hour's
 * TTL on everything — a check looks two minutes back.
 */
@Injectable()
export class ConfigDeliveryState {
  private readonly logger = new Logger(ConfigDeliveryState.name);

  public constructor(private readonly store: RawCacheService) {}

  public async recordReport(consumer: ConfigVersionConsumer, report: ConfigDeliveryReport): Promise<void> {
    await this.write(configReportKey(consumer), report);
  }

  /** The latest report of each process; `null` where there is none. */
  public async reports(): Promise<Readonly<Record<ConfigVersionConsumer, ConfigDeliveryReport | null>>> {
    const [api, bot] = await Promise.all(
      CONFIG_VERSION_CONSUMERS.map((consumer) => this.read<ConfigDeliveryReport>(configReportKey(consumer))),
    );
    return { api: api ?? null, bot: bot ?? null };
  }

  public async markSave(group: ConfigVersionKey, savedAt: number): Promise<void> {
    await this.write(configLatestSaveKey(group), savedAt);
  }

  public async latestSave(group: ConfigVersionKey): Promise<number | null> {
    const value = await this.read<unknown>(configLatestSaveKey(group));
    return typeof value === 'number' ? value : null;
  }

  public async recordHintOutcome(event: ConfigHintEvent, outcome: ConfigHintOutcome): Promise<void> {
    await this.write(configHintOutcomeKey(event), outcome);
  }

  public async hintOutcome(event: ConfigHintEvent): Promise<ConfigHintOutcome | null> {
    return this.read<ConfigHintOutcome>(configHintOutcomeKey(event));
  }

  private async write(key: string, value: unknown): Promise<void> {
    try {
      await this.store.set(key, value, CONFIG_DELIVERY_STATE_TTL_SECONDS);
    } catch (err: unknown) {
      this.logger.warn(`Could not write ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async read<T>(key: string): Promise<T | null> {
    try {
      return await this.store.get<T>(key);
    } catch (err: unknown) {
      this.logger.warn(`Could not read ${key}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
