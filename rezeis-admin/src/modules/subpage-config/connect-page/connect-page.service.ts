import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { readJsonObject } from '../../../common/utils/read-json-object.util';
import { DEFAULT_CONNECT_PAGE_CONFIG } from './connect-page.default';
import {
  auditConnectPageConfig,
  connectPageConfigSchema,
  normalizeConnectPageConfig,
  type ConnectPageConfig,
  type ConnectPageIssue,
} from './connect-page.schema';
import { InvalidIconError, sanitizeIconMarkup } from './svg-sanitizer.util';

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

  private readonly logger = new Logger(ConnectPageService.name);

  public constructor(private readonly prisma: PrismaService) {}

  /**
   * What the cabinet and the editor both read. Never null: an install that has
   * never been edited still has a working catalog.
   */
  public async getEffectiveConfig(): Promise<ConnectPageConfig> {
    const row = await this.prisma.subpageConfig.findUnique({
      where: { key: ConnectPageService.KEY },
    });
    if (row === null) return DEFAULT_CONNECT_PAGE_CONFIG;

    const parsed = connectPageConfigSchema.safeParse(readJsonObject(row.config));
    if (parsed.success) return parsed.data;

    // A stored config that no longer parses is a schema change that landed
    // without a migration. Serving the default keeps customers connecting while
    // that is sorted out; serving the unparsed blob would push the failure into
    // the cabinet, where nobody can read it.
    this.logger.error(
      `Stored connect-page config no longer matches the schema; serving the default. First issue: ${
        parsed.error.issues[0]?.message ?? 'unknown'
      }`,
    );
    return DEFAULT_CONNECT_PAGE_CONFIG;
  }

  /** True once an operator has saved one, as opposed to running the default. */
  public async hasStoredConfig(): Promise<boolean> {
    const count = await this.prisma.subpageConfig.count({
      where: { key: ConnectPageService.KEY },
    });
    return count > 0;
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
      throw new BadRequestException({
        message: 'Invalid connect-page config',
        issues: parsed.error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const cleanedIcons: Record<string, string[]> = {};
    const icons: Record<string, string> = {};
    const iconIssues: ConnectPageIssue[] = [];
    for (const [key, markup] of Object.entries(parsed.data.icons)) {
      try {
        const result = sanitizeIconMarkup(markup);
        icons[key] = result.markup;
        if (result.removed.length > 0) cleanedIcons[key] = [...result.removed];
      } catch (error) {
        iconIssues.push({
          path: `icons.${key}`,
          message: error instanceof InvalidIconError ? error.message : 'The icon could not be read',
        });
      }
    }

    const config = normalizeConnectPageConfig({ ...parsed.data, icons });
    // The audit runs on the CLEANED config: an icon the sanitizer refused is an
    // icon key that no longer exists, and the audit is what notices that
    // something still points at it.
    const issues = [...iconIssues, ...auditConnectPageConfig(config)];
    if (issues.length > 0) {
      throw new BadRequestException({ message: 'The catalog would not work', issues });
    }

    await this.prisma.subpageConfig.upsert({
      where: { key: ConnectPageService.KEY },
      create: { key: ConnectPageService.KEY, config: config as unknown as Prisma.InputJsonValue },
      update: { config: config as unknown as Prisma.InputJsonValue },
    });

    this.logger.log(
      `Connect-page catalog updated: ${config.platforms.length} platform(s), ${config.platforms.reduce(
        (sum, platform) => sum + platform.apps.length,
        0,
      )} app(s).`,
    );
    return { config, cleanedIcons };
  }

  /**
   * Check without storing, for the editor to show problems as they are typed.
   *
   * Same three passes as {@link replaceConfig} and deliberately the same code:
   * a preview that validated differently from the save would tell an operator
   * their catalog is fine and then refuse it.
   */
  public dryRun(input: unknown): { readonly ok: boolean; readonly issues: readonly ConnectPageIssue[] } {
    const parsed = connectPageConfigSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
    }

    const issues: ConnectPageIssue[] = [];
    const icons: Record<string, string> = {};
    for (const [key, markup] of Object.entries(parsed.data.icons)) {
      try {
        icons[key] = sanitizeIconMarkup(markup).markup;
      } catch (error) {
        issues.push({
          path: `icons.${key}`,
          message: error instanceof InvalidIconError ? error.message : 'The icon could not be read',
        });
      }
    }
    issues.push(...auditConnectPageConfig(normalizeConnectPageConfig({ ...parsed.data, icons })));
    return { ok: issues.length === 0, issues };
  }
}
