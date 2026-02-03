import type { FastifyRequest, FastifyReply } from 'fastify';
import { createUserService, UserNotFoundError, UserAlreadyExistsError } from './user.service.js';
import { logger } from '../../utils/logger.js';
import type {
  CreateUserInput,
  UpdateUserInput,
  GetUsersQuery,
  BlockUserParams,
  UnblockUserParams,
  GetUserSubscriptionsParams,
  GetUserDetailsParams,
} from './user.schemas.js';

/**
 * Handle get users request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetUsers(
  request: FastifyRequest<{ Querystring: GetUsersQuery }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const userService = createUserService(request.server.pg);
    const result = await userService.getUsers(request.query);

    reply.send({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get users');
    reply.status(500).send({
      success: false,
      error: 'Failed to get users',
    });
  }
}

/**
 * Handle get user by ID request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetUserById(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const userService = createUserService(request.server.pg);
    const user = await userService.getUserById(request.params.id);

    if (!user) {
      reply.status(404).send({
        success: false,
        error: 'User not found',
      });
      return;
    }

    reply.send({
      success: true,
      data: user,
    });
  } catch (error) {
    logger.error({ error, userId: request.params.id }, 'Failed to get user');
    reply.status(500).send({
      success: false,
      error: 'Failed to get user',
    });
  }
}

/**
 * Handle create user request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleCreateUser(
  request: FastifyRequest<{ Body: CreateUserInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const userService = createUserService(request.server.pg);
    const user = await userService.createUser(request.body);

    reply.status(201).send({
      success: true,
      data: user,
      message: 'User created successfully',
    });
  } catch (error) {
    if (error instanceof UserAlreadyExistsError) {
      reply.status(409).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to create user');
    reply.status(500).send({
      success: false,
      error: 'Failed to create user',
    });
  }
}

/**
 * Handle update user request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleUpdateUser(
  request: FastifyRequest<{ Params: { id: string }; Body: UpdateUserInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const userService = createUserService(request.server.pg);
    const user = await userService.updateUser(request.params.id, request.body);

    reply.send({
      success: true,
      data: user,
      message: 'User updated successfully',
    });
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof UserAlreadyExistsError) {
      reply.status(409).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, userId: request.params.id }, 'Failed to update user');
    reply.status(500).send({
      success: false,
      error: 'Failed to update user',
    });
  }
}

/**
 * Handle delete user request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleDeleteUser(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const userService = createUserService(request.server.pg);
    const deleted = await userService.deleteUser(request.params.id);

    if (!deleted) {
      reply.status(404).send({
        success: false,
        error: 'User not found',
      });
      return;
    }

    reply.send({
      success: true,
      message: 'User deleted successfully',
    });
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, userId: request.params.id }, 'Failed to delete user');
    reply.status(500).send({
      success: false,
      error: 'Failed to delete user',
    });
  }
}

/**
 * Handle block user request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleBlockUser(
  request: FastifyRequest<{ Params: BlockUserParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const userService = createUserService(request.server.pg);
    const user = await userService.blockUser(request.params.id);

    reply.send({
      success: true,
      data: user,
      message: 'User blocked successfully',
    });
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, userId: request.params.id }, 'Failed to block user');
    reply.status(500).send({
      success: false,
      error: 'Failed to block user',
    });
  }
}

/**
 * Handle unblock user request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleUnblockUser(
  request: FastifyRequest<{ Params: UnblockUserParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const userService = createUserService(request.server.pg);
    const user = await userService.unblockUser(request.params.id);

    reply.send({
      success: true,
      data: user,
      message: 'User unblocked successfully',
    });
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, userId: request.params.id }, 'Failed to unblock user');
    reply.status(500).send({
      success: false,
      error: 'Failed to unblock user',
    });
  }
}

/**
 * Handle get user subscriptions request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetUserSubscriptions(
  request: FastifyRequest<{ Params: GetUserSubscriptionsParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const userService = createUserService(request.server.pg);
    const subscriptions = await userService.getUserSubscriptions(request.params.id);

    reply.send({
      success: true,
      data: subscriptions.map((sub) => ({
        id: sub.id,
        userId: sub.userId,
        planId: sub.planId,
        status: sub.status,
        startDate: sub.startDate.toISOString(),
        endDate: sub.endDate.toISOString(),
        remnawaveUuid: sub.remnawaveUuid,
        createdAt: sub.createdAt.toISOString(),
        updatedAt: sub.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, userId: request.params.id }, 'Failed to get user subscriptions');
    reply.status(500).send({
      success: false,
      error: 'Failed to get user subscriptions',
    });
  }
}

/**
 * Handle get user details request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetUserDetails(
  request: FastifyRequest<{ Params: GetUserDetailsParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const userService = createUserService(request.server.pg);
    const details = await userService.getUserDetails(request.params.id);

    reply.send({
      success: true,
      data: details,
    });
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, userId: request.params.id }, 'Failed to get user details');
    reply.status(500).send({
      success: false,
      error: 'Failed to get user details',
    });
  }
}
