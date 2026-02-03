import type { FastifyRequest, FastifyReply } from 'fastify';
import { getValkey } from '../config/redis.js';
import { logger } from '../utils/logger.js';

/**
 * Rate limiting configuration options
 */
export interface RateLimitOptions {
  /** Maximum number of requests allowed within the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Key prefix for Valkey storage */
  keyPrefix?: string;
  /** Skip rate limiting for these IPs */
  whitelist?: string[];
  /** Custom key generator function */
  keyGenerator?: (request: FastifyRequest) => string;
  /** Handler when rate limit is exceeded */
  onLimitExceeded?: (request: FastifyRequest, reply: FastifyReply) => void;
}

/**
 * Predefined rate limit configurations for different endpoint types
 */
export const RATE_LIMITS = {
  /** Strict limits for authentication endpoints (login, register, etc.) */
  auth: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 5,
    keyPrefix: 'rate_limit:auth',
  } as RateLimitOptions,

  /** API endpoints that modify data */
  apiWrite: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 30,
    keyPrefix: 'rate_limit:api:write',
  } as RateLimitOptions,

  /** API endpoints that only read data */
  apiRead: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 100,
    keyPrefix: 'rate_limit:api:read',
  } as RateLimitOptions,

  /** Client-facing API endpoints */
  client: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 60,
    keyPrefix: 'rate_limit:client',
  } as RateLimitOptions,

  /** Mini App specific endpoints */
  miniapp: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 60,
    keyPrefix: 'rate_limit:miniapp',
  } as RateLimitOptions,

  /** Webhook endpoints - more lenient */
  webhook: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 200,
    keyPrefix: 'rate_limit:webhook',
  } as RateLimitOptions,

  /** File upload endpoints */
  upload: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10,
    keyPrefix: 'rate_limit:upload',
  } as RateLimitOptions,

  /** Admin endpoints - higher limits */
  admin: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 200,
    keyPrefix: 'rate_limit:admin',
  } as RateLimitOptions,
} as const;

/**
 * Type for rate limit configurations
 */
export type RateLimitType = keyof typeof RATE_LIMITS;

/**
 * Whitelisted IPs (admin IPs that bypass rate limiting)
 */
const WHITELISTED_IPS = new Set<string>([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  // Add more admin IPs here
]);

/**
 * Generate rate limit key for request
 * @param request Fastify request
 * @param keyPrefix Optional key prefix override
 * @returns Rate limit key
 */
export function generateRateLimitKey(
  request: FastifyRequest,
  keyPrefix?: string
): string {
  // Use user ID if authenticated, otherwise use IP address
  const userId = request.user?.userId;
  const identifier = userId || request.ip;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const route = (request as any).routerPath || request.url;
  const prefix = keyPrefix || 'rate_limit';

  return `${prefix}:${route}:${identifier}`;
}

/**
 * Check if IP is whitelisted
 * @param ip IP address
 * @param additionalWhitelist Additional whitelist to check
 * @returns True if whitelisted
 */
function isWhitelisted(ip: string, additionalWhitelist?: string[]): boolean {
  if (WHITELISTED_IPS.has(ip)) {
    return true;
  }
  if (additionalWhitelist?.includes(ip)) {
    return true;
  }
  return false;
}

/**
 * Convert GlideString to string
 */
function gs(value: import('@valkey/valkey-glide').GlideString): string {
  if (Buffer.isBuffer(value)) {
    return value.toString('utf-8');
  }
  return String(value);
}

/**
 * Rate limiting middleware
 * Limits the number of requests from a client within a time window
 * @param options Rate limiting options
 * @returns Middleware function
 */
