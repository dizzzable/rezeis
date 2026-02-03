import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'crypto';
import { getCacheService } from '../cache/cache.service.js';
import { logger } from '../utils/logger.js';

/**
 * Cache control options
 */
export interface CacheControlOptions {
  /** Max age in seconds for Cache-Control header */
  maxAge: number;
  /** Enable private cache (default: true) */
  private?: boolean;
  /** Enable must-revalidate */
  mustRevalidate?: boolean;
  /** Enable no-cache for specific conditions */
  noCache?: boolean;
}

/**
 * Generate ETag for response body
 * @param body - Response body
 * @returns ETag string
 */
export function generateETag(body: unknown): string {
  const hash = createHash('md5');
  hash.update(JSON.stringify(body));
  return `W/"${hash.digest('hex').substring(0, 16)}"`;
}

/**
 * Generate Last-Modified timestamp
 * @param date - Date to use
 * @returns Formatted timestamp
 */
export function generateLastModified(date: Date = new Date()): string {
  return date.toUTCString();
}

/**
 * Cache middleware for adding HTTP cache headers
 * @param options - Cache control options
 * @returns Fastify preHandler hook
 */
export function cacheMiddleware(options: CacheControlOptions) {
  const { maxAge, private: isPrivate = true, mustRevalidate = true, noCache = false } = options;

  return async function cacheHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Build Cache-Control header
    const directives: string[] = [];

    if (noCache) {
      directives.push('no-cache');
    } else {
      if (isPrivate) {
        directives.push('private');
      } else {
        directives.push('public');
      }
      directives.push(`max-age=${maxAge}`);
      if (mustRevalidate) {
        directives.push('must-revalidate');
      }
    }

    reply.header('Cache-Control', directives.join(', '));

    // Handle conditional requests
    const ifNoneMatch = request.headers['if-none-match'];
    const ifModifiedSince = request.headers['if-modified-since'];

    // Store for later use in response hook
    (request as unknown as Record<string, unknown>).cacheMetadata = {
      ifNoneMatch,
      ifModifiedSince,
      maxAge,
    };
  };
}

/**
 * Conditional GET middleware
 * Supports 304 Not Modified responses
 * @returns Fastify preHandler hook
 */
export function conditionalGetMiddleware() {
  return async function conditionalGetHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Hook into the response to check for 304
    const originalSend = reply.send.bind(reply);

    reply.send = function (payload: unknown): typeof reply {
      // Skip for error responses
      if (reply.statusCode >= 400) {
        return originalSend(payload);
      }

      // Generate ETag for successful responses
      if (payload && reply.statusCode === 200) {
        const etag = generateETag(payload);
        reply.header('ETag', etag);

        const ifNoneMatch = request.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === etag) {
          reply.status(304);
          return originalSend(undefined);
        }
      }

      return originalSend(payload);
    };
  };
}

/**
 * Response cache middleware
 * Caches responses in Redis
 * @param ttl - Time to live in seconds
 * @param keyGenerator - Custom key generator
 * @returns Fastify preHandler hook
 */
export function responseCacheMiddleware(
  ttl: number,
  keyGenerator?: (request: FastifyRequest) => string
) {
  const cacheService = getCacheService();

  return async function responseCacheHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Skip for non-GET requests
    if (request.method !== 'GET') {
      return;
    }

    const cacheKey = keyGenerator
      ? `response:${keyGenerator(request)}`
      : `response:${request.url}`;

    try {
      // Try to get cached response
      const cached = await cacheService.get<{
        body: unknown;
        headers: Record<string, string>;
        statusCode: number;
      }>(cacheKey);

      if (cached) {
        // Set cached headers
        for (const [key, value] of Object.entries(cached.headers)) {
          reply.header(key, value);
        }
        reply.header('X-Cache', 'HIT');
        reply.status(cached.statusCode).send(cached.body);
        return;
      }

      // Hook into response to cache it
      const originalSend = reply.send.bind(reply);

      reply.send = function (payload: unknown): typeof reply {
        // Only cache successful GET responses
        if (reply.statusCode === 200 && payload) {
          const headers: Record<string, string> = {};
          const responseHeaders = reply.getHeaders();

          // Copy relevant headers
          const headersToCache = ['content-type', 'etag', 'last-modified'];
          for (const header of headersToCache) {
            const value = responseHeaders[header];
            if (value) {
              headers[header] = String(value);
            }
          }

          // Cache asynchronously without awaiting
          void cacheService.set(
            cacheKey,
            {
              body: payload,
              headers,
              statusCode: reply.statusCode,
            },
            ttl
          );

          reply.header('X-Cache', 'MISS');
        }

        return originalSend(payload);
      };
    } catch (error) {
      logger.error({ error }, 'Response cache error');
    }
  };
}

/**
 * Invalidate response cache middleware
 * Invalidates cache patterns after write operations
 * @param pattern - Cache key pattern to invalidate
 * @returns Fastify onSend hook
 */
export function invalidateResponseCacheMiddleware(pattern: string) {
  const cacheService = getCacheService();

  return async function invalidateCacheHandler(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown
  ): Promise<unknown> {
    // Invalidate on successful write operations
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      if (reply.statusCode >= 200 && reply.statusCode < 300) {
        try {
          const deleted = await cacheService.deleteByPattern(`response:${pattern}`);
          logger.debug({ pattern, deleted }, 'Response cache invalidated');
        } catch (error) {
          logger.error({ error, pattern }, 'Failed to invalidate response cache');
        }
      }
    }
    return payload;
  };
}

/**
 * Browser cache middleware with ETag support
 * Combines multiple caching strategies
 * @param options - Cache options
 * @returns Fastify preHandler hook
 */
export function browserCacheMiddleware(options: {
  maxAge: number;
  etag?: boolean;
  lastModified?: boolean;
}) {
  const { maxAge, etag = true, lastModified = true } = options;

  return async function browserCacheHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Set cache control headers
    reply.header('Cache-Control', `private, max-age=${maxAge}, must-revalidate`);

    // Hook into send to add ETag and Last-Modified
    const originalSend = reply.send.bind(reply);

    reply.send = function (payload: unknown): typeof reply {
      if (reply.statusCode === 200 && payload) {
        if (etag) {
          const etagValue = generateETag(payload);
          reply.header('ETag', etagValue);

          // Check If-None-Match
          const ifNoneMatch = request.headers['if-none-match'];
          if (ifNoneMatch === etagValue) {
            reply.status(304);
            return originalSend(undefined);
          }
        }

        if (lastModified) {
          reply.header('Last-Modified', generateLastModified());
        }
      }

      return originalSend(payload);
    };
  };
}

/**
 * No cache middleware
 * Disables caching completely
 * @returns Fastify preHandler hook
 */
export function noCacheMiddleware() {
  return async function noCacheHandler(
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');
    reply.header('Surrogate-Control', 'no-store');
  };
}

/**
 * Short cache middleware (for semi-dynamic content)
 * @param maxAge - Max age in seconds (default: 60)
 * @returns Fastify preHandler hook
 */
export function shortCacheMiddleware(maxAge = 60) {
  return cacheMiddleware({ maxAge, private: true, mustRevalidate: true });
}

/**
 * Long cache middleware (for static content)
 * @param maxAge - Max age in seconds (default: 86400 = 1 day)
 * @returns Fastify preHandler hook
 */
export function longCacheMiddleware(maxAge = 86400) {
  return cacheMiddleware({ maxAge, private: false, mustRevalidate: false });
}
