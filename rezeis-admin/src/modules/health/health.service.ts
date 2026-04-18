import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { appConfig } from '../../common/config/app.config';
import { PrismaService } from '../../common/prisma/prisma.service';

interface HealthResponse {
  readonly status: string;
  readonly service: string;
  readonly timestamp: string;
  readonly database: {
    readonly status: string;
  };
}

/**
 * Builds health check payloads for the service.
 */
@Injectable()
export class HealthService {
  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(appConfig.KEY)
    private readonly appConfiguration: ConfigType<typeof appConfig>,
  ) {}

  /**
   * Returns a structured service health payload with a database probe.
   */
  public async getHealth(): Promise<HealthResponse> {
    const isDatabaseAvailable: boolean = await this.checkDatabase();
    return {
      status: isDatabaseAvailable ? 'ok' : 'error',
      service: this.appConfiguration.serviceName,
      timestamp: new Date().toISOString(),
      database: {
        status: isDatabaseAvailable ? 'up' : 'down',
      },
    };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.prismaService.$queryRawUnsafe('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
