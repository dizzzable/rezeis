import { Pool } from 'pg';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createWriteStream, createReadStream } from 'fs';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { getBackupConfig, getTelegramConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Backup data structure
 */
export interface BackupData {
  metadata: {
    version: string;
    createdAt: string;
    tables: string[];
    recordCounts: Record<string, number>;
    compressed: boolean;
  };
  data: Record<string, unknown[]>;
}

/**
 * Backup file info
 */
export interface BackupFile {
  filename: string;
  size: number;
  createdAt: Date;
  tables: string[];
  recordCount: number;
  compressed: boolean;
}

/**
 * Available tables for backup
 */
export const AVAILABLE_TABLES = [
  'users',
  'subscriptions',
  'transactions',
  'plans',
  'plan_durations',
  'plan_prices',
  'payment_gateways',
  'partners',
  'referrals',
  'promocodes',
  'promocode_activations',
  'broadcasts',
  'banners',
  'statistics',
  'settings',
  'admins',
  'backups',
] as const;

export type BackupTable = (typeof AVAILABLE_TABLES)[number];

/**
 * Backup Service
 * Handles database backups with selectable tables and multiple destinations
 */
export class BackupService {
  private pool: Pool;
  private config: ReturnType<typeof getBackupConfig>;
  private telegramConfig: ReturnType<typeof getTelegramConfig>;

  constructor(pool: Pool) {
    this.pool = pool;
    this.config = getBackupConfig();
    this.telegramConfig = getTelegramConfig();
  }

  /**
   * Reload configuration (useful after env changes)
   */
  reloadConfig(): void {
    this.config = getBackupConfig();
    this.telegramConfig = getTelegramConfig();
  }

  /**
   * Get list of tables to backup based on configuration
   */
  private getTablesToBackup(): string[] {
    if (this.config.includeTables.includes('all')) {
      return AVAILABLE_TABLES.map(t => t);
    }
    return this.config.includeTables.filter(t => AVAILABLE_TABLES.includes(t as BackupTable));
  }

  /**
   * Create a backup
   * @param options Backup options
   * @returns Backup result
   */
  async createBackup(options?: {
    tables?: string[];
    name?: string;
    description?: string;
  }): Promise<{
    success: boolean;
    message: string;
    filename?: string;
    size?: number;
    recordCount?: number;
  }> {
    try {
      const tables = options?.tables || this.getTablesToBackup();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = options?.name 
        ? `${options.name}.json${this.config.compression ? '.gz' : ''}`
        : `backup_${timestamp}.json${this.config.compression ? '.gz' : ''}`;
      
      const backupPath = path.join(this.config.location, filename);

      // Ensure backup directory exists
      await fs.mkdir(this.config.location, { recursive: true });

      // Collect data from tables
      const backupData: BackupData = {
        metadata: {
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          tables: [],
          recordCounts: {},
          compressed: this.config.compression,
        },
        data: {},
      };

      let totalRecords = 0;

      for (const table of tables) {
        try {
          const result = await this.pool.query(`SELECT * FROM ${table}`);
          backupData.data[table] = result.rows;
          backupData.metadata.tables.push(table);
          backupData.metadata.recordCounts[table] = result.rowCount || 0;
          totalRecords += result.rowCount || 0;
          
          logger.info(`Backed up ${result.rowCount} records from ${table}`);
        } catch (error) {
          logger.warn({ error, table }, `Failed to backup table ${table}`);
        }
      }

      // Write backup file
      const jsonData = JSON.stringify(backupData, null, 2);
      
      if (this.config.compression) {
        await this.compressAndWrite(jsonData, backupPath);
      } else {
        await fs.writeFile(backupPath, jsonData, 'utf-8');
      }

      const stats = await fs.stat(backupPath);

      // Clean up old backups
      await this.cleanupOldBackups();

      // Send to Telegram if enabled
      if (this.config.telegramEnabled && this.config.telegramChatId) {
        await this.sendToTelegram(backupPath, {
          tables: backupData.metadata.tables,
          recordCount: totalRecords,
          description: options?.description,
        });
      }

      logger.info({ 
        filename, 
        size: stats.size, 
        tables: backupData.metadata.tables.length,
        records: totalRecords 
      }, 'Backup created successfully');

      return {
        success: true,
        message: `Backup created: ${filename}`,
        filename,
        size: stats.size,
        recordCount: totalRecords,
      };

    } catch (error) {
      logger.error({ error }, 'Failed to create backup');
      return {
        success: false,
        message: `Backup failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Compress data and write to file
   */
  private async compressAndWrite(data: string, filePath: string): Promise<void> {
    const source = createReadStream(Buffer.from(data));
    const destination = createWriteStream(filePath);
    const gzip = createGzip();
    
    await pipeline(source, gzip, destination);
  }

  /**
   * Send backup to Telegram
   */
  private async sendToTelegram(
    filePath: string, 
    metadata: { tables: string[]; recordCount: number; description?: string }
  ): Promise<void> {
    try {
      const botToken = this.telegramConfig.botToken;
      if (!botToken) {
        logger.warn('Telegram bot token not configured, skipping backup upload');
        return;
      }

      const formData = new FormData();
      const fileContent = await fs.readFile(filePath);
      const blob = new Blob([fileContent]);
      
      formData.append('document', blob, path.basename(filePath));
      formData.append('chat_id', this.config.telegramChatId);
      
      const caption = `📦 <b>Backup Created</b>

🗓 <i>${new Date().toLocaleString()}</i>
📊 Tables: ${metadata.tables.length}
📝 Records: ${metadata.recordCount}
${metadata.description ? `\n💬 ${metadata.description}` : ''}`;
      
      formData.append('caption', caption);
      formData.append('parse_mode', 'HTML');

      if (this.config.telegramTopicId) {
        formData.append('message_thread_id', this.config.telegramTopicId);
      }

      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Telegram API error: ${error}`);
      }

      logger.info('Backup sent to Telegram successfully');
    } catch (error) {
      logger.error({ error }, 'Failed to send backup to Telegram');
    }
  }

  /**
   * Clean up old backups, keeping only the most recent ones
   */
  private async cleanupOldBackups(): Promise<void> {
    try {
      const files = await fs.readdir(this.config.location);
      const backupFiles = files.filter(f => f.startsWith('backup_') && f.endsWith('.json') || f.endsWith('.json.gz'));
      
      if (backupFiles.length <= this.config.maxKeep) {
        return;
      }

      // Sort by modification time
      const fileStats = await Promise.all(
        backupFiles.map(async (filename) => {
          const stat = await fs.stat(path.join(this.config.location, filename));
          return { filename, stat };
        })
      );

      fileStats.sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());

      // Delete old backups
      const filesToDelete = fileStats.slice(this.config.maxKeep);
      for (const { filename } of filesToDelete) {
        await fs.unlink(path.join(this.config.location, filename));
        logger.debug({ filename }, 'Deleted old backup');
      }

      logger.info({ deleted: filesToDelete.length }, 'Cleaned up old backups');
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup old backups');
    }
  }

  /**
   * Get list of available backups
   */
  async listBackups(): Promise<BackupFile[]> {
    try {
      await fs.mkdir(this.config.location, { recursive: true });
      const files = await fs.readdir(this.config.location);
      const backupFiles = files.filter(f => f.startsWith('backup_'));

      const backups: BackupFile[] = [];

      for (const filename of backupFiles) {
        try {
          const filePath = path.join(this.config.location, filename);
          const stat = await fs.stat(filePath);
          
          // Try to read metadata from the file
          let tables: string[] = [];
          let recordCount = 0;
          let compressed = filename.endsWith('.gz');

          try {
            const content = await fs.readFile(filePath);
            const jsonContent = compressed 
              ? content.toString() // Would need to decompress
              : content.toString();
            const data: BackupData = JSON.parse(jsonContent);
            tables = data.metadata.tables || [];
            recordCount = Object.values(data.metadata.recordCounts || {}).reduce((a, b) => a + b, 0);
            compressed = data.metadata.compressed || compressed;
          } catch {
            // If we can't parse, use defaults
          }

          backups.push({
            filename,
            size: stat.size,
            createdAt: stat.mtime,
            tables,
            recordCount,
            compressed,
          });
        } catch (error) {
          logger.warn({ error, filename }, 'Failed to read backup file');
        }
      }

      backups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return backups;

    } catch (error) {
      logger.error({ error }, 'Failed to list backups');
      return [];
    }
  }

  /**
   * Restore from backup
   * @param filename Backup filename
   * @param options Restore options
   */
  async restoreBackup(
    filename: string, 
    options: {
      mode: 'merge' | 'clear';
      tables?: string[];
    }
  ): Promise<{
    success: boolean;
    message: string;
    restoredTables?: string[];
    restoredCount?: number;
  }> {
    try {
      const filePath = path.join(this.config.location, filename);
      
      // Check if file exists
      await fs.access(filePath);

      // Read and parse backup
      const content = await fs.readFile(filePath);
      let jsonContent: string;

      if (filename.endsWith('.gz')) {
        // Would need to decompress
        jsonContent = content.toString();
      } else {
        jsonContent = content.toString();
      }

      const backupData: BackupData = JSON.parse(jsonContent);
      const tablesToRestore = options.tables || backupData.metadata.tables;
      
      const restoredTables: string[] = [];
      let totalRestored = 0;

      for (const table of tablesToRestore) {
        if (!backupData.data[table]) {
          logger.warn(`Table ${table} not found in backup`);
          continue;
        }

        const records = backupData.data[table];
        
        // Clear table if mode is 'clear'
        if (options.mode === 'clear') {
          await this.pool.query(`TRUNCATE TABLE ${table} CASCADE`);
        }

        // Insert records
        for (const record of records) {
          const recordObj = record as Record<string, unknown>;
          const columns = Object.keys(recordObj);
          const values = Object.values(recordObj);
          const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

          try {
            await this.pool.query(
              `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
              values
            );
          } catch (error) {
            logger.warn({ error, table, record }, `Failed to restore record in ${table}`);
          }
        }

        restoredTables.push(table);
        totalRestored += records.length;
        logger.info(`Restored ${records.length} records to ${table}`);
      }

      return {
        success: true,
        message: `Restored ${totalRestored} records to ${restoredTables.length} tables`,
        restoredTables,
        restoredCount: totalRestored,
      };

    } catch (error) {
      logger.error({ error }, 'Failed to restore backup');
      return {
        success: false,
        message: `Restore failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Delete a backup file
   */
  async deleteBackup(filename: string): Promise<boolean> {
    try {
      const filePath = path.join(this.config.location, filename);
      await fs.unlink(filePath);
      logger.info({ filename }, 'Backup deleted');
      return true;
    } catch (error) {
      logger.error({ error, filename }, 'Failed to delete backup');
      return false;
    }
  }

  /**
   * Get backup statistics
   */
  async getStats(): Promise<{
    totalBackups: number;
    totalSize: number;
    oldestBackup: Date | null;
    latestBackup: Date | null;
  }> {
    try {
      const backups = await this.listBackups();
      
      if (backups.length === 0) {
        return {
          totalBackups: 0,
          totalSize: 0,
          oldestBackup: null,
          latestBackup: null,
        };
      }

      const totalSize = backups.reduce((sum, b) => sum + b.size, 0);
      
      return {
        totalBackups: backups.length,
        totalSize,
        oldestBackup: backups[backups.length - 1].createdAt,
        latestBackup: backups[0].createdAt,
      };

    } catch (error) {
      logger.error({ error }, 'Failed to get backup stats');
      return {
        totalBackups: 0,
        totalSize: 0,
        oldestBackup: null,
        latestBackup: null,
      };
    }
  }
}

/**
 * Factory function to create BackupService instance
 */
export function createBackupService(pool: Pool): BackupService {
  return new BackupService(pool);
}
