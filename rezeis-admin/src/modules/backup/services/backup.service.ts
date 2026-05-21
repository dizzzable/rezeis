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

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BackupScope } from '@prisma/client';

import { databaseConfig } from '../../../common/config/database.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';

const DEFAULT_BACKUP_LOCATION = '/app/data/backups';
const RETENTION_FALLBACK = 7;

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
  /** Admin id that triggered the backup (null = scheduler / cron). */
  readonly initiatedBy: string | null;
}

/**
 * Backup module — Phase 3 implementation.
 *
 * Performs the actual `pg_dump` for `scope=DB`/`FULL`, stores the file on
 * the local volume mounted at `BACKUP_LOCATION`, hashes it for integrity,
 * keeps the most recent N rows (`BACKUP_MAX_KEEP`) and removes older
 * dumps.
 *
 * The actual command runs in a detached child process so the HTTP request
 * that initiated the backup can return immediately. Status is reflected
 * in the DB row: `sizeBytes=0` + `errorMessage=null` → in-progress;
 * `sizeBytes>0` → finished; `errorMessage!=null` → failed.
 */
@Injectable()
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger(BackupService.name);

  public constructor(
    @Inject(databaseConfig.KEY)
    private readonly databaseConfiguration: ConfigType<typeof databaseConfig>,
    private readonly prismaService: PrismaService,
    private readonly systemEventsService: SystemEventsService,
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
    return {
      items: rows.map(toDto),
      total,
      limit,
      offset,
    };
  }

  public async getStats(): Promise<{
    readonly total: number;
    readonly lastBackup: BackupRecordDto | null;
  }> {
    const [total, lastBackup] = await Promise.all([
      this.prismaService.backupRecord.count(),
      this.prismaService.backupRecord.findFirst({
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { total, lastBackup: lastBackup ? toDto(lastBackup) : null };
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
    const stream = createReadStream(fullPath);
    return {
      stream,
      mimeType: filename.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream',
      filename,
    };
  }

  // ── Public write API ───────────────────────────────────────────────────

  public async createBackup(input: CreateBackupInput): Promise<BackupRecordDto> {
    if (input.scope === BackupScope.ASSETS) {
      // Assets-only backups are not implemented yet — they would need a
      // separate asset directory walker. Reject loudly so the operator
      // doesn't silently get an empty dump.
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

    // Run the actual dump asynchronously. We deliberately do NOT await
    // here; the HTTP route returns immediately with a "processing"
    // record.
    void this.runDumpAndFinalise(record.id, filename, input.scope, input.initiatedBy)
      .catch((err) => {
        this.logger.error(`Backup ${record.id} crashed: ${(err as Error).stack ?? err}`);
      });

    return toDto(record);
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

  /**
   * Cron driver — daily at 03:00 UTC. The interval is fixed because the
   * existing settings table doesn't expose a backup schedule yet; once
   * it does, we can route through `config_service`.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  public async runScheduled(): Promise<void> {
    if (!shouldRunSchedules()) return;
    if (process.env.BACKUP_AUTO_ENABLED === 'false') return;
    try {
      await this.createBackup({ scope: BackupScope.DB, initiatedBy: null });
    } catch (err) {
      this.logger.error(`Scheduled backup failed: ${(err as Error).message}`);
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private getBackupLocation(): string {
    return process.env.BACKUP_LOCATION ?? DEFAULT_BACKUP_LOCATION;
  }

  private getRetention(): number {
    const raw = process.env.BACKUP_MAX_KEEP;
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : RETENTION_FALLBACK;
  }

  private async runDumpAndFinalise(
    recordId: string,
    filename: string,
    scope: BackupScope,
    initiatedBy: string | null,
  ): Promise<void> {
    const dir = this.getBackupLocation();
    await fsp.mkdir(dir, { recursive: true });
    const fullPath = path.join(dir, filename);
    try {
      const sizeBytes = await this.spawnPgDumpToFile(fullPath);
      const checksum = await sha256OfFile(fullPath);
      await this.prismaService.backupRecord.update({
        where: { id: recordId },
        data: {
          sizeBytes: BigInt(sizeBytes),
          checksum,
          deliveredAt: new Date(),
        },
      });
      this.systemEventsService.info(
        EVENT_TYPES.SYSTEM_BACKUP_COMPLETED,
        'SYSTEM',
        `Backup completed: ${filename}`,
        {
          backupId: recordId,
          filename,
          scope,
          sizeBytes,
          checksum,
          initiatedBy,
          targetType: 'backup',
          targetId: recordId,
        },
      );
      await this.applyRetention();
    } catch (err) {
      const message = (err as Error).message;
      await this.prismaService.backupRecord
        .update({
          where: { id: recordId },
          data: { errorMessage: message },
        })
        .catch(() => undefined);
      // Best-effort: remove the partial file so the volume doesn't fill up.
      await fsp.unlink(fullPath).catch(() => undefined);
      this.systemEventsService.error(
        EVENT_TYPES.SYSTEM_ERROR,
        'SYSTEM',
        `Backup failed: ${message}`,
        {
          backupId: recordId,
          filename,
          scope,
          error: message,
          initiatedBy,
          targetType: 'backup',
          targetId: recordId,
        },
      );
    }
  }

  /**
   * Spawns `pg_dump` and pipes stdout through gzip into the destination
   * file. Resolves with the resulting file size in bytes.
   *
   * The function relies on `pg_dump` being available on PATH inside the
   * container (the official Postgres image and the rezeis-admin image
   * both ship it).
   */
  private spawnPgDumpToFile(destination: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const env = {
        ...process.env,
        PGPASSWORD: this.databaseConfiguration.password,
      };
      const args = [
        '-h', this.databaseConfiguration.host,
        '-p', String(this.databaseConfiguration.port),
        '-U', this.databaseConfiguration.user,
        '-d', this.databaseConfiguration.name,
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-privileges',
      ];
      const dump = spawn('pg_dump', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const gzip = zlib.createGzip();
      const out = createWriteStream(destination);

      let stderr = '';
      dump.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      let dumpExited = false;
      let exitedWithError: Error | null = null;
      dump.on('error', (err) => {
        exitedWithError = err;
        gzip.destroy();
        out.destroy();
        reject(new Error(`pg_dump spawn failed: ${err.message}`));
      });
      dump.on('exit', (code) => {
        dumpExited = true;
        if (code !== 0 && !exitedWithError) {
          exitedWithError = new Error(`pg_dump exited ${code}: ${stderr.trim() || 'unknown error'}`);
          gzip.destroy();
          out.destroy();
          reject(exitedWithError);
        }
      });

      out.on('error', (err) => reject(err));
      out.on('finish', async () => {
        if (!dumpExited && exitedWithError) return;
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
    const keep = this.getRetention();
    const all = await this.prismaService.backupRecord.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, filename: true },
    });
    const stale = all.slice(keep);
    for (const row of stale) {
      const fullPath = path.resolve(this.getBackupLocation(), row.filename);
      await fsp.unlink(fullPath).catch(() => undefined);
      await this.prismaService.backupRecord
        .delete({ where: { id: row.id } })
        .catch(() => undefined);
    }
  }
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
  // No path separators, no parent traversal, stays within our naming
  // pattern (alphanumerics, dot, hyphen, underscore).
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
