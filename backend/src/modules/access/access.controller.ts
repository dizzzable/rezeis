import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  createAccessService,
  AdminNotFoundError,
  AdminAlreadyExistsError,
  CannotDeleteSuperAdminError,
  PermissionDeniedError,
} from './access.service.js';
import { logger } from '../../utils/logger.js';
import type {
  CreateAdminInput,
  UpdateAdminRoleInput,
  GetAdminsQuery,
  AdminParams,
} from './access.schemas.js';

/**
 * Handle get admins request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetAdmins(
  request: FastifyRequest<{ Querystring: GetAdminsQuery }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const accessService = createAccessService(request.server.pg);
    const userRole = request.user?.role || '';
    const result = await accessService.getAdmins(request.query, userRole);

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

    logger.error({ error }, 'Failed to get admins');
    reply.status(500).send({
      success: false,
      error: 'Failed to get admins',
    });
  }
}

/**
 * Handle get admin by ID request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetAdminById(
  request: FastifyRequest<{ Params: AdminParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const accessService = createAccessService(request.server.pg);
    const userRole = request.user?.role || '';
    const admin = await accessService.getAdminById(request.params.id, userRole);

    if (!admin) {
      reply.status(404).send({
        success: false,
        error: 'Admin not found',
      });
      return;
    }

    reply.send({
      success: true,
      data: admin,
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, adminId: request.params.id }, 'Failed to get admin');
    reply.status(500).send({
      success: false,
      error: 'Failed to get admin',
    });
  }
}

/**
 * Handle create admin request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleCreateAdmin(
  request: FastifyRequest<{ Body: CreateAdminInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const accessService = createAccessService(request.server.pg);
    const userRole = request.user?.role || '';
    const admin = await accessService.createAdmin(request.body, userRole);

    reply.status(201).send({
      success: true,
      data: admin,
      message: 'Admin created successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof AdminAlreadyExistsError) {
      reply.status(409).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to create admin');
    reply.status(500).send({
      success: false,
      error: 'Failed to create admin',
    });
  }
}

/**
 * Handle update admin role request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleUpdateAdminRole(
  request: FastifyRequest<{ Params: AdminParams; Body: UpdateAdminRoleInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const accessService = createAccessService(request.server.pg);
    const userRole = request.user?.role || '';
    const admin = await accessService.updateAdminRole(request.params.id, request.body, userRole);

    reply.send({
      success: true,
      data: admin,
      message: 'Admin role updated successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof AdminNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof CannotDeleteSuperAdminError) {
      reply.status(409).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, adminId: request.params.id }, 'Failed to update admin role');
    reply.status(500).send({
      success: false,
      error: 'Failed to update admin role',
    });
  }
}

/**
 * Handle delete admin request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleDeleteAdmin(
  request: FastifyRequest<{ Params: AdminParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const accessService = createAccessService(request.server.pg);
    const userRole = request.user?.role || '';
    const deleted = await accessService.deleteAdmin(request.params.id, userRole);

    if (!deleted) {
      reply.status(404).send({
        success: false,
        error: 'Admin not found',
      });
      return;
    }

    reply.send({
      success: true,
      message: 'Admin deleted successfully',
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      reply.status(403).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof AdminNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof CannotDeleteSuperAdminError) {
      reply.status(409).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, adminId: request.params.id }, 'Failed to delete admin');
    reply.status(500).send({
      success: false,
      error: 'Failed to delete admin',
    });
  }
}
