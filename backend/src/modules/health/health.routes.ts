import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { testConnection } from '../../config/database.js';
import { testValkeyConnection as testRedisConnection, testValkeyConnection as testRedisPool, getValkeyStats } from '../../config/redis.js';
import { getCacheService } from '../../cache/cache.service.js';
import { getPerformanceMonitor } from '../../monitoring/performance.js';
import { getPool } from '../../config/database.js';
import { logger } from '../../utils/logger.js';

/**
 * Health check response
 */
interface HealthResponse {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  version: string;
  uptime: number;
  services: {
    database: 'connected' | 'disconnected';
    valkey: 'connected' | 'disconnected';
    valkeyPool: 'healthy' | 'unhealthy';
    // Redis aliases for backward compatibility
    redis?: 'connected' | 'disconnected';
    redisPool?: 'healthy' | 'unhealthy';
  };
}

/**
 * Detailed health check response with metrics
 */
interface DetailedHealthResponse extends HealthResponse {
  metrics: {
    memory: NodeJS.MemoryUsage;
    cpu: NodeJS.CpuUsage;
    databaseConnections?: {
      total: number;
      idle: number;
      waiting: number;
    };
    valkeyStats?: {
      connectedClients: number;
      usedMemory: number;
      keyspaceHits: number;
      keyspaceMisses: number;
      hitRate: number;
    };
    // Redis alias for backward compatibility
    redisStats?: {
      connectedClients: number;
      usedMemory: number;
      keyspaceHits: number;
      keyspaceMisses: number;
      hitRate: number;
    };
    cacheStats?: {
      hits: number;
      misses: number;
      keys: number;
      memory: string;
    };
  };
}

/**
 * Register health check routes
 * @param fastify Fastify instance
 */
