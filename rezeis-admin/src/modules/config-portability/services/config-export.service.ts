import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Configuration export schema versioning.
 *
 * Bumping `CONFIG_EXPORT_VERSION` is mandatory whenever the shape of any
 * exported section changes incompatibly (renamed fields, removed
 * sections, restructured arrays). The import service refuses to load
 * payloads with a higher version than it knows about.
 */
export const CONFIG_EXPORT_VERSION = 1;

export type ConfigExportSection =
  | 'roles'
  | 'permissions'
  | 'scopePolicies'
  | 'automations'
  | 'webhooks'
  | 'notificationTemplates'
  | 'settings'
  | 'blockedIps'
  | 'adminIpAllowlist'
  | 'faqItems'
  | 'legalDocuments';

export const ALL_SECTIONS: readonly ConfigExportSection[] = [
  'roles',
  'permissions',
  'scopePolicies',
  'automations',
  'webhooks',
  'notificationTemplates',
  'settings',
  'blockedIps',
  'adminIpAllowlist',
  'faqItems',
  'legalDocuments',
];

/**
 * Row count this export observed for every section it wrote.
 *
 * The manifest is the file's own account of itself, and the import side
 * holds the payload against it. Its whole purpose is to make two facts
 * distinguishable that the payload alone cannot separate:
 *
 *   * `"roles": []` because the source really has no roles, and
 *   * `"roles": []` because something ate them between the database and
 *     the file.
 *
 * It is NOT a signature — anyone who can edit `sections` can edit
 * `manifest`. It defends against accidents (a truncated download, a
 * half-written file, a hand-edit that dropped a section) and against
 * exports produced by the code that used to swallow section failures.
 */
export type ConfigExportManifestInterface = Partial<Record<ConfigExportSection, number>>;

export interface ConfigExportPayloadInterface {
  readonly version: number;
  readonly exportedAt: string;
  readonly source: 'rezeis-admin';
  /**
   * Absent on files produced before the manifest existed. The import
   * side treats an absent manifest as "unverifiable", never as "empty" —
   * an empty manifest would mean "this file contains nothing".
   */
  readonly manifest?: ConfigExportManifestInterface;
  readonly sections: Partial<Record<ConfigExportSection, unknown[]>>;
}

/**
 * Read-side service for the operator "Config Export / Import" UI.
 *
 * Goals
 *   - **Atomic snapshot** of operator-curated configuration: roles,
 *     permissions, automations, webhooks, settings, FAQ, IP lists,
 *     notification templates.
 *   - **No PII** — we never serialise users, subscriptions, payments
 *     or anything user-identifying. The export is meant for promoting
 *     a config from staging to production, not for migrating customer
 *     data (that's the role of the existing `imports` module).
 *   - **Stable shape** — every section is a plain array of POJOs that
 *     mirrors the Prisma row 1:1 (with `Date` coerced to ISO strings).
 *     The import side trusts the shape because validation lives there.
 *
 * Sensitive fields
 *   - Webhook secrets ARE exported (operators expect roundtrip).
 *   - 2FA secrets and admin passwords are NEVER exported (they live on
 *     `admin_users` which we never touch from this module).
 */
@Injectable()
export class ConfigExportService {
  private readonly logger = new Logger(ConfigExportService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Export a subset (or all) of the configurable sections.
   * `sections` empty / null → every known section.
   *
   * A section that cannot be read fails the whole export. This used to
   * be swallowed — the failed section was written as `[]` and the
   * response still came back 200 — which produced a file that looks
   * complete and restores to nothing. An operator who genuinely wants a
   * file without the broken section already has an honest way to get
   * one: deselect it and export again. That path makes the omission the
   * operator's own choice and records it in the manifest, so there is
   * nothing a silently-partial file buys that a deliberate subset
   * export does not buy without the lie.
   *
   * Every requested section is still attempted before we throw, so the
   * operator is told about all of the broken ones at once instead of
   * discovering them one retry at a time.
   */
  public async exportConfig(
    sections: readonly ConfigExportSection[] | null,
  ): Promise<ConfigExportPayloadInterface> {
    const requested = sections === null || sections.length === 0
      ? ALL_SECTIONS
      : sections;
    const payload: Partial<Record<ConfigExportSection, unknown[]>> = {};
    const manifest: Partial<Record<ConfigExportSection, number>> = {};
    const failed: ConfigExportSection[] = [];

    for (const section of requested) {
      try {
        const rows = await this.exportSection(section);
        payload[section] = rows;
        manifest[section] = rows.length;
      } catch (err) {
        this.logger.error(`Failed to export section "${section}": ${(err as Error).message}`);
        failed.push(section);
      }
    }

    if (failed.length > 0) {
      // The underlying message stays in the log only: it comes from
      // Prisma and routinely carries a connection string, which the safe
      // exception filter would rightly reduce the whole response to a
      // generic 500 over. The section names are what the operator needs
      // and they carry nothing sensitive.
      throw new ServiceUnavailableException(
        `Config export failed for section(s): ${failed.join(', ')}. `
          + 'No file was produced — retry, or deselect the failing section(s) to export the rest deliberately.',
      );
    }

    return {
      version: CONFIG_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      manifest,
      sections: payload,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async exportSection(section: ConfigExportSection): Promise<unknown[]> {
    switch (section) {
      case 'roles':
        return this.prismaService.adminRole.findMany({});

      case 'permissions':
        return this.prismaService.adminPermission.findMany({});

      case 'scopePolicies':
        return this.prismaService.adminScopePolicy.findMany({});

      case 'automations':
        return this.prismaService.automationRule.findMany({});

      case 'webhooks':
        // Includes the secret — operators promoting config to a fresh
        // env need the receivers to keep validating. Strip via UI on
        // export if you want to ship a sanitised copy.
        return this.prismaService.webhookSubscription.findMany({});

      case 'notificationTemplates':
        return this.prismaService.notificationTemplate.findMany({});

      case 'settings': {
        const row = await this.prismaService.settings.findFirst();
        return row ? [row] : [];
      }

      case 'blockedIps':
        return this.prismaService.blockedIp.findMany({});

      case 'adminIpAllowlist':
        return this.prismaService.adminIpAllowlist.findMany({});

      case 'faqItems':
        return this.prismaService.faqItem.findMany({});

      // The agreement / offer texts and their on/off switches. Carried because
      // a transfer that leaves them behind does not merely lose content: the
      // destination keeps the two empty, inactive rows the migration seeds, so
      // registration silently stops asking for consent. Consents themselves
      // (`user_legal_consents`) are NOT exported — they belong to users, not to
      // the configuration.
      case 'legalDocuments':
        return this.prismaService.legalDocument.findMany({});

      default: {
        const exhaustive: never = section;
        throw new Error(`Unknown config section: ${String(exhaustive)}`);
      }
    }
  }
}
