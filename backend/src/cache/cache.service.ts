import type { BaseClient, GlideString } from '@valkey/valkey-glide';
import { getValkey } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import { CACHE_NAMESPACES, buildCacheKey, buildCachePattern } from './cache.config.js';

/**
 * Cache operation options
 */
export interface CacheOptions {
  /** Time to live in seconds */
  ttl?: number;
  /** Key prefix */
  prefix?: string;
  /** Namespace for organization */
  namespace?: string;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  hits: number;
  misses: number;
  keys: number;
  memory: string;
}

/**
 * Convert GlideString to string
 */
function gs(value: GlideString): string {
  if (Buffer.isBuffer(value)) {
    return value.toString('utf-8');
  }
  return String(value);
}

/**
 * Cache service for Valkey-based caching
 * Provides methods for get, set, delete, and pattern-based operations
 */
export class CacheService {
  private readonly valkey: BaseClient;
  private readonly stats: { hits: number; misses: number } = { hits: 0, misses: 0 };

  constructor() {
    this.valkey = getValkey();
  }

  /**
   * Get value from cache
   * @param key - Cache key
   * @returns Parsed value or null if not found
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.valkey.get(key);
      if (value === null) {
        this.stats.misses++;
        return null;
      }
      this.stats.hits++;
      return JSON.parse(gs(value)) as T;
    } catch (error) {
      logger.error({ error, key }, 'Cache get error');
      return null;
    }
  }

  /**
   * Set value in cache with optional TTL
   * @param key - Cache key
   * @param value - Value to cache
   * @param ttl - Time to live in seconds (optional)
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttl && ttl > 0) {
        // Valkey-Glide uses expiry option - set expiry then set value
        await this.valkey.set(key, serialized);
        await this.valkey.expire(key, ttl);
      } else {
        await this.valkey.set(key, serialized);
      }
    } catch (error) {
      logger.error({ error, key }, 'Cache set error');
    }
  }

  /**
   * Delete a key from cache
   * @param key - Cache key to delete
   */
  async delete(key: string): Promise<void> {
    try {
      await this.valkey.del([key]);
    } catch (error) {
      logger.error({ error, key }, 'Cache delete error');
    }
  }

