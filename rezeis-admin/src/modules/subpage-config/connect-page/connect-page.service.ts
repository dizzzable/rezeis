import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { readJsonObject } from '../../../common/utils/read-json-object.util';
import { DEFAULT_CONNECT_PAGE_CONFIG } from './connect-page.default';
import {
  auditConnectPageConfig,
  connectPageConfigSchema,
  MAX_ICON_BYTES,
  normalizeConnectPageConfig,
  type ConnectPageConfig,
  type ConnectPageIssue,
} from './connect-page.schema';
import { InvalidIconError, sanitizeIconMarkup } from './svg-sanitizer.util';

/**
 * The stable code both refusals of a catalog carry.
 *
 * Its twin is a literal inside `admin-safe-exception.filter.ts`, not an import
 * of this constant — that filter's allowlists are hand-audited on purpose, and
 * one that imports the set it gates admits every future member automatically.
 * `connect-page-refusal-wire.spec.ts` checks the two spellings agree, and that
 * the rows actually survive the filter, because the throw site and the wire are
 * different places and only the second one is what the editor sees.
 */
export const CONNECT_PAGE_CATALOG_INVALID = 'CONNECT_PAGE_CATALOG_INVALID';

/**
 * ConnectPageService
 * ──────────────────
 * Owns the catalog the cabinet's connect screen renders.
 *
 * Stored beside the v1 config in `subpage_configs`, under its own key, so this
 * needs no migration and the two can coexist while the old editor is still
 * wired to v1. They are not versions of one row on purpose: a single row that
 * changes shape underneath a running editor is how a panel ships broken between
 * two deploys.
 *
 * ── Everything is checked on the way IN ──────────────────────────────────────
 *
 * Three passes, and each answers a different question:
 *
 *   1. the schema  — is every field the right shape?
 *   2. the icons   — is this markup safe to put in a customer's page?
 *   3. the audit   — does the catalog as a whole actually work?
 *
 * A config can pass the first and fail the third: three tidy steps, two store
 * buttons and no way to hand the subscription over parses perfectly and shows
 * a customer a card they cannot use. The reason all three run here rather than
 * in the cabinet is that here there is still somebody looking at the screen who
 * can fix it.
 */
@Injectable()
export class ConnectPageService {
  private static readonly KEY = 'connect-page-v2';
  /**
   * The switch lives in its OWN row, not in the catalog.
   *
   * It travels to the cabinet inside the same payload — that part was right and
   * is unchanged. What was wrong was storing it there: the toggle card had to
   * send the whole config back to flip one boolean, so the first flick froze
   * the built-in default into the database forever and no later improvement to
   * it would ever reach that install. And the editor, saving a draft branched
   * before the flick, silently switched the screen back off.
   *
   * Two rows, one payload, and neither writer can clobber the other's field.
   */
  private static readonly ENABLED_KEY = 'connect-page-enabled';

  private readonly logger = new Logger(ConnectPageService.name);

  public constructor(private readonly prisma: PrismaService) {}

  /**
   * What the cabinet and the editor both read. Never null: an install that has
   * never been edited still has a working catalog.
   */
  public async getEffectiveConfig(): Promise<ConnectPageConfig> {
    const [row, enabled] = await Promise.all([
      this.prisma.subpageConfig.findUnique({ where: { key: ConnectPageService.KEY } }),
      this.isEnabled(),
    ]);
    const withFlag = (config: ConnectPageConfig): ConnectPageConfig => ({
      ...config,
      connectScreenEnabled: enabled,
    });
    // Normalized on the way out as well as on the way in, so `encode` is
    // present on every deep link the cabinet ever sees — including the default,
    // which never passes through the save path. The cabinet refuses to render a
    // button without it rather than guessing, and "the default is the one
    // config that guesses" is not a difference anyone would find on purpose.
    if (row === null) return withFlag(normalizeConnectPageConfig(DEFAULT_CONNECT_PAGE_CONFIG));

    const parsed = connectPageConfigSchema.safeParse(readJsonObject(row.config));
    if (parsed.success) return withFlag(normalizeConnectPageConfig(parsed.data));

    // A stored config that no longer parses is a schema change that landed
    // without a migration. Serving the default keeps customers connecting while
    // that is sorted out; serving the unparsed blob would push the failure into
    // the cabinet, where nobody can read it.
    this.logger.error(
      `Stored connect-page config no longer matches the schema; serving the default. First issue: ${
        parsed.error.issues[0]?.message ?? 'unknown'
      }`,
    );
    return withFlag(normalizeConnectPageConfig(DEFAULT_CONNECT_PAGE_CONFIG));
  }

