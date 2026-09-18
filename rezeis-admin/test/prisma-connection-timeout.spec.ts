import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { describe, it, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Pool, type PoolConfig } from 'pg';

import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * A database that stops answering fails a query; it does not park it.
 * ═══════════════════════════════════════════════════════════════════
 * pg-pool arms no timer unless `connectionTimeoutMillis` is set, and
 * `PrismaService` built its pool without one — so a checkout against a frozen
 * database (a paused container, a VM stall: the TCP handshake completes, the
 * startup reply never comes) waited forever, and every request behind it
 * outlived the panel's 30-s cut.
 *
 * The stand-in is a TCP server on loopback that accepts the connection and
 * never writes a byte: exactly that frozen server, with nothing routed anywhere.
 */

interface SilentDatabase {
  readonly url: string;
  readonly connections: () => number;
  readonly close: () => Promise<void>;
}

async function silentDatabase(): Promise<SilentDatabase> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `postgresql://rezeis:secret@127.0.0.1:${port}/rezeis`,
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A `PrismaService` built the way Nest builds it, pointed at `url`. */
function serviceFor(url: string): PrismaService {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  try {
    return new PrismaService();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

/** The exact `pg.Pool` configuration `PrismaPg` will hand to `new Pool(...)`. */
function poolConfigOf(service: PrismaService): PoolConfig {
  const config = (service as unknown as { _engineConfig?: { adapter?: { config?: PoolConfig } } })._engineConfig
    ?.adapter?.config;
  assert.ok(config, 'PrismaService no longer carries its adapter config where this reads it');
  return config;
}

/** Turns of the event loop, for real I/O to land; `setImmediate` is never mocked here. */
async function turns(count: number, until: () => boolean = () => false): Promise<void> {
  for (let turn = 0; turn < count && !until(); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('PrismaService connection timeout', () => {
  it('gives up on a database that takes the connection and never answers — at 15 s, not before', async (t: TestContext) => {
    const database = await silentDatabase();
    t.after(() => database.close());
    const config = poolConfigOf(serviceFor(database.url));

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pool = new Pool(config);
    let outcome: 'waiting' | 'connected' | Error = 'waiting';
    // Read through a function: the callbacks below set `outcome`, and an assertion
    // on the variable itself would narrow it for the rest of the test.
    const outcomeNow = (): 'waiting' | 'connected' | Error => outcome;
    const checkout = pool.connect().then(
      (client) => {
        outcome = 'connected';
        client.release();
      },
      (error: Error) => {
        outcome = error;
      },
    );

    // The connection is really open and the startup message sent: the stand-in is
    // not refusing anything, it is simply silent.
    await turns(5_000, () => database.connections() === 1);
    assert.equal(database.connections(), 1, 'the pool never reached the stand-in database');

    t.mock.timers.tick(14_999);
    await turns(50);
    assert.equal(outcomeNow(), 'waiting', 'gave up before 15 s');

    t.mock.timers.tick(1);
    await turns(5_000, () => outcomeNow() !== 'waiting');
    const settled = outcomeNow();
    assert.ok(
      settled instanceof Error,
      'still waiting on a database that never answers after 15 s: the pool has no connection timeout',
    );
    assert.match(settled.message, /timeout/i);
    await checkout;
    await pool.end();
  });

  it('fails a real query through the service instead of hanging', { timeout: 60_000 }, async (t: TestContext) => {
    // End to end, on the real clock: Prisma, the adapter, the pool and the socket,
    // with nothing faked but the database. Slow on purpose — 15 s is the thing
    // being proved.
    const database = await silentDatabase();
    t.after(() => database.close());
    const service = serviceFor(database.url);
    t.after(() => service.$disconnect().catch(() => undefined));

    const guard = new AbortController();
    const started = Date.now();
    const outcome = await Promise.race([
      service.$queryRawUnsafe('SELECT 1').then(
        () => 'answered' as const,
        (error: unknown) => error,
      ),
      sleep(25_000, 'still waiting after 25 s' as const, { signal: guard.signal, ref: false }).catch(() => 'aborted' as const),
    ]);
    guard.abort();
    const elapsedMs = Date.now() - started;

    assert.ok(outcome instanceof Error, `the query did not fail: ${String(outcome)}`);
    assert.ok(
      elapsedMs >= 14_000 && elapsedMs < 20_000,
      `the query failed after ${elapsedMs} ms — not the 15 s connection timeout`,
    );
    assert.equal(database.connections(), 1);
  });
});
