import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  promises as fsp,
  type ReadStream,
} from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BackupScope } from '@prisma/client';
import { Queue } from 'bullmq';

import { databaseConfig } from '../../../common/config/database.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import { BACKUP_QUEUE, BACKUP_JOBS } from '../backup.constants';
import { SettingsService } from '../../settings/services/settings.service';
import {
  BotNotifierClient,
  type NotifyDeliveryResult,
} from '../../notifications/services/bot-notifier.client';
import { isRetryableRelayOutcome } from '../backup-delivery-retry.util';
import { signBackupDownloadToken } from '../utils/backup-download-token.util';
import {
  type ArchiveProvenance,
  buildProvenanceTrailer,
  describeForeignReason,
  readArchiveProvenance,
} from '../utils/backup-provenance.util';
import type { BackupCreateJobData, BackupDeliverTelegramJobData, BackupRestoreJobData } from '../backup.processor';

const DEFAULT_BACKUP_LOCATION = '/app/data/backups';
const RETENTION_FALLBACK = 7;
const INTERVAL_HOURS_FALLBACK = 24;

/**
 * Mode every backup file is left at.
 *
 * A dump is the whole database in one file — customers, transactions, admin
 * password hashes, the SMTP password. `createWriteStream` used the default
 * 0666 & ~umask, i.e. 0644: world-readable to anything else sharing the
 * `rezeis-data` volume. The API and the worker run as the SAME uid (1001,
 * `rezeis` — `docker-entrypoint.sh` drops to it with `su-exec` for both
 * services), so 0600 costs the worker nothing: it is the owner.
 */
const BACKUP_FILE_MODE = 0o600;

/** Cloud Bot API upload cap; raised via BACKUP_MAX_DELIVERY_BYTES for a Local Bot API Server. */
const DEFAULT_MAX_DELIVERY_BYTES = 50 * 1024 * 1024;
const HARD_MAX_DELIVERY_BYTES = 2 * 1024 * 1024 * 1024;

function resolveMaxDeliveryBytes(): number {
  const raw = Number.parseInt(process.env.BACKUP_MAX_DELIVERY_BYTES ?? '', 10);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(raw, HARD_MAX_DELIVERY_BYTES);
  }
  return DEFAULT_MAX_DELIVERY_BYTES;
}

// ── DTOs ────────────────────────────────────────────────────────────────────

interface BackupListInput {
  readonly limit?: number;
  readonly offset?: number;
}