  /**
   * Whether the cabinet opens its own screen.
   *
   * Read and written on its own so flicking the switch is not an edit of the
   * catalog — see {@link ConnectPageService.ENABLED_KEY}.
   */
  public async isEnabled(): Promise<boolean> {
    const row = await this.prisma.subpageConfig.findUnique({
      where: { key: ConnectPageService.ENABLED_KEY },
    });
    return row === null ? false : readJsonObject(row.config)['enabled'] === true;
  }

  public async setEnabled(enabled: boolean): Promise<boolean> {
    await this.prisma.subpageConfig.upsert({
      where: { key: ConnectPageService.ENABLED_KEY },
      create: { key: ConnectPageService.ENABLED_KEY, config: { enabled } },
      update: { config: { enabled } },
    });
    this.logger.log(`Connect screen ${enabled ? 'enabled' : 'disabled'}.`);
    return enabled;
  }

  /** True once an operator has saved one, as opposed to running the default. */
  public async hasStoredConfig(): Promise<boolean> {
    const count = await this.prisma.subpageConfig.count({
      where: { key: ConnectPageService.KEY },
    });
    return count > 0;
  }

  /**
   * Whether the stored catalog is there but unreadable.
   *
   * The editor has to be able to tell that apart from "nothing saved yet",
   * because the two look identical from `getEffectiveConfig` + `hasStoredConfig`:
   * both hand back the built-in default with `stored: true`. An operator would
   * see the default, assume it was their catalog, change one label and save —
   * destroying the real one. The neighbouring landing builder was bitten by
   * exactly this and now returns a `corrupted` marker; so does this.
   */
  public async readState(): Promise<{
    readonly config: ConnectPageConfig;
    readonly stored: boolean;
    readonly corrupted: string | null;
  }> {
    const row = await this.prisma.subpageConfig.findUnique({
      where: { key: ConnectPageService.KEY },
    });
    const config = await this.getEffectiveConfig();
    if (row === null) return { config, stored: false, corrupted: null };
    const parsed = connectPageConfigSchema.safeParse(readJsonObject(row.config));
    return {
      config,
      stored: true,
      corrupted: parsed.success ? null : (parsed.error.issues[0]?.message ?? 'unreadable'),
    };
  }

