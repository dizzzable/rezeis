import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { verifyToken } from '../modules/auth/auth.service.js';
import { logger } from '../utils/logger.js';

/**
 * Authenticate middleware
 * Verifies JWT token from Authorization header
 * @param request Fastify request
 * @param reply Fastify reply
 */
export async function authenticateMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.status(401).send({ error: 'Missing or invalid authorization header' });
      return;
    }

    const token = authHeader.substring(7);

    if (!token) {
      reply.status(401).send({ error: 'Missing token' });
      return;
    }

    const payload = verifyToken(token);

    request.user = {
      userId: payload.userId,
      username: payload.username,
      role: payload.role,
    };
  } catch (error) {
    logger.error({ error }, 'Authentication failed');
    reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

/**
 * Register authentication decorator on Fastify instance
 * @param fastify Fastify instance
 */
export function registerAuthMiddleware(fastify: FastifyInstance): void {
  fastify.decorate('authenticate', authenticateMiddleware);
}

/**
 * Authenticate middleware (alias for compatibility)
 */
export const authenticate = authenticateMiddleware;

/**
 * Require auth middleware (alias for compatibility)
 */
export const requireAuth = authenticateMiddleware;
