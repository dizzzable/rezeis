import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { partnerService } from '../modules/partner/partner.service.js';
import { logger } from '../utils/logger.js';

/**
 * Partner middleware
 * Checks if the authenticated user is a partner
 * @param request Fastify request
 * @param reply Fastify reply
 */
export async function requirePartner(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const userId = request.user?.userId;

    if (!userId) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    const isPartner = await partnerService.isPartner(userId);

    if (!isPartner) {
      reply.status(403).send({
        error: 'Forbidden',
        message: 'Partner access required. Please contact support for partnership opportunities.',
        code: 'PARTNER_ACCESS_REQUIRED',
      });
      return;
    }
  } catch (error) {
    logger.error({ error }, 'Partner middleware check failed');
    reply.status(500).send({
      error: 'Internal Server Error',
      message: 'Failed to verify partner status',
    });
  }
}

/**
 * Optional partner middleware
 * Attaches partner status to request without blocking
 * @param request Fastify request
 * @param reply Fastify reply
 */
export async function checkPartner(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  void reply;
  try {
    const userId = request.user?.userId;

    if (!userId) {
      return;
    }

    const isPartner = await partnerService.isPartner(userId);

    // Extend request with partner status
    (request as unknown as { isPartner: boolean }).isPartner = isPartner;
  } catch (error) {
    logger.error({ error }, 'Partner check failed');
  }
}

/**
 * Combined middleware that requires both auth and partner status
 * @param request Fastify request
 * @param reply Fastify reply
 */
export async function requirePartnerAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // First check authentication
  if (!request.user?.userId) {
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
    return;
  }

  // Then check partner status
  await requirePartner(request, reply);
}

/**
 * Register partner middleware decorator on Fastify instance
 * @param fastify Fastify instance
 */
export function registerPartnerMiddleware(fastify: FastifyInstance): void {
  fastify.decorate('requirePartner', requirePartner);
  fastify.decorate('checkPartner', checkPartner);
}

// Type declaration for Fastify instance augmentation
declare module 'fastify' {
  interface FastifyInstance {
    requirePartner: typeof requirePartner;
    checkPartner: typeof checkPartner;
  }
}
