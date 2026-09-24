import { Inject, Injectable, Logger } from '@nestjs/common';

import { configVersionOf } from './config-version-hash';
import { CONFIG_VERSIONS_CACHE_TTL_MS, type ConfigVersionKey } from './config-versions.constants';

/**
 * One group's payload, read exactly the way its internal route serves it —
 * see `config-version-sources.ts`.
 */
export interface ConfigVersionSource {
  readonly key: ConfigVersionKey;
  readonly read: () => Promise<unknown>;
}

export const CONFIG_VERSION_SOURCES = Symbol('CONFIG_VERSION_SOURCES');

/** The version of every group that could be read; a group that failed is absent. */
export type ConfigVersions = Readonly<Partial<Record<ConfigVersionKey, string>>>;

/**
 * ConfigVersionsService
 * ═════════════════════
 * The version of each settings group the cabinet copies, as the cabinet will
 * compute it from its copy (`config-version-hash.ts`).
 *
 * Kept cheap: one computation serves every poll for `CONFIG_VERSIONS_CACHE_TTL_MS`,
 * polls that arrive during one join it, and a hint busts it in the process
 * that sent the hint — the save is in the next answer, not the one after the
 * TTL. A save made in the other container (the worker) is not busted here; it
 * shows within the TTL, which is inside the cabinet's poll interval anyway.
 *
 * The bust has a generation, for the race `invalidation-undone-by-inflight-read`
 * records: a computation begun before a save may read the pre-save rows, and
 * if it could still store its answer when it lands after the bust, every poll
 * for another TTL would be told the old version — and the cabinet, holding the
 * old copy, would find nothing to re-read.
 *
 * A group that cannot be read is left out of the answer, never answered with a
 * guess: the cabinet skips a key it is not given. Its failure is logged once
 * per streak.
 */
@Injectable()
export class ConfigVersionsService {
  private readonly logger = new Logger(ConfigVersionsService.name);
  private cached: { readonly versions: ConfigVersions; readonly at: number } | null = null;
  private inflight: { readonly generation: number; readonly promise: Promise<ConfigVersions> } | null = null;
  private generation = 0;
  /** Groups whose last read failed — logged on the first failure of a streak only. */
  private readonly failing = new Set<ConfigVersionKey>();

  public constructor(
    @Inject(CONFIG_VERSION_SOURCES) private readonly sources: readonly ConfigVersionSource[],
  ) {}

  /**
   * The versions: from the cache while it is younger than the TTL, else
   * computed. `fresh` skips the cache — the delivery check wants what the
   * database says now — but still joins a computation begun since the last bust.
   */
  public async current(options: { readonly fresh?: boolean } = {}): Promise<ConfigVersions> {
    const cached = this.cached;
    if (options.fresh !== true && cached !== null && Date.now() - cached.at < CONFIG_VERSIONS_CACHE_TTL_MS) {
      return cached.versions;
    }
    const inflight = this.inflight;
    if (inflight !== null && inflight.generation === this.generation) return inflight.promise;
    const generation = this.generation;
    const promise: Promise<ConfigVersions> = this.compute()
      .then((versions) => {
        if (generation === this.generation) this.cached = { versions, at: Date.now() };
        return versions;
      })
      .finally(() => {
        // After a bust the slot may already hold a newer computation.
        if (this.inflight?.promise === promise) this.inflight = null;
      });
    this.inflight = { generation, promise };
    return promise;
  }

  /** A save was hinted: nothing computed before this moment is served again. */
  public bust(): void {
    this.generation += 1;
    this.cached = null;
    this.inflight = null;
  }

  private async compute(): Promise<ConfigVersions> {
    const versions: Partial<Record<ConfigVersionKey, string>> = {};
    await Promise.all(
      this.sources.map(async (source) => {
        try {
          versions[source.key] = configVersionOf(await source.read());
          this.failing.delete(source.key);
        } catch (err: unknown) {
          if (this.failing.has(source.key)) return;
          this.failing.add(source.key);
          this.logger.warn(
            `Config version of ${source.key} could not be computed; left out of the answer: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }),
    );
    return versions;
  }
}
