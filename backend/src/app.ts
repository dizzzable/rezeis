import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import websocket from '@fastify/websocket';
import { getEnv, getDatabaseConfig, getRedisConfig, getRemnawaveConfig } from './config/env.js';
import { initializePool, getPool } from './config/database.js';
import { initializeValkey } from './config/redis.js';
import { registerSwagger } from './config/swagger.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { registerAuthMiddleware } from './middleware/auth.middleware.js';
import { getPerformanceMonitor } from './monitoring/performance.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { userRoutes } from './modules/users/user.routes.js';
import { subscriptionRoutes } from './modules/subscriptions/subscription.routes.js';
import { planRoutes } from './modules/plans/plan.routes.js';
import { statisticsRoutes } from './modules/statistics/statistics.routes.js';
import { accessRoutes } from './modules/access/access.routes.js';
import { backupRoutes } from './modules/backup/backup.routes.js';
import { broadcastRoutes } from './modules/broadcast/broadcast.routes.js';
import { promocodeRoutes } from './modules/promocodes/promocode.routes.js';
import { gatewayRoutes } from './modules/gateways/gateway.routes.js';
import { bannerRoutes } from './modules/banners/banner.routes.js';
import { partnerRoutes } from './modules/partners/partner.routes.js';
import { referralRoutes } from './modules/referrals/referral.routes.js';
import { remnawaveRoutes } from './modules/remnawave/remnawave.routes.js';
import { remnawaveWebhookRoutes } from './modules/remnawave/remnawave-webhook.routes.js';
import { remnawaveSyncRoutes } from './modules/remnawave/remnawave-sync.routes.js';
import { multisubscriptionRoutes } from './modules/multisubscriptions/multisubscription.routes.js';
import { notificationRoutes } from './modules/notifications/notification.routes.js';
import { websocketRoutes } from './modules/websocket/websocket.routes.js';
import { monitoringRoutes } from './modules/monitoring/monitoring.routes.js';
import { clientRoutes } from './modules/client/index.js';
import { webhookRoutes } from './modules/payments/index.js';
import { adminPaymentGatewayRoutes } from './modules/admin/payment-gateways/index.js';
import { adminPartnerRoutes } from './modules/admin/partner/index.js';
import { adminPromocodesRoutes } from './modules/admin/promocodes/index.js';
import { adminTrialRoutes } from './modules/admin/trial/index.js';
import { pubSubService } from './websocket/pubsub.service.js';
import { wsServer, startWebSocketServer } from './websocket/websocket.server.js';
import { RemnawaveService } from './services/remnawave.service.js';

/**
 * Create and configure Fastify application
 * @returns Configured Fastify instance
 */
