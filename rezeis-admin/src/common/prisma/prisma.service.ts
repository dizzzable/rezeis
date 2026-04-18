import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Wraps the Prisma client lifecycle for NestJS modules.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  /**
   * Connects to the database when the module initializes.
   */
  public async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /**
   * Disconnects from the database when the module is destroyed.
   */
  public async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
