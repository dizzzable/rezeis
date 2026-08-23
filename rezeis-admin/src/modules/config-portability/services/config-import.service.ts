import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';

import { LegalDocumentKey, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  LEGAL_DOCUMENT_KEYS,
} from '../../legal-documents/services/legal-documents.service';
import { isValidPermission } from '../../rbac/rbac.resources';
import { RESERVED_ROLE_NAMES } from '../../rbac/services/rbac.service';
import {
  ALL_SECTIONS,
  CONFIG_EXPORT_VERSION,
  ConfigExportManifestInterface,
  ConfigExportPayloadInterface,
  ConfigExportSection,
  ConfigPortabilityActor,
} from './config-export.service';

export type ImportStrategy = 'skip' | 'overwrite';

/**
 * The permissions an importer must ALSO hold, per section, on top of the
 * endpoint's own `config_portability:import`.
 *
 * `roles` and `permissions` have been gated on `rbac_roles:edit` since this
 * module was written, and that gate is correct — it is the reason a
 * config-import-only admin cannot mint itself `admins:edit`. What was missing
 * is that five OTHER sections carry security state and had no gate at all, so
 * `config_portability:import` alone was a superset of five separate
 * permissions:
 *
 *   - `settings`         — the whole singleton is patched: AI gate and API key,
 *                          Turnstile, anti-fraud tunables, platform policy, the
 *                          backup Telegram chat id, the encrypted bot token.
 *   - `webhooks`         — a subscription on `eventTypes: ['*']` pointing at an
 *                          attacker URL with an attacker-chosen secret sends
 *                          every system event's metadata off-box.
 *   - `automations`      — `AutomationRule.actions` is arbitrary JSON, and the
 *                          `webhook_post` action POSTs to ANY url with an
 *                          operator-supplied `Authorization` header and no
 *                          allowlist. Exfiltration plus SSRF.
 *   - `adminIpAllowlist` — add your own IP; and because the allowlist opens
 *                          fully when zero active entries remain, an
 *                          `overwrite` against known ids disables it outright.
 *   - `blockedIps`       — deactivate a block.
 *
 * Each is mapped to the permission that already governs the same power through
 * its own screen: `settings:edit`, `webhooks:*`, `automations:*`,
 * `admins:edit` (which is what `AdminIpAllowlistController` uses) and
 * `blocked_ips:*`.
 *
 * ALL tokens listed for a section are required, not any one of them, because
 * the import both creates and updates rows: an admin who may create a webhook
 * but not edit one must not be able to overwrite the existing set through this
 * door. Superadmin and DEV hold the full catalog, so nothing changes for them.
 *
 * Three MORE sections were ungated for the same reason
 * ────────────────────────────────────────────────────
 * Gating those five fixed five holes and left the mechanism that produced them
 * untouched: the map was `Partial<>`, so a section simply absent from it was
 * written with no check beyond `config_portability:import`, and
 * `collectMissingSectionPermissions` said so out loud with
 * `if (required === undefined) continue`. Absence is not a decision — it is the
 * absence of one, and it failed OPEN. Three sections that DO have a gate on
 * their own screen were falling through it:
 *
 *   - `notificationTemplates` — `notifications:edit` on every write in
 *                          `AdminNotificationTemplatesController` (create, seed,
 *                          update, delete). Rewrites the text and the buttons of
 *                          the messages the system sends to every subscriber.
 *   - `faqItems`         — `faq:create` on POST and `faq:edit` on PATCH in
 *                          `AdminFaqController`. Rewrites public help content.
 *   - `legalDocuments`   — `settings:edit` on the one PATCH in
 *                          `AdminLegalDocumentsController`, and the sharpest of
 *                          the three: `user_legal_consents` records that a
 *                          subscriber agreed to THESE documents, so rewriting
 *                          their bodies retroactively changes what every stored
 *                          consent refers to.
 *
 * `faqItems` gets `faq:create` + `faq:edit` and NOT `faq:delete`: `upsertById`
 * only ever creates or updates, and an overwrite that hides an entry with
 * `isActive: false` is precisely what `faq:edit` already permits on the PATCH.
 * (`blockedIps` pairs `create` with `delete` instead of `edit` for the opposite
 * reason — `blocked_ips` has no `edit` action in the RBAC catalog, and
 * neutering a block through an overwrite is what deleting it does.)
 *
 * Why this map is TOTAL
 * ─────────────────────
 * `Record`, not `Partial<Record>`, over the closed `ConfigExportSection` union:
 * a section added to that union without an entry here is now a COMPILE error
 * rather than a silent ungated write, which is exactly how the hole above
 * opened and stayed open. The price is that a section which genuinely needs no
 * gate has to say so; `scopePolicies` is the only one, and it says so.
 *
 * Listed in `ALL_SECTIONS` order so that "is every section here?" is answerable
 * by reading down the column.
 */
