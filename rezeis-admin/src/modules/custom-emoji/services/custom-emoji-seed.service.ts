import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { getProcessRole } from '../../../common/runtime/process-role.util';
import { SettingsService } from '../../settings/services/settings.service';
import { CustomEmojiService } from './custom-emoji.service';

/** A standard pack shipped with the project. */
interface BuiltinPackSeed {
  /** Stable id used for the seeded-defaults marker (never re-seed twice). */
  readonly id: string;
  /** Telegram sticker-set name for re-import via the bot token. */
  readonly setName: string;
  /** Display title; also used to match an already-imported pack on this instance. */
  readonly title: string;
}

/**
 * Curated default emoji packs. On a fresh deploy these are re-imported from
 * Telegram (via the configured bot token) so the cabinet + bot have working
 * emoji out of the box. Light-footprint: only set names are bundled — assets
 * are fetched on first boot, never committed to the repo.
 */
const BUILTIN_PACKS: readonly BuiltinPackSeed[] = [
  { id: 'builtin_news', setName: 'NewsEmoji', title: 'News Emoji' },
  { id: 'builtin_decoration', setName: 'Decoration_Pack2', title: 'Decoration_Pack2' },
  { id: 'builtin_widestdicons', setName: 'widestdicons_2_by_fStikBot', title: 'widestdicons_2_by_fStikBot' },
  { id: 'builtin_tgiosicons', setName: 'tgiosicons', title: 'tgiosicons' },
  { id: 'builtin_outline', setName: 'OutlineEmoji', title: 'OutlineEmoji' },
  { id: 'builtin_translucent', setName: 'TranslucentPack', title: 'TranslucentPack' },
  { id: 'builtin_tgmacicons', setName: 'tgmacicons', title: 'tgmacicons' },
  { id: 'builtin_adaptivestatus', setName: 'AdaptiveStatus', title: 'AdaptiveStatus' },
  { id: 'builtin_restricted', setName: 'RestrictedEmoji', title: 'RestrictedEmoji' },
  { id: 'builtin_application', setName: 'ApplicationEmoji', title: 'ApplicationEmoji' },
  { id: 'builtin_game', setName: 'GameEmoji', title: 'GameEmoji' },
  { id: 'builtin_islomjonanime', setName: 'IslomjonAnimeEmoji', title: 'IslomjonAnimeEmoji' },
];

/**
 * CustomEmojiSeedService
 * ──────────────────────
 * On API-process boot, ensures the curated default packs exist:
 *   1. Already on this instance (matched by title) → flag it `builtin` and
 *      record the marker (no download — handles upgrades of existing
 *      deployments that imported these packs manually).
 *   2. Not present + bot token configured → re-import via `importBySetLink`.
 *   3. Not present + no token yet → skip; retried on the next boot (the
 *      marker is only written on success, so nothing is lost).
 *
 * Idempotent via the `seededEmojiDefaults` marker: a pack is seeded at most
 * once, and an operator deletion is never resurrected.
 */
@Injectable()
export class CustomEmojiSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CustomEmojiSeedService.name);

  public constructor(
    private readonly customEmojiService: CustomEmojiService,
    private readonly settingsService: SettingsService,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    // API role only — the worker shares the DB and must not race the seed.
    if (getProcessRole() === 'worker') return;
    try {
      await this.seedDefaults();
      const recovery = await this.customEmojiService.rehydrateMissingAssets();
      if (recovery.recoveredEmojiCount > 0 || recovery.skippedPacks > 0) {
        this.logger.log(
          `Custom emoji asset recovery: ${recovery.recoveredEmojiCount} repaired, ${recovery.skippedPacks} skipped`,
        );
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Default emoji-pack seed failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async seedDefaults(): Promise<void> {
    const seeded = new Set(await this.customEmojiService.readSeededDefaults());
    const pending = BUILTIN_PACKS.filter((p) => !seeded.has(p.id));
    const packs = await this.customEmojiService.listPacks();
    const byTitle = new Map(packs.map((p) => [p.name, p] as const));
    const token = await this.settingsService.getDecryptedBotToken();

    for (const seed of pending) {
      try {
        // (1) Already imported on this instance → just flag it builtin.
        const existing = byTitle.get(seed.title);
        if (existing) {
          await this.customEmojiService.markPackBuiltin(existing.id);
          await this.customEmojiService.addSeededDefault(seed.id);
          this.logger.log(`Flagged builtin emoji pack "${seed.title}"`);
          continue;
        }
        // (2) Fresh deploy → re-import from Telegram (needs the bot token).
        if (!token) {
          this.logger.log(
            `Skipping builtin pack "${seed.title}" — bot token not configured yet (will retry on next boot)`,
          );
          continue;
        }
        await this.customEmojiService.importBySetLink({
          packName: seed.title,
          link: seed.setName,
          builtin: true,
        });
        await this.customEmojiService.addSeededDefault(seed.id);
        this.logger.log(`Seeded builtin emoji pack "${seed.title}" (${seed.setName})`);
      } catch (err: unknown) {
        // Per-pack isolation: a bad set name / transient Telegram error must
        // not block the rest. Not marked → retried next boot.
        this.logger.warn(
          `Failed to seed builtin pack "${seed.title}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // A restored database can keep every seed marker while the persisted packs
    // predate `setName`. Reconcile known builtin metadata on every API boot so
    // missing-file recovery has a trustworthy Telegram source.
    const current = await this.customEmojiService.listPacks();
    const currentByTitle = new Map(current.map((pack) => [pack.name, pack] as const));
    for (const seed of BUILTIN_PACKS) {
      const existing = currentByTitle.get(seed.title);
      if (!existing) continue;
      await this.customEmojiService.backfillPackSource(existing.id, {
        setName: seed.setName,
        builtin: true,
      });
    }
  }
}
