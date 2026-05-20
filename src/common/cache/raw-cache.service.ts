import Redis from 'ioredis';
import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';

@Injectable()
export class RawCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RawCacheService.name);
  private redis: Redis;

  constructor() {}

  onModuleInit() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      this.logger.warn('REDIS_URL not set - cache operations will be no-ops');
      return;
    }
    this.redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
    this.redis.on('error', (err) => this.logger.error('Redis error', err.message));
    this.redis.on('connect', () => this.logger.log('Redis connected'));
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
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) await this.redis.del(...keys);
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

  async expire(key: string, ttlSeconds: number): Promise<void> {
    if (!this.isReady()) return;
    await this.redis.expire(key, ttlSeconds);
  }
}
