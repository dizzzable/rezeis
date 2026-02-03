import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  createBackupService,
  BackupNotFoundError,
  BackupInProgressError,
  PermissionDeniedError,
  RestoreNotAllowedError,
} from './backup.service.js';
import { logger } from '../../utils/logger.js';
import type {
  CreateBackupInput,
  UpdateBackupConfigInput,
  GetBackupsQuery,
  BackupParams,
} from './backup.schemas.js';

/**
 * Handle get backup config request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetConfig(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const backupService = createBackupService(request.server.pg);
    const config = await backupService.getConfig();

    reply.send({
      success: true,
      data: config,
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to get backup config');
    reply.status(500).send({
      success: false,
      error: 'Failed to get backup configuration',
    });
  }
}

/**
 * Handle update backup config request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleUpdateConfig(
  request: FastifyRequest<{ Body: UpdateBackupConfigInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const backupService = createBackupService(request.server.pg);
    const userRole = request.user?.role || '';
    const config = await backupService.updateConfig(request.body, userRole);

    reply.send({
      success: true,
      data: config,
      message: 'Backup configuration updated successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to update backup config');
    reply.status(500).send({
      success: false,
      error: 'Failed to update backup configuration',
    });
  }
}

/**
 * Handle get backups request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetBackups(
  request: FastifyRequest<{ Querystring: GetBackupsQuery }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const backupService = createBackupService(request.server.pg);
    const userRole = request.user?.role || '';
    const result = await backupService.getBackups(request.query, userRole);

    reply.send({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to get backups');
    reply.status(500).send({
      success: false,
      error: 'Failed to get backups',
    });
  }
}

/**
 * Handle create backup request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleCreateBackup(
  request: FastifyRequest<{ Body: CreateBackupInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const backupService = createBackupService(request.server.pg);
    const userRole = request.user?.role || '';
    const backup = await backupService.createBackup(request.body, userRole);

    reply.status(201).send({
      success: true,
      data: backup,
      message: 'Backup created successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof BackupInProgressError) {
      reply.status(409).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to create backup');
    reply.status(500).send({
      success: false,
      error: 'Failed to create backup',
    });
  }
}

/**
 * Handle restore backup request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleRestoreBackup(
  request: FastifyRequest<{ Params: BackupParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const backupService = createBackupService(request.server.pg);
    const userRole = request.user?.role || '';
    await backupService.restoreBackup(request.params.id, userRole);

    reply.send({
      success: true,
      message: 'Backup restored successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof BackupNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof RestoreNotAllowedError) {
      reply.status(400).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, backupId: request.params.id }, 'Failed to restore backup');
    reply.status(500).send({
      success: false,
      error: 'Failed to restore backup',
    });
  }
}

/**
 * Handle delete backup request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleDeleteBackup(
  request: FastifyRequest<{ Params: BackupParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const backupService = createBackupService(request.server.pg);
    const userRole = request.user?.role || '';
    await backupService.deleteBackup(request.params.id, userRole);

    reply.send({
      success: true,
      message: 'Backup deleted successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof BackupNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, backupId: request.params.id }, 'Failed to delete backup');
    reply.status(500).send({
      success: false,
      error: 'Failed to delete backup',
    });
  }
}
