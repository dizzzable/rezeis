import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

/**
 * User payload from JWT token
 */
export interface UserPayload {
  userId: string;
  username: string;
  role: string;
  telegramId?: string;
}

/**
 * Extended request with super admin flag
 */
export interface RequestWithSuperAdmin extends FastifyRequest {
  isSuperAdmin?: boolean;
}

/**
 * Extend FastifyRequest to include user property
 */
declare module 'fastify' {
  interface FastifyRequest {
    user?: UserPayload;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    pg: Pool;
  }
}
