/**
 * Cache module exports
 * Provides caching utilities, decorators, and configuration
 */

// Core cache service
export {
  CacheService,
  getCacheService,
  resetCacheService,
  type CacheOptions,
  type CacheStats,
} from './cache.service.js';

// Cache configuration
export {
  CACHE_CONFIG,
  CACHE_NAMESPACES,
  getCacheConfig,
  buildCacheKey,
  buildCachePattern,
  type CacheConfigKey,
  type CacheNamespace,
} from './cache.config.js';

// Cache decorators
export {
  Cacheable,
  InvalidateCache,
  CacheEvict,
  CachePut,
  CacheableWithInvalidation,
  createCacheKey,
  createUserCacheKey,
  createPaginationCacheKey,
  type CacheableOptions,
  type InvalidateCacheOptions,
} from './decorators.js';