export async function createApp() {
  const env = getEnv();
  void getDatabaseConfig();
  void getRedisConfig();
  void getRemnawaveConfig();

  /**
   * Initialize Fastify instance
   */
  const app = Fastify({
    logger: env.NODE_ENV === 'development',
    trustProxy: true,
  });

  /**
   * Register error handlers
   */
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  /**
   * Register CORS plugin with configured origins
   */
  const corsOrigins = env.CORS_ORIGINS 
    ? env.CORS_ORIGINS.split(',').map(o => o.trim())
    : env.NODE_ENV === 'development';

  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });

  /**
   * Register swagger documentation
   */
  await registerSwagger(app);

  /**
   * Register compression plugin
   */
  await app.register(compress, {
    threshold: 1024, // Compress responses > 1KB
    encodings: ['br', 'gzip', 'deflate'], // Brotli preferred
    brotliOptions: {
      params: {
        4: 4, // BROTLI_PARAM_QUALITY
      },
    },
  });

  /**
   * Register performance monitoring
   */
  const monitor = getPerformanceMonitor();
  app.addHook('onResponse', async (request, reply) => {
    monitor.recordRequest(reply.elapsedTime, request.url, reply.statusCode);
  });

  /**
   * Register rate limit plugin
   */
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${context.after}`,
      retryAfter: context.after,
    }),
  });

  /**
   * Register WebSocket plugin
   */
  if (env.FEATURE_WEBSOCKET_ENABLED) {
    await app.register(websocket);
  }

  /**
   * Register authentication decorator
   */
  registerAuthMiddleware(app);

  /**
   * Initialize database connections
   */
  initializePool();
  await initializeValkey();

  /**
   * Initialize Pub/Sub service for WebSocket scaling
   */
  if (env.FEATURE_WEBSOCKET_ENABLED) {
    await pubSubService.initialize();

    /**
     * Setup event relay from Valkey Pub/Sub to WebSocket
     */
    pubSubService.setupEventRelay(async (event) => {
      await wsServer.emitEvent(event);
    });
  }

  /**
   * Decorate fastify instance with database pool
   */
  app.decorate('pg', getPool());

  /**
   * Register routes
   */
  await app.register(healthRoutes, { prefix: '/health' });
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(subscriptionRoutes, { prefix: '/api/subscriptions' });
  await app.register(planRoutes, { prefix: '/api/plans' });
  await app.register(statisticsRoutes, { prefix: '/api/statistics' });
  await app.register(accessRoutes, { prefix: '/api/access' });
  await app.register(backupRoutes, { prefix: '/api/backup' });
  await app.register(broadcastRoutes, { prefix: '/api/broadcasts' });
  await app.register(promocodeRoutes, { prefix: '/api/promocodes' });
  await app.register(gatewayRoutes, { prefix: '/api/gateways' });
  await app.register(bannerRoutes, { prefix: '/api/banners' });
  await app.register(partnerRoutes, { prefix: '/api/partners' });
  await app.register(referralRoutes, { prefix: '/api/referrals' });
  await app.register(multisubscriptionRoutes, { prefix: '/api/multisubscriptions' });
  await app.register(notificationRoutes, { prefix: '/api/notifications' });
  await app.register(monitoringRoutes, { prefix: '/api/monitoring' });
  // Register Remnawave routes
  await app.register(remnawaveRoutes, { prefix: '/api' });
  await app.register(remnawaveWebhookRoutes, { prefix: '/api' });
  await app.register(remnawaveSyncRoutes, { prefix: '/api' });
  await app.register(clientRoutes, { prefix: '/api/client' });
  await app.register(adminPaymentGatewayRoutes, { prefix: '/api/admin/payment-gateways' });
  await app.register(adminPartnerRoutes, { prefix: '/api/admin/partners' });
  // Register admin routes
  await app.register(adminPromocodesRoutes, { prefix: '/api/admin/promocodes' });
  await app.register(adminTrialRoutes, { prefix: '/api/admin/trial' });
  
  if (env.FEATURE_WEBSOCKET_ENABLED) {
    await app.register(websocketRoutes, { prefix: '/ws' });
  }
  
  await app.register(webhookRoutes, { prefix: '/webhook/payments' });

  /**
   * Root route
   */
  app.get('/', async (_request, reply) => {
    reply.send({
      name: 'Rezeis Panel API',
      version: '1.0.0',
      status: 'running',
      environment: env.NODE_ENV,
      features: {
        websocket: env.FEATURE_WEBSOCKET_ENABLED,
        payments: env.FEATURE_PAYMENTS_ENABLED,
        referral: env.FEATURE_REFERRAL_ENABLED,
        partner: env.FEATURE_PARTNER_ENABLED,
      },
      documentation: '/documentation',
    });
  });

  return app;
}

/**
 * Test Remnawave connection on startup
 */
async function testRemnawaveConnection(pool: ReturnType<typeof getPool>): Promise<void> {
  try {
    const remnawaveService = new RemnawaveService(pool);
    const result = await remnawaveService.testConnection();
    
    if (result.success) {
      logger.info(`✅ Remnawave connection: ${result.message}`);
    } else {
      logger.warn(`⚠️ Remnawave connection failed: ${result.message}`);
    }
  } catch (error) {
    logger.error({ error }, 'Failed to test Remnawave connection');
  }
}

/**
 * Start the server
 */
export async function startServer(): Promise<void> {
  const env = getEnv();
  const dbConfig = getDatabaseConfig();

  try {
    const app = await createApp();

    // Test Remnawave connection
    await testRemnawaveConnection(getPool());

    // Use APP_BACKEND_PORT instead of PORT for unified configuration
    const port = env.APP_BACKEND_PORT;

    await app.listen({ port, host: '0.0.0.0' });

    logger.info(`🚀 Server running on port ${port}`);
    logger.info(`🔧 Environment: ${env.NODE_ENV}`);
    logger.info(`📊 Database: ${dbConfig.host}:${dbConfig.port}/${dbConfig.name}`);
    logger.info(`💾 Valkey: ${env.VALKEY_HOST}:${env.VALKEY_PORT}`);

    // Start WebSocket server on separate port (4003)
    await startWebSocketServer();
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}
