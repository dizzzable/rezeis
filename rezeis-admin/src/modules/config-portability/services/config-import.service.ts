import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { isValidPermission } from '../../rbac/rbac.resources';
import {
  ALL_SECTIONS,
  CONFIG_EXPORT_VERSION,
  ConfigExportManifestInterface,
  ConfigExportPayloadInterface,
  ConfigExportSection,
} from './config-export.service';

export type ImportStrategy = 'skip' | 'overwrite';

/**
 * Sections that can create/alter RBAC grants. Importing them is a
 * privilege-escalation surface, so we gate them behind `rbac_roles:edit`
 * (see `PRIVILEGED_SECTION_TOKEN`) in addition to the endpoint's own
 * `config_portability:import` permission.
 */
const PRIVILEGED_SECTIONS: ReadonlySet<ConfigExportSection> = new Set([
  'roles',
  'permissions',
]);

/** The permission an importer must hold to import roles/permissions. */
const PRIVILEGED_SECTION_TOKEN = 'rbac_roles:edit';

export interface ConfigImportInput {
  readonly payload: ConfigExportPayloadInterface;
  readonly sections: readonly ConfigExportSection[] | null;
  readonly strategy: ImportStrategy;
  readonly dryRun: boolean;
  /**
   * Flat `resource:action` tokens the importing admin effectively holds.
   * Used to enforce two invariants on RBAC-bearing sections:
   *   1. `roles`/`permissions` may only be imported by an admin who holds
   *      `rbac_roles:edit`;
   *   2. an admin can never import a permission it does not itself hold
   *      (no self-escalation via a crafted export payload).
   * Superadmin/DEV hold the full catalog, so both checks pass for them.
   */
  readonly importerPermissions: ReadonlySet<string>;
}

/**
 * What actually happened to a section, as opposed to how many rows moved.
 *
 * `created: 0, updated: 0, errors: []` used to be the answer for four
 * different situations, only one of which is a success. They are now
 * four different words:
 *
 *   - `imported` — the section was in the file and every row was
 *     processed. Zero counts here mean the file genuinely held zero rows.
 *   - `missing`  — the file has no such key. Nothing was imported and
 *     nothing is known about it. This is NOT a failure when the operator
 *     imported "everything" from a deliberately partial file; it is one
 *     when they named the section.
 *   - `rejected` — the key is there but the payload is not trustworthy
 *     (not an array, or it contradicts the export manifest). Refused
 *     before touching the database.
 *   - `failed`   — the section was attempted and the write threw. See
 *     `errors`.
 */
export type SectionImportStatus = 'imported' | 'missing' | 'rejected' | 'failed';

/**
 * Whether the payload could be held against its own manifest.
 *
 * - `verified`     — the file carries a manifest and every section this
 *   import looked at agreed with it. Sections outside the requested set
 *   are not checked, so this is a statement about what was imported, not
 *   about the whole file.
 * - `unverifiable` — the file carries no manifest. Either it predates
 *   the manifest or it was written by hand. Its sections are taken at
 *   face value, exactly as they always were.
 * - `violated`     — the manifest and the payload disagree somewhere.
 *   The file is damaged; the disagreeing sections were refused.
 */
export type PayloadIntegrityStatus = 'verified' | 'unverifiable' | 'violated';

export interface SectionImportSummaryInterface {
  readonly section: ConfigExportSection;
  readonly status: SectionImportStatus;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly errors: readonly string[];
}

export interface ConfigImportResultInterface {
  readonly version: number;
  readonly strategy: ImportStrategy;
  readonly dryRun: boolean;
  readonly integrity: PayloadIntegrityStatus;
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

    const explicit = input.sections !== null && input.sections.length > 0;
    const requested = explicit
      ? (input.sections as readonly ConfigExportSection[])
      : ALL_SECTIONS;

    // Read every requested section out of the payload BEFORE any write,
    // so the escalation gate, the manifest check and the summary all
    // agree on what the file actually contains.
    const manifest = readManifest(input.payload);
    const plan = requested.map((section) =>
      classifySection(section, input.payload.sections, manifest, explicit),
    );

