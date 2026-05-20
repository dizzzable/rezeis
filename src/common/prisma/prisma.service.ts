import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Wraps the Prisma 7 client lifecycle for NestJS modules.
 *
 * Builds the connection string from individual DATABASE_* environment
 * variables (matching the `.env.example` layout). Falls back to
 * `DATABASE_URL` if set explicitly for backward compatibility.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  public constructor() {
    super({ adapter: new PrismaPg({ connectionString: resolveDatabaseUrl() }) });
  }

  public async onModuleInit(): Promise<void> {
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
