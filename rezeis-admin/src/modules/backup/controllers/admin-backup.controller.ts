import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { mkdirSync, promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { diskStorage } from 'multer';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Request, Response } from 'express';
import { BackupScope, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { RbacService } from '../../rbac/services/rbac.service';
import type { ArchiveProvenance } from '../utils/backup-provenance.util';
import { BackupRecordDto, BackupService, type BackupSettingsView } from '../services/backup.service';

class ListBackupsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

class CreateBackupDto {
  @IsEnum(BackupScope)
  scope!: BackupScope;
}

class BackupTelegramSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  chatId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  topicId?: string | null;
}

class UpdateBackupSettingsDto {
  @IsOptional()
  @IsBoolean()
  autoEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  intervalHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  maxKeep?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => BackupTelegramSettingsDto)
  telegram?: BackupTelegramSettingsDto;
}

interface BackupListResponse {
  readonly items: readonly BackupRecordDto[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

const DEFAULT_BACKUP_LOCATION = '/app/data/backups';
const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB
const HARD_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

function resolveUploadMaxBytes(): number {
  const raw = Number.parseInt(process.env.BACKUP_MAX_UPLOAD_BYTES ?? '', 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, HARD_MAX_UPLOAD_BYTES);
  return DEFAULT_MAX_UPLOAD_BYTES;
}

/**
 * Disk-storage interceptor for the upload-and-restore endpoint. The file is
 * streamed straight to the backup directory (never buffered fully in memory),
 * under a safe, generated `.sql.gz` name. The service validates the gzip magic
 * before enqueuing the restore.
 */
const restoreUploadInterceptor = FileInterceptor('file', {
  storage: diskStorage({
    destination: (_req, _file, cb): void => {
      const dir = process.env.BACKUP_LOCATION ?? DEFAULT_BACKUP_LOCATION;
      try {
        mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err as Error, dir);
      }
    },
    filename: (_req, _file, cb): void => {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      cb(null, `uploaded-db-${ts}-${randomBytes(4).toString('hex')}.sql.gz`);
    },
  }),
  limits: { fileSize: resolveUploadMaxBytes() },
});

/**
 * The permission an admin must ALSO hold to restore an archive this deployment
 * cannot prove it produced.
 *
 * Chosen, rather than invented: a foreign archive fed to `psql` runs whatever
 * SQL it contains as the database owner, and the first thing an attacker writes
 * is a row in `admin_users`. So the acknowledgement costs exactly the
 * permission that grants that power directly. `backups:run` on its own still
 * restores anything this panel stamped — the disaster-recovery path is
 * untouched — and a migration to a new server still works, it just has to be
 * performed by somebody who could have created the admin account by hand
 * anyway. Same shape as the config-import gate, which puts `roles`/`permissions`
 * behind `rbac_roles:edit` on top of `config_portability:import`.
 */
const FOREIGN_ARCHIVE_TOKEN = 'admins:edit';

/**
 * Accepts the acknowledgement from JSON (`true`) and from a multipart text
 * field (`'true'`), and from nothing else. `restore-upload` is multipart, so
 * every field arrives as a string; treating any truthy value as consent would
 * make `"false"` an acknowledgement.
 */
function isAcknowledged(raw: unknown): boolean {
  return raw === true || raw === 'true' || raw === '1';
}

/**
 * Delete an upload that landed on disk and will never be adopted.
 *
 * `restoreUploadInterceptor` uses multer DISK storage, so by the time this
 * handler's first line runs the whole archive — up to 2 GiB — is already
 * written into the backup directory. Until `restoreFromUpload` succeeds and
 * writes its `BackupRecord`, nothing in the system points at that file:
 *
 *   * `GET /admin/backup` lists `backupRecord.findMany`, so it is invisible;
 *   * `DELETE /admin/backup/:id` takes a record id, so it cannot be targeted;
 *   * `applyRetention` also iterates `backupRecord.findMany`, and there is no
 *     `readdir` anywhere in `src/modules/backup`, so nothing ever reclaims it.
 *
 * An orphan here is therefore permanent, invisible, and repeatable once per
 * refused attempt. `restoreFromUpload` already understood this and unlinks on
 * every one of its own refusals; the legs that throw BEFORE it never got the
 * same treatment, which is why this exists.
 *
 * These are the same three lines as `BackupService.safeUnlink`, deliberately
 * repeated rather than reached: that method is `private`, and widening a
 * service's public surface so a controller can borrow one `unlink` buys less
 * than it costs. Failures are swallowed for the reason they are swallowed
 * there too — the caller is already throwing, and a cleanup that threw would
 * replace a precise 403 with an opaque 500 and tell the operator nothing.
 */
async function discardUnadoptedUpload(target: string | undefined): Promise<void> {
  if (target === undefined || target.length === 0) return;
  await fsp.unlink(target).catch((): void => undefined);
}

@ApiTags('admin/backup')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/backup')
export class AdminBackupController {
  public constructor(
    private readonly backupService: BackupService,
    private readonly prismaService: PrismaService,
    private readonly rbacService: RbacService,
  ) {}