export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /health
   * Basic health check
   */
  fastify.get('/', {
    schema: {
      description: 'Basic health check endpoint',
      tags: ['health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['healthy', 'unhealthy', 'degraded'] },
            timestamp: { type: 'string', format: 'date-time' },
            version: { type: 'string' },
          },
        },
      },
    },
    handler: async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.send({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
      });
    },
  });

  /**
   * GET /health/detailed
   * Detailed health check with service status
   */
  fastify.get('/detailed', {
    schema: {
      description: 'Detailed health check with service status',
      tags: ['health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['healthy', 'unhealthy', 'degraded'] },
            timestamp: { type: 'string', format: 'date-time' },
            version: { type: 'string' },
            uptime: { type: 'number' },
            services: {
              type: 'object',
              properties: {
                database: { type: 'string', enum: ['connected', 'disconnected'] },
                valkey: { type: 'string', enum: ['connected', 'disconnected'] },
                valkeyPool: { type: 'string', enum: ['healthy', 'unhealthy'] },
                redis: { type: 'string', enum: ['connected', 'disconnected'] },
                redisPool: { type: 'string', enum: ['healthy', 'unhealthy'] },
              },
            },
          },
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
            version: { type: 'string' },
            uptime: { type: 'number' },
            services: {
              type: 'object',
              properties: {
                database: { type: 'string' },
                valkey: { type: 'string' },
                valkeyPool: { type: 'string' },
                redis: { type: 'string' },
                redisPool: { type: 'string' },
              },
            },
          },
        },
      },
    },
    handler: async (_request: FastifyRequest, reply: FastifyReply) => {
      const [dbHealthy, redisHealthy, poolHealthy] = await Promise.all([
        testConnection(),
        testRedisConnection(),
        testRedisPool(),
      ]);

      const isHealthy = dbHealthy && redisHealthy && poolHealthy;
      const status = isHealthy
        ? 'healthy'
        : (dbHealthy || redisHealthy)
          ? 'degraded'
          : 'unhealthy';

      const health: HealthResponse = {
        status,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        uptime: process.uptime(),
        services: {
          database: dbHealthy ? 'connected' : 'disconnected',
          valkey: redisHealthy ? 'connected' : 'disconnected',
          valkeyPool: poolHealthy ? 'healthy' : 'unhealthy',
          redis: redisHealthy ? 'connected' : 'disconnected', // backward compatibility
          redisPool: poolHealthy ? 'healthy' : 'unhealthy', // backward compatibility
        },
      };

      reply.code(isHealthy ? 200 : 503).send(health);
    },
  });

  /**
   * GET /health/full
   * Full health check with metrics
   */
  fastify.get('/full', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const [dbHealthy, redisHealthy, poolHealthy] = await Promise.all([
        testConnection(),
        testRedisConnection(),
        testRedisPool(),
      ]);

      const isHealthy = dbHealthy && redisHealthy && poolHealthy;
      const status = isHealthy
        ? 'healthy'
        : (dbHealthy || redisHealthy)
          ? 'degraded'
          : 'unhealthy';

      // Get database pool info
      let dbConnections: { total: number; idle: number; waiting: number } | undefined;
      if (dbHealthy) {
        const pool = getPool();
        dbConnections = {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        };
      }

      // Get Valkey stats
      let valkeyStats: {
        connectedClients: number;
        usedMemory: number;
        keyspaceHits: number;
        keyspaceMisses: number;
        hitRate: number;
      } | undefined;
      if (redisHealthy) {
        valkeyStats = await getValkeyStats();
      }

      // Get cache stats
      let cacheStats: { hits: number; misses: number; keys: number; memory: string } | undefined;
      try {
        cacheStats = await getCacheService().getStats();
      } catch {
        // Cache stats not critical
      }

      const health: DetailedHealthResponse = {
        status,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        uptime: process.uptime(),
        services: {
          database: dbHealthy ? 'connected' : 'disconnected',
          valkey: redisHealthy ? 'connected' : 'disconnected',
          valkeyPool: poolHealthy ? 'healthy' : 'unhealthy',
          redis: redisHealthy ? 'connected' : 'disconnected', // backward compatibility
          redisPool: poolHealthy ? 'healthy' : 'unhealthy', // backward compatibility
        },
        metrics: {
          memory: process.memoryUsage(),
          cpu: process.cpuUsage(),
          databaseConnections: dbConnections,
          valkeyStats,
          redisStats: valkeyStats, // backward compatibility
          cacheStats,
        },
      };

      reply.code(isHealthy ? 200 : 503).send(health);
    } catch (error) {
      logger.error({ error }, 'Health check failed');
      reply.code(503).send({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        uptime: process.uptime(),
        services: {
          database: 'disconnected',
          valkey: 'disconnected',
          valkeyPool: 'unhealthy',
          redis: 'disconnected', // backward compatibility
          redisPool: 'unhealthy', // backward compatibility
        },
        error: 'Health check failed',
      });
    }
  });

  /**
   * GET /health/ready
   * Kubernetes readiness probe
   */
  fastify.get('/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
    const [dbHealthy, redisHealthy] = await Promise.all([
      testConnection(),
      testRedisConnection(),
    ]);

    if (dbHealthy && redisHealthy) {
      reply.send({ status: 'ready' });
    } else {
      reply.code(503).send({
        status: 'not ready',
        services: {
          database: dbHealthy ? 'connected' : 'disconnected',
          valkey: redisHealthy ? 'connected' : 'disconnected',
          redis: redisHealthy ? 'connected' : 'disconnected', // backward compatibility
        },
      });
    }
  });

  /**
   * GET /health/live
   * Kubernetes liveness probe
   */
  fastify.get('/live', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.send({
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  /**
   * GET /health/metrics
   * Prometheus-compatible metrics endpoint
   */
  fastify.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const monitor = getPerformanceMonitor();
      const metrics = await monitor.getPrometheusMetrics();

      reply.header('Content-Type', 'text/plain; version=0.0.4');
      reply.send(metrics);
    } catch (error) {
      logger.error({ error }, 'Failed to get metrics');
      reply.code(500).send({ error: 'Failed to get metrics' });
    }
  });

  /**
   * GET /health/cache
   * Cache statistics endpoint
   */
  fastify.get('/cache', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const cacheService = getCacheService();
      const stats = await cacheService.getStats();
      const valkeyStats = await getValkeyStats();

      reply.send({
        cache: stats,
        valkey: valkeyStats,
        redis: valkeyStats, // backward compatibility
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get cache stats');
      reply.code(500).send({ error: 'Failed to get cache statistics' });
    }
  });

  /**
   * POST /health/cache/flush
   * Flush cache endpoint (admin only)
   */
  fastify.post('/cache/flush', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Check if user is admin
      if (request.user?.role !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const cacheService = getCacheService();
      const { namespace } = request.body as { namespace?: string };

      if (namespace) {
        const deleted = await cacheService.flushNamespace(namespace);
        reply.send({
          flushed: true,
          namespace,
          keysDeleted: deleted,
          timestamp: new Date().toISOString(),
        });
      } else {
        // Flush all keys matching pattern
        const deleted = await cacheService.deleteByPattern('*');
        reply.send({
          flushed: true,
          keysDeleted: deleted,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.error({ error }, 'Failed to flush cache');
      reply.code(500).send({ error: 'Failed to flush cache' });
    }
  });

  /**
   * GET /health/performance
   * Performance metrics endpoint
   */
  fastify.get('/performance', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const monitor = getPerformanceMonitor();
      const metrics = monitor.getMetrics();

      reply.send({
        ...metrics,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get performance metrics');
      reply.code(500).send({ error: 'Failed to get performance metrics' });
    }
  });

  /**
   * POST /health/performance/reset
   * Reset performance metrics (admin only)
   */
  fastify.post('/performance/reset', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Check if user is admin
      if (request.user?.role !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const monitor = getPerformanceMonitor();
      monitor.reset();

      reply.send({
        reset: true,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to reset performance metrics');
      reply.code(500).send({ error: 'Failed to reset metrics' });
    }
  });
}