export function rateLimitMiddleware(options: RateLimitOptions) {
  const {
    maxRequests,
    windowMs,
    keyPrefix = 'rate_limit',
    whitelist,
    keyGenerator,
    onLimitExceeded,
  } = options;

  return async function rateLimitHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    try {
      // Check whitelist
      if (isWhitelisted(request.ip, whitelist)) {
        return;
      }

      const valkey = getValkey();
      const key = keyGenerator
        ? keyGenerator(request)
        : generateRateLimitKey(request, keyPrefix);

      // Use incr and get/set for atomic-like operations
      // Valkey-Glide doesn't have pipeline like ioredis
      const currentCount = await valkey.incr(key);

      // Set expiry on first request
      if (currentCount === 1) {
        await valkey.pexpire(key, windowMs);
      }

      // Get remaining TTL
      const ttl = await valkey.pttl(key);

      // Calculate reset time
      const resetTime = Date.now() + (ttl > 0 ? ttl : windowMs);
      const remaining = Math.max(0, maxRequests - currentCount);

      // Set rate limit headers
      reply.header('X-RateLimit-Limit', maxRequests);
      reply.header('X-RateLimit-Remaining', remaining);
      reply.header('X-RateLimit-Reset', new Date(resetTime).toISOString());
      reply.header('X-RateLimit-Window', windowMs);

      // Check if limit exceeded
      if (currentCount > maxRequests) {
        // Set Retry-After header
        reply.header('Retry-After', Math.ceil(ttl / 1000));

        logger.warn({
          key,
          count: currentCount,
          maxRequests,
          ip: request.ip,
          userId: request.user?.userId,
          path: request.url,
        }, 'Rate limit exceeded');

        if (onLimitExceeded) {
          onLimitExceeded(request, reply);
          return;
        }

        reply.status(429).send({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${Math.ceil(ttl / 1000)} seconds.`,
          retryAfter: Math.ceil(ttl / 1000),
          limit: maxRequests,
          windowMs,
        });
        return;
      }

      // Log high usage warnings
      if (currentCount > maxRequests * 0.8) {
        logger.debug({
          key,
          count: currentCount,
          maxRequests,
          ip: request.ip,
        }, 'Rate limit approaching');
      }
    } catch (error) {
      // Log error but don't block request if Valkey fails
      logger.error({ error }, 'Rate limiting error, allowing request');
    }
  };
}

/**
 * Get rate limit status for a key
 * @param key Rate limit key
 * @returns Current count and TTL
 */
export async function getRateLimitStatus(key: string): Promise<{
  count: number;
  ttl: number;
  resetTime: Date;
} | null> {
  try {
    const valkey = getValkey();
    const [count, ttl] = await Promise.all([
      valkey.get(key),
      valkey.pttl(key),
    ]);

    if (count === null) {
      return null;
    }

    const ttlValue = Math.max(0, ttl);

    return {
      count: parseInt(gs(count), 10),
      ttl: ttlValue,
      resetTime: new Date(Date.now() + ttlValue),
    };
  } catch (error) {
    logger.error({ error, key }, 'Failed to get rate limit status');
    return null;
  }
}

/**
 * Reset rate limit for a key
 * @param key Rate limit key
 */
export async function resetRateLimit(key: string): Promise<void> {
  try {
    const valkey = getValkey();
    await valkey.del([key]);
    logger.info({ key }, 'Rate limit reset');
  } catch (error) {
    logger.error({ error, key }, 'Failed to reset rate limit');
  }
}

/**
 * Strict rate limiting middleware for sensitive endpoints
 * Use for login, register, password reset, etc.
 */
export function strictRateLimitMiddleware(options?: Partial<RateLimitOptions>) {
  return rateLimitMiddleware({
    ...RATE_LIMITS.auth,
    ...options,
  });
}

/**
 * API rate limiting middleware for general API endpoints
 */
export function apiRateLimitMiddleware(
  type: 'read' | 'write' = 'read',
  options?: Partial<RateLimitOptions>
) {
  const baseConfig = type === 'write' ? RATE_LIMITS.apiWrite : RATE_LIMITS.apiRead;
  return rateLimitMiddleware({
    ...baseConfig,
    ...options,
  });
}

/**
 * Client API rate limiting middleware
 * Separate limits for client-facing endpoints
 */
export function clientRateLimitMiddleware(options?: Partial<RateLimitOptions>) {
  return rateLimitMiddleware({
    ...RATE_LIMITS.client,
    ...options,
  });
}

/**
 * Mini App rate limiting middleware
 */
export function miniappRateLimitMiddleware(options?: Partial<RateLimitOptions>) {
  return rateLimitMiddleware({
    ...RATE_LIMITS.miniapp,
    ...options,
  });
}

/**
 * Webhook rate limiting middleware
 * More lenient for webhook endpoints
 */
export function webhookRateLimitMiddleware(options?: Partial<RateLimitOptions>) {
  return rateLimitMiddleware({
    ...RATE_LIMITS.webhook,
    ...options,
  });
}

/**
 * Upload rate limiting middleware
 * Strict limits for file uploads
 */
export function uploadRateLimitMiddleware(options?: Partial<RateLimitOptions>) {
  return rateLimitMiddleware({
    ...RATE_LIMITS.upload,
    ...options,
  });
}

/**
 * Admin rate limiting middleware
 * Higher limits for admin endpoints
 */
export function adminRateLimitMiddleware(options?: Partial<RateLimitOptions>) {
  return rateLimitMiddleware({
    ...RATE_LIMITS.admin,
    ...options,
  });
}

/**
 * Dynamic rate limiting based on user tier
 * @param getUserTier Function to get user's tier
 * @returns Middleware function
 */
export function tieredRateLimitMiddleware(
  getUserTier: (request: FastifyRequest) => 'free' | 'premium' | 'admin'
) {
  return async function tieredRateLimitHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const tier = getUserTier(request);

    const tierLimits: Record<string, RateLimitOptions> = {
      free: RATE_LIMITS.client,
      premium: { ...RATE_LIMITS.client, maxRequests: 120 },
      admin: RATE_LIMITS.admin,
    };

    const limiter = rateLimitMiddleware(tierLimits[tier] || RATE_LIMITS.client);
    return limiter(request, reply);
  };
}

/**
 * Sliding window rate limiting middleware
 * Note: Simplified implementation for Valkey-Glide compatibility
 * @param options Rate limiting options
 */
export function slidingWindowRateLimitMiddleware(options: RateLimitOptions) {
  // For Valkey-Glide compatibility, use the simple fixed window algorithm
  // The sliding window implementation requires sorted set operations that are complex
  logger.warn('Sliding window rate limiting uses fixed window fallback for Valkey-Glide compatibility');
  return rateLimitMiddleware(options);
}
