import { getCacheService } from './cache.service.js';
import { getCacheConfig, type CacheConfigKey } from './cache.config.js';
import { logger } from '../utils/logger.js';

/**
 * Cacheable decorator options
 */
export interface CacheableOptions {
  /** Cache configuration key */
  configKey?: CacheConfigKey;
  /** Custom TTL in seconds (overrides configKey) */
  ttl?: number;
  /** Custom key prefix (overrides configKey) */
  prefix?: string;
  /** Custom namespace */
  namespace?: string;
  /** Key generator function - receives method arguments */
  keyGenerator?: (args: unknown[]) => string;
  /** Condition to determine if result should be cached */
  condition?: (args: unknown[], result: unknown) => boolean;
  /** Tags for cache invalidation */
  tags?: string[];
}

/**
 * Invalidate cache decorator options
 */
export interface InvalidateCacheOptions {
  /** Key pattern to invalidate (supports wildcards) */
  pattern?: string;
  /** Tags to invalidate */
  tags?: string[];
  /** Custom pattern generator function */
  patternGenerator?: (args: unknown[]) => string;
  /** Namespace for the pattern */
  namespace?: string;
  /** Prefix for the pattern */
  prefix?: string;
  /** Invalidate by key generator (same as Cacheable) */
  keyGenerator?: (args: unknown[]) => string;
}

/**
 * Type for method decorators
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MethodDecoratorType = (target: any, propertyKey: string, descriptor: PropertyDescriptor) => void;

/**
 * Cacheable method decorator
 * Caches the result of a method call
 * @param options - Cache options
 * @returns Method decorator
 *
 * @example
 * ```typescript
 * class UserService {
 *   @Cacheable({ configKey: 'userProfile', keyGenerator: (args) => `user:${args[0]}` })
 *   async getUserProfile(userId: string) {
 *     // Expensive operation
 *     return await this.db.users.findById(userId);
 *   }
 * }
 * ```
 */
export function Cacheable(options: CacheableOptions = {}): MethodDecoratorType {
  const cacheService = getCacheService();

  return function (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ): void {
    const originalMethod = descriptor.value;
    const methodName = propertyKey;

    descriptor.value = async function (...args: unknown[]): Promise<unknown> {
      try {
        // Get configuration
        const config = options.configKey ? getCacheConfig(options.configKey) : null;
        const ttl = options.ttl ?? config?.ttl ?? 300; // Default 5 minutes
        const prefix = options.prefix ?? config?.prefix ?? methodName;
        const namespace = options.namespace;

        // Generate cache key
        let cacheKey: string;
        if (options.keyGenerator) {
          const keyPart = options.keyGenerator(args);
          cacheKey = namespace
            ? `${namespace}:${prefix}:${keyPart}`
            : `${prefix}:${keyPart}`;
        } else {
          // Default key generation based on arguments
          const argsHash = args.length > 0
            ? args.map(arg =>
                typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
              ).join(':')
            : 'default';
          cacheKey = namespace
            ? `${namespace}:${prefix}:${argsHash}`
            : `${prefix}:${argsHash}`;
        }

        // Try to get from cache
        const cached = await cacheService.get<unknown>(cacheKey);
        if (cached !== null) {
          logger.debug({ methodName, cacheKey }, 'Cache hit');
          return cached;
        }

        // Execute original method
        const result = await originalMethod.apply(this, args);

        // Check condition before caching
        if (options.condition && !options.condition(args, result)) {
          logger.debug({ methodName, cacheKey }, 'Cache skipped due to condition');
          return result;
        }

        // Store in cache
        await cacheService.set(cacheKey, result, ttl);

        // Add tags if specified
        if (options.tags && options.tags.length > 0) {
          for (const tag of options.tags) {
            await cacheService.addTag(cacheKey, tag);
          }
        }

        logger.debug({ methodName, cacheKey, ttl }, 'Cache set');
        return result;
      } catch (error) {
        // On error, just execute original method without caching
        logger.error({ error, methodName }, 'Cacheable decorator error');
        return await originalMethod.apply(this, args);
      }
    };
  };
}

/**
 * Invalidate cache decorator
 * Invalidates cache entries after method execution
 * @param options - Invalidation options
 * @returns Method decorator
 *
 * @example
 * ```typescript
 * class UserService {
 *   @Cacheable({ configKey: 'userProfile', keyGenerator: (args) => `user:${args[0]}` })
 *   async getUserProfile(userId: string) {
 *     return await this.db.users.findById(userId);
 *   }
 *
 *   @InvalidateCache({ keyGenerator: (args) => `user:${args[0]}` })
 *   async updateUserProfile(userId: string, data: UpdateUserData) {
 *     return await this.db.users.update(userId, data);
 *   }
 * }
 * ```
 */
