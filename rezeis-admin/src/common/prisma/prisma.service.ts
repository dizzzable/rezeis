import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { resolveDbPoolMax, resolveResourceProfile } from '../runtime/resource-profile.util';

/**
 * How long a query may wait for a database connection before it fails.
 *
 * pg-pool arms no timer of its own: without this a checkout waited for as long
 * as it took. With the database unreachable, opening a connection waits on the
 * OS's TCP connect (about two minutes on Linux); with it frozen — a paused
 * container, a VM stall — the TCP handshake completes and the startup reply
 * never comes, so it waits forever. Either way the request outlived the panel's
 * 30-s cut (`request-timeout.middleware.ts`): the client got its 408 while the
 * handler was still parked, and the next requests queued behind it.
 *
 * The one timer covers both ways a query gets a connection: opening a new one
 * (TCP connect and the startup handshake) and waiting for a pooled one while all
 * `max` are busy. It also caps the connection wait of every interactive
 * transaction, because Prisma takes that connection from this pool — so it is
 * the longest checkout a request path already chose, the wheel spin's and the
 * contest draw's `maxWait: 15_000`, rather than something shorter that would
 * quietly cut those. The plan migration's 30 s and 60 s ceilings are the only
 * ones it shortens, and they run in the worker. Half the 30-s cut: a dead
 * database now fails a request inside it instead of hanging past it.
 *
 * Not covered: a query already running on an open connection to a server that
 * stops answering. That needs a statement or socket timeout, not this.
 */
const DB_CONNECTION_TIMEOUT_MS = 15_000;

/**
 * Wraps the Prisma 7 client lifecycle for NestJS modules.
 *
 * Builds the connection string from individual DATABASE_* environment
 * variables (matching the `.env.example` layout). Falls back to
 * `DATABASE_URL` if set explicitly for backward compatibility.
 *
 * The connection-pool `max` is auto-sized to the container's resource budget
 * (see `resolveDbPoolMax`) so the same image runs well on a 1 GB VPS or a
 * 4 GB one; an explicit `DATABASE_POOL_SIZE` always overrides.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  public constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: resolveDatabaseUrl(),
        max: resolveDbPoolMax(),
        connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
      }),
    });
  }

  public async onModuleInit(): Promise<void> {
    const profile = resolveResourceProfile();
    this.logger.log(
      `DB pool max=${resolveDbPoolMax()} ` +
        `(tier=${profile.tier}, memory=${profile.memoryBudgetMb}MiB/${profile.memorySource}, cpu=${profile.cpuBudget})`,
    );
    await this.$connect();
  }

  public async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

function resolveDatabaseUrl(): string {
  // Explicit DATABASE_URL takes precedence (backward compat)
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0) {
    return process.env.DATABASE_URL;
  }
  const host = process.env.DATABASE_HOST ?? 'localhost';
  const port = process.env.DATABASE_PORT ?? '5432';
  const name = process.env.DATABASE_NAME ?? 'rezeis';
  const user = process.env.DATABASE_USER ?? 'rezeis';
  const password = encodeURIComponent(process.env.DATABASE_PASSWORD ?? '');
  return `postgresql://${user}:${password}@${host}:${port}/${name}`;
}
