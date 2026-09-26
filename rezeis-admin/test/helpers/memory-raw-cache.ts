import type { RawCacheService } from '../../src/common/cache/raw-cache.service';

/**
 * `RawCacheService` in memory, for the cabinet-registry specs: JSON values as
 * Redis would hold them, `EX` honoured against a clock the spec moves, `SET NX`
 * for `claimOnce`, and the sorted-set index (`sortedIndexAdd` /
 * `sortedIndexNewest`) with Redis's order — score, then member. `down()` makes
 * it answer like a cache that is not connected (`null` reads, no-op writes,
 * `claimOnce` false); `failing()` makes every command throw, like a command
 * error.
 */
export function memoryRawCache(clock: { now: () => number } = { now: () => Date.now() }) {
  const data = new Map<string, { raw: string; expiresAt: number | null }>();
  const sets = new Map<string, { members: Map<string, number>; expiresAt: number | null }>();
  const mode = { down: false, failing: false };
  const commands: string[] = [];

  const live = (key: string): string | null => {
    const entry = data.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= clock.now()) {
      data.delete(key);
      return null;
    }
    return entry.raw;
  };
  const liveSet = (key: string): Map<string, number> | null => {
    const entry = sets.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= clock.now()) {
      sets.delete(key);
      return null;
    }
    return entry.members;
  };
  /** Ascending, as ZRANGE: by score, then by member. */
  const ranked = (members: Map<string, number>): string[] =>
    [...members.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([m]) => m);
  const guard = (command: string): boolean => {
    commands.push(command);
    if (mode.failing) throw new Error(`redis command failed: ${command}`);
    return !mode.down;
  };
  const parse = <T>(raw: string | null): T | null => {
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };

  const store = {
    get: async <T>(key: string): Promise<T | null> => {
      if (!guard(`get ${key}`)) return null;
      return parse<T>(live(key));
    },
    getMany: async <T>(keys: readonly string[]): Promise<Array<T | null> | null> => {
      if (!guard(`mget ${keys.join(' ')}`)) return null;
      return keys.map((key) => parse<T>(live(key)));
    },
    set: async (key: string, value: unknown, ttlSeconds?: number): Promise<void> => {
      if (!guard(`set ${key}`)) return;
      data.set(key, { raw: JSON.stringify(value), expiresAt: ttlSeconds ? clock.now() + ttlSeconds * 1000 : null });
    },
    del: async (key: string): Promise<void> => {
      if (!guard(`del ${key}`)) return;
      data.delete(key);
    },
    delMany: async (keys: string[]): Promise<void> => {
      if (!guard(`del ${keys.join(' ')}`)) return;
      for (const key of keys) data.delete(key);
    },
    exists: async (key: string): Promise<boolean> => {
      if (!guard(`exists ${key}`)) return false;
      return live(key) !== null;
    },
    claimOnce: async (key: string, ttlSeconds: number): Promise<boolean> => {
      if (!guard(`claim ${key}`)) return false;
      if (live(key) !== null) return false;
      data.set(key, { raw: '"1"', expiresAt: clock.now() + ttlSeconds * 1000 });
      return true;
    },
    sortedIndexAdd: async (
      key: string,
      member: string,
      score: number,
      options: { readonly cap: number; readonly ttlSeconds: number; readonly keepFrom?: number },
    ): Promise<string[]> => {
      if (!guard(`zadd ${key} ${score} ${member}`)) return [];
      const members = liveSet(key) ?? new Map<string, number>();
      members.set(member, score);
      sets.set(key, { members, expiresAt: clock.now() + options.ttlSeconds * 1000 });
      // ZCARD, then ZRANGEBYSCORE -inf (keepFrom LIMIT 0 excess.
      const order = ranked(members);
      const excess = order.length - options.cap;
      if (excess <= 0) return [];
      const keepFrom = options.keepFrom ?? Number.POSITIVE_INFINITY;
      const dropped = order.filter((candidate) => (members.get(candidate) ?? 0) < keepFrom).slice(0, excess);
      for (const gone of dropped) members.delete(gone);
      return dropped;
    },
    sortedIndexNewest: async (key: string, count: number): Promise<string[] | null> => {
      if (!guard(`zrevrange ${key} 0 ${count - 1}`)) return null;
      const members = liveSet(key);
      return members === null ? [] : ranked(members).reverse().slice(0, count);
    },
  };

  return {
    store: store as unknown as RawCacheService,
    data,
    sets,
    commands,
    /** The stored value of `key`, parsed; `undefined` when absent. */
    read: (key: string): unknown => {
      const raw = live(key);
      return raw === null ? undefined : JSON.parse(raw);
    },
    /** The members of a sorted-set index, lowest score first; `[]` when absent. */
    index: (key: string): string[] => {
      const members = liveSet(key);
      return members === null ? [] : ranked(members);
    },
    down: (value = true): void => {
      mode.down = value;
    },
    failing: (value = true): void => {
      mode.failing = value;
    },
  };
}