const SECTION_REQUIRED_PERMISSIONS: Readonly<
  Record<ConfigExportSection, readonly string[]>
> = {
  roles: ['rbac_roles:edit'],
  permissions: ['rbac_roles:edit'],
  /**
   * Deliberately ungated, and empty rather than absent so that the decision is
   * written down instead of inferred from a missing key.
   *
   * `AdminScopePolicy` is exported and imported here and is referenced NOWHERE
   * ELSE in `src/` — verified, not assumed: no guard, service or controller
   * reads the table (see the `case 'scopePolicies':` branch). Importing it
   * therefore neither grants nor restricts anything; it moves inert rows, and
   * demanding a permission for that would refuse a legitimate whole-config
   * promotion over data that does nothing. If anything ever starts READING
   * `admin_scope_policies`, this is the line that has to change with it.
   */
  scopePolicies: [],
  automations: ['automations:create', 'automations:edit'],
  webhooks: ['webhooks:create', 'webhooks:edit'],
  notificationTemplates: ['notifications:edit'],
  settings: ['settings:edit'],
  blockedIps: ['blocked_ips:create', 'blocked_ips:delete'],
  adminIpAllowlist: ['admins:edit'],
  faqItems: ['faq:create', 'faq:edit'],
  legalDocuments: ['settings:edit'],
};

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
  /**
   * Who is applying this payload. Optional so the service stays callable
   * without an HTTP request behind it; the controller always supplies it from
   * `@CurrentAdmin()`. When present, an audit row naming the sections and the
   * strategy is written.
   */
  readonly actor?: ConfigPortabilityActor;
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

/**
 * What one section's writes did, with no verdict attached.
 *
 * Deliberately separate from `SectionImportSummaryInterface`: these numbers are
 * produced INSIDE a transaction and are only meaningful once that transaction
 * resolves. Keeping them in their own type is what stops a failure path from
 * reporting them — see `runSection`.
 */
