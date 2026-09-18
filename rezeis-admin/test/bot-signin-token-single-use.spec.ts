import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { RawCacheService } from '../src/common/cache/raw-cache.service';
import { BotSigninTokenService } from '../src/modules/web-auth/services/bot-signin-token.service';

/**
 * A bot sign-in token signs somebody in ONCE, however many requests present it
 * at the same moment.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The token is a five-minute cabinet credential: the Reiwa BFF hands it to
 * `consume` and mints a web session for whatever user comes back. `consume`
 * used to read the Redis key and then delete it — two commands — so two
 * requests racing on one token could both read the payload before either
 * deleted it, and both got a session.
 *
 * ── The Redis these cases run against ──────────────────────────────────────
 *
 * A fake, and deliberately not a stub of `RawCacheService`: the service under
 * test and the cache wrapper are both the REAL classes, and only the ioredis
 * client underneath is replaced. It models the two properties this is about:
 *
 *   - every command is a round trip. It is sent at once, applied when the
 *     server reaches it and answered after that, so the SEPARATE commands of
 *     two callers interleave in the order they were sent — GET, GET, DEL, DEL —
 *     as they do on a real server;
 *   - a MULTI/EXEC block is one round trip whose commands are applied together,
 *     with no other caller's command between them, which is what EXEC promises.
 *
 * The last block proves the first property is really there: through this fake,
 * the old read-then-delete lets two callers read one value. Without that case a
 * fake that answered every command in one synchronous burst would make the old
 * code pass as well.
 */

interface StoredValue {
  readonly value: string;
  readonly ttlSeconds: number | null;
}

class FakeRedis {
  public status: 'ready' | 'end' = 'ready';
  /** Every command in the order it was SENT. */
  public readonly sent: string[] = [];
  public readonly store = new Map<string, StoredValue>();
  /** When set, the next EXEC answers this instead of running its commands. */
  public nextExecAnswer: unknown = undefined;

