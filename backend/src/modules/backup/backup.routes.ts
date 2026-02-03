import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { BackupService, AVAILABLE_TABLES } from '../../services/backup.service.js';
import { requireSuperAdmin } from '../../middleware/super-admin.middleware.js';
import { logger } from '../../utils/logger.js';

/**
 * Create backup routes
 */
export async function backupRoutes(app: FastifyInstance) {
  const backupService = new BackupService(app.pg);

  /**
   * GET /api/backups - List all backups
   */
  app.get('/backups', { preHandler: [app.authenticate, requireSuperAdmin] }, async (
    _request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const backups = await backupService.listBackups();
      const stats = await backupService.getStats();
      
      return reply.send({
        success: true,
        data: {
          backups,
          stats,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to list backups');
      return reply.status(500).send({
        success: false,
        error: 'Failed to list backups',
      });
    }
  });

  /**
   * POST /api/backups - Create new backup
   */
  app.post('/backups', { preHandler: [app.authenticate, requireSuperAdmin] }, async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const body = request.body as {
        tables?: string[];
        name?: string;
        description?: string;
      };
      
      const result = await backupService.createBackup({
        tables: body?.tables,
        name: body?.name,
        description: body?.description,
      });

      if (result.success) {
        return reply.status(201).send(result);
      } else {
        return reply.status(400).send(result);
      }
    } catch (error) {
      logger.error({ error }, 'Failed to create backup');
      return reply.status(500).send({
        success: false,
        error: 'Failed to create backup',
      });
    }
  });

  /**
   * POST /api/backups/:filename/restore - Restore from backup
   */
  app.post('/backups/:filename/restore', { preHandler: [app.authenticate, requireSuperAdmin] }, async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const params = request.params as { filename: string };
      const body = request.body as {
        mode: 'merge' | 'clear';
        tables?: string[];
      };

      const result = await backupService.restoreBackup(params.filename, {
        mode: body?.mode || 'merge',
        tables: body?.tables,
      });

      if (result.success) {
        return reply.send(result);
      } else {
        return reply.status(400).send(result);
      }
    } catch (error) {
      logger.error({ error }, 'Failed to restore backup');
      return reply.status(500).send({
        success: false,
        error: 'Failed to restore backup',
      });
    }
  });

  /**
   * DELETE /api/backups/:filename - Delete backup
   */
  app.delete('/backups/:filename', { preHandler: [app.authenticate, requireSuperAdmin] }, async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const params = request.params as { filename: string };
      const success = await backupService.deleteBackup(params.filename);

      if (success) {
        return reply.send({ success: true, message: 'Backup deleted' });
      } else {
        return reply.status(404).send({
          success: false,
          error: 'Backup not found or could not be deleted',
        });
      }
    } catch (error) {
      logger.error({ error }, 'Failed to delete backup');
      return reply.status(500).send({
        success: false,
        error: 'Failed to delete backup',
      });
    }
  });

  /**
   * GET /api/backups/tables - List available tables for backup
   */
  app.get('/backups/tables', { preHandler: [app.authenticate, requireSuperAdmin] }, async (
    _request: FastifyRequest,
    reply: FastifyReply
  ) => {
    return reply.send({
      success: true,
      data: AVAILABLE_TABLES,
    });
  });

  /**
   * GET /api/backups/config - Get backup configuration
   */
  app.get('/backups/config', { preHandler: [app.authenticate, requireSuperAdmin] }, async (
    _request: FastifyRequest,
    reply: FastifyReply
  ) => {
    const { getBackupConfig } = await import('../../config/env.js');
    const config = getBackupConfig();
    
    return reply.send({
      success: true,
      data: {
        enabled: config.enabled,
        intervalHours: config.intervalHours,
        time: config.time,
        maxKeep: config.maxKeep,
        location: config.location,
        compression: config.compression,
        includeTables: config.includeTables,
        telegramEnabled: config.telegramEnabled,
        telegramChatId: config.telegramChatId ? '***' : null,
        s3Enabled: config.s3Enabled,
        s3Bucket: config.s3Bucket,
      },
    });
  });

  /**
   * GET /api/backups/stats - Get backup statistics
   */
  app.get('/backups/stats', { preHandler: [app.authenticate, requireSuperAdmin] }, async (
    _request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const stats = await backupService.getStats();
      return reply.send({
        success: true,
        data: stats,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get backup stats');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get backup stats',
      });
    }
  });
}
