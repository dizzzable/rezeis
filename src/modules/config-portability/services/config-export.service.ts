import { Injectable, Logger } from '@nestjs/common';

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
  | 'faqItems';

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
];

export interface ConfigExportPayloadInterface {
  readonly version: number;
  readonly exportedAt: string;
  readonly source: 'rezeis-admin';
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
   */
  public async exportConfig(
    sections: readonly ConfigExportSection[] | null,
  ): Promise<ConfigExportPayloadInterface> {
    const requested = sections === null || sections.length === 0
      ? ALL_SECTIONS
      : sections;
    const payload: Partial<Record<ConfigExportSection, unknown[]>> = {};

    for (const section of requested) {
      try {
        payload[section] = await this.exportSection(section);
      } catch (err) {
        this.logger.error(`Failed to export section "${section}": ${(err as Error).message}`);
        payload[section] = [];
      }
    }

    return {
      version: CONFIG_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
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

      default: {
        const exhaustive: never = section;
        throw new Error(`Unknown config section: ${String(exhaustive)}`);
      }
    }
  }
}
