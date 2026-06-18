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
import { BotNotifierClient } from '../../notifications/services/bot-notifier.client';
import { signBackupDownloadToken } from '../utils/backup-download-token.util';
import type { BackupCreateJobData, BackupDeliverTelegramJobData, BackupRestoreJobData } from '../backup.processor';

const DEFAULT_BACKUP_LOCATION = '/app/data/backups';
const RETENTION_FALLBACK = 7;
const INTERVAL_HOURS_FALLBACK = 24;

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

  public async restoreBackup(filename: string, initiatedBy: string | null): Promise<{ jobId: string }> {
    if (!isSafeFilename(filename)) {
      throw new BadRequestException('Invalid backup filename');
    }
    const fullPath = path.resolve(this.getBackupLocation(), filename);
    try {
      await fsp.access(fullPath);
    } catch {
      throw new NotFoundException('Backup file not found');
    }

    const job = await this.backupQueue.add(
      BACKUP_JOBS.RESTORE,
      { filename, initiatedBy } satisfies BackupRestoreJobData,
      {
        attempts: 1, // restore should not auto-retry
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      },
    );

    return { jobId: job.id ?? filename };
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
      const sizeBytes = await this.spawnPgDumpToFile(fullPath);
      const checksum = await sha256OfFile(fullPath);

      await this.prismaService.backupRecord.update({
        where: { id: recordId },
        data: { sizeBytes: BigInt(sizeBytes), checksum, deliveredAt: new Date() },
      });

      this.systemEventsService.info(
        EVENT_TYPES.SYSTEM_BACKUP_COMPLETED,
        'SYSTEM',
        `Backup completed: ${filename} (${formatBytes(sizeBytes)})`,
        { backupId: recordId, filename, scope, sizeBytes, checksum, initiatedBy },
      );

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
   * Restore database from a .sql.gz backup file.
   * Spawns gunzip | psql pipeline.
   */
  public async runRestore(filename: string): Promise<boolean> {
    const fullPath = path.resolve(this.getBackupLocation(), filename);
    try {
      await fsp.access(fullPath);
    } catch {
      throw new NotFoundException('Backup file not found for restore');
    }

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
   * Send a backup file to Telegram as a document.
   */
  public async deliverToTelegram(recordId: string, filename: string): Promise<boolean> {
    const tgConfig = await this.loadTelegramConfig();
    if (!tgConfig.enabled || !tgConfig.chatId) {
      this.logger.warn('Telegram delivery not configured — skipping');
      return false;
    }

    const fullPath = path.resolve(this.getBackupLocation(), filename);
    try {
      await fsp.access(fullPath);
    } catch {
      this.logger.warn(`Backup file not found for Telegram delivery: ${filename}`);
      return false;
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
      return false;
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
          return true;
        }
        const errorBody = await response.text();
        this.logger.warn(`Telegram delivery failed: ${errorBody.slice(0, 300)}`);
        return false;
      } catch (err) {
        this.logger.warn(`Telegram delivery threw: ${(err as Error).message}`);
        return false;
      }
    }

    // Relay path — hand the reiwa bot a signed download URL token; the bot
    // fetches the file from rezeis (docker hop) and uploads it to Telegram.
    if (!this.botNotifier?.isEnabled) {
      this.logger.warn(
        'Backup Telegram delivery skipped: no local bot token and reiwa relay unavailable (set BOT_TOKEN or REIWA_URL + WEBHOOK_SECRET_HEADER)',
      );
      return false;
    }
    const secret = process.env.REZEIS_CRYPT_KEY ?? '';
    if (secret.length === 0) {
      this.logger.warn('Backup Telegram relay skipped: REZEIS_CRYPT_KEY is not set');
      return false;
    }
    try {
      const token = signBackupDownloadToken(recordId, secret);
      await this.botNotifier.relayBackupDocument({
        recordId,
        token,
        filename,
        caption,
        chatId: tgConfig.chatId,
        topicThreadId: tgConfig.topicId ?? undefined,
      });
      await this.prismaService.backupRecord.update({
        where: { id: recordId },
        data: {
          deliveryChannel: 'telegram-relay',
          deliveryRecipient: tgConfig.chatId,
          deliveredAt: new Date(),
        },
      });
      this.logger.log(`Backup ${filename} relayed to Telegram via reiwa`);
      return true;
    } catch (err) {
      this.logger.warn(`Backup Telegram relay threw: ${(err as Error).message}`);
      return false;
    }
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
      const out = createWriteStream(destination);

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
          const stat = await fsp.stat(destination);
          resolve(stat.size);
        } catch (err) {
          reject(err);
        }
      });

      dump.stdout.pipe(gzip).pipe(out);
    });
  }

  private async applyRetention(): Promise<void> {
    const keep = (await this.readBackupConfig()).maxKeep;
    const all = await this.prismaService.backupRecord.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, filename: true },
    });
    const stale = all.slice(keep);
    for (const row of stale) {
      const fullPath = path.resolve(this.getBackupLocation(), row.filename);
      await fsp.unlink(fullPath).catch((): void => undefined);
      await this.prismaService.backupRecord.delete({ where: { id: row.id } }).catch((): void => undefined);
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
