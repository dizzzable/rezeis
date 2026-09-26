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

  /**
   * Reads a key and removes it in ONE step, so exactly one caller ever receives
   * its value — the primitive for single-use secrets such as bot sign-in tokens.
   *
   * `get` followed by `del` is two commands, and two callers can both read the
   * value before either of them deletes it: that is how one sign-in token could
   * mint two sessions. GET and DEL queued in one MULTI/EXEC run back to back on
   * the server with no other client's command between them, so a second caller's
   * GET already finds the key gone.
   *
   * MULTI rather than GETDEL: GETDEL needs Redis 6.2 — the bundled Valkey 9 has
   * it, but `REDIS_URL` may point at an operator's own, older server — while
   * MULTI/EXEC works on every version the queues run on.
   *
   * `null` when the key is absent or expired, when the cache is unavailable, and
   * when the transaction did not run. A command error inside it is thrown, as
   * `get` would throw it.
   */
  async take<T>(key: string): Promise<T | null> {
    if (!this.isReady()) return null;
    const results = await this.redis.multi().get(key).del(key).exec();
    if (results === null || results.length !== 2) return null;
    const [[readError, raw], [removeError, removed]] = results as [
      [Error | null, unknown],
      [Error | null, unknown],
    ];
    if (readError !== null) throw readError;
    if (removeError !== null) throw removeError;
    // Both halves ran in the same transaction, so a value and a removal of
    // exactly one key always come together. Asking for both costs nothing and
    // keeps this honest should the two ever disagree.
    if (typeof raw !== 'string' || removed !== 1) return null;
    return JSON.parse(raw) as T;
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

  /**
   * Several keys' values read as JSON in one MGET, in the order asked; `null`
   * in a slot whose key is absent or whose value is not JSON.
   *
   * `null` for the whole answer when the cache is unavailable, which is NOT a
   * list of nulls: a caller that decides something from absence has to tell
   * "nothing is there" from "could not look". A command error is thrown, as
   * `get` would throw it.
   */
  async getMany<T>(keys: readonly string[]): Promise<Array<T | null> | null> {
    if (!this.isReady()) return null;
    if (keys.length === 0) return [];
    const raws = await this.redis.mget(...keys);
    return keys.map((_key, index) => {
      const raw = raws[index];
      if (typeof raw !== 'string') return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    });
  }

  /**
   * An index kept as a sorted set: `member` scored by `score` (ZADD), the set
   * given `ttlSeconds` so an abandoned index goes too, and — past `cap`
   * members — the lowest-scored ones removed, but never one scored `keepFrom`
   * or higher: with it, the set holds more than `cap` while those do. Answers
   * the members it removed, so the caller can delete what they stood for.
   * Nothing when the cache is unavailable.
   */
  async sortedIndexAdd(
    key: string,
    member: string,
    score: number,
    options: { readonly cap: number; readonly ttlSeconds: number; readonly keepFrom?: number },
  ): Promise<string[]> {
    if (!this.isReady()) return [];
    await this.redis.zadd(key, score, member);
    await this.redis.expire(key, options.ttlSeconds);
    const excess = (await this.redis.zcard(key)) - options.cap;
    if (excess <= 0) return [];
    // The `excess` lowest-scored, of those scored below `keepFrom`.
    const below = options.keepFrom === undefined ? '+inf' : `(${options.keepFrom}`;
    const dropped = await this.redis.zrangebyscore(key, '-inf', below, 'LIMIT', 0, excess);
    if (dropped.length > 0) await this.redis.zrem(key, ...dropped);
    return dropped;
  }

  /**
   * The `count` highest-scored members of a sorted-set index, highest first;
   * `null` when the cache is unavailable (not the same answer as `[]`).
   */
  async sortedIndexNewest(key: string, count: number): Promise<string[] | null> {
    if (!this.isReady()) return null;
    return this.redis.zrevrange(key, 0, count - 1);
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