export function InvalidateCache(options: InvalidateCacheOptions = {}): MethodDecoratorType {
  const cacheService = getCacheService();

  return function (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ): void {
    const originalMethod = descriptor.value;
    const methodName = propertyKey;

    descriptor.value = async function (...args: unknown[]): Promise<unknown> {
      // Execute original method first
      const result = await originalMethod.apply(this, args);

      try {
        // Invalidate by pattern generator
        if (options.patternGenerator) {
          const pattern = options.patternGenerator(args);
          const fullPattern = options.namespace
            ? `${options.namespace}:${pattern}`
            : pattern;
          const deleted = await cacheService.deleteByPattern(fullPattern);
          logger.debug({ methodName, pattern: fullPattern, deleted }, 'Cache invalidated by pattern');
        }

        // Invalidate by key generator (same as Cacheable)
        if (options.keyGenerator) {
          const keyPart = options.keyGenerator(args);
          const cacheKey = options.namespace
            ? `${options.namespace}:${options.prefix ?? ''}:${keyPart}`
            : `${options.prefix ?? ''}:${keyPart}`;
          await cacheService.delete(cacheKey);
          logger.debug({ methodName, cacheKey }, 'Cache invalidated by key');
        }

        // Invalidate by fixed pattern
        if (options.pattern) {
          const fullPattern = options.namespace
            ? `${options.namespace}:${options.pattern}`
            : options.pattern;
          const deleted = await cacheService.deleteByPattern(fullPattern);
          logger.debug({ methodName, pattern: fullPattern, deleted }, 'Cache invalidated by fixed pattern');
        }

        // Invalidate by tags
        if (options.tags && options.tags.length > 0) {
          const deleted = await cacheService.invalidateByTags(options.tags);
          logger.debug({ methodName, tags: options.tags, deleted }, 'Cache invalidated by tags');
        }
      } catch (error) {
        logger.error({ error, methodName }, 'InvalidateCache decorator error');
      }

      return result;
    };
  };
}

/**
 * Cache evict decorator - alias for InvalidateCache
 * @param options - Invalidation options
 * @returns Method decorator
 */
export function CacheEvict(options: InvalidateCacheOptions = {}): MethodDecoratorType {
  return InvalidateCache(options);
}

/**
 * Cache put decorator - updates cache without reading
 * @param options - Cache options
 * @returns Method decorator
 */
export function CachePut(options: CacheableOptions = {}): MethodDecoratorType {
  const cacheService = getCacheService();

  return function (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ): void {
    const originalMethod = descriptor.value;
    const methodName = propertyKey;

    descriptor.value = async function (...args: unknown[]): Promise<unknown> {
      const result = await originalMethod.apply(this, args);

      try {
        const config = options.configKey ? getCacheConfig(options.configKey) : null;
        const ttl = options.ttl ?? config?.ttl ?? 300;
        const prefix = options.prefix ?? config?.prefix ?? methodName;
        const namespace = options.namespace;

        let cacheKey: string;
        if (options.keyGenerator) {
          const keyPart = options.keyGenerator(args);
          cacheKey = namespace
            ? `${namespace}:${prefix}:${keyPart}`
            : `${prefix}:${keyPart}`;
        } else {
          const argsHash = args.length > 0
            ? args.map(arg =>
                typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
              ).join(':')
            : 'default';
          cacheKey = namespace
            ? `${namespace}:${prefix}:${argsHash}`
            : `${prefix}:${argsHash}`;
        }

        await cacheService.set(cacheKey, result, ttl);
        logger.debug({ methodName, cacheKey, ttl }, 'Cache put');
      } catch (error) {
        logger.error({ error, methodName }, 'CachePut decorator error');
      }

      return result;
    };
  };
}

/**
 * Composite decorator: Cacheable with automatic invalidation on mutations
 * @param cacheOptions - Cacheable options
 * @param invalidateOptions - Invalidate options for mutations
 * @returns Method decorator for queries
 */
export function CacheableWithInvalidation(
  cacheOptions: CacheableOptions,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _invalidateOptions: InvalidateCacheOptions
): MethodDecoratorType {
  return Cacheable(cacheOptions);
}

/**
 * Helper to create cache key from method arguments
 * @param args - Method arguments
 * @returns Cache key string
 */
export function createCacheKey(...args: unknown[]): string {
  return args.map(arg =>
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(':');
}

/**
 * Helper to create cache key with user ID
 * @param userId - User ID
 * @param suffix - Optional suffix
 * @returns Cache key string
 */
export function createUserCacheKey(userId: string, suffix?: string): string {
  return suffix ? `${userId}:${suffix}` : userId;
}

/**
 * Helper to create cache key for paginated results
 * @param base - Base key
 * @param page - Page number
 * @param limit - Items per page
 * @returns Cache key string
 */
export function createPaginationCacheKey(
  base: string,
  page: number,
  limit: number
): string {
  return `${base}:page:${page}:limit:${limit}`;
}
