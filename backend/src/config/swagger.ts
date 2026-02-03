import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { OpenAPIV3 } from 'openapi-types';

/**
 * Swagger configuration options
 */
const swaggerOptions = {
  openapi: {
    info: {
      title: 'Altshop Panel API',
      description: 'API documentation for Altshop Panel - VPN subscription management system',
      version: '1.0.0',
      contact: {
        name: 'Altshop Support',
      },
    },
    servers: [
      {
        url: 'http://localhost:3001',
        description: 'Development server',
      },
    ],
    tags: [
      { name: 'health', description: 'Health check endpoints' },
      { name: 'auth', description: 'Authentication endpoints' },
      { name: 'users', description: 'User management' },
      { name: 'subscriptions', description: 'Subscription management' },
      { name: 'plans', description: 'Plan management' },
      { name: 'statistics', description: 'Statistics and analytics' },
      { name: 'access', description: 'Access control' },
      { name: 'backup', description: 'Backup operations' },
      { name: 'broadcasts', description: 'Broadcast messages' },
      { name: 'promocodes', description: 'Promocode management' },
      { name: 'gateways', description: 'Payment gateways' },
      { name: 'banners', description: 'Banner management' },
      { name: 'partners', description: 'Partner program' },
      { name: 'referrals', description: 'Referral system' },
      { name: 'notifications', description: 'Notification management' },
      { name: 'client', description: 'Client-facing endpoints' },
      { name: 'admin', description: 'Admin-only endpoints' },
      { name: 'websocket', description: 'WebSocket endpoints' },
      { name: 'payments', description: 'Payment processing' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http' as const,
          scheme: 'bearer' as const,
          bearerFormat: 'JWT',
          description: 'JWT token for authentication',
        } satisfies OpenAPIV3.SecuritySchemeObject,
      },
    },
  },
};

/**
 * Swagger UI configuration options
 */
const swaggerUiOptions = {
  routePrefix: '/documentation',
  uiConfig: {
    docExpansion: 'list' as const,
    deepLinking: true,
    displayRequestDuration: true,
    filter: true,
    persistAuthorization: true,
  },
  staticCSP: true,
  transformStaticCSP: (header: string): string => header,
};

/**
 * Register swagger documentation plugins
 * @param fastify - Fastify instance
 */
export async function registerSwagger(fastify: FastifyInstance): Promise<void> {
  await fastify.register(swagger, swaggerOptions);
  await fastify.register(swaggerUi, swaggerUiOptions);
}
