import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { type ConfigExportOptions, redactSectionRows } from './config-export-redaction';

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

/**
 * Who asked, and from where.
 *
 * Taken from `@CurrentAdmin()` and the request, never from a body field — an
 * actor a caller can name is an actor a caller can forge, and the whole value
 * of these rows is that the name in them is the one the JWT proved.
 */
export interface ConfigPortabilityActor {
  readonly adminId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

export interface ConfigExportRequestOptions extends ConfigExportOptions {
  readonly actor?: ConfigPortabilityActor;
}

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
 *     mirrors the ALLOWLISTED columns of the Prisma row (with `Date`
 *     coerced to ISO strings). The import side trusts the shape because
 *     validation lives there.
 *
 * Sensitive fields
 *   This block used to say "No PII" and "2FA secrets and admin passwords
 *   are NEVER exported". Both were literally true and both were beside
 *   the point: the file still carried the SMTP password in the clear,
 *   `botTokenEnc`, `webPush.privateKeyEnc`, `turnstileSecretEnc`, the
 *   quest-partner `secretEnc`, the AI `apiKeyEnc` and every
 *   `webhooks.secret`. What is true now:
 *
 *   - Every section is filtered through `config-export-redaction.ts`:
 *     a column allowlist, plus a recursive pass that strips
 *     secret-shaped KEY NAMES and ciphertext-shaped VALUES from JSON
 *     columns at any depth. A column added to `schema.prisma` is
 *     excluded until somebody adds it to the allowlist on purpose.
 *   - `webhooks.secret` is exported only when the caller asks for it
 *     (`includeWebhookSecrets`). The round-trip capability is kept; it
 *     just stopped being the default.
 *   - 2FA secrets and admin passwords are still never exported — they
 *     live on `admin_users`, which this module does not read.
 *   - Redaction OMITS a field rather than replacing it, so importing a
 *     redacted export leaves the destination's own secrets intact.
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
    options: ConfigExportRequestOptions = {},
  ): Promise<ConfigExportPayloadInterface> {
    const requested = sections === null || sections.length === 0
      ? ALL_SECTIONS
      : sections;
    const payload: Partial<Record<ConfigExportSection, unknown[]>> = {};
    const manifest: Partial<Record<ConfigExportSection, number>> = {};
    const failed: ConfigExportSection[] = [];
    const droppedColumns = new Set<string>();
    const redactedPaths = new Set<string>();

    for (const section of requested) {
      try {
        const raw = await this.exportSection(section);
        // Nothing reaches `payload` un-filtered. Deliberately here, at the one
        // place every section funnels through, rather than in the eleven
        // `findMany` arms — a twelfth arm added later is filtered too.
        const redacted = redactSectionRows(section, raw, options);
        for (const column of redacted.droppedColumns) droppedColumns.add(column);
        for (const path of redacted.redactedPaths) redactedPaths.add(path);
        payload[section] = redacted.rows;
        manifest[section] = redacted.rows.length;
      } catch (err) {
        this.logger.error(`Failed to export section "${section}": ${(err as Error).message}`);
        failed.push(section);
      }
    }

    if (droppedColumns.size > 0) {
      // Not silent: a column added to `schema.prisma` and not to the allowlist
      // simply stops being promoted between environments, and the operator
      // would find out when the destination behaves differently for no visible
      // reason. This line is how the next person learns to make a decision.
      this.logger.warn(
        `Config export dropped columns that are not on the allowlist (add them to `
          + `SECTION_FIELD_ALLOWLIST if they are safe to export): ${[...droppedColumns].join(', ')}`,
      );
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

    await this.recordExport(options.actor, {
      sections: [...requested],
      includeWebhookSecrets: options.includeWebhookSecrets === true,
      redactedPaths: [...redactedPaths].slice(0, 100),
      droppedColumns: [...droppedColumns].slice(0, 100),
    });

    return {
      version: CONFIG_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      manifest,
      sections: payload,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────

  /**
   * Write the audit row for an export.
   *
   * Nothing in this module wrote one before: the single most exfiltration-shaped
   * operation the panel has — "give me the configuration of this deployment as
   * a file" — left no record of who took it, from where, or which sections.
   *
   * `actor` is optional so the service stays callable from a non-HTTP context
   * (and so the existing unit tests, which construct it with a bare Prisma
   * stub, keep describing the export rather than the audit). The controller
   * always supplies one, taken from `@CurrentAdmin()` — never from the body.
   */
  private async recordExport(
    actor: ConfigPortabilityActor | undefined,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (actor === undefined) return;
    await this.prismaService.adminAuditLog.create({
      data: {
        action: 'config_portability.exported',
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: { requestId: actor.requestId, ...metadata } as Prisma.InputJsonObject,
        adminUser: { connect: { id: actor.adminId } },
      },
    });
  }

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
        // The secret is read here and dropped by the redaction pass unless the
        // caller passed `includeWebhookSecrets`. Kept as a full row read rather
        // than a `select` so the allowlist stays the single place that decides
        // what leaves — a `select` here would be a second, competing answer.
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
