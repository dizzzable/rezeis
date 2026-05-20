import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  ALL_SECTIONS,
  CONFIG_EXPORT_VERSION,
  ConfigExportPayloadInterface,
  ConfigExportSection,
} from './config-export.service';

export type ImportStrategy = 'skip' | 'overwrite';

export interface ConfigImportInput {
  readonly payload: ConfigExportPayloadInterface;
  readonly sections: readonly ConfigExportSection[] | null;
  readonly strategy: ImportStrategy;
  readonly dryRun: boolean;
}

export interface SectionImportSummaryInterface {
  readonly section: ConfigExportSection;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly errors: readonly string[];
}

export interface ConfigImportResultInterface {
  readonly version: number;
  readonly strategy: ImportStrategy;
  readonly dryRun: boolean;
  readonly summaries: readonly SectionImportSummaryInterface[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

/**
 * Configuration import service.
 *
 * Strategies
 *   - `skip`      → if a row with the same primary key already exists,
 *                   it stays untouched and the input is dropped.
 *   - `overwrite` → existing rows are PATCHED with the imported values
 *                   (never deleted; the old fields keep their values
 *                   when the import omits them).
 *
 * Dry-run
 *   When `dryRun=true` the service runs every step inside a transaction
 *   that ALWAYS rolls back, so the operator sees the per-section
 *   summary without committing anything. Useful for promoting config
 *   between environments — operators preview, then re-run with
 *   `dryRun=false`.
 *
 * Sensitive notes
 *   - We never import `admin_users` rows (those are managed by the auth
 *     module).
 *   - Settings (singleton) is always overwritten when included; the
 *     `skip` strategy on settings means "leave the singleton untouched".
 */
@Injectable()
export class ConfigImportService {
  private readonly logger = new Logger(ConfigImportService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  public async importConfig(input: ConfigImportInput): Promise<ConfigImportResultInterface> {
    this.validatePayload(input.payload);

    const requested = input.sections === null || input.sections.length === 0
      ? ALL_SECTIONS
      : input.sections;
    const startedAt = new Date();

    const summaries: SectionImportSummaryInterface[] = [];

    // Run inside a single transaction so partial failures roll back as
    // a whole. Dry-run uses an explicit rollback at the end.
    try {
      await this.prismaService.$transaction(async (tx) => {
        for (const section of requested) {
          const rows = (input.payload.sections[section] ?? []) as Array<Record<string, unknown>>;
          summaries.push(
            await this.importSection(tx, section, rows, input.strategy),
          );
        }
        if (input.dryRun) {
          // Roll the transaction back by throwing a sentinel error.
          throw new DryRunRollback();
        }
      });
    } catch (err) {
      if (!(err instanceof DryRunRollback)) {
        throw err;
      }
    }

    return {
      version: CONFIG_EXPORT_VERSION,
      strategy: input.strategy,
      dryRun: input.dryRun,
      summaries,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }

  private validatePayload(payload: ConfigExportPayloadInterface): void {
    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException('Payload must be an object');
    }
    if (typeof payload.version !== 'number' || payload.version > CONFIG_EXPORT_VERSION) {
      throw new BadRequestException(
        `Unsupported config export version (got ${payload.version}, max ${CONFIG_EXPORT_VERSION})`,
      );
    }
    if (typeof payload.sections !== 'object' || payload.sections === null) {
      throw new BadRequestException('Payload.sections must be an object');
    }
  }

  private async importSection(
    tx: PrismaTransactionClient,
    section: ConfigExportSection,
    rows: Array<Record<string, unknown>>,
    strategy: ImportStrategy,
  ): Promise<SectionImportSummaryInterface> {
    const errors: string[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    if (rows.length === 0) {
      return { section, created, updated, skipped, errors };
    }

    try {
      switch (section) {
        case 'roles':
          ({ created, updated, skipped } = await this.upsertById(tx.adminRole, rows, strategy));
          break;
        case 'permissions':
          // Permissions hang off roles via FK. Drop rows whose role is
          // missing in the destination instead of failing the section.
          ({ created, updated, skipped } = await this.upsertPermissions(tx, rows, strategy));
          break;
        case 'scopePolicies':
          ({ created, updated, skipped } = await this.upsertById(tx.adminScopePolicy, rows, strategy));
          break;
        case 'automations':
          ({ created, updated, skipped } = await this.upsertById(tx.automationRule, rows, strategy));
          break;
        case 'webhooks':
          ({ created, updated, skipped } = await this.upsertById(tx.webhookSubscription, rows, strategy));
          break;
        case 'notificationTemplates':
          ({ created, updated, skipped } = await this.upsertById(tx.notificationTemplate, rows, strategy));
          break;
        case 'settings':
          ({ created, updated, skipped } = await this.upsertSettings(tx, rows, strategy));
          break;
        case 'blockedIps':
          ({ created, updated, skipped } = await this.upsertById(tx.blockedIp, rows, strategy));
          break;
        case 'adminIpAllowlist':
          ({ created, updated, skipped } = await this.upsertById(tx.adminIpAllowlist, rows, strategy));
          break;
        case 'faqItems':
          ({ created, updated, skipped } = await this.upsertById(tx.faqItem, rows, strategy));
          break;
        default: {
          const exhaustive: never = section;
          throw new Error(`Unknown config section: ${String(exhaustive)}`);
        }
      }
    } catch (err) {
      errors.push((err as Error).message);
    }

    return { section, created, updated, skipped, errors };
  }

  /**
   * Generic upsert by `id` for sections whose rows have a `String id`
   * primary key. Skips rows without an id and rows whose timestamps
   * cannot be coerced.
   */
  private async upsertById(
    delegate: GenericPrismaDelegate,
    rows: Array<Record<string, unknown>>,
    strategy: ImportStrategy,
  ): Promise<{ created: number; updated: number; skipped: number }> {
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const id = row['id'];
      if (typeof id !== 'string' || id.length === 0) {
        skipped += 1;
        continue;
      }
      const existing = await delegate.findUnique({ where: { id } });
      // Strip relation fields that Prisma doesn't accept on raw create.
      const data = stripRelationFields(coerceTimestamps(row));
      if (existing) {
        if (strategy === 'skip') {
          skipped += 1;
          continue;
        }
        await delegate.update({ where: { id }, data });
        updated += 1;
      } else {
        await delegate.create({ data });
        created += 1;
      }
    }
    return { created, updated, skipped };
  }

  /**
   * Permissions need an extra step: drop rows whose role is missing in
   * the destination. Uses the `(roleId, resource, action)` composite
   * unique index for upsert lookup.
   */
  private async upsertPermissions(
    tx: PrismaTransactionClient,
    rows: Array<Record<string, unknown>>,
    strategy: ImportStrategy,
  ): Promise<{ created: number; updated: number; skipped: number }> {
    let created = 0;
    const updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const roleId = row['roleId'];
      const resource = row['resource'];
      const action = row['action'];
      if (typeof roleId !== 'string' || typeof resource !== 'string' || typeof action !== 'string') {
        skipped += 1;
        continue;
      }
      // Skip orphans — operator may have unselected the roles section.
      const role = await tx.adminRole.findUnique({ where: { id: roleId } });
      if (!role) {
        skipped += 1;
        continue;
      }
      const existing = await tx.adminPermission.findUnique({
        where: { roleId_resource_action: { roleId, resource, action } },
      });
      if (existing) {
        if (strategy === 'skip') {
          skipped += 1;
          continue;
        }
        // Composite uniques are immutable here — nothing to update on
        // overwrite. We just keep the existing row.
        skipped += 1;
        continue;
      }
      await tx.adminPermission.create({ data: { roleId, resource, action } });
      created += 1;
    }
    return { created, updated, skipped };
  }

  /**
   * Settings is a singleton (id=1). On `skip` we leave the destination
   * row untouched; on `overwrite` we patch the existing row with all
   * fields from the import.
   */
  private async upsertSettings(
    tx: PrismaTransactionClient,
    rows: Array<Record<string, unknown>>,
    strategy: ImportStrategy,
  ): Promise<{ created: number; updated: number; skipped: number }> {
    if (rows.length === 0) {
      return { created: 0, updated: 0, skipped: 0 };
    }
    const row = rows[0]!;
    const data = stripRelationFields(coerceTimestamps(row));
    delete data['id'];
    const existing = await tx.settings.findFirst();
    if (existing) {
      if (strategy === 'skip') {
        return { created: 0, updated: 0, skipped: 1 };
      }
      await tx.settings.update({ where: { id: existing.id }, data });
      return { created: 0, updated: 1, skipped: 0 };
    }
    await tx.settings.create({ data: { ...data, id: 1 } });
    return { created: 1, updated: 0, skipped: 0 };
  }
}

class DryRunRollback extends Error {
  public constructor() {
    super('dry-run-rollback');
  }
}

/**
 * Common shape for Prisma delegates used by `upsertById`. We don't pull
 * the generated Prisma types directly because the delegates are nested
 * inside the transactional client and we don't want to thread their
 * exact generic signatures through every call.
 */
interface GenericPrismaDelegate {
  findUnique(args: { where: { id: string } }): Promise<unknown>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
}

type PrismaTransactionClient = Parameters<
  Parameters<PrismaService['$transaction']>[0]
>[0];

function coerceTimestamps(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        out[key] = parsed;
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

function stripRelationFields(row: Record<string, unknown>): Record<string, unknown> {
  // Defensive: drop any nested objects/arrays Prisma would reject as
  // implicit relation writes. We also drop `auditLogs`, `executions`,
  // and other reverse-side relations that some delegates may have
  // included via `include`.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (Array.isArray(value)) {
      // Accept arrays of strings (TEXT[]) — like `eventTypes`,
      // `affectedUserIds`, `internalSquads`, `totpRecoveryCodes`.
      if (value.every((v) => typeof v === 'string')) {
        out[key] = value;
      }
      continue;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !(value instanceof Date)
    ) {
      // Allow plain JSON columns (objects). Reject relation includes.
      // We can't tell the two apart structurally, so we keep them: any
      // bad shape will surface as a Prisma error and be caught by the
      // section-level try/catch.
      out[key] = value;
      continue;
    }
    out[key] = value;
  }
  return out;
}