  @Get()
  @RequirePermission('backups', 'view')
  @ApiOperation({ summary: 'Lists backup records with pagination' })
  @ApiOkResponse({ description: 'Paginated backup list' })
  public list(@Query() query: ListBackupsQueryDto): Promise<BackupListResponse> {
    return this.backupService.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('backups', 'create')
  @ApiOperation({ summary: 'Triggers a new pg_dump backup (returns immediately, dump runs async)' })
  public async create(
    @Body() dto: CreateBackupDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<BackupRecordDto> {
    const record = await this.backupService.createBackup({
      scope: dto.scope,
      initiatedBy: admin.id,
    });
    await this.audit(admin, request, 'backup.created', {
      backupId: record.id,
      filename: record.filename,
      scope: record.scope,
    });
    return record;
  }

  @Get('settings')
  @RequirePermission('backups', 'view')
  @ApiOperation({ summary: 'Returns the operator backup settings (schedule + Telegram delivery)' })
  public getSettings(): Promise<BackupSettingsView> {
    return this.backupService.getSettings();
  }

  /**
   * `backups:create` covers TWO powers, and the operator has decided to keep it
   * that way — recorded here so it is not re-opened as a discovery.
   *
   * The permission reads as "may take a backup". This route also writes the
   * Telegram chat id that finished `.sql.gz` dumps are delivered to
   * (`backup.service.ts`, `formData.append('chat_id', tgConfig.chatId)`), so a
   * holder can point deliveries at a chat of their own and then trigger a dump
   * with the same permission — the whole database, by design of the gate rather
   * than by any bug.
   *
   * Splitting them needs a new action in `RBAC_RESOURCES.backups` (there is no
   * `edit`, and an undeclared pair is rejected when a role is saved), plus the
   * superadmin seed and the frontend gate moved together. Not done, because no
   * default role holds ANY `backups:*` permission and the operator does not
   * intend to grant one: today the only holders are DEV and superadmin, who can
   * read the database directly anyway.
   *
   * What would change that: the first custom role granted `backups:create` so
   * somebody can run backups without full access. At that moment this stops
   * being a naming wart and becomes an exfiltration path, and the split above
   * is the fix.
   */
  @Patch('settings')
  @RequirePermission('backups', 'create')
  @ApiOperation({ summary: 'Updates the operator backup settings' })
  public async updateSettings(
    @Body() dto: UpdateBackupSettingsDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<BackupSettingsView> {
    const view = await this.backupService.updateSettings({
      autoEnabled: dto.autoEnabled,
      intervalHours: dto.intervalHours,
      maxKeep: dto.maxKeep,
      telegram: dto.telegram
        ? { enabled: dto.telegram.enabled, chatId: dto.telegram.chatId, topicId: dto.telegram.topicId }
        : undefined,
    });
    // Audited because of the route comment above: this write chooses the
    // Telegram chat finished dumps are delivered to. Repointing it and then
    // triggering a backup is a documented exfiltration path through the gate's
    // own design, and until now it left no trace at all.
    await this.audit(admin, request, 'backup.settings_updated', {
      autoEnabled: view.autoEnabled,
      intervalHours: view.intervalHours,
      maxKeep: view.maxKeep,
      telegramEnabled: view.telegram.enabled,
      telegramChatId: view.telegram.chatId,
      telegramTopicId: view.telegram.topicId,
    });
    return view;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('backups', 'delete')
  @ApiOperation({ summary: 'Deletes a backup record and the underlying file' })
  public async delete(
    @Param('id') id: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<void> {
    await this.backupService.deleteBackup(id);
    await this.audit(admin, request, 'backup.deleted', { backupId: id });
  }

  @Post('restore/:filename')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('backups', 'run')
  @ApiOperation({ summary: 'Restore database from a backup file (async via BullMQ)' })
  public async restore(
    @Param('filename') filename: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() request: Request,
    @Body('acknowledgeForeignArchive') acknowledgeForeignArchive?: unknown,
  ): Promise<{ jobId: string; message: string; provenance: string }> {
    const allowForeignArchive = await this.resolveForeignArchiveConsent(
      admin,
      acknowledgeForeignArchive,
    );
    const { jobId, provenance } = await this.backupService.restoreBackup(filename, admin.id, {
      allowForeignArchive,
    });
    await this.audit(admin, request, 'backup.restore_started', {
      filename,
      jobId,
      source: 'stored',
      ...describeProvenance(provenance, allowForeignArchive),
    });
    return { jobId, message: 'Restore job enqueued', provenance: provenance.status };
  }

  @Post('restore-upload')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('backups', 'run')
  @UseInterceptors(restoreUploadInterceptor)
  @ApiOperation({
    summary: 'Upload a .sql.gz backup and restore the database from it (async via BullMQ)',
  })
  public async restoreUpload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() request: Request,
    /**
     * KEEP THIS `unknown`, AND ADD NO PIPE TO ANY PARAMETER ABOVE — or move
     * the cleanup out of the method body first.
     *
     * Pipes on this route run with the uploaded archive ALREADY ON DISK and
     * before a single line of the method executes, so anything a pipe throws
     * lands outside the `try` below and strands the file permanently — the
     * exact bug that `try` exists to close, re-entered through a door the
     * handler cannot reach. Nest applies pipes inside the handler that the
     * interceptor chain wraps (`router-execution-context.js:36-46`:
     * guards, then `interceptorsConsumer.intercept(..., handler)`, and
     * `handler` is `fnApplyPipes` then the callback), and the interceptor is
     * multer.
     *
     * The global `ValidationPipe` (`main.ts`: whitelist + transform +
     * forbidNonWhitelisted) therefore already runs here. It is harmless today
     * for one reason only: `unknown` emits a `design:paramtype` of `Object`,
     * which `ValidationPipe.toValidate()` skips. Replace it with a DTO class
     * and the pipe starts validating; the first request that fails validation
     * leaks up to 2 GiB that nothing in the panel can list or delete. A
     * `ParseFilePipe` on `@UploadedFile()` does the same.
     *
     * `backup-upload-orphan-cleanup.spec.ts` pins both facts — the metatype
     * and the absence of parameter pipes — so either change fails a test
     * rather than shipping quietly.
     */
    @Body('acknowledgeForeignArchive') acknowledgeForeignArchive?: unknown,
  ): Promise<{ jobId: string; message: string; provenance: string }> {
    if (!file) {
      // Nothing to discard: multer only reaches the handler with no `file` when
      // no part named `file` arrived at all. A part under any other name aborts
      // the request with `LIMIT_UNEXPECTED_FILE` inside the interceptor, and
      // multer removes what it wrote before the handler is ever called.
      throw new BadRequestException('File is required. Upload a .sql.gz backup.');
    }
    // ── Owner of the file on disk: THIS BLOCK, until the service takes over ──
    //
    // Every statement between the upload landing and `restoreFromUpload`
    // belongs inside this `try`, and anything added here later must go inside
    // it too. Two live legs throw from `resolveForeignArchiveConsent` alone:
    // the `ForbiddenException` for an admin without `admins:edit`, and any
    // failure of the RBAC lookup itself — the second stranding an upload from
    // an operator who *does* hold the permission. A validation pipe or a
    // further pre-check added above the service call would strand identically;
    // pipes run after interceptors, so they see the file already written.
    //
    // The `try` deliberately stops at `restoreFromUpload`. Past that call the
    // service owns the file and cleans up its own refusals, and once its
    // `BackupRecord` exists the file is listed, deletable and inside retention
    // — unlinking it from out here would delete an archive a queued restore
    // job is about to read.
    let allowForeignArchive: boolean;
    try {
      allowForeignArchive = await this.resolveForeignArchiveConsent(
        admin,
        acknowledgeForeignArchive,
      );
    } catch (err) {
      await discardUnadoptedUpload(file.path);
      throw err;
    }
    const { jobId, provenance } = await this.backupService.restoreFromUpload(
      { filename: file.filename, path: file.path, size: file.size },
      admin.id,
      { allowForeignArchive },
    );
    await this.audit(admin, request, 'backup.restore_started', {
      filename: file.filename,
      sizeBytes: file.size,
      jobId,
      source: 'upload',
      ...describeProvenance(provenance, allowForeignArchive),
    });
    return { jobId, message: 'Restore job enqueued', provenance: provenance.status };
  }

  /**
   * `backups:export`, not `backups:view`.
   *
   * There is no encryption anywhere in this module: the file this route streams
   * is `pg_dump | gzip` and nothing else, so it contains every customer, every
   * transaction, every admin password hash, the SMTP password in the clear and
   * every webhook secret. A permission whose name promises "may see the list"
   * was handing over the database — and `backups:view` is the one action on
   * this resource that a read-only role would plausibly be granted.
   *
   * Split the way this repo already splits the same problem elsewhere:
   * `users:view_registration` vs `users:export_registration`,
   * `payment_gateways:view` vs `payment_gateways:view_secrets`,
   * `config_portability:view` vs `config_portability:export`. Listing backups
   * stays on `view`; taking one off the server needs the export action, which
   * no default role holds.
   */
  @Get('download/:filename')
  @RequirePermission('backups', 'export')
  @ApiOperation({ summary: 'Streams a backup file by filename' })
  public async download(
    @Param('filename') filename: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const { stream, mimeType, filename: safeName } =
      await this.backupService.resolveDownloadStream(filename);
    // Audited BEFORE the first byte leaves: an aborted transfer still copied
    // whatever was already on the wire, and "the download started" is the fact
    // an incident responder needs.
    await this.audit(admin, request, 'backup.downloaded', { filename: safeName });
    response.setHeader('Content-Type', mimeType);
    response.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    stream.pipe(response);
  }

  /**
   * Turn a request-supplied acknowledgement into a permission decision.
   *
   * Only consulted when the caller actually asked for it, so the ordinary
   * restore of a stamped archive never pays for a permission lookup — and an
   * admin who cannot hold `admins:edit` gets a 403 naming what is missing
   * rather than a confusing 400 about provenance.
   */
  private async resolveForeignArchiveConsent(
    admin: CurrentAdminInterface,
    raw: unknown,
  ): Promise<boolean> {
    if (!isAcknowledged(raw)) return false;
    const effective = await this.rbacService.getEffectivePermissions({
      id: admin.id,
      role: admin.role,
      rbacRoleId: admin.rbacRoleId,
    });
    const held = new Set(effective.map((p) => `${p.resource}:${p.action}`));
    if (!held.has(FOREIGN_ARCHIVE_TOKEN)) {
      throw new ForbiddenException(
        `Restoring an archive this deployment cannot verify also requires the ${FOREIGN_ARCHIVE_TOKEN} `
          + 'permission: the archive can create or replace admin accounts, roles and the IP allowlist.',
      );
    }
    return true;
  }

  private async audit(
    admin: CurrentAdminInterface,
    request: Request,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const requestMetadata = extractRequestMetadata(request);
    await this.prismaService.adminAuditLog.create({
      data: {
        action,
        ipAddress: requestMetadata.remoteAddress,
        userAgent: requestMetadata.userAgent,
        metadata: { requestId: requestMetadata.requestId, ...metadata } as Prisma.InputJsonObject,
        adminUser: { connect: { id: admin.id } },
      },
    });
  }
}

/** Provenance verdict flattened into audit metadata an operator can read. */
function describeProvenance(
  provenance: ArchiveProvenance,
  allowForeignArchive: boolean,
): Record<string, unknown> {
  return {
    provenance: provenance.status,
    ...(provenance.status === 'foreign' ? { provenanceReason: provenance.reason } : {}),
    acknowledgedForeignArchive: allowForeignArchive,
  };
}
