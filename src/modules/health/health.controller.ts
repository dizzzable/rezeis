import { Controller, Get } from '@nestjs/common';

import { HealthService } from './health.service';

interface HealthResponse {
  readonly status: string;
  readonly service: string;
  readonly timestamp: string;
  readonly database: {
    readonly status: string;
  };
}

/**
 * Exposes service health endpoints.
 */
@Controller('health')
export class HealthController {
  public constructor(private readonly healthService: HealthService) {}

  /**
   * Returns a db-aware service health response.
   */
  @Get()
  public async getHealth(): Promise<HealthResponse> {
    return this.healthService.getHealth();
  }
}
