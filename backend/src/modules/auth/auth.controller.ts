import type { FastifyRequest, FastifyReply } from 'fastify';
import { createAuthService, InvalidTelegramDataError, AuthenticationError } from './auth.service.js';
import { UserRepository } from '../../repositories/index.js';
import { logger } from '../../utils/logger.js';
import { isSuperAdmin } from '../../config/env.js';
import type { LoginInput, RegisterInput, TelegramAuthInput, SetupSuperAdminInput } from './auth.schemas.js';

/**
 * Handle login request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleLogin(
  request: FastifyRequest<{ Body: LoginInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const authService = createAuthService(request.server.pg);
    const result = await authService.loginUser(request.body);
    reply.send(result);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      reply.status(401).send({ error: error.message });
      return;
    }
    logger.error({ error }, 'Login failed');
    reply.status(500).send({ error: 'Login failed' });
  }
}

/**
 * Handle register request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleRegister(
  request: FastifyRequest<{ Body: RegisterInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const authService = createAuthService(request.server.pg);
    const result = await authService.registerUser(request.body);
    reply.status(201).send(result);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      reply.status(409).send({ error: error.message });
      return;
    }
    logger.error({ error }, 'Registration failed');
    reply.status(500).send({ error: 'Registration failed' });
  }
}

/**
 * Handle get current user request
 * @param request - Fastify request with user info from JWT
 * @param reply - Fastify reply
 */
export async function handleGetMe(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const userId = request.user?.userId;

    if (!userId) {
      reply.status(401).send({ error: 'Unauthorized' });
      return;
    }

    const authService = createAuthService(request.server.pg);
    const user = await authService.getCurrentUser(userId);

    if (!user) {
      reply.status(404).send({ error: 'User not found' });
      return;
    }

    reply.send({ user });
  } catch (error) {
    logger.error({ error }, 'Get current user failed');
    reply.status(500).send({ error: 'Failed to get user' });
  }
}

/**
 * Handle logout request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleLogout(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  reply.send({ message: 'Logged out successfully' });
}

/**
 * Handle Telegram WebApp authentication request
 * @param request - Fastify request with Telegram initData
 * @param reply - Fastify reply
 */
export async function handleTelegramAuth(
  request: FastifyRequest<{ Body: TelegramAuthInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const authService = createAuthService(request.server.pg);
    const result = await authService.verifyTelegramAuth({ initData: request.body.initData });

    reply.send({
      success: true,
      token: result.token,
      user: result.user,
    });
  } catch (error) {
    if (error instanceof InvalidTelegramDataError) {
      reply.status(401).send({ error: error.message });
      return;
    }
    logger.error({ error }, 'Telegram authentication failed');
    reply.status(500).send({ error: 'Authentication failed' });
  }
}

/**
 * Handle setup super admin request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleSetupSuperAdmin(
  request: FastifyRequest<{ Body: SetupSuperAdminInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const userRepository = new UserRepository(request.server.pg);

    // Check if setup is already completed
    const existingAdmin = await userRepository.findFirstAdmin();
    if (existingAdmin) {
      reply.status(403).send({ error: 'Setup already completed' });
      return;
    }

    // Validate Telegram ID
    if (!isSuperAdmin(request.body.telegramId)) {
      reply.status(403).send({ error: 'Invalid Telegram ID' });
      return;
    }

    // Create super admin
    const authService = createAuthService(request.server.pg);
    await authService.createSuperAdmin(request.body);

    reply.status(201).send({ message: 'Super admin created' });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      reply.status(409).send({ error: error.message });
      return;
    }
    logger.error({ error }, 'Super admin setup failed');
    reply.status(500).send({ error: 'Failed to create super admin' });
  }
}

/**
 * Handle get setup status request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetSetupStatus(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const userRepository = new UserRepository(request.server.pg);
    const admin = await userRepository.findFirstAdmin();
    reply.send({ needsSetup: !admin });
  } catch (error) {
    logger.error({ error }, 'Failed to get setup status');
    reply.status(500).send({ error: 'Failed to get setup status' });
  }
}