  /**
   * Validate, clean, stamp, store.
   *
   * Returns what was actually persisted rather than what was sent: the icons
   * come back cleaned and `encode` comes back derived, so the editor shows the
   * operator the config that exists rather than the one they submitted.
   */
  public async replaceConfig(input: unknown): Promise<{
    readonly config: ConnectPageConfig;
    /** What the sanitizer threw away, per icon, so it can be reported instead of silently applied. */
    readonly cleanedIcons: Readonly<Record<string, readonly string[]>>;
  }> {
    const parsed = connectPageConfigSchema.safeParse(input);
    if (!parsed.success) {
      // The code is what carries the rows past the safe exception filter: it
      // allowlists `issues` per code, and without it the editor gets a 400 with
      // nothing in it but "could not save". See `CODES_CARRYING_ISSUES`.
      throw new BadRequestException({
        code: CONNECT_PAGE_CATALOG_INVALID,
        message: 'Invalid connect-page config',
        issues: parsed.error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const { icons, cleanedIcons, issues: iconIssues } = ConnectPageService.cleanIcons(
      parsed.data.icons,
    );
    // The flag is not the editor's to write: a draft branched before the switch
    // was flicked would carry the old value and turn the screen back off under
    // a green "saved" toast. It is re-read from its own row on the way out.
    const config = normalizeConnectPageConfig({ ...parsed.data, icons, connectScreenEnabled: false });
    // The audit runs on the CLEANED config: an icon the sanitizer refused is an
    // icon key that no longer exists, and the audit is what notices that
    // something still points at it.
    const issues = [...iconIssues, ...auditConnectPageConfig(config)];
    if (issues.length > 0) {
      throw new BadRequestException({
        code: CONNECT_PAGE_CATALOG_INVALID,
        message: 'The catalog would not work',
        issues,
      });
    }

    await this.prisma.subpageConfig.upsert({
      where: { key: ConnectPageService.KEY },
      create: { key: ConnectPageService.KEY, config: config as unknown as Prisma.InputJsonValue },
      update: { config: config as unknown as Prisma.InputJsonValue },
    });

    const enabled = await this.isEnabled();
    this.logger.log(
      `Connect-page catalog updated: ${config.platforms.length} platform(s), ${config.platforms.reduce(
        (sum, platform) => sum + platform.apps.length,
        0,
      )} app(s).`,
    );
    return { config: { ...config, connectScreenEnabled: enabled }, cleanedIcons };
  }

  /**
   * Check without storing, for the editor to show problems as they are typed.
   *
   * Same three passes as {@link replaceConfig} and deliberately the same code:
   * a preview that validated differently from the save would tell an operator
   * their catalog is fine and then refuse it.
   */
  public dryRun(input: unknown): {
    readonly ok: boolean;
    readonly issues: readonly ConnectPageIssue[];
    /** What a save would strip from each icon — reported, not silently applied. */
    readonly cleanedIcons: Readonly<Record<string, readonly string[]>>;
  } {
    const parsed = connectPageConfigSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        cleanedIcons: {},
        issues: parsed.error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
    }

    const { icons, cleanedIcons, issues: iconIssues } = ConnectPageService.cleanIcons(
      parsed.data.icons,
    );
    const issues = [
      ...iconIssues,
      ...auditConnectPageConfig(
        normalizeConnectPageConfig({ ...parsed.data, icons, connectScreenEnabled: false }),
      ),
    ];
    return { ok: issues.length === 0, issues, cleanedIcons };
  }

  /**
   * The icon pass, shared by the save and the dry run because the docblock
   * above promised they were "deliberately the same code" and they were not.
   *
   * The dry run had its own copy of this loop, missing exactly one branch: the
   * size re-check below. So an icon that grew past the ceiling while being
   * cleaned passed the preview and was refused by the save a click later —
   * a green "the catalog works" followed by a red refusal, which is precisely
   * the outcome that comment forbids. A promise of sameness that two copies
   * have to keep is not a promise, it is a hope; now there is one copy.
   */
  private static cleanIcons(source: Readonly<Record<string, string>>): {
    readonly icons: Record<string, string>;
    readonly cleanedIcons: Record<string, string[]>;
    readonly issues: ConnectPageIssue[];
  } {
    const icons: Record<string, string> = {};
    const cleanedIcons: Record<string, string[]> = {};
    const issues: ConnectPageIssue[] = [];
    for (const [key, markup] of Object.entries(source)) {
      try {
        const result = sanitizeIconMarkup(markup);
        // Checked AFTER cleaning, because cleaning GROWS the string: every `&`
        // becomes `&amp;`. An icon just under the ceiling on the way in came out
        // over it, was stored anyway, and then failed to parse on the way out —
        // turning a successful save into a config the cabinet could not read and
        // the editor could not tell from a fresh install.
        if (result.markup.length > MAX_ICON_BYTES) {
          issues.push({
            path: `icons.${key}`,
            message: 'The icon is too large once cleaned — simplify it or shorten its text',
          });
          continue;
        }
        icons[key] = result.markup;
        if (result.removed.length > 0) cleanedIcons[key] = [...result.removed];
      } catch (error) {
        issues.push({
          path: `icons.${key}`,
          message: error instanceof InvalidIconError ? error.message : 'The icon could not be read',
        });
      }
    }
    return { icons, cleanedIcons, issues };
  }
}