    // Privilege-escalation guard: importing roles/permissions can hand out
    // grants, so an admin needs `rbac_roles:edit` on top of the endpoint's
    // `config_portability:import`. Without this, an admin whose ONLY power
    // is config import could inject `rbac_roles:edit`/`admins:edit` grants
    // and take over the panel.
    //
    // Reads the classified rows rather than the raw payload: `?? []`
    // followed by `.length > 0` also passed for a non-array `sections.roles`
    // (a string has a length), and a section the manifest check refuses
    // must not arm the gate either.
    const touchesPrivileged = plan.some(
      (entry) =>
        PRIVILEGED_SECTIONS.has(entry.section)
        && entry.status === 'imported'
        && entry.rows.length > 0,
    );
    if (touchesPrivileged && !input.importerPermissions.has(PRIVILEGED_SECTION_TOKEN)) {
      throw new BadRequestException(
        'Importing roles/permissions requires the rbac_roles:edit permission',
      );
    }

    const startedAt = new Date();

    const summaries: SectionImportSummaryInterface[] = [];

    // Run inside a single transaction so partial failures roll back as
    // a whole. Dry-run uses an explicit rollback at the end.
    try {
      await this.prismaService.$transaction(async (tx) => {
        for (const entry of plan) {
          if (entry.status !== 'imported') {
            // Absent or untrustworthy: nothing was attempted, and the
            // summary says so instead of reporting a row of zeros that
            // reads like a success.
            summaries.push({
              section: entry.section,
              status: entry.status,
              created: 0,
              updated: 0,
              skipped: 0,
              errors: entry.errors,
            });
            continue;
          }
          summaries.push(
            await this.importSection(
              tx,
              entry.section,
              entry.rows,
              input.strategy,
              input.importerPermissions,
            ),
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
      integrity: resolveIntegrity(manifest, plan),
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
    assertManifestShape(payload.manifest);
  }

  private async importSection(
    tx: PrismaTransactionClient,
    section: ConfigExportSection,
    rows: Array<Record<string, unknown>>,
    strategy: ImportStrategy,
    importerPermissions: ReadonlySet<string>,
  ): Promise<SectionImportSummaryInterface> {
    const errors: string[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    if (rows.length === 0) {
      // The file asserts the source had zero rows here, and the manifest
      // (when present) has already agreed. A genuine no-op.
      return { section, status: 'imported', created, updated, skipped, errors };
    }

    try {
      switch (section) {
        case 'roles':
          ({ created, updated, skipped } = await this.upsertById(tx.adminRole, rows, strategy));
          break;
        case 'permissions':
          // Permissions hang off roles via FK. Drop rows whose role is
          // missing in the destination instead of failing the section.
          ({ created, updated, skipped } = await this.upsertPermissions(
            tx,
            rows,
            strategy,
            importerPermissions,
          ));
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

    return {
      section,
      status: errors.length === 0 ? 'imported' : 'failed',
      created,
      updated,
      skipped,
      errors,
    };
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
    importerPermissions: ReadonlySet<string>,
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
      // Reject grants that aren't in the RBAC catalog: `upsertPermissions`
      // writes `adminPermission` rows directly (bypassing the validated
      // role-editor path), so a crafted payload could otherwise persist a
      // bogus/forged (resource, action).
      if (!isValidPermission(resource, action)) {
        skipped += 1;
        continue;
      }
      // Self-escalation guard: never let an admin import a permission it
      // does not itself hold. Combined with the section-level
      // `rbac_roles:edit` gate this closes the "grant myself anything"
      // path — a limited admin can only import grants ⊆ its own set.
      if (!importerPermissions.has(permissionToken(resource, action))) {
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

function permissionToken(resource: string, action: string): string {
  return `${resource}:${action}`;
}

/**
 * One requested section, resolved against the payload before any write.
 * `rows` is only populated for `imported`; the other statuses carry an
 * empty array precisely so a caller cannot accidentally act on them.
 */
interface SectionPlanEntryInterface {
  readonly section: ConfigExportSection;
  readonly status: SectionImportStatus;
  readonly rows: Array<Record<string, unknown>>;
  readonly errors: string[];
  /** Set when this entry is the reason the payload failed its manifest. */
  readonly manifestViolation: boolean;
}

/**
 * The payload arrives as operator-uploaded JSON, so the manifest is only
 * usable once it has been shown to be a map of known sections to
 * non-negative integers. A junk manifest is a bad request, not something
 * to shrug off — shrugging is how the payload lost its sections in the
 * first place.
 */
function assertManifestShape(manifest: unknown): void {
  // `null` reads the same as an omitted key here, matching how a `null`
  // section is treated as absent rather than as a damaged array. Keeping
  // the two in step is what makes `readManifest`'s null branch reachable
  // instead of dead.
  if (manifest === undefined || manifest === null) return;
  if (typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new BadRequestException('Payload.manifest must be an object when present');
  }
  for (const section of ALL_SECTIONS) {
    const declared = (manifest as Record<string, unknown>)[section];
    if (declared === undefined) continue;
    if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 0) {
      throw new BadRequestException(
        `Payload.manifest.${section} must be a non-negative integer`,
      );
    }
  }
}

function readManifest(
  payload: ConfigExportPayloadInterface,
): ConfigExportManifestInterface | undefined {
  const manifest = payload.manifest;
  if (manifest === undefined || manifest === null) return undefined;
  return manifest;
}

/**
 * Decide what a single requested section is, before anything is written.
 *
 * The distinction the old `?? []` collapsed:
 *   - the key is absent  → the file makes no claim about this section;
 *   - the key is `[]`    → the file claims the source had zero rows.
 *
 * Absent is only an error when the operator named the section. Importing
 * "everything" from a file that was deliberately exported as a subset is
 * a normal workflow, and turning nine informational rows into nine red
 * errors would train operators to ignore the column.
 */
function classifySection(
  section: ConfigExportSection,
  sections: ConfigExportPayloadInterface['sections'],
  manifest: ConfigExportManifestInterface | undefined,
  explicitlyRequested: boolean,
): SectionPlanEntryInterface {
  const raw = (sections as Record<string, unknown>)[section];
  const present = raw !== undefined && raw !== null;
  const declared = manifest?.[section];

  if (present && !Array.isArray(raw)) {
    return {
      section,
      status: 'rejected',
      rows: [],
      manifestViolation: false,
      errors: [
        `section "${section}" is present but is not an array (got ${typeof raw}) `
          + '— refused, nothing was imported for it',
      ],
    };
  }

  const actual = present ? (raw as unknown[]).length : undefined;

  // A manifest is the file's account of itself; if it disagrees with the
  // payload the file is damaged and we refuse the section rather than
  // restore a truncated one. Refusing is safe — the import only ever
  // upserts, so declining to touch a section leaves the destination as
  // it was.
  if (manifest !== undefined && declared !== actual) {
    return {
      section,
      status: 'rejected',
      rows: [],
      manifestViolation: true,
      errors: [
        `section "${section}" contradicts the export manifest `
          + `(manifest: ${describeCount(declared)}, payload: ${describeCount(actual)}) `
          + '— the file is damaged, nothing was imported for it',
      ],
    };
  }

  if (!present) {
    return {
      section,
      status: 'missing',
      rows: [],
      manifestViolation: false,
      errors: explicitlyRequested
        ? [
            `section "${section}" was requested but is absent from the payload `
              + '— nothing was imported for it',
          ]
        : [],
    };
  }

  return {
    section,
    status: 'imported',
    rows: raw as Array<Record<string, unknown>>,
    manifestViolation: false,
    errors: [],
  };
}

function describeCount(count: number | undefined): string {
  return count === undefined ? 'section absent' : `${count} row(s)`;
}

function resolveIntegrity(
  manifest: ConfigExportManifestInterface | undefined,
  plan: readonly SectionPlanEntryInterface[],
): PayloadIntegrityStatus {
  if (manifest === undefined) return 'unverifiable';
  return plan.some((entry) => entry.manifestViolation) ? 'violated' : 'verified';
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