interface BackupListResult {
  readonly items: readonly BackupRecordDto[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface BackupRecordDto {
  readonly id: string;
  readonly filename: string;
  readonly scope: BackupScope;
  readonly sizeBytes: string;
  readonly checksum: string | null;
  readonly deliveryChannel: string | null;
  readonly deliveryRecipient: string | null;
  readonly deliveredAt: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
}

interface CreateBackupInput {
  readonly scope: BackupScope;
  readonly initiatedBy: string | null;
}

/** Caller's decision about an archive this deployment cannot prove it produced. */
export interface RestoreOptions {
  /**
   * The operator has said, explicitly, that they know this archive is not
   * verifiably ours and want it restored anyway (server migration, or a dump
   * predating provenance stamping). Never defaulted to `true` anywhere, and
   * never read from anything but a request the controller has already checked
   * `admins:edit` on.
   */
  readonly allowForeignArchive?: boolean;
}

export interface RestoreEnqueueResult {
  readonly jobId: string;
  /** What the admission check concluded, for the audit row and the response. */
  readonly provenance: ArchiveProvenance;
}

/** Operator-managed backup settings (persisted in `Settings.systemNotifications.backup`). */
export interface BackupSettingsView {
  readonly autoEnabled: boolean;
  readonly intervalHours: number;
  readonly maxKeep: number;
  readonly telegram: {
    readonly enabled: boolean;
    readonly chatId: string | null;
    readonly topicId: number | null;
  };
  /** Whether an admin bot token is configured (encrypted) or available via env.
   *  Telegram delivery of the backup FILE only works when this is true. */
  readonly botTokenConfigured: boolean;
}

/** What one `backup.deliver-telegram` attempt achieved, and whether to try again. */
export interface BackupDeliveryOutcome {
  /**
   * True only on proof of delivery — a Telegram message id via the relay, or a
   * 2xx from the Bot API on the direct path. Same standard as before.
   */
  readonly delivered: boolean;
  /**
   * Whether another BullMQ attempt could plausibly change `delivered`. The
   * processor throws on `true` (the only thing that makes BullMQ retry) and
   * returns on `false`.
   */
  readonly retryable: boolean;
  /** Names the outcome for the log line and the retry error; `null` on success. */
  readonly reason: string | null;
}

/** A failure no further attempt can help with. */
function terminalDelivery(reason: string): BackupDeliveryOutcome {
  return { delivered: false, retryable: false, reason };
}

export interface UpdateBackupSettingsInput {
  readonly autoEnabled?: boolean;
  readonly intervalHours?: number;
  readonly maxKeep?: number;
  readonly telegram?: {
    readonly enabled?: boolean;
    readonly chatId?: string | null;
    readonly topicId?: number | string | null;
  };
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * Backup service — pg_dump/restore via BullMQ with Telegram delivery.
 *
 * Lifecycle:
 *   1. `createBackup()` → creates DB record + enqueues BullMQ job
 *   2. Processor calls `runDump()` → pg_dump → gzip → checksum → retention
 *   3. If Telegram delivery configured → `deliverToTelegram()` sends file
 *   4. `restoreBackup()` → enqueues restore job → `runRestore()` → pg_restore
 *
 * All heavy operations run in BullMQ jobs (survive container restarts).
 */
@Injectable()
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger(BackupService.name);

  public constructor(
    @Inject(databaseConfig.KEY)
    private readonly databaseConfiguration: ConfigType<typeof databaseConfig>,
    private readonly prismaService: PrismaService,
    private readonly systemEventsService: SystemEventsService,
    private readonly settingsService: SettingsService,
    @InjectQueue(BACKUP_QUEUE)
    private readonly backupQueue: Queue,
    @Optional()
    private readonly botNotifier?: BotNotifierClient,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────

  public async onModuleInit(): Promise<void> {
    try {
      await fsp.mkdir(this.getBackupLocation(), { recursive: true });
    } catch (err) {
      this.logger.warn(`Could not ensure backup directory: ${(err as Error).message}`);
    }
  }

  // ── Public read API ────────────────────────────────────────────────────

  public async list(input: BackupListInput = {}): Promise<BackupListResult> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    const [rows, total] = await Promise.all([
      this.prismaService.backupRecord.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prismaService.backupRecord.count(),
    ]);
    return { items: rows.map(toDto), total, limit, offset };
  }

  public async getStats(): Promise<{
    readonly total: number;
    readonly lastBackup: BackupRecordDto | null;
  }> {
    const [total, lastBackup] = await Promise.all([
      this.prismaService.backupRecord.count(),
      this.prismaService.backupRecord.findFirst({ orderBy: { createdAt: 'desc' } }),
    ]);
    return { total, lastBackup: lastBackup ? toDto(lastBackup) : null };
  }

  // ── Settings (persisted in Settings.systemNotifications.backup) ──────────

  /** Read the operator backup settings, merged with env/defaults. */
  public async getSettings(): Promise<BackupSettingsView> {
    const cfg = await this.readBackupConfig();
    const token = await this.resolveBotToken();
    return {
      autoEnabled: cfg.autoEnabled,
      intervalHours: cfg.intervalHours,
      maxKeep: cfg.maxKeep,
      telegram: { enabled: cfg.telegram.enabled, chatId: cfg.telegram.chatId, topicId: cfg.telegram.topicId },
      botTokenConfigured: token !== null,
    };
  }

  /** Persist a partial backup-settings patch into `systemNotifications.backup`. */
  public async updateSettings(patch: UpdateBackupSettingsInput): Promise<BackupSettingsView> {
    const settings = await this.prismaService.settings.findFirst({
      orderBy: { updatedAt: 'asc' },
      select: { id: true, systemNotifications: true },
    });
    if (settings === null) {
      throw new BadRequestException('Settings row not initialised');
    }
    const sys =
      typeof settings.systemNotifications === 'object' && settings.systemNotifications !== null
        ? (settings.systemNotifications as Record<string, unknown>)
        : {};
    const current = this.normalizeBackupConfig(sys.backup);

    const nextTelegram = {
      enabled: patch.telegram?.enabled ?? current.telegram.enabled,
      chatId:
        patch.telegram?.chatId !== undefined
          ? normalizeNullableString(patch.telegram.chatId)
          : current.telegram.chatId,
      topicId:
        patch.telegram?.topicId !== undefined
          ? normalizeNullableTopicId(patch.telegram.topicId)
          : current.telegram.topicId,
    };
    const next = {
      autoEnabled: patch.autoEnabled ?? current.autoEnabled,
      intervalHours: clampInt(patch.intervalHours ?? current.intervalHours, 1, 168),
      maxKeep: clampInt(patch.maxKeep ?? current.maxKeep, 1, 100),
      telegram: nextTelegram,
    };

    await this.prismaService.settings.update({
      where: { id: settings.id },
      data: { systemNotifications: { ...sys, backup: next } as never },
    });
    return this.getSettings();
  }

  public async resolveDownloadStream(filename: string): Promise<{
    readonly stream: ReadStream;
    readonly mimeType: string;
    readonly filename: string;
  }> {
    if (!isSafeFilename(filename)) {
      throw new BadRequestException('Invalid backup filename');
    }
    const fullPath = path.resolve(this.getBackupLocation(), filename);
    if (!fullPath.startsWith(path.resolve(this.getBackupLocation()) + path.sep)) {
      throw new BadRequestException('Refusing to read outside backup directory');
    }
    try {
      await fsp.access(fullPath);
    } catch {
      throw new NotFoundException('Backup file not found');
    }
    return {
      stream: createReadStream(fullPath),
      mimeType: filename.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream',
      filename,
    };
  }

  // ── Public write API (enqueue jobs) ────────────────────────────────────

  public async createBackup(input: CreateBackupInput): Promise<BackupRecordDto> {
    if (input.scope === BackupScope.ASSETS) {
      throw new BadRequestException('ASSETS scope is not implemented yet');
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `rezeis-${input.scope.toLowerCase()}-${ts}.sql.gz`;
    const record = await this.prismaService.backupRecord.create({
      data: {
        filename,
        scope: input.scope,
        sizeBytes: 0n,
        checksum: null,
        deliveryChannel: 'local',
        deliveryRecipient: null,
      },
    });

    // Enqueue the actual dump job (survives container restarts)
    await this.backupQueue.add(
      BACKUP_JOBS.CREATE,
      {
        recordId: record.id,
        filename,
        scope: input.scope,
        initiatedBy: input.initiatedBy,
      } satisfies BackupCreateJobData,
      {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      },
    );

    return toDto(record);
  }

  public async restoreBackup(
    filename: string,
    initiatedBy: string | null,
    options: RestoreOptions = {},
  ): Promise<RestoreEnqueueResult> {
    if (!isSafeFilename(filename)) {
      throw new BadRequestException('Invalid backup filename');
    }
    const fullPath = path.resolve(this.getBackupLocation(), filename);
    try {
      await fsp.access(fullPath);
    } catch {
      throw new NotFoundException('Backup file not found');
    }

    const allowForeignArchive = options.allowForeignArchive === true;
    const provenance = await this.admitArchiveForRestore(fullPath, allowForeignArchive);

    const job = await this.backupQueue.add(
      BACKUP_JOBS.RESTORE,
      { filename, initiatedBy, allowForeignArchive } satisfies BackupRestoreJobData,
      {
        attempts: 1, // restore should not auto-retry
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      },
    );

    return { jobId: job.id ?? filename, provenance };
  }

  /**
   * Decide whether an archive may be fed to `psql` at all.
   *
   * The control sits HERE, at admission, and not inside the restore pipeline,
   * because the pipeline has no seam: `psql --single-transaction` reads a
   * single stdin stream and the only way to vet it statement-by-statement
   * would be to parse a PostgreSQL dump — a parser whose bugs would each be a
   * silent bypass. Admission has to answer one question instead, about the
   * file as a whole, and it can answer it in a second.
   *
   * A provably-native archive restores on `backups:run` alone; that is the
   * disaster-recovery path and it is unchanged. Anything else — another
   * deployment's archive (server migration), an archive taken before stamping
   * existed, or a file somebody assembled — needs the caller to have said so
   * explicitly, and the CALLER is where that costs something: the controller
   * only accepts the acknowledgement from an admin who also holds
   * `admins:edit`, because that is exactly the power a foreign restore hands
   * out. See `AdminBackupController.restoreUpload`.
   */
  private async admitArchiveForRestore(
    fullPath: string,
    allowForeignArchive: boolean,
  ): Promise<ArchiveProvenance> {
    const provenance = await readArchiveProvenance(fullPath, process.env.REZEIS_CRYPT_KEY ?? '');
    if (provenance.status === 'native') return provenance;
    if (allowForeignArchive) {
      this.logger.warn(
        `Restoring an archive this deployment cannot verify (${provenance.reason}) — acknowledged by the operator`,
      );
      return provenance;
    }
    throw new BadRequestException(
      `Refusing to restore an archive this deployment cannot verify: ${describeForeignReason(provenance.reason)}. `
        + 'Restoring it runs whatever SQL it contains as the database owner, which can replace admin_users, '
        + 'roles, permissions and the IP allowlist. If this archive really is yours — a server migration, or a '
        + 'dump taken before provenance stamping existed — re-send the request with '
        + '"acknowledgeForeignArchive": true. That path additionally requires the admins:edit permission.',
    );
  }

  /** Read-only provenance check, for a UI that wants to warn before asking. */
  public async inspectArchiveProvenance(filename: string): Promise<ArchiveProvenance> {
    if (!isSafeFilename(filename)) {
      throw new BadRequestException('Invalid backup filename');
    }
    const fullPath = path.resolve(this.getBackupLocation(), filename);
    return readArchiveProvenance(fullPath, process.env.REZEIS_CRYPT_KEY ?? '');
  }

  /**
   * Restore from an UPLOADED backup file (disaster recovery / server
   * migration). Unlike {@link restoreBackup}, which restores a file already
   * present on the server, this accepts a `.sql.gz` the operator downloaded
   * earlier (from this panel or its Telegram delivery) and:
   *   1. validates it is a gzip dump (the restore pipeline pipes through gunzip),
   *   2. records it as a BackupRecord so it shows in the list and can be
   *      re-restored / deleted later,
   *   3. enqueues the same async restore job as a server-side restore.
   *
   * The file is expected to already be on disk under the backup directory
   * (multer disk storage), identified by `filename`.
   */
  public async restoreFromUpload(
    file: { readonly filename?: string; readonly path?: string; readonly size?: number },
    initiatedBy: string | null,
    options: RestoreOptions = {},
  ): Promise<RestoreEnqueueResult> {
    const filename = file.filename;
    if (!filename || !isSafeFilename(filename)) {
      await this.safeUnlink(file.path);
      throw new BadRequestException('Invalid uploaded backup filename');
    }
    const fullPath = path.resolve(this.getBackupLocation(), filename);
    // Guard against path traversal escaping the backup directory.
    if (!fullPath.startsWith(path.resolve(this.getBackupLocation()) + path.sep)) {
      await this.safeUnlink(fullPath);
      throw new BadRequestException('Refusing to write outside backup directory');
    }
    try {
      await fsp.access(fullPath);
    } catch {
      throw new BadRequestException('Uploaded file was not stored');
    }

    // The restore pipeline pipes the file through gunzip, so the upload MUST be
    // a gzip-compressed dump (.sql.gz) — exactly what this panel produces and
    // delivers. Reject anything else up front with a clear error.
    if (!(await firstBytesAreGzip(fullPath))) {
      await this.safeUnlink(fullPath);
      throw new BadRequestException('Uploaded file is not a gzip (.sql.gz) backup');
    }

    // A dump is world-readable at 0644 under the default umask, on a volume the
    // worker shares. Same uid on both services, so 0600 loses nothing.
    await fsp.chmod(fullPath, BACKUP_FILE_MODE).catch((err: unknown): void => {
      this.logger.warn(
        `Could not tighten permissions on ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    // Provenance BEFORE the record is written: an archive that is refused must
    // not leave a BackupRecord behind, or it would be restorable later through
    // `restore/:filename` — a path that would then see a file "this panel
    // knows about" and never learn where it came from.
    const allowForeignArchive = options.allowForeignArchive === true;
    let provenance: ArchiveProvenance;
    try {
      provenance = await this.admitArchiveForRestore(fullPath, allowForeignArchive);
    } catch (err) {
      await this.safeUnlink(fullPath);
      throw err;
    }

    // ── The upload is an ORPHAN until this block returns ─────────────────
    //
    // `admitArchiveForRestore` above unlinks when it refuses, and the queue
    // call below must NOT unlink when it fails. Everything in between was the
    // gap: the archive is on disk, admitted, and still nameless. Nothing in
    // the system points at it — `GET /admin/backup` lists
    // `backupRecord.findMany`, `DELETE /admin/backup/:id` needs a record id,
    // and `applyRetention` iterates those same rows — and there is no
    // `readdir` anywhere in this module, so a throw here left up to 2 GiB that
    // no operator could see or remove short of logging into the host.
    //
    // Three things can throw in that gap and none is far-fetched: `fsp.stat`
    // (the file removed under us between admission and here), `sha256OfFile`
    // (a full read of up to 2 GiB — much the longest window of the three, and
    // the one that fails on EIO or a descriptor limit) and `create` itself
    // (database unreachable, pool exhausted, statement timeout). `BigInt` on a
    // `stat.size` cannot realistically throw but is inside the block anyway.
    //
    // The block ENDS at a successful `create`, deliberately. That row is the
    // only durable thing that names the file: once it exists the archive is
    // listed, deletable and inside retention, so it is no longer an orphan and
    // unlinking it would be the worse bug. `backupQueue.add` below fails with
    // Redis down, and cleaning up there would destroy a disaster-recovery
    // upload the operator can otherwise simply restore again — leaving a
    // BackupRecord pointing at nothing.
    try {
      const stat = await fsp.stat(fullPath);
      const checksum = await sha256OfFile(fullPath);
      await this.prismaService.backupRecord.create({
        data: {
          filename,
          scope: BackupScope.DB,
          sizeBytes: BigInt(stat.size),
          checksum,
          deliveryChannel: 'uploaded',
          deliveryRecipient: initiatedBy,
          deliveredAt: new Date(),
        },
      });
    } catch (err) {
      await this.safeUnlink(fullPath);
      throw err;
    }

    // Retention had exactly one caller — the tail of a successful `runDump` —
    // so uploads accumulated forever: N uploads of up to 1 GiB each, never
    // pruned, on the same volume the next dump needs space on. Housekeeping
    // must not be able to block a disaster-recovery restore, hence the catch.
    await this.applyRetention().catch((err: unknown): void => {
      this.logger.warn(
        `Retention after upload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    const job = await this.backupQueue.add(
      BACKUP_JOBS.RESTORE,
      { filename, initiatedBy, allowForeignArchive } satisfies BackupRestoreJobData,
      {
        attempts: 1, // restore must not auto-retry
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      },
    );
    return { jobId: job.id ?? filename, provenance };
  }

  private async safeUnlink(target: string | undefined): Promise<void> {
    if (!target) return;
    await fsp.unlink(target).catch((): void => undefined);
  }

  public async deleteBackup(id: string): Promise<void> {
    const record = await this.prismaService.backupRecord.findUnique({
      where: { id },
      select: { filename: true },
    });
    if (!record) throw new NotFoundException('Backup not found');
    const fullPath = path.resolve(this.getBackupLocation(), record.filename);
    try {
      await fsp.unlink(fullPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Backup file removal failed: ${(err as Error).message}`);
      }
    }
    await this.prismaService.backupRecord.delete({ where: { id } });
  }

  public async enqueueDeliverTelegram(recordId: string, filename: string): Promise<void> {
    await this.backupQueue.add(
      BACKUP_JOBS.DELIVER_TELEGRAM,
      { recordId, filename } satisfies BackupDeliverTelegramJobData,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      },
    );
  }

  // ── Cron ───────────────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_HOUR)
  public async runScheduled(): Promise<void> {
    if (!shouldRunSchedules()) return;
    const cfg = await this.readBackupConfig();
    if (!cfg.autoEnabled) return;
    // Honor the configured interval: only run once enough time has elapsed
    // since the most recent backup (hourly tick + elapsed check).
    const last = await this.prismaService.backupRecord.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last !== null) {
      const elapsedMs = Date.now() - last.createdAt.getTime();
      // 1-minute grace so a slightly-early hourly tick still fires on schedule.
      if (elapsedMs < cfg.intervalHours * 3_600_000 - 60_000) return;
    }
    try {
      await this.createBackup({ scope: BackupScope.DB, initiatedBy: null });
    } catch (err) {
      this.logger.error(`Scheduled backup failed: ${(err as Error).message}`);
    }
  }

  // ── Methods called by processor ────────────────────────────────────────

  /**
   * Execute pg_dump, compress, checksum, update record, apply retention.
   * Called by BackupProcessor — NOT directly from HTTP handlers.
   */
  public async runDump(
    recordId: string,
    filename: string,
    scope: string,
    initiatedBy: string | null,
  ): Promise<{ sizeBytes: number; checksum: string }> {
    const dir = this.getBackupLocation();
    await fsp.mkdir(dir, { recursive: true });
    const fullPath = path.join(dir, filename);

    try {
      await this.spawnPgDumpToFile(fullPath);
      const stamped = await this.stampProvenance(fullPath);
      const sizeBytes = (await fsp.stat(fullPath)).size;
      const checksum = await sha256OfFile(fullPath);

      await this.prismaService.backupRecord.update({
        where: { id: recordId },
        data: { sizeBytes: BigInt(sizeBytes), checksum, deliveredAt: new Date() },
      });

      // `emit` rather than `info`, for the one field `info` cannot carry:
      // `adminId`. Every backup/restore completion used to land in the audit
      // log with `adminUserId: null` and `ipAddress: 'system'`, so the audit
      // page showed "system" as the actor for all of them and the admin who
      // pressed the button survived only as a metadata string.
      this.systemEventsService.emit({
        type: EVENT_TYPES.SYSTEM_BACKUP_COMPLETED,
        category: 'SYSTEM',
        severity: 'INFO',
        message: `Backup completed: ${filename} (${formatBytes(sizeBytes)})`,
        metadata: { backupId: recordId, filename, scope, sizeBytes, checksum, initiatedBy, stamped },
        adminId: initiatedBy,
      });

      await this.applyRetention();
      return { sizeBytes, checksum };
    } catch (err) {
      const message = (err as Error).message;
      await this.prismaService.backupRecord
        .update({ where: { id: recordId }, data: { errorMessage: message } })
        .catch((): void => undefined);
      await fsp.unlink(fullPath).catch((): void => undefined);

      this.systemEventsService.error(
        EVENT_TYPES.SYSTEM_ERROR,
        'SYSTEM',
        `Backup failed: ${message}`,
        { backupId: recordId, filename, scope, error: message, initiatedBy },
      );
      throw err;
    }
  }

  /**
   * Append the provenance member that lets a later restore prove this file is
   * ours. Returns whether the stamp was written.
   *
   * An append of ~190 bytes, not a rewrite: `.gz` files concatenate, so the
   * stamp costs nothing on a gigabyte dump. Without `REZEIS_CRYPT_KEY` there
   * is nothing to sign with — the dump is still perfectly good, it simply
   * cannot be verified later, and restoring it will demand the explicit
   * foreign-archive acknowledgement.
   */
  private async stampProvenance(fullPath: string): Promise<boolean> {
    const cryptKey = process.env.REZEIS_CRYPT_KEY ?? '';
    if (cryptKey.length === 0) {
      this.logger.warn(
        'REZEIS_CRYPT_KEY is not set — this backup cannot be stamped, and restoring it later '
          + 'will require an explicit foreign-archive acknowledgement',
      );
      return false;
    }
    const payloadSha256 = await sha256OfFile(fullPath);
    await fsp.appendFile(fullPath, buildProvenanceTrailer(payloadSha256, cryptKey));
    return true;
  }

  /**
   * Restore database from a .sql.gz backup file.
   * Spawns gunzip | psql pipeline.
   */
  public async runRestore(filename: string, options: RestoreOptions = {}): Promise<boolean> {
    const fullPath = path.resolve(this.getBackupLocation(), filename);
    try {
      await fsp.access(fullPath);
    } catch {
      throw new NotFoundException('Backup file not found for restore');
    }

    // Checked again here, and not only at admission, because this is the last
    // point before the file becomes SQL running as the database owner. The job
    // may have been queued minutes ago against a file that has since changed;
    // an acknowledgement the operator did give travels in the job payload, and
    // its absence means the archive must still verify on its own.
    await this.admitArchiveForRestore(fullPath, options.allowForeignArchive === true);

    return new Promise<boolean>((resolve, reject) => {
      const env = {
        ...process.env,
        PGPASSWORD: this.databaseConfiguration.password,
      };
      const psqlArgs = [
        '-h', this.databaseConfiguration.host,
        '-p', String(this.databaseConfiguration.port),
        '-U', this.databaseConfiguration.user,
        '-d', this.databaseConfiguration.name,
        '--single-transaction',
      ];

      const gunzip = zlib.createGunzip();
      const psql = spawn('psql', psqlArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] });

      let stderr = '';
      psql.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      psql.on('error', (err) => reject(new Error(`psql spawn failed: ${err.message}`)));
      psql.on('exit', (code) => {
        if (code === 0) {
          resolve(true);
        } else {
          reject(new Error(`psql exited ${code}: ${stderr.trim() || 'unknown error'}`));
        }
      });

      const fileStream = createReadStream(fullPath);
      fileStream.pipe(gunzip).pipe(psql.stdin);
      fileStream.on('error', (err) => reject(err));
      gunzip.on('error', (err) => reject(new Error(`Decompression failed: ${err.message}`)));
    });
  }

  /**
   * Re-apply any Prisma migrations newer than the restored snapshot.
   *
   * A `.sql.gz` dump captures the schema **and** the `_prisma_migrations`
   * table exactly as they were when the backup was taken. Restoring an OLDER
   * backup therefore rolls the schema back to that version, while the running
   * build expects the latest migrations. We run `prisma migrate deploy` right
   * after a restore so the schema is brought forward to match the current
   * code — the same step the container entrypoint runs on boot, applied
   * immediately so the operator does NOT have to restart the container after
   * restoring a backup from an older version.
   *
   * Best-effort: a failure here does not undo the data restore (rows are
   * already loaded). It is surfaced to the caller so the restore event can
   * flag that the operator should reconcile the schema (restart / restore a
   * matching build).
   */
  public async runMigrateDeploy(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const child = spawn('npx', ['prisma', 'migrate', 'deploy'], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // npx resolves to npx.cmd on Windows dev hosts; in the Linux container
        // it's a plain binary on PATH.
        shell: process.platform === 'win32',
      });
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (line.length > 0) this.logger.log(`[migrate] ${line}`);
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        this.logger.error(`migrate deploy spawn failed: ${err.message}`);
        resolve(false);
      });
      child.on('exit', (code) => {
        if (code === 0) {
          this.logger.log('Post-restore migrate deploy: schema up-to-date');
          resolve(true);
        } else {
          this.logger.error(
            `Post-restore migrate deploy failed (exit ${code}): ${stderr.trim().slice(0, 500) || 'unknown error'}`,
          );
          resolve(false);
        }
      });
    });
  }

  /**
   * Send a backup file to Telegram as a document.
   *
   * Kept as the boolean-returning entry point five years of callers expect;
   * `attemptTelegramDelivery` is the same work with the retry decision attached.
   */
  public async deliverToTelegram(recordId: string, filename: string): Promise<boolean> {
    const outcome = await this.attemptTelegramDelivery(recordId, filename);
    return outcome.delivered;
  }

  /**
   * Send a backup file to Telegram, reporting whether another attempt could
   * plausibly change the answer.
   *
   * `options.isFinalAttempt` governs the OPERATOR ALERT only, never the record:
   * a failure is written to the backup record every time, because "not
   * delivered" is true on each attempt that has not delivered it. The alert is
   * different — three attempts must produce one alert, not three — so on a
   * retryable failure it is held back until the last attempt. A terminal
   * failure alerts immediately whatever the flag says: nothing is coming after
   * it to do the alerting. Defaults to `true` so a direct call still behaves
   * exactly as it always has.
   */
  public async attemptTelegramDelivery(
    recordId: string,
    filename: string,
    options: { readonly isFinalAttempt?: boolean } = {},
  ): Promise<BackupDeliveryOutcome> {
    const isFinalAttempt = options.isFinalAttempt ?? true;
    const tgConfig = await this.loadTelegramConfig();
    if (!tgConfig.enabled || !tgConfig.chatId) {
      this.logger.warn('Telegram delivery not configured — skipping');
      return terminalDelivery('not_configured');
    }

    const fullPath = path.resolve(this.getBackupLocation(), filename);
    try {
      await fsp.access(fullPath);
    } catch {
      this.logger.warn(`Backup file not found for Telegram delivery: ${filename}`);
      return terminalDelivery('file_missing');
    }

    const stat = await fsp.stat(fullPath);
    // Telegram upload cap: 50 MB on the cloud Bot API, up to 2 GB with a
    // self-hosted Local Bot API Server. Operators raise the limit via
    // BACKUP_MAX_DELIVERY_BYTES once their reiwa bot points at a local server.
    const maxDeliveryBytes = resolveMaxDeliveryBytes();
    if (stat.size > maxDeliveryBytes) {
      this.logger.warn(`Backup ${filename} too large for Telegram (${formatBytes(stat.size)})`);
      await this.prismaService.backupRecord.update({
        where: { id: recordId },
        data: { deliveryChannel: 'local', deliveryRecipient: 'too_large_for_telegram' },
      });
      this.systemEventsService.warn(
        EVENT_TYPES.SYSTEM_BACKUP_COMPLETED,
        'SYSTEM',
        `Backup stored locally (too large for Telegram): ${filename} (${formatBytes(stat.size)})`,
        { backupId: recordId, filename, sizeBytes: stat.size, deliveredToTelegram: false },
      );
      // Terminal: no number of retries shrinks the file.
      return terminalDelivery('too_large_for_telegram');
    }

    const caption = `🗄 Backup: ${filename}\nSize: ${formatBytes(stat.size)}`;

    // Direct path — only when rezeis has a local bot token (single-process
    // deployments). On the split deployment the token lives in reiwa.
    if (tgConfig.botToken) {
      const fileBuffer = await fsp.readFile(fullPath);
      const formData = new FormData();
      formData.append('chat_id', tgConfig.chatId);
      formData.append('document', new Blob([fileBuffer]), filename);
      formData.append('caption', caption);
      if (tgConfig.topicId) {
        formData.append('message_thread_id', String(tgConfig.topicId));
      }
      try {
        const response = await fetch(
          `https://api.telegram.org/bot${tgConfig.botToken}/sendDocument`,
          { method: 'POST', body: formData },
        );
        if (response.ok) {
          await this.prismaService.backupRecord.update({
            where: { id: recordId },
            data: {
              deliveryChannel: 'telegram',
              deliveryRecipient: tgConfig.chatId,
              deliveredAt: new Date(),
            },
          });
          this.logger.log(`Backup ${filename} delivered to Telegram`);
          return { delivered: true, retryable: false, reason: null };
        }
        const errorBody = await response.text();
        this.logger.warn(`Telegram delivery failed: ${errorBody.slice(0, 300)}`);
        // The direct path is left exactly as it was — no record write, no
        // alert, no retry. Its failures carry none of the evidence the relay's
        // `NotifyDeliveryResult` carries, so retrying here would mean inventing
        // a classification AND an alert this path has never had. Out of scope
        // for the relay defect; noted rather than half-fixed.
        return terminalDelivery('telegram_api_rejected');
      } catch (err) {
        this.logger.warn(`Telegram delivery threw: ${(err as Error).message}`);
        return terminalDelivery('telegram_api_threw');
      }
    }

    // Relay path — hand the reiwa bot a signed download URL token; the bot
    // fetches the file from rezeis (docker hop) and uploads it to Telegram.
    if (!this.botNotifier?.isEnabled) {
      this.logger.warn(
        'Backup Telegram delivery skipped: no local bot token and reiwa relay unavailable (set BOT_TOKEN or REIWA_URL + WEBHOOK_SECRET_HEADER)',
      );
      return terminalDelivery('relay_unavailable');
    }
    const secret = process.env.REZEIS_CRYPT_KEY ?? '';
    if (secret.length === 0) {
      this.logger.warn('Backup Telegram relay skipped: REZEIS_CRYPT_KEY is not set');
      return terminalDelivery('crypt_key_missing');
    }
    try {
      const token = signBackupDownloadToken(recordId, secret);
      const outcome = await this.botNotifier.relayBackupDocument({
        recordId,
        token,
        filename,
        caption,
        chatId: tgConfig.chatId,
        topicThreadId: tgConfig.topicId ?? undefined,
      });
      // `relayBackupDocument` reports failure by return value, never by
      // throwing — so this branch is the only thing standing between a failed
      // relay and a record that claims the file is safely off-site. The direct
      // path above gates on `response.ok` for the same reason; this is the
      // relay's equivalent, and it demands the same strength of evidence: a
      // Telegram message id, not merely a hop that accepted the instruction.
      if (outcome.status !== 'confirmed') {
        const retryable = isRetryableRelayOutcome(outcome);
        // The record is corrected on every attempt — "not delivered" is true
        // right now regardless of what attempt four might prove — but the
        // operator only hears about it when nothing further is coming.
        await this.recordRelayNotDelivered(recordId, filename, outcome, {
          alert: !retryable || isFinalAttempt,
        });
        return { delivered: false, retryable, reason: `telegram_relay_${outcome.status}` };
      }
      await this.prismaService.backupRecord.update({
        where: { id: recordId },
        data: {
          deliveryChannel: 'telegram-relay',
          deliveryRecipient: tgConfig.chatId,
          deliveredAt: new Date(),
        },
      });
      this.logger.log(`Backup ${filename} relayed to Telegram via reiwa`);
      return { delivered: true, retryable: false, reason: null };
    } catch (err) {
      // Reachable for real: `signBackupDownloadToken` and the Prisma write can
      // throw even though the relay call itself cannot.
      //
      // Terminal on purpose. A throwing `signBackupDownloadToken` is a bad key
      // and is deterministic; a throwing Prisma write here happens only on the
      // CONFIRMED branch above, meaning the file is already in Telegram and we
      // merely failed to write that down. Retrying would upload a second copy
      // of a backup that is already safely off-site, and most likely fail to
      // record that one too.
      this.logger.warn(`Backup Telegram relay threw: ${(err as Error).message}`);
      await this.recordRelayNotDelivered(
        recordId,
        filename,
        { status: 'failed', messageId: null, httpStatus: null, detail: (err as Error).message },
        { alert: true },
      );
      return terminalDelivery('telegram_relay_failed');
    }
  }

  /**
   * A relay attempt that did not prove delivery leaves the record saying what
   * is true: the file is still only local. Mirrors the "too large for Telegram"
   * bookkeeping above — `deliveryChannel: 'local'` plus a recipient marker
   * naming the reason — rather than setting `errorMessage`, which the operator
   * UI reads as "the backup itself failed". The dump is fine; only its trip
   * off-site is not.
   *
   * `alert` splits the two halves: the record is always corrected, the operator
   * event is emitted only when this attempt is the last word on the subject.
   */
  private async recordRelayNotDelivered(
    recordId: string,
    filename: string,
    outcome: NotifyDeliveryResult,
    options: { readonly alert: boolean },
  ): Promise<void> {
    const reason = `telegram_relay_${outcome.status}`;
    await this.prismaService.backupRecord
      .update({
        where: { id: recordId },
        data: { deliveryChannel: 'local', deliveryRecipient: reason },
      })
      .catch((err: unknown): void => {
        this.logger.warn(
          `Could not record failed Telegram relay for ${filename}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    if (!options.alert) {
      this.logger.warn(
        `Backup Telegram relay ${outcome.status} for ${filename} — retrying; operator alert held for the final attempt`,
      );
      return;
    }
    this.systemEventsService.warn(
      EVENT_TYPES.SYSTEM_BACKUP_COMPLETED,
      'SYSTEM',
      `Backup stored locally — Telegram relay did not confirm delivery (${outcome.status}): ${filename}`,
      {
        backupId: recordId,
        filename,
        deliveredToTelegram: false,
        relayStatus: outcome.status,
        httpStatus: outcome.httpStatus,
        detail: outcome.detail,
      },
    );
  }

  /** Check if Telegram delivery is configured and enabled. */
  public async shouldDeliverToTelegram(): Promise<boolean> {
    const config = await this.loadTelegramConfig();
    // A local bot token is NOT required: the split deployment delivers via the
    // reiwa relay. The delivery job decides direct-vs-relay at run time.
    return config.enabled && !!config.chatId;
  }

  /**
   * Resolves a backup record to its on-disk file for the signed-download
   * endpoint. Returns `null` when the record or the file is missing.
   */
  public async resolveBackupFileForDownload(
    recordId: string,
  ): Promise<{ readonly fullPath: string; readonly filename: string } | null> {
    const record = await this.prismaService.backupRecord.findUnique({
      where: { id: recordId },
      select: { filename: true },
    });
    if (!record) return null;
    const fullPath = path.resolve(this.getBackupLocation(), record.filename);
    try {
      await fsp.access(fullPath);
    } catch {
      return null;
    }
    return { fullPath, filename: record.filename };
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private getBackupLocation(): string {
    return process.env.BACKUP_LOCATION ?? DEFAULT_BACKUP_LOCATION;
  }

  /** Read + normalize the persisted backup config, falling back to env/defaults. */
  private async readBackupConfig(): Promise<{
    autoEnabled: boolean;
    intervalHours: number;
    maxKeep: number;
    telegram: { enabled: boolean; chatId: string | null; topicId: number | null };
  }> {
    const settings = await this.prismaService.settings.findFirst({
      select: { systemNotifications: true },
    });
    const sys =
      settings && typeof settings.systemNotifications === 'object' && settings.systemNotifications !== null
        ? (settings.systemNotifications as Record<string, unknown>)
        : {};
    return this.normalizeBackupConfig(sys.backup);
  }

  private normalizeBackupConfig(raw: unknown): {
    autoEnabled: boolean;
    intervalHours: number;
    maxKeep: number;
    telegram: { enabled: boolean; chatId: string | null; topicId: number | null };
  } {
    const b = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const tg = typeof b.telegram === 'object' && b.telegram !== null ? (b.telegram as Record<string, unknown>) : {};
    const envMaxKeep = Number.parseInt(process.env.BACKUP_MAX_KEEP ?? '', 10);
    return {
      autoEnabled:
        typeof b.autoEnabled === 'boolean' ? b.autoEnabled : process.env.BACKUP_AUTO_ENABLED !== 'false',
      intervalHours:
        typeof b.intervalHours === 'number' && b.intervalHours > 0
          ? clampInt(b.intervalHours, 1, 168)
          : INTERVAL_HOURS_FALLBACK,
      maxKeep:
        typeof b.maxKeep === 'number' && b.maxKeep > 0
          ? clampInt(b.maxKeep, 1, 100)
          : Number.isFinite(envMaxKeep) && envMaxKeep > 0
            ? envMaxKeep
            : RETENTION_FALLBACK,
      telegram: {
        enabled: tg.enabled === true,
        chatId: normalizeNullableString(tg.chatId),
        topicId: normalizeNullableTopicId(tg.topicId),
      },
    };
  }

  /** Decrypt the admin bot token (settings) or fall back to env BOT_TOKEN. */
  private async resolveBotToken(): Promise<string | null> {
    const fromSettings = await this.settingsService.getDecryptedBotToken();
    if (fromSettings) return fromSettings;
    const env = process.env.BOT_TOKEN;
    return typeof env === 'string' && env.length > 0 ? env : null;
  }

  private spawnPgDumpToFile(destination: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const env = { ...process.env, PGPASSWORD: this.databaseConfiguration.password };
      const args = [
        '-h', this.databaseConfiguration.host,
        '-p', String(this.databaseConfiguration.port),
        '-U', this.databaseConfiguration.user,
        '-d', this.databaseConfiguration.name,
        '--clean', '--if-exists', '--no-owner', '--no-privileges',
      ];
      const dump = spawn('pg_dump', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const gzip = zlib.createGzip();
      // `mode` is masked by the process umask, so it can only ever be tighter
      // than 0600, never looser — but an inherited 0022 umask would leave a
      // requested 0644 world-readable, which is what it did. The explicit
      // chmod below closes the window for a pre-existing file, which
      // `createWriteStream` would open without changing its mode.
      const out = createWriteStream(destination, { mode: BACKUP_FILE_MODE });

      let stderr = '';
      dump.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      let exitedWithError: Error | null = null;
      dump.on('error', (err) => {
        exitedWithError = err;
        gzip.destroy();
        out.destroy();
        reject(new Error(`pg_dump spawn failed: ${err.message}`));
      });
      dump.on('exit', (code) => {
        if (code !== 0 && !exitedWithError) {
          exitedWithError = new Error(`pg_dump exited ${code}: ${stderr.trim() || 'unknown error'}`);
          gzip.destroy();
          out.destroy();
          reject(exitedWithError);
        }
      });

      out.on('error', (err) => reject(err));
      out.on('finish', async () => {
        if (exitedWithError) return;
        try {
          await fsp.chmod(destination, BACKUP_FILE_MODE);
          const stat = await fsp.stat(destination);
          resolve(stat.size);
        } catch (err) {
          reject(err);
        }
      });

      dump.stdout.pipe(gzip).pipe(out);
    });
  }

  /**
   * Prune down to `maxKeep` local files.
   *
   * Retention keys on count and recency alone — it has no idea whether a file
   * it is about to delete exists anywhere else. When every backup is off-site
   * (or none is), that is harmless. When only some are, deleting the local copy
   * of one that never made it off-site destroys that backup outright, while a
   * copy Telegram is still holding survives in its place.
   *
   * So: the same number of files is kept, and the newest is always among them
   * (restoring the latest snapshot must not require a round trip to Telegram),
   * but when the count forces a choice the duplicated copies are spent before
   * the sole ones. Deleting a sole copy anyway is announced, because the
   * alternative is the operator finding out at restore time.
   */
  private async applyRetention(): Promise<void> {
    const cfg = await this.readBackupConfig();
    const keep = cfg.maxKeep;
    const all = await this.prismaService.backupRecord.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, filename: true, deliveryChannel: true },
    });
    if (all.length <= keep) return;

    // `all` is newest-first and `filter` is order-preserving, so each group
    // stays newest-first; the head keeps its place regardless of delivery.
    const [newest, ...rest] = all;
    const ordered = [
      ...(newest === undefined ? [] : [newest]),
      ...rest.filter((row) => !isDeliveredOffsite(row.deliveryChannel)),
      ...rest.filter((row) => isDeliveredOffsite(row.deliveryChannel)),
    ];
    const stale = ordered.slice(keep);

    for (const row of stale) {
      const fullPath = path.resolve(this.getBackupLocation(), row.filename);
      await fsp.unlink(fullPath).catch((): void => undefined);
      await this.prismaService.backupRecord.delete({ where: { id: row.id } }).catch((): void => undefined);
      if (cfg.telegram.enabled && !isDeliveredOffsite(row.deliveryChannel)) {
        // The operator asked for off-site copies and this one never got there.
        // Its local file was the whole backup, and it is now gone.
        this.systemEventsService.warn(
          EVENT_TYPES.SYSTEM_BACKUP_COMPLETED,
          'SYSTEM',
          `Retention deleted the only copy of ${row.filename} — it was never delivered off-site`,
          {
            backupId: row.id,
            filename: row.filename,
            deliveredToTelegram: false,
            deliveryChannel: row.deliveryChannel,
            maxKeep: keep,
          },
        );
      }
    }
  }

  private async loadTelegramConfig(): Promise<{
    enabled: boolean;
    botToken: string | null;
    chatId: string | null;
    topicId: number | null;
  }> {
    const cfg = await this.readBackupConfig();
    const botToken = await this.resolveBotToken();
    return {
      enabled: cfg.telegram.enabled,
      botToken,
      chatId: cfg.telegram.chatId,
      topicId: cfg.telegram.topicId,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Whether a record's channel means a copy of the file exists somewhere other
 * than the local disk. `deliveredAt` deliberately plays no part: `runDump`
 * stamps it the moment the dump finishes (the admin UI reads it as "ready"),
 * long before any delivery is attempted, so it is true of every backup and
 * proves nothing about where the bytes are.
 */
function isDeliveredOffsite(deliveryChannel: string | null): boolean {
  return deliveryChannel === 'telegram' || deliveryChannel === 'telegram-relay';
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Coerce a topic id from a number or numeric string; null/empty → null. */
function normalizeNullableTopicId(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const n = Number.parseInt(trimmed, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

function toDto(row: {
  readonly id: string;
  readonly filename: string;
  readonly scope: BackupScope;
  readonly sizeBytes: bigint;
  readonly checksum: string | null;
  readonly deliveryChannel: string;
  readonly deliveryRecipient: string | null;
  readonly deliveredAt: Date | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
}): BackupRecordDto {
  return {
    id: row.id,
    filename: row.filename,
    scope: row.scope,
    sizeBytes: row.sizeBytes.toString(),
    checksum: row.checksum,
    deliveryChannel: row.deliveryChannel,
    deliveryRecipient: row.deliveryRecipient,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
  };
}

function isSafeFilename(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..');
}

/** Read the first two bytes of a file and check the gzip magic (1f 8b). */
async function firstBytesAreGzip(filePath: string): Promise<boolean> {
  const fd = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(2);
    await fd.read(buf, 0, 2, 0);
    return buf[0] === 0x1f && buf[1] === 0x8b;
  } finally {
    await fd.close();
  }
}

async function sha256OfFile(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const stream = createReadStream(filePath);
    const hash = createHash('sha256');
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