  /**
   * Check if key exists in cache
   * @param key - Cache key
   * @returns True if exists
   */
  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.valkey.exists([key]);
      return result === 1;
    } catch (error) {
      logger.error({ error, key }, 'Cache exists error');
      return false;
    }
  }

  /**
   * Get keys matching a pattern
   * Note: Valkey-Glide doesn't support scan directly, so this returns empty array
   * @param pattern - Valkey pattern (e.g., "user:*")
   * @returns Array of matching keys (limited support)
   */
  async getByPattern(pattern: string): Promise<string[]> {
    void pattern; // Not used but kept for API consistency
    // Note: Valkey-Glide doesn't expose SCAN command directly
    // Return empty array as fallback
    logger.warn('Pattern-based key lookup not supported in Valkey-Glide');
    return [];
  }

  /**
   * Delete keys matching a pattern
   * Note: Limited support in Valkey-Glide
   * @param pattern - Valkey pattern
   * @returns Number of keys deleted
   */
  async deleteByPattern(pattern: string): Promise<number> {
    try {
      const keys = await this.getByPattern(pattern);
      if (keys.length === 0) {
        return 0;
      }
      await this.valkey.del(keys);
      return keys.length;
    } catch (error) {
      logger.error({ error, pattern }, 'Cache deleteByPattern error');
      return 0;
    }
  }

  /**
   * Get hash field value
   * @param key - Hash key
   * @param field - Field name
   * @returns Field value or null
   */
  async hget<T>(key: string, field: string): Promise<T | null> {
    try {
      const value = await this.valkey.hget(key, field);
      if (value === null) {
        return null;
      }
      return JSON.parse(gs(value)) as T;
    } catch (error) {
      logger.error({ error, key, field }, 'Cache hget error');
      return null;
    }
  }

  /**
   * Set hash field value with optional TTL on the key
   * @param key - Hash key
   * @param field - Field name
   * @param value - Value to set
   * @param ttl - Optional TTL for the hash key
   */
  async hset<T>(key: string, field: string, value: T, ttl?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      // Valkey-Glide uses object format: { [field]: value }
      await this.valkey.hset(key, { [field]: serialized });
      if (ttl && ttl > 0) {
        await this.valkey.expire(key, ttl);
      }
    } catch (error) {
      logger.error({ error, key, field }, 'Cache hset error');
    }
  }

  /**
   * Delete hash field
   * @param key - Hash key
   * @param field - Field to delete
   */
  async hdel(key: string, field: string): Promise<void> {
    try {
      await this.valkey.hdel(key, [field]);
    } catch (error) {
      logger.error({ error, key, field }, 'Cache hdel error');
    }
  }

  /**
   * Get all hash fields
   * @param key - Hash key
   * @returns Object with all fields
   */
  async hgetall<T>(key: string): Promise<Record<string, T> | null> {
    try {
      const result = await this.valkey.hgetall(key);
      if (!result || result.length === 0) {
        return null;
      }
      const parsed: Record<string, T> = {};
      // HashDataType is array of { field, value } objects
      for (const item of result) {
        parsed[gs(item.field)] = JSON.parse(gs(item.value)) as T;
      }
      return parsed;
    } catch (error) {
      logger.error({ error, key }, 'Cache hgetall error');
      return null;
    }
  }

  /**
   * Push values to the left of a list
   * @param key - List key
   * @param values - Values to push
   * @returns New list length
   */
  async lpush(key: string, ...values: string[]): Promise<number> {
    try {
      return await this.valkey.lpush(key, values);
    } catch (error) {
      logger.error({ error, key }, 'Cache lpush error');
      return 0;
    }
  }

  /**
   * Get range of elements from a list
   * @param key - List key
   * @param start - Start index (0-based)
   * @param stop - Stop index (inclusive, -1 for all)
   * @returns Array of values
   */
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    try {
      const result = await this.valkey.lrange(key, start, stop);
      return result.map(gs);
    } catch (error) {
      logger.error({ error, key }, 'Cache lrange error');
      return [];
    }
  }

  /**
   * Increment a key's value by 1
   * @param key - Key to increment
   * @returns New value
   */
  async incr(key: string): Promise<number> {
    try {
      return await this.valkey.incr(key);
    } catch (error) {
      logger.error({ error, key }, 'Cache incr error');
      return 0;
    }
  }

  /**
   * Increment a key's value by specified amount
   * @param key - Key to increment
   * @param amount - Amount to add
   * @returns New value
   */
  async incrby(key: string, amount: number): Promise<number> {
    try {
      return await this.valkey.incrBy(key, amount);
    } catch (error) {
      logger.error({ error, key, amount }, 'Cache incrby error');
      return 0;
    }
  }

  /**
   * Set key expiration
   * @param key - Key to expire
   * @param seconds - TTL in seconds
   * @returns True if timeout was set
   */
  async expire(key: string, seconds: number): Promise<boolean> {
    try {
      const result = await this.valkey.expire(key, seconds);
      return result;
    } catch (error) {
      logger.error({ error, key, seconds }, 'Cache expire error');
      return false;
    }
  }

  /**
   * Get key TTL
   * @param key - Key to check
   * @returns TTL in seconds, -1 if no expiration, -2 if not exists
   */
  async ttl(key: string): Promise<number> {
    try {
      return await this.valkey.ttl(key);
    } catch (error) {
      logger.error({ error, key }, 'Cache ttl error');
      return -2;
    }
  }

  /**
   * Flush all keys in a namespace
   * Note: Limited support in Valkey-Glide
   * @param namespace - Namespace to flush
   * @returns Number of keys deleted
   */
  async flushNamespace(namespace: string): Promise<number> {
    try {
      const pattern = buildCachePattern('*', namespace);
      logger.warn({ pattern, namespace }, 'Namespace flush not fully supported in Valkey-Glide');
      return 0;
    } catch (error) {
      logger.error({ error, namespace }, 'Cache flushNamespace error');
      return 0;
    }
  }

  /**
   * Get cache statistics
   * @returns Cache stats including hits, misses, keys count, and memory
   */
  async getStats(): Promise<CacheStats> {
    try {
      // Note: Valkey-Glide doesn't expose INFO or DBSIZE directly
      // Return stats based on local tracking only
      return {
        hits: this.stats.hits,
        misses: this.stats.misses,
        keys: 0,
        memory: 'unknown',
      };
    } catch (error) {
      logger.error({ error }, 'Cache getStats error');
      return {
        hits: this.stats.hits,
        misses: this.stats.misses,
        keys: 0,
        memory: 'unknown',
      };
    }
  }

  /**
   * Reset cache statistics
   */
  resetStats(): void {
    this.stats.hits = 0;
    this.stats.misses = 0;
  }

  /**
   * Get or set cache value (cache-aside pattern)
   * @param key - Cache key
   * @param factory - Factory function to generate value if not cached
   * @param ttl - Time to live in seconds
   * @returns Cached or freshly generated value
   */
  async getOrSet<T>(key: string, factory: () => Promise<T>, ttl: number): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }
    const value = await factory();
    await this.set(key, value, ttl);
    return value;
  }

  /**
   * Build cache key with prefix and optional namespace
   * @param prefix - Key prefix
   * @param identifier - Unique identifier
   * @param namespace - Optional namespace
   * @returns Full cache key
   */
  buildKey(prefix: string, identifier: string, namespace?: string): string {
    return buildCacheKey(prefix, identifier, namespace);
  }

  /**
   * Build pattern for cache key matching
   * @param prefix - Key prefix
   * @param namespace - Optional namespace
   * @returns Pattern for Valkey scan
   */
  buildPattern(prefix: string, namespace?: string): string {
    return buildCachePattern(prefix, namespace);
  }

  /**
   * Invalidate cache by tags
   * Note: Limited support in Valkey-Glide
   * @param tags - Array of tags to invalidate
   */
  async invalidateByTags(tags: string[]): Promise<number> {
    logger.warn({ tags }, 'Tag-based invalidation not fully supported in Valkey-Glide');
    return 0;
  }

  /**
   * Add tag to a cache key for later invalidation
   * @param key - Cache key
   * @param tag - Tag to add
   */
  async addTag(key: string, tag: string): Promise<void> {
    try {
      const tagKey = buildCacheKey(`tag:${tag}`, key);
      await this.valkey.set(tagKey, '1');
      await this.valkey.expire(tagKey, 86400 * 7); // 7 days
    } catch (error) {
      logger.error({ error, key, tag }, 'Cache addTag error');
    }
  }
}

/**
 * Singleton cache service instance
 */
let cacheServiceInstance: CacheService | null = null;

/**
 * Get or create cache service instance
 * @returns CacheService instance
 */
export function getCacheService(): CacheService {
  if (!cacheServiceInstance) {
    cacheServiceInstance = new CacheService();
  }
  return cacheServiceInstance;
}

/**
 * Reset cache service instance (useful for testing)
 */
export function resetCacheService(): void {
  cacheServiceInstance = null;
}

// Export namespaces for convenience
export { CACHE_NAMESPACES };
