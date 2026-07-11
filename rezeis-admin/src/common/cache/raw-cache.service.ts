import Redis from 'ioredis';
import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';

@Injectable()
export class RawCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RawCacheService.name);
  private redis: Redis;

  constructor() {}

  onModuleInit() {
    const redisUrl = process.env.REDIS_URL ?? this.buildRedisUrlFromDiscreteEnv();
    if (!redisUrl) {
      this.logger.warn('REDIS_URL / REDIS_HOST not set - cache operations will be no-ops');
      return;
    }
    this.redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
    this.redis.on('error', (err) => this.logger.error('Redis error', err.message));
    this.redis.on('connect', () => this.logger.log('Redis connected'));
  }

  /**
   * Production compose ships the discrete `REDIS_HOST` / `REDIS_PORT` /
   * `REDIS_PASSWORD` / `REDIS_NAME` vars (not a single `REDIS_URL`). Build the
   * URL from them when `REDIS_URL` is absent — otherwise this cache silently
   * no-ops and everything that depends on it (bot-signin magic-link tokens,
   * temp passwords, etc.) breaks invisibly. Mirrors reiwa's loadConfig fix.
   */
  private buildRedisUrlFromDiscreteEnv(): string | null {
    const host = process.env.REDIS_HOST?.trim();
    if (!host) return null;
    const port = process.env.REDIS_PORT?.trim() || '6379';
    const db = process.env.REDIS_NAME?.trim() || '0';
    const password = process.env.REDIS_PASSWORD?.trim();
    const auth = password ? `:${encodeURIComponent(password)}@` : '';
    return `redis://${auth}${host}:${port}/${db}`;
  }

  async onModuleDestroy() {
    if (this.redis) await this.redis.quit();
  }

  private isReady(): boolean {
    return this.redis?.status === 'ready';
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.isReady()) return null;
    const raw = await this.redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.isReady()) return;
    const raw = JSON.stringify(value);
    if (ttlSeconds) {
      await this.redis.set(key, raw, 'EX', ttlSeconds);
    } else {
      await this.redis.set(key, raw);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.isReady()) return;
    await this.redis.del(key);
  }

  async delMany(keys: string[]): Promise<void> {
    if (!this.isReady() || keys.length === 0) return;
    await this.redis.del(...keys);
  }

  async delByPattern(pattern: string): Promise<void> {
    if (!this.isReady()) return;
    // Use SCAN instead of KEYS to avoid blocking Redis on large keyspaces
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) await this.redis.del(...keys);
    } while (cursor !== '0');
  }

  async exists(key: string): Promise<boolean> {
    if (!this.isReady()) return false;
    return (await this.redis.exists(key)) === 1;
  }

  async setMany(entries: { key: string; value: unknown; ttlSeconds?: number }[]): Promise<void> {
    if (!this.isReady() || entries.length === 0) return;
    const pipe = this.redis.pipeline();
    for (const { key, value, ttlSeconds } of entries) {
      const raw = JSON.stringify(value);
      if (ttlSeconds) {
        pipe.set(key, raw, 'EX', ttlSeconds);
      } else {
        pipe.set(key, raw);
      }
    }
    await pipe.exec();
  }

  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttlSeconds: number,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const value = await factory();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  async increment(key: string, by = 1): Promise<number> {
    if (!this.isReady()) return 0;
    return this.redis.incrby(key, by);
  }

  /**
   * Atomically claim a one-time key (anti-replay / nonce dedup). Returns true
   * only for the FIRST caller within the TTL window; every later claim of the
   * same key returns false. Uses a single `SET key val NX EX ttl` so there is
   * no check-then-set race.
   *
   * FAIL-CLOSED: when the cache is unavailable we return false (treat as
   * "already seen") so a replay can never slip through during an outage — the
   * caller must reject rather than grant on an unverifiable nonce.
   */
  async claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
    if (!this.isReady()) return false;
    const result = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    if (!this.isReady()) return;
    await this.redis.expire(key, ttlSeconds);
  }
}