interface SectionCounts {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
}

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

    // Privilege-escalation guard: several sections hand out powers the
    // endpoint's own `config_portability:import` says nothing about, so each
    // one additionally demands the permission that governs the same power
    // through its own screen. Without this, an admin whose ONLY power is
    // config import could inject `rbac_roles:edit`/`admins:edit` grants, point
    // every system event at a URL of its own, or switch the admin IP allowlist
    // off — and take over the panel.
    //
    // Reads the classified rows rather than the raw payload: `?? []`
    // followed by `.length > 0` also passed for a non-array `sections.roles`
    // (a string has a length), and a section the manifest check refuses
    // must not arm the gate either.
    const missing = collectMissingSectionPermissions(plan, input.importerPermissions);
    if (missing.length > 0) {
      throw new BadRequestException(
        `Importing these sections requires permissions this admin does not hold: ${missing
          .map((entry) => `${entry.section} needs ${entry.tokens.join(' + ')}`)
          .join('; ')}`,
      );
    }

    // Refused here, beside the escalation gate, and NOT inside the per-section
    // try/catch below — that catch turns a throw into a `status: 'failed'` row,
    // which is the right answer for a malformed record and the wrong one for an
    // attempt to mint authority. The caller must be told plainly.
    assertNoReservedRoleNames(plan);

    const startedAt = new Date();

    const summaries: SectionImportSummaryInterface[] = [];

    // ONE TRANSACTION PER SECTION, not one for the whole import.
    //
    // It used to be a single `$transaction` wrapping this whole loop, and
    // `importSection` caught its own errors — so a row that failed never
    // aborted anything. The loop carried on and the transaction COMMITTED.
    // A webhooks section of ten rows that failed on the third left the first
    // two in the database and reported
    // `status: 'failed', created: 0, updated: 0`: not merely under-reported,
    // but actively claiming nothing was written while two rows were committed.
    // During the staging→production promotion this module exists for, that is
    // the worst available answer — the operator retries or hand-fixes against a
    // destination they have been told is untouched.
    //
    // All-or-nothing across the whole import was the other candidate and it is
    // worse: one malformed FAQ row would discard nine good sections. So the
    // contract is per-section atomicity — a section lands whole or not at all —
    // and the summary says which ones landed.
    //
    // The counts can no longer disagree with the database, and that is
    // structural rather than remembered: they are the RESOLVED VALUE of the
    // section's transaction, so there is no path on which a caller holds counts
    // from a transaction that rolled back.
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
      summaries.push(await this.runSection(entry, input));
    }

    const result: ConfigImportResultInterface = {
      version: CONFIG_EXPORT_VERSION,
      strategy: input.strategy,
      dryRun: input.dryRun,
      integrity: resolveIntegrity(manifest, plan),
      summaries,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };

    await this.recordImport(input.actor, {
      strategy: input.strategy,
      dryRun: input.dryRun,
      integrity: result.integrity,
      // Which sections, and what each one actually did — the two questions an
      // incident responder asks about an import, neither of which survived
      // anywhere before. `dryRun` is recorded too: a dry run that reports what
      // WOULD change is itself reconnaissance worth seeing in the log.
      sections: summaries.map((entry) => ({
        section: entry.section,
        status: entry.status,
        created: entry.created,
        updated: entry.updated,
        skipped: entry.skipped,
      })),
    });

    return result;
  }

  /**
   * Write the audit row for an import. See `ConfigExportService.recordExport`
   * for why `actor` is optional and where it comes from.
   */
  private async recordImport(
    actor: ConfigPortabilityActor | undefined,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (actor === undefined) return;
    await this.prismaService.adminAuditLog.create({
      data: {
        action: 'config_portability.imported',
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: { requestId: actor.requestId, ...metadata } as Prisma.InputJsonObject,
        adminUser: { connect: { id: actor.adminId } },
      },
    });
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

  /**
   * Run one section inside its own transaction and report what it actually did.
   *
   * The three outcomes, and why each reports the counts it does:
   *
   *   - **committed** — the transaction resolved. The counts ARE what landed,
   *     because they are the value that transaction resolved with.
   *   - **rolled back on purpose** (`dryRun`) — `DryRunRollback` carries the
   *     counts out through the abort, so the preview can still say what WOULD
   *     have happened. Nothing persists.
   *   - **rolled back because a row failed** — the counts are unreachable from
   *     here by construction, and the summary reports 0/0/0. That is not a
   *     rounding-down: nothing from this section is in the database, including
   *     the rows written before the failing one.
   *
   * `dryRun` uses the same per-section transactions rather than one enclosing
   * one, so a preview and a real run take the same path. The known cost, stated
   * rather than hidden: `upsertPermissions` looks its role up through `tx`, so
   * in a DRY RUN a permission whose role is being created by the `roles` section
   * of the same file reports as skipped — the role's transaction has already
   * rolled back. A real import is correct there, because `roles` commits before
   * `permissions` runs. The preview errs toward "will do less", which is the
   * safe direction for a migration; the fix would be per-section SAVEPOINTs
   * inside one transaction, which is a different and riskier piece of work.
   */
  private async runSection(
    entry: SectionPlanEntryInterface,
    input: ConfigImportInput,
  ): Promise<SectionImportSummaryInterface> {
    const { section, rows } = entry;
    try {
      const counts = await this.prismaService.$transaction(async (tx) => {
        const applied = await this.importSection(
          tx,
          section,
          rows,
          input.strategy,
          input.importerPermissions,
        );
        if (input.dryRun) {
          // Abort the section's transaction, carrying the counts out with the
          // sentinel so the preview keeps its answer.
          throw new DryRunRollback(applied);
        }
        return applied;
      });
      return { section, status: 'imported', ...counts, errors: [] };
    } catch (err) {
      if (err instanceof DryRunRollback) {
        return { section, status: 'imported', ...err.counts, errors: [] };
      }
      return {
        section,
        status: 'failed',
        created: 0,
        updated: 0,
        skipped: 0,
        errors: [
          this.describeSectionFailure(section, rows, err, input.actor?.requestId ?? null),
        ],
      };
    }
  }

  private async importSection(
    tx: PrismaTransactionClient,
    section: ConfigExportSection,
    rows: Array<Record<string, unknown>>,
    strategy: ImportStrategy,
    importerPermissions: ReadonlySet<string>,
  ): Promise<SectionCounts> {
    let created = 0;
    let updated = 0;
    let skipped = 0;

    if (rows.length === 0) {
      // The file asserts the source had zero rows here, and the manifest
      // (when present) has already agreed. A genuine no-op.
      return { created, updated, skipped };
    }

    // No try/catch here any more, and that is the whole point. It used to
    // swallow the throw, which left the enclosing transaction ALIVE and
    // committing — see `runSection`. A write that fails must now abort its
    // section's transaction, so these counts can only ever be observed by a
    // caller whose transaction actually committed.
    switch (section) {
      case 'roles':
        ({ created, updated, skipped } = await this.upsertById(
          tx.adminRole,
          rows.map((row) => sanitiseImportedRole(row)),
          strategy,
        ));
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
        // NOTE: `adminScopePolicy` is exported and imported here and is
        // referenced NOWHERE ELSE in `src/` — no guard, no service, no
        // controller reads it. Importing it therefore neither grants nor
        // restricts anything; it moves inert rows. Left alone deliberately:
        // dropping the section would break round-tripping for deployments
        // whose files already contain it, and removing the table is a
        // migration. Reported rather than acted on.
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
      case 'legalDocuments':
        ({ created, updated, skipped } = await this.upsertLegalDocuments(tx, rows, strategy));
        break;
      default: {
        const exhaustive: never = section;
        throw new Error(`Unknown config section: ${String(exhaustive)}`);
      }
    }

    return { created, updated, skipped };
  }

  /**
   * Turn a thrown write into something the operator can act on, WITHOUT
   * handing them the driver's own text.
   *
   * What this replaces was `errors.push((err as Error).message)`, and the
   * message went into `summaries[].errors` — which is returned in the body of a
   * **200**. That matters more than it looks: `AdminSafeExceptionFilter` is an
   * `ExceptionFilter`, so it only ever sees a THROWN exception. An error that
   * is caught and embedded in a successful response walks straight past it, and
   * the protection this codebase already built simply never runs.
   *
   * `ConfigExportService` had already ruled on exactly this class of string —
   * it keeps the Prisma message log-only because it "routinely carries a
   * connection string" (see the `failed.length > 0` branch there). The import
   * side was doing the opposite to the same operator, from the same module. The
   * export side is right; this brings the import side into line rather than the
   * other way round.
   *
   * Not webhook-specific: this is the ONE catch every section funnels through,
   * so all eleven stop leaking, and a twelfth added later is covered without
   * anybody remembering to.
   */
  private describeSectionFailure(
    section: ConfigExportSection,
    rows: ReadonlyArray<Record<string, unknown>>,
    err: unknown,
    requestId: string | null,
  ): string {
    const raw = err instanceof Error ? err.message : String(err);
    const correlation = requestId === null ? '' : ` (request ${requestId})`;
    // The raw text lives HERE and nowhere else on this path.
    this.logger.error(
      `Config import failed for section "${section}"${correlation}: ${raw}`,
      err instanceof Error ? err.stack : undefined,
    );
    // Every failure message ends with the same fact, because it is the fact the
    // operator needs before deciding whether to retry: the section was rolled
    // back, so the destination is exactly as it was. Saying it here rather than
    // in each branch keeps a future diagnosis from quietly omitting it.
    const rolledBack =
      ` The whole section was rolled back — none of its ${rows.length} row(s) `
      + 'were applied, including any written before the failure.';
    return (
      (diagnoseSectionFailure(section, rows)
        ?? `section "${section}" could not be written — the database rejected it. `
          + `The details are in the server log${correlation}.`)
      + rolledBack
    );
  }

  /**
   * Generic upsert by `id` for sections whose rows have a `String id`
   * primary key. Skips rows without an id and rows whose timestamps
   * cannot be coerced.
   */
  /**
   * See `sanitiseImportedRole`. Kept as a method-adjacent note because this is
   * the one section whose rows describe AUTHORITY rather than configuration.
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
        await delegate.update({ where: { id }, data: mergeAgainstExistingRow(data, existing) });
        updated += 1;
      } else {
        await delegate.create({ data });
        created += 1;
      }
    }
    return { created, updated, skipped };
  }

  /**
   * Legal documents are keyed by `key`, not by `id`, so the generic
   * `upsertById` would skip every row — it requires a string `id` and there is
   * none. Keyed on the enum by design: there are exactly two documents and
   * neither is created or deleted, only edited.
   *
   * An unknown key is skipped rather than created. A payload from a newer
   * source may name a third document this instance has no enum value for, and
   * inventing the row would fail on the foreign key from `user_legal_consents`
   * anyway.
   */
  private async upsertLegalDocuments(
    tx: PrismaTransactionClient,
    rows: Array<Record<string, unknown>>,
    strategy: ImportStrategy,
  ): Promise<{ created: number; updated: number; skipped: number }> {
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const key = row['key'];
      if (typeof key !== 'string' || !LEGAL_DOCUMENT_KEYS.includes(key as LegalDocumentKey)) {
        skipped += 1;
        continue;
      }
      const documentKey = key as LegalDocumentKey;
      const existing = await tx.legalDocument.findUnique({ where: { key: documentKey } });
      const data = stripRelationFields(coerceTimestamps(row));
      if (existing) {
        if (strategy === 'skip') {
          skipped += 1;
          continue;
        }
        await tx.legalDocument.update({
          where: { key: documentKey },
          data: mergeAgainstExistingRow(data, existing),
        });
        updated += 1;
      } else {
        await tx.legalDocument.create({ data: data as never });
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
   *
   * "Patch" is load-bearing and used to be true only one level deep. Fifteen
   * of this table's twenty-five columns are `Json`, and every secret the export
   * redacts lives INSIDE one of them, so the patch has to reach that far — see
   * `mergeAgainstExistingRow`.
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
      await tx.settings.update({
        where: { id: existing.id },
        data: mergeAgainstExistingRow(data, existing),
      });
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
 * The one section failure this module can explain precisely, and the reason the
 * generic message above is not the whole answer.
 *
 * `webhooks.secret` is a required `String` column that the export DELIBERATELY
 * withholds unless the operator asks for it. So the ordinary, correct workflow
 * — export, promote to a fresh environment, import — hits a wall the moment a
 * subscription does not already exist there: `upsertById` takes the `create`
 * branch and Prisma refuses a row with no `secret`. That is not operator error
 * and it is not a bug; it is the redaction working. What was broken is that the
 * operator was told about it in the form of a multi-line
 * `PrismaClientValidationError` naming an argument, which does not mention the
 * export flag that would have prevented it.
 *
 * Read off the PAYLOAD, never off the driver's text: a webhooks row without a
 * usable `secret` cannot be created, full stop, so this is a fact about the
 * file rather than a guess at what the exception meant. If the section also
 * failed for some other reason, the missing secret is still a blocking problem
 * the operator has to fix, and the raw cause is in the log either way.
 */
function diagnoseSectionFailure(
  section: ConfigExportSection,
  rows: ReadonlyArray<Record<string, unknown>>,
): string | null {
  if (section !== 'webhooks') return null;
  const unusable = rows.filter((row) => {
    const secret = row['secret'];
    return typeof secret !== 'string' || secret.length === 0;
  });
  if (unusable.length === 0) return null;
  // Capped and truncated: these are operator-authored strings being reflected
  // into a response, and an unbounded list of them is a payload, not a message.
  const named = unusable
    .slice(0, 5)
    .map((row) => {
      const label = row['name'] ?? row['id'] ?? '(unnamed)';
      return `"${String(label).slice(0, 64)}"`;
    })
    .join(', ');
  const more = unusable.length > 5 ? ` and ${unusable.length - 5} more` : '';
  return (
    `section "webhooks" could not be written: ${unusable.length} subscription(s) `
    + `carry no signing secret (${named}${more}). The export omits `
    + '`webhooks.secret` unless it is asked for, and the column is required, so a '
    + 'subscription that does not already exist in this environment cannot be '
    + 'created from a redacted file. Either re-export with "include webhook '
    + 'signing secrets" (which needs webhooks:edit), or create the subscription '
    + 'here first and re-import to update it.'
  );
}

/** A section the importer asked for and is not allowed to write. */
export interface MissingSectionPermissionInterface {
  readonly section: ConfigExportSection;
  readonly tokens: readonly string[];
}

/**
 * Which requested sections the importer may not write.
 *
 * Only sections that will actually be WRITTEN arm a gate: a section that is
 * absent from the file, refused by the manifest check, or genuinely empty
 * changes nothing, and refusing the whole import over it would make a
 * deliberate subset export unusable by anyone but a superadmin.
 *
 * Exported so the guarding test can hold the map itself, not merely one path
 * through it.
 */
export function collectMissingSectionPermissions(
  plan: readonly SectionPlanEntryInterface[],
  importerPermissions: ReadonlySet<string>,
): readonly MissingSectionPermissionInterface[] {
  const missing: MissingSectionPermissionInterface[] = [];
  for (const entry of plan) {
    if (entry.status !== 'imported' || entry.rows.length === 0) continue;
    // No `if (required === undefined) continue` here any more, and its absence
    // is the point: that line WAS the fail-open default, and deleting it is
    // what makes the total map above load-bearing. An empty array is now the
    // only way to say "no extra gate", and it has to be typed out. Widen the
    // map back to `Partial<>` and this line stops compiling under
    // `strictNullChecks` instead of quietly skipping the gate again.
    const required = SECTION_REQUIRED_PERMISSIONS[entry.section];
    const absent = required.filter((token) => !importerPermissions.has(token));
    if (absent.length > 0) {
      missing.push({ section: entry.section, tokens: absent });
    }
  }
  return missing;
}

/**
 * One requested section, resolved against the payload before any write.
 * `rows` is only populated for `imported`; the other statuses carry an
 * empty array precisely so a caller cannot accidentally act on them.
 */
export interface SectionPlanEntryInterface {
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

/**
 * Aborts a section's transaction on purpose, carrying its counts out with it.
 *
 * The counts have to ride on the sentinel because the only way out of an
 * interactive transaction without committing is to throw, and a preview that
 * lost its numbers on the way out would report every section as a no-op.
 */
class DryRunRollback extends Error {
  public constructor(public readonly counts: SectionCounts) {
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

/**
 * Strips the two fields on an imported role that decide AUTHORITY rather than
 * configuration, and refuses the names the boot seed owns.
 *
 * `roles` is the one section whose rows are not settings — they are the grant
 * matrix itself. Everything in `RbacService` that protects it (`createRole`
 * forcing `isSystem: false`, `updateRole` refusing to touch `name`/`isSystem`,
 * `assertGrantsWithinActor`, `RESERVED_ROLE_NAMES`) sits on the SERVICE path,
 * and this file writes `adminRole` through Prisma directly. Without this an
 * importer holding `config_portability:import` + `rbac_roles:edit` could send
 * `{ name: 'superadmin', isSystem: true }` and land on the `grantedAll`
 * short-circuit in `RbacService.resolvePermissions` — full superuser, past
 * every guard, in one request. That was proved reachable, not theorised.
 *
 * `isSystem` is dropped rather than forced to `false`: the seed owns that flag
 * and re-asserts it on boot for the rows it knows, so an import has no reason
 * to state it in either direction.
 */
function sanitiseImportedRole(row: Record<string, unknown>): Record<string, unknown> {
  const { isSystem: _isSystem, ...rest } = row;
  return rest;
}

/**
 * Refuses the whole import when any role row claims a name the boot seed owns.
 *
 * Separate from `sanitiseImportedRole` and raised BEFORE the transaction,
 * because the per-section `catch` downgrades a throw to `status: 'failed'` —
 * correct for a malformed record, wrong for an escalation attempt, which the
 * operator has to see as a refusal rather than as a partial success.
 */
function assertNoReservedRoleNames(
  plan: ReadonlyArray<{ readonly section: string; readonly rows: readonly unknown[] }>,
): void {
  const roles = plan.find((entry) => entry.section === 'roles');
  if (!roles) return;
  for (const row of roles.rows) {
    if (typeof row !== 'object' || row === null) continue;
    const name = (row as Record<string, unknown>)['name'];
    if (typeof name === 'string' && RESERVED_ROLE_NAMES.has(name)) {
      throw new BadRequestException(
        `Role name "${name}" is reserved for a system role and cannot be imported`,
      );
    }
  }
}

/**
 * Make the "patch, never replace" promise true INSIDE a `Json` column.
 *
 * The bug this closes
 * ───────────────────
 * `config-export-redaction.ts` OMITS a secret rather than substituting a
 * placeholder, and both that file and `ConfigExportService` state the reason:
 * "importing a redacted export leaves the destination's own secrets intact."
 * That was true for a secret held in its own COLUMN — Prisma's `update` writes
 * only the keys present in `data`, so an absent column is untouched (this is
 * why `webhooks.secret`, a top-level `String`, survives a redacted re-import).
 *
 * It was false for every secret held INSIDE a `Json` column, because Prisma
 * replaces a `Json` value WHOLESALE — it does not deep-merge. `Settings` has
 * no secret-bearing column of its own; all six of the named secrets are nested:
 *
 *   systemNotifications.email.password        (SMTP, stored in the clear)
 *   systemNotifications.botTokenEnc           (admin Telegram bot token)
 *   systemNotifications.webPush.privateKeyEnc (VAPID private key)
 *   supportSettings.turnstileSecretEnc        (Cloudflare Turnstile)
 *   questPartnerSettings.partners[].secretEnc (quest partner HMAC)
 *   aiSupportSettings.apiKeyEnc               (AI provider key)
 *
 * So exporting production and re-importing it wrote each of those columns back
 * with the secret KEY ABSENT — not redacted, gone — and reported
 * `status: 'imported'`. Mail, push and the bot stop working; nothing errors.
 *
 * The rule
 * ────────
 * A key PRESENT in the payload wins. A key ABSENT from the payload keeps the
 * destination's current value. Applied recursively, so it reaches
 * `email.password` at depth two as readily as `botTokenEnc` at depth one.
 *
 * `null` is PRESENT, and therefore wins — writing `null` is how an operator
 * clears a value, and it is the only way to express a deletion at all once
 * absence has been given the opposite meaning. This costs nothing against
 * redaction, which never leaves a `null` behind at an object key: `scrub()`
 * drops the key outright.
 *
 * Which columns merge is decided by SHAPE, not by name: a pair merges only
 * when the stored value and the incoming value are BOTH plain objects, or both
 * arrays. Nothing else in a Prisma row reads back as a plain object — `Date`,
 * `Decimal` and `Bytes` all carry their own prototype, and `BigInt`, `String`
 * and the enums are not objects at all. That matters concretely here:
 * `AdminScopePolicy.actions` is a `String` despite its name, and a merge
 * applied to it would be a fresh bug. Deciding by shape also means a `Json`
 * column added to `schema.prisma` tomorrow is covered without an edit here —
 * the opposite of the allowlist's deliberately manual direction, and correct
 * in this direction because the failure mode is silent data LOSS.
 */
function mergeAgainstExistingRow(
  incoming: Record<string, unknown>,
  existing: unknown,
): Record<string, unknown> {
  if (!isPlainJsonObject(existing)) return incoming;
  const out: Record<string, unknown> = {};
  // Iterates the INCOMING keys only. A column the payload does not carry must
  // stay out of `data` entirely, so that Prisma's own partial-update semantics
  // keep applying to it; this merge changes what happens inside a column, never
  // which columns are written.
  for (const [column, value] of Object.entries(incoming)) {
    out[column] = mergeJsonValue(existing[column], value);
  }
  return out;
}

/** One level of the rule above. Returns `patch` whenever the pair cannot merge. */
function mergeJsonValue(base: unknown, patch: unknown): unknown {
  if (isPlainJsonObject(base) && isPlainJsonObject(patch)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      out[key] = key in base ? mergeJsonValue(base[key], value) : value;
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(patch)) {
    return mergeJsonArray(base, patch);
  }
  return patch;
}

/**
 * Keys tried, in order, as an array element's identity. See `mergeJsonArray`.
 *
 * `slug` is not speculative: `quest-partner-settings.util.ts` keys its own
 * merge on exactly that field (`new Map(current.partners.map((p) => [p.slug, p]))`),
 * so this agrees with how the panel already treats that array.
 */
const ARRAY_IDENTITY_KEYS: readonly string[] = ['id', 'slug', 'key', 'name'];

/**
 * An array in the payload REPLACES the stored array — length, order and
 * membership all come from the payload, so removing an element or reordering
 * one is honoured. Merging arrays positionally would be wrong: inserting a
 * single element at the front re-pairs every later index with the wrong
 * neighbour, and quietly rewrites data the operator never touched.
 *
 * The one exception is an array whose elements CARRY THEIR OWN IDENTITY, and it
 * exists because a named secret lives in one: `questPartnerSettings.partners`
 * is `[{ slug, secretEnc, label? }]`, and a wholesale replace destroys every
 * partner's HMAC secret exactly as the wholesale column replace did. When every
 * element on both sides is a plain object carrying the same identity key, and
 * that key's value is unique within each array, elements are paired by identity
 * and merged by the rule above. Uniqueness is required precisely so that an
 * ambiguous pairing falls back to replacement rather than guessing.
 *
 * Note what this still does NOT recover, stated rather than hidden: an array of
 * bare ciphertext STRINGS. `scrub()` turns an omitted array element into `null`
 * to avoid re-indexing the array, and a `null` element has no identity to pair
 * on, so those `null`s are written. No such shape exists in the settings
 * allowlist today; a new one must nest its secret in an identified object.
 *
 * Reached, today, only for a nested array (`questPartnerSettings.partners`) or a
 * `String[]` column (`webhooks.eventTypes`, `faqItems.mediaUrls`, which have no
 * object elements and so replace wholesale). A TOP-LEVEL `Json` array column —
 * `settings.customIcons`, `automations.actions`, `notificationTemplates.buttons`
 * — never gets this far, because `stripRelationFields` drops it first. See the
 * note there before changing that.
 */
function mergeJsonArray(base: readonly unknown[], patch: readonly unknown[]): unknown[] {
  const identity = chooseArrayIdentityKey(base, patch);
  if (identity === null) return [...patch];
  const byIdentity = new Map<unknown, Record<string, unknown>>();
  for (const item of base) {
    byIdentity.set((item as Record<string, unknown>)[identity], item as Record<string, unknown>);
  }
  return patch.map((item) => {
    const counterpart = byIdentity.get((item as Record<string, unknown>)[identity]);
    return counterpart === undefined ? item : mergeJsonValue(counterpart, item);
  });
}

function chooseArrayIdentityKey(
  base: readonly unknown[],
  patch: readonly unknown[],
): string | null {
  if (base.length === 0 || patch.length === 0) return null;
  if (!base.every(isPlainJsonObject) || !patch.every(isPlainJsonObject)) return null;
  for (const key of ARRAY_IDENTITY_KEYS) {
    if (
      hasUniqueIdentity(base as ReadonlyArray<Record<string, unknown>>, key) &&
      hasUniqueIdentity(patch as ReadonlyArray<Record<string, unknown>>, key)
    ) {
      return key;
    }
  }
  return null;
}

/** Whether every element carries `key` as a scalar, and no two share a value. */
function hasUniqueIdentity(
  items: ReadonlyArray<Record<string, unknown>>,
  key: string,
): boolean {
  const seen = new Set<unknown>();
  for (const item of items) {
    const value = item[key];
    if (typeof value !== 'string' && typeof value !== 'number') return false;
    if (seen.has(value)) return false;
    seen.add(value);
  }
  return true;
}

/**
 * A plain object and nothing else.
 *
 * Checked on the PROTOTYPE rather than with `typeof value === 'object'`, so
 * `Date`, `Prisma.Decimal`, `Buffer`/`Uint8Array` and every other class
 * instance a Prisma row can hold are excluded. Values that arrive from JSONB or
 * from `JSON.parse` carry `Object.prototype`; `Object.create(null)` is accepted
 * for completeness.
 */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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
      //
      // Consequence worth knowing before you widen this: a TOP-LEVEL `Json`
      // array column is dropped here, so `settings.customIcons`,
      // `automations.actions` and `notificationTemplates.buttons` are never
      // written by an import at all. That is its own defect (those columns
      // silently do not promote between environments) — but it is ALSO what
      // currently keeps `automations.actions[].params.authorizationHeader`
      // alive, since the export redacts that header and `actions` elements are
      // `{ type, params }` with no identity key for `mergeJsonArray` to pair
      // on. Start writing this column without giving its elements a stable id
      // and every automation's Authorization header is destroyed on the first
      // re-import, exactly the way the settings secrets were.
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
