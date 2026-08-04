import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import type { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { ReiwaCacheInvalidatorService } from '../../bot-config/services/reiwa-cache-invalidator.service';
import { DEFAULT_LANDING_CONFIG } from '../landing-config.default';
import { migrateLandingConfig } from '../landing-config.migrations';
import {
  collectPublishStrictIssues,
  landingConfigSchema,
  LANDING_SCHEMA_VERSION,
  type EffectiveLandingPayload,
  type LandingConfigPayload,
} from '../landing-config.schema';

/** How many published revisions to retain (older are pruned on publish). */
const REVISION_RETENTION = 30;

export interface LandingDraftResult {
  readonly config: LandingConfigPayload;
  readonly version: number;
  readonly stored: boolean;
  /**
   * Set when a STORED draft failed schema validation and `config` is therefore
   * the bundled default rather than the operator's work. Without this the
   * builder silently opened a blank landing over a corrupt row, and the first
   * autosave overwrote the original — losing it for good. The admin surfaces a
   * warning and refuses to autosave, publishing is refused server-side, and
   * `raw` carries the original row so it can be inspected or exported before
   * anything is overwritten.
   */
  readonly corrupted?: {
    readonly issues: readonly { readonly path: string; readonly message: string }[];
    readonly raw: unknown;
  };
}

export interface LandingRevisionMeta {
  readonly id: string;
  readonly schemaVersion: number;
  readonly publishedBy: string | null;
  readonly publishedAt: Date;
  readonly isCurrent: boolean;
}

/**
 * LandingConfigService
 * ────────────────────
 * Owns the singleton landing draft (`landing_configs.key = "default"`) and the
 * append-only published history (`landing_revisions`). The public site serves
 * only the PUBLISHED revision; draft edits never affect visitors until publish.
 *
 * Cache invalidation is explicit (not an interceptor): `publish()`/`rollback()`
 * fire `ReiwaCacheInvalidatorService.invalidateLanding()`; draft saves never do.
 */
@Injectable()
export class LandingConfigService {
  private static readonly SINGLETON_KEY = 'default';

  private readonly logger = new Logger(LandingConfigService.name);

  public constructor(
    private readonly prisma: PrismaService,
    private readonly reiwaCacheInvalidator: ReiwaCacheInvalidatorService,
  ) {}

  /** Current draft (bundled default when none) + optimistic-concurrency version. */
  public async getDraft(): Promise<LandingDraftResult> {
    const row = await this.prisma.landingConfig.findUnique({
      where: { key: LandingConfigService.SINGLETON_KEY },
    });
    if (row === null) {
      return { config: DEFAULT_LANDING_CONFIG, version: 0, stored: false };
    }
    const migrated = migrateLandingConfig(row.draft);
    const parsed = landingConfigSchema.safeParse(migrated);
    if (parsed.success) {
      return { config: parsed.data, version: row.version, stored: true };
    }
    // A stored draft that no longer parses is an incident, not a blank slate:
    // report it instead of quietly handing back the default, which the next
    // autosave would then write over the operator's real content.
    this.logger.error(
      `Stored landing draft failed validation (version ${row.version}); ` +
        `serving the bundled default read-only. Issues: ${parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
    );
    return {
      config: DEFAULT_LANDING_CONFIG,
      version: row.version,
      stored: true,
      corrupted: {
        issues: parsed.error.issues.slice(0, 10).map((issue) => ({
          path: issue.path.join('.') || '<root>',
          message: issue.message,
        })),
        raw: row.draft,
      },
    };
  }

  /** The published revision the operator currently has draft-vs-published diff against. */
  public async getPublished(): Promise<LandingConfigPayload | null> {
    const row = await this.prisma.landingConfig.findUnique({
      where: { key: LandingConfigService.SINGLETON_KEY },
    });
    if (row === null || row.publishedRevisionId === null) return null;
    const revision = await this.prisma.landingRevision.findUnique({
      where: { id: row.publishedRevisionId },
    });
    if (revision === null) return null;
    const parsed = landingConfigSchema.safeParse(migrateLandingConfig(revision.config));
    return parsed.success ? parsed.data : null;
  }

  /**
   * Save the draft with optimistic concurrency. Rejects (409) when the caller's
   * `expectedVersion` no longer matches the stored token (a second editor saved
   * in between). Shallow-validates the shape; never invalidates the reiwa cache.
   */
  public async saveDraft(input: unknown, expectedVersion: number): Promise<LandingDraftResult> {
    const parsed = landingConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid landing config',
        issues: parsed.error.issues.slice(0, 10),
      });
    }
    const config = parsed.data;

    return this.prisma.$transaction(
      async (tx: Prisma.TransactionClient): Promise<LandingDraftResult> => {
        const existing = await tx.landingConfig.findUnique({
          where: { key: LandingConfigService.SINGLETON_KEY },
        });
        const currentVersion = existing?.version ?? 0;
        if (currentVersion !== expectedVersion) {
          throw new ConflictException({
            message: 'LANDING_DRAFT_CONFLICT',
            currentVersion,
          });
        }
        const nextVersion = currentVersion + 1;
        await tx.landingConfig.upsert({
          where: { key: LandingConfigService.SINGLETON_KEY },
          create: {
            key: LandingConfigService.SINGLETON_KEY,
            draft: config as unknown as Prisma.InputJsonValue,
            version: nextVersion,
          },
          update: {
            draft: config as unknown as Prisma.InputJsonValue,
            version: nextVersion,
          },
        });
        return { config, version: nextVersion, stored: true };
      },
    );
  }

  /**
   * Publish the current draft: validate publish-strict, append an immutable
   * revision, repoint the singleton, prune old revisions, audit, and fire the
   * explicit reiwa cache invalidation. Returns the new revision id.
   */
  public async publish(
    currentAdmin: CurrentAdminInterface,
    metadata: RequestMetadataInterface,
  ): Promise<{ revisionId: string }> {
    const { config, corrupted } = await this.getDraft();
    // `getDraft` stands the bundled default in for a draft it could not parse
    // so the builder still renders. Publishing that stand-in would push it over
    // the live landing — and since the default ships `enabled: false`, the
    // public site would go dark on the next cache invalidation. The default is
    // fully localized, so `assertPublishable` sees nothing wrong with it and
    // would wave it through. Refuse here instead.
    this.assertDraftIntact(corrupted);
    this.assertPublishable(config);

    const revisionId = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient): Promise<string> => {
        const revision = await tx.landingRevision.create({
          data: {
            schemaVersion: LANDING_SCHEMA_VERSION,
            config: config as unknown as Prisma.InputJsonValue,
            publishedBy: currentAdmin.id,
          },
        });
        await tx.landingConfig.update({
          where: { key: LandingConfigService.SINGLETON_KEY },
          data: { publishedRevisionId: revision.id },
        });
        await this.pruneRevisions(tx, revision.id);
        await tx.adminAuditLog.create({
          data: {
            action: 'landing.published',
            ipAddress: metadata.remoteAddress,
            userAgent: metadata.userAgent,
            metadata: { requestId: metadata.requestId, revisionId: revision.id } as Prisma.InputJsonValue,
            adminUser: { connect: { id: currentAdmin.id } },
          },
        });
        return revision.id;
      },
    );

    void this.reiwaCacheInvalidator.invalidateLanding('publish');
    this.logger.log(`Landing published (revision=${revisionId}).`);
    return { revisionId };
  }

  /**
   * Roll back to a prior revision by re-publishing its snapshot as a NEW
   * current revision (history is append-only). The snapshot is forward-migrated
   * and re-validated (publish-strict) before it can be re-published.
   */
  public async rollback(
    revisionId: string,
    currentAdmin: CurrentAdminInterface,
    metadata: RequestMetadataInterface,
  ): Promise<{ revisionId: string }> {
    const source = await this.prisma.landingRevision.findUnique({ where: { id: revisionId } });
    if (source === null) {
      throw new NotFoundException('LANDING_REVISION_NOT_FOUND');
    }
    const parsed = landingConfigSchema.safeParse(migrateLandingConfig(source.config));
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'LANDING_REVISION_INVALID',
        issues: parsed.error.issues.slice(0, 10),
      });
    }
    const config = parsed.data;
    this.assertPublishable(config);

    const newId = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient): Promise<string> => {
        const revision = await tx.landingRevision.create({
          data: {
            schemaVersion: LANDING_SCHEMA_VERSION,
            config: config as unknown as Prisma.InputJsonValue,
            publishedBy: currentAdmin.id,
          },
        });
        await tx.landingConfig.update({
          where: { key: LandingConfigService.SINGLETON_KEY },
          data: { publishedRevisionId: revision.id },
        });
        await this.pruneRevisions(tx, revision.id);
        await tx.adminAuditLog.create({
          data: {
            action: 'landing.rolledBack',
            ipAddress: metadata.remoteAddress,
            userAgent: metadata.userAgent,
            metadata: {
              requestId: metadata.requestId,
              fromRevisionId: revisionId,
              revisionId: revision.id,
            } as Prisma.InputJsonValue,
            adminUser: { connect: { id: currentAdmin.id } },
          },
        });
        return revision.id;
      },
    );

    void this.reiwaCacheInvalidator.invalidateLanding('rollback');
    this.logger.log(`Landing rolled back to ${revisionId} (new revision=${newId}).`);
    return { revisionId: newId };
  }

  /**
   * Effective PUBLISHED config for reiwa (internal endpoint). Returns the
   * disabled sentinel when nothing is published or the module is off, so the
   * edge routes `/` → `/sign-in` (fail-closed, never an empty page).
   */
  public async getEffectivePublished(): Promise<EffectiveLandingPayload> {
    const published = await this.getPublished();
    if (published === null || published.enabled !== true) {
      return { enabled: false };
    }
    const visible = published.sections.filter((section) => section.visible);
    if (visible.length === 0) {
      return { enabled: false };
    }
    return published;
  }

  /** Revision history metadata (newest first) for the admin drawer. */
  public async listRevisions(): Promise<LandingRevisionMeta[]> {
    const config = await this.prisma.landingConfig.findUnique({
      where: { key: LandingConfigService.SINGLETON_KEY },
    });
    const currentId = config?.publishedRevisionId ?? null;
    const rows = await this.prisma.landingRevision.findMany({
      orderBy: { publishedAt: 'desc' },
      take: REVISION_RETENTION,
    });
    return rows.map((row) => ({
      id: row.id,
      schemaVersion: row.schemaVersion,
      publishedBy: row.publishedBy,
      publishedAt: row.publishedAt,
      isCurrent: row.id === currentId,
    }));
  }

  /** True once an operator has saved a draft (vs. serving the bundled default). */
  public async hasStoredDraft(): Promise<boolean> {
    const count = await this.prisma.landingConfig.count({
      where: { key: LandingConfigService.SINGLETON_KEY },
    });
    return count > 0;
  }

  /** Throws a 400 with the missing-translation paths when publish-strict fails. */
  /**
   * Refuse any operation that would write the stand-in default back over the
   * operator's stored work. The draft itself is never touched by publishing, so
   * the original row stays recoverable — but the live landing would already
   * have been replaced by then.
   */
  private assertDraftIntact(corrupted: LandingDraftResult['corrupted']): void {
    if (corrupted !== undefined) {
      throw new BadRequestException({
        message: 'LANDING_DRAFT_CORRUPTED',
        issues: corrupted.issues,
      });
    }
  }

  private assertPublishable(config: LandingConfigPayload): void {
    const issues = collectPublishStrictIssues(config);
    if (issues.length > 0) {
      throw new BadRequestException({
        message: 'LANDING_PUBLISH_INCOMPLETE',
        issues: issues.slice(0, 20),
      });
    }
  }

  /** Delete revisions older than the newest N, never touching the just-published one. */
  private async pruneRevisions(tx: Prisma.TransactionClient, keepId: string): Promise<void> {
    const keep = await tx.landingRevision.findMany({
      orderBy: { publishedAt: 'desc' },
      take: REVISION_RETENTION,
      select: { id: true },
    });
    const keepIds = new Set(keep.map((row) => row.id));
    keepIds.add(keepId);
    await tx.landingRevision.deleteMany({
      where: { id: { notIn: Array.from(keepIds) } },
    });
  }
}
