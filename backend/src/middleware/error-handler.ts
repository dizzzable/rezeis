import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../utils/logger.js';

/**
 * Custom error response
 */
interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  code?: string;
}

/**
 * Global error handler
 * @param error Fastify error
 * @param request Fastify request
 * @param reply Fastify reply
 */
export function errorHandler(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply
): void {
  logger.error({
    error: error.message,
    stack: error.stack,
    code: error.code,
    statusCode: error.statusCode,
  }, 'Request error');

  const statusCode = error.statusCode ?? 500;

  const response: ErrorResponse = {
    statusCode,
    error: error.name ?? 'Error',
    message: statusCode >= 500 ? 'Internal server error' : error.message,
    code: error.code,
  };

  reply.status(statusCode).send(response);
}

/**
 * Not found handler
 * @param request Fastify request
 * @param reply Fastify reply
 */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  reply.status(404).send({
    statusCode: 404,
    error: 'Not Found',
    message: `Route ${request.method} ${request.url} not found`,
  });
}
