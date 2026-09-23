import {
  BadRequestException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { getProcessRole } from '../../../common/runtime/process-role.util';
import { readBrandingSettings } from '../../settings/utils/branding-settings.util';
import { DEFAULT_SUBPAGE_CONFIG } from '../subpage-config.default';
import { readJsonObject, subpageConfigSchema } from '../subpage-config.validation';
import { SubpageCacheInvalidatorService } from './subpage-cache-invalidator.service';

/**
 * The bundled default's title, which the editor used to open on — so the
 * first «Сохранить» for any reason stored it. Compared byte for byte
 * (`upgradeRetiredDefaultTitle`); a literal, not the generated file's value,
 * because it names what installs already hold, whatever a later generation
 * ships.
 */
const RETIRED_DEFAULT_TITLE = 'Rezeis';

/**
 * SubpageConfigService
 * ────────────────────
 * Owns the single global subscription-page config (branding, app catalog,
 * baseSettings, translations) that rezeis-subpage consumes. Stored as one
 * JSON blob in a singleton row (`subpage_configs.key = "default"`).
 *
 * rezeis-admin is the source of truth; the subpage fetches the effective
 * config from the internal endpoint and re-validates it against the full
 * (AGPL) schema on its side.
 */
@Injectable()
export class SubpageConfigService implements OnApplicationBootstrap {
  private static readonly SINGLETON_KEY = 'default';

  private readonly logger = new Logger(SubpageConfigService.name);

  public constructor(
    private readonly prisma: PrismaService,
    /**
     * Tells rezeis-subpage when the boot upgrade changed the title. Last and
     * `@Optional()` so positional construction in the specs keeps working;
     * `SubpageConfigModule` provides it.
     */
    @Optional()
    private readonly subpageCache?: SubpageCacheInvalidatorService,
  ) {}

  /**
   * Once per boot, on the processes that serve requests — not the worker,
   * which shares the database — see {@link upgradeRetiredDefaultTitle}.
   */
  public async onApplicationBootstrap(): Promise<void> {
    if (getProcessRole() === 'worker') return;
    await this.upgradeRetiredDefaultTitle();
  }

  /**
   * A stored title that is still, BYTE FOR BYTE, the bundled default's
   * "Rezeis" becomes "not set", so the page follows the brand.
   *
   * The editor used to open on the bundled default, and its first save for
   * any reason stored that title: a pre-fill, not an operator's choice. Any
   * other title — "Rezeis VPN", " Rezeis", "rezeis" — is left alone, and once
   * upgraded the row no longer matches, so a second boot writes nothing.
   *
   * The whole config is written back, so the write is a compare-and-set on
   * `updatedAt`: an operator's save landing between the read and the write
   * keeps everything it saved, and the next boot looks again. Never fails the
   * boot.
   */
  private async upgradeRetiredDefaultTitle(): Promise<void> {
    try {
      const row = await this.prisma.subpageConfig.findUnique({
        where: { key: SubpageConfigService.SINGLETON_KEY },
        select: { config: true, updatedAt: true },
      });
      if (row === null) return;
      const config = readJsonObject(row.config);
      if (rawTitleOf(config) !== RETIRED_DEFAULT_TITLE) return;

      const { count } = await this.prisma.subpageConfig.updateMany({
        where: { key: SubpageConfigService.SINGLETON_KEY, updatedAt: row.updatedAt },
        data: { config: withTitle(config, '') as Prisma.InputJsonValue },
      });
      if (count === 0) return;
      this.logger.log(
        `Stored subscription-page title "${RETIRED_DEFAULT_TITLE}" was the old editor's pre-fill; now "not set" — the page follows the brand.`,
      );
      void this.subpageCache?.invalidate('subpage title: retired default upgraded at boot');
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to upgrade the stored subscription-page title: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The config rezeis-subpage renders: the stored config, else the bundled
   * default (never null) — headed by the SAVED title, or by the operator's
   * brand while there is none.
   *
   * ── The title ─────────────────────────────────────────────────────────────
   *
   * rezeis-subpage prints `brandingSettings.title` at the top of every
   * customer's subscription page. The bundled default's is "Rezeis" — the
   * panel's name; the file is generated in rezeis-subpage and kept
   * byte-identical to its own default, so the title is settled here, on the
   * way out, not by a hand edit the next generation would undo.
   *
   * An empty title means "not set" and is filled at READ time with the brand
   * as it is now, so a brand rename reaches the page. Writing the brand into
   * the config instead is what froze it: the editor showed it as a value and
   * the first save stored it for good.
   */
  public async getEffectiveConfig(): Promise<Record<string, unknown>> {
    const { config } = await this.readSaved();
    if (savedTitleOf(config) !== '') return config;
    return withTitle(config, await this.brandName());
  }

  /**
   * The editor's view (`GET /admin/subpage-config`): the config with the title
   * an operator SAVED — `''` when none, never the bundled default's "Rezeis"
   * and never the brand — and, apart, the brand an empty title shows, for the
   * field's placeholder.
   */
  public async getEditorView(): Promise<{
    readonly config: Record<string, unknown>;
    readonly stored: boolean;
    readonly titleFallback: string;
  }> {
    const [{ config, stored }, titleFallback] = await Promise.all([this.readSaved(), this.brandName()]);
    return { config, stored, titleFallback };
  }

  /** The stored config, or the bundled default; its title as saved (`''`: not set). */
  private async readSaved(): Promise<{ readonly config: Record<string, unknown>; readonly stored: boolean }> {
    const row = await this.prisma.subpageConfig.findUnique({
      where: { key: SubpageConfigService.SINGLETON_KEY },
    });
    if (row === null) {
      // The default's own title is nobody's choice. A copy, never the shared
      // constant: every request reads that one object.
      return { config: withTitle(DEFAULT_SUBPAGE_CONFIG, ''), stored: false };
    }
    const config = readJsonObject(row.config);
    return { config: withTitle(config, savedTitleOf(config)), stored: true };
  }

  /**
   * The operator's `brandName` — the name the cabinet, the emails and the push
   * titles carry; not `projectName`, which only fills `{project_name}` in
   * templates. A settings read that fails gives the stock brand rather than
   * failing the page.
   */
  private async brandName(): Promise<string> {
    const settings = await this.prisma.settings
      .findFirst({ select: { brandingSettings: true } })
      .catch(() => null);
    return readBrandingSettings(settings?.brandingSettings ?? null).brandName;
  }

  /**
   * Replace the whole config. Shallow-validates the top-level shape (the
   * subpage re-validates fully). Returns the persisted config.
   */
  public async replaceConfig(input: unknown): Promise<Record<string, unknown>> {
    const parsed = subpageConfigSchema.safeParse(input);

    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid subpage config',
        issues: parsed.error.issues.slice(0, 10),
      });
    }

    // A title of nothing but spaces is "not set" too, stored as `''`, so the
    // page keeps following the brand (`getEffectiveConfig`).
    const data = parsed.data as Record<string, unknown>;
    const config = withTitle(data, savedTitleOf(data));

    await this.prisma.subpageConfig.upsert({
      where: { key: SubpageConfigService.SINGLETON_KEY },
      create: {
        key: SubpageConfigService.SINGLETON_KEY,
        config: config as Prisma.InputJsonValue,
      },
      update: {
        config: config as Prisma.InputJsonValue,
      },
    });

    this.logger.log('Subpage config updated.');
    return config;
  }
}

/** The title as saved, trimmed; `''` when there is none. */
function savedTitleOf(config: Record<string, unknown>): string {
  return rawTitleOf(config)?.trim() ?? '';
}

/** The title exactly as stored, or `null` when there is no string there. */
function rawTitleOf(config: Record<string, unknown>): string | null {
  const branding = config.brandingSettings;
  if (branding === null || typeof branding !== 'object') return null;
  const title = (branding as Record<string, unknown>).title;
  return typeof title === 'string' ? title : null;
}

/**
 * `config` with `title` in its branding block — a copy; the input is never
 * written to. A config without a branding object is returned as it is: there
 * is no title to settle, and inventing half a block would not make it valid.
 */
function withTitle(config: Record<string, unknown>, title: string): Record<string, unknown> {
  const branding = config.brandingSettings;
  if (branding === null || typeof branding !== 'object' || Array.isArray(branding)) return config;
  return { ...config, brandingSettings: { ...(branding as Record<string, unknown>), title } };
}