  /** Applied when the server reaches it, one event-loop turn after sending. */
  private roundTrip<T>(apply: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      setImmediate(() => {
        try {
          resolve(apply());
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private readNow(key: string): string | null {
    return this.store.get(key)?.value ?? null;
  }

  private deleteNow(keys: readonly string[]): number {
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed += 1;
    return removed;
  }

  public get(key: string): Promise<string | null> {
    this.sent.push(`GET ${key}`);
    return this.roundTrip(() => this.readNow(key));
  }

  public set(key: string, value: string, mode?: string, seconds?: number): Promise<'OK'> {
    this.sent.push(`SET ${key}`);
    return this.roundTrip(() => {
      this.store.set(key, { value, ttlSeconds: mode === 'EX' && seconds !== undefined ? seconds : null });
      return 'OK' as const;
    });
  }

  public del(...keys: string[]): Promise<number> {
    this.sent.push(`DEL ${keys.join(' ')}`);
    return this.roundTrip(() => this.deleteNow(keys));
  }

  public multi() {
    const queued: Array<() => unknown> = [];
    const names: string[] = [];
    const chain = {
      get: (key: string) => {
        names.push(`GET ${key}`);
        queued.push(() => this.readNow(key));
        return chain;
      },
      del: (...keys: string[]) => {
        names.push(`DEL ${keys.join(' ')}`);
        queued.push(() => this.deleteNow(keys));
        return chain;
      },
      exec: () => {
        this.sent.push(`MULTI ${names.join('; ')} EXEC`);
        const canned = this.nextExecAnswer;
        this.nextExecAnswer = undefined;
        return this.roundTrip(() =>
          canned !== undefined ? canned : queued.map((command) => [null, command()] as const),
        );
      },
    };
    return chain;
  }
}

interface User {
  readonly id: string;
  readonly telegramId: bigint;
  isBlocked: boolean;
}

function setup() {
  const redis = new FakeRedis();
  const cache = new RawCacheService();
  // The ioredis client `onModuleInit` would have built. Everything above it —
  // `take`, `set`, `get`, `del` — is the production code.
  (cache as unknown as { redis: FakeRedis }).redis = redis;

  const users = new Map<string, User>([
    ['user-1', { id: 'user-1', telegramId: 777000111n, isBlocked: false }],
  ]);
  const prisma = {
    user: {
      findUnique: async (args: { where: { id?: string; telegramId?: bigint } }) => {
        const found = [...users.values()].find((user) =>
          args.where.id !== undefined ? user.id === args.where.id : user.telegramId === args.where.telegramId,
        );
        return found === undefined ? null : { id: found.id, isBlocked: found.isBlocked };
      },
    },
  };
  const service = new BotSigninTokenService(cache, prisma as never);
  return { redis, cache, service, users };
}

async function issuedToken(service: BotSigninTokenService): Promise<string> {
  const issued = await service.issue('777000111');
  assert.ok(issued, 'issue() refused a known, unblocked user');
  return issued.token;
}

const KEY_PREFIX = 'web-auth:bot-signin:';
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

describe('bot sign-in token: exactly one sign-in per token', () => {
  it('lets exactly one of eight simultaneous consumes sign anybody in', async () => {
    const { service, redis } = setup();
    const token = await issuedToken(service);

    const answers = await Promise.all(Array.from({ length: 8 }, () => service.consume(token)));

    const winners = answers.filter((answer) => answer !== null);
    assert.equal(
      winners.length,
      1,
      `${winners.length} requests got a session from one single-use token`,
    );
    assert.deepEqual(winners[0], { userId: 'user-1' });
    assert.equal(redis.store.size, 0, 'the token outlived its use');
  });

  it('finds nothing for a consume that comes after the one that won', async () => {
    const { service } = setup();
    const token = await issuedToken(service);

    assert.deepEqual(await service.consume(token), { userId: 'user-1' });
    assert.equal(await service.consume(token), null);
  });

  it('reads and removes the key in one transaction, never as two commands', async () => {
    const { service, redis } = setup();
    const token = await issuedToken(service);
    redis.sent.length = 0;

    await service.consume(token);

    const key = `${KEY_PREFIX}${sha256(token)}`;
    assert.deepEqual(redis.sent, [`MULTI GET ${key}; DEL ${key} EXEC`]);
  });
});

describe('bot sign-in token: the rules that did not change', () => {
  it('stores only the hash of the token, for five minutes', async () => {
    const { service, redis } = setup();
    const token = await issuedToken(service);

    assert.deepEqual([...redis.store.keys()], [`${KEY_PREFIX}${sha256(token)}`]);
    const stored = [...redis.store.values()][0]!;
    assert.equal(stored.ttlSeconds, 5 * 60);
    assert.deepEqual(JSON.parse(stored.value), { userId: 'user-1', telegramId: '777000111' });
    assert.ok(!stored.value.includes(token), 'the plaintext token was written to Redis');
  });

  it('refuses a malformed token without asking Redis anything', async () => {
    const { service, redis } = setup();
    await issuedToken(service);
    redis.sent.length = 0;

    for (const bad of ['a'.repeat(63), 'z'.repeat(64), `${'a'.repeat(64)}0`, 42 as unknown as string]) {
      assert.equal(await service.consume(bad), null);
    }
    assert.deepEqual(redis.sent, []);
  });

  it('refuses an unknown token', async () => {
    const { service } = setup();
    await issuedToken(service);

    assert.equal(await service.consume('b'.repeat(64)), null);
  });

  it('signs nobody in for a user blocked or gone since the token was issued, and spends the token', async () => {
    for (const change of ['blocked', 'deleted'] as const) {
      const { service, redis, users } = setup();
      const token = await issuedToken(service);
      if (change === 'blocked') users.get('user-1')!.isBlocked = true;
      else users.delete('user-1');

      assert.equal(await service.consume(token), null, change);
      assert.equal(redis.store.size, 0, `${change}: the token was left usable`);
    }
  });
});

describe('RawCacheService.take', () => {
  it('answers nothing for an absent key, and nothing without a connection', async () => {
    const { cache, redis } = setup();
    assert.equal(await cache.take('absent'), null);

    redis.status = 'end';
    redis.store.set('present', { value: '"x"', ttlSeconds: null });
    assert.equal(await cache.take('present'), null);
    assert.equal(redis.store.size, 1, 'it touched Redis without a connection');
  });

  it('throws a command error from inside the transaction, as get would', async () => {
    const { cache, redis } = setup();
    redis.nextExecAnswer = [
      [new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), null],
      [null, 1],
    ];

    await assert.rejects(() => cache.take('k'), /WRONGTYPE/);
  });

  it('answers nothing when the transaction did not run, or removed no key', async () => {
    const { cache, redis } = setup();
    redis.nextExecAnswer = null;
    assert.equal(await cache.take('k'), null);

    redis.nextExecAnswer = [
      [null, '"value"'],
      [null, 0],
    ];
    assert.equal(await cache.take('k'), null);
  });
});

describe('the fake Redis lets separate commands interleave, as a real server does', () => {
  it('lets two read-then-delete callers both read one value — the defect the cases above rule out', async () => {
    // Anti-vacuity. If this stopped holding, the eight-consume case would pass
    // against the old code too, and prove nothing.
    const { cache, redis } = setup();
    redis.store.set('one-time', { value: '"payload"', ttlSeconds: 300 });

    const readThenDelete = async (): Promise<string | null> => {
      const value = await cache.get<string>('one-time');
      await cache.del('one-time');
      return value;
    };
    const answers = await Promise.all([readThenDelete(), readThenDelete()]);

    assert.deepEqual(answers, ['payload', 'payload']);
    assert.deepEqual(redis.sent, ['GET one-time', 'GET one-time', 'DEL one-time', 'DEL one-time']);
  });
});
