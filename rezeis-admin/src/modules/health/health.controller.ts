import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';

import { HealthService } from './health.service';

/**
 * Health check endpoints — no auth required.
 *
 * Endpoints:
 *   GET /api/health       — full health with all components (for dashboards)
 *   GET /api/health/live  — simple liveness probe (for k8s/docker)
 *   GET /api/health/ready — readiness probe (DB + Redis must be up)
 */
@SkipThrottle()
@Public()
@Controller('health')
export class HealthController {
  public constructor(private readonly healthService: HealthService) {}

  @Get()
  public async getHealth(@Res() res: Response): Promise<void> {
    const health = await this.healthService.getHealth();
    const statusCode = health.status === 'error' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK;
    res.status(statusCode).json(health);
  }

  @Get('live')
  @HttpCode(HttpStatus.OK)
  public liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  public async readiness(@Res() res: Response): Promise<void> {
    const health = await this.healthService.getHealth();
    const isReady = health.components.database.status === 'up' && health.components.redis.status === 'up';
    res.status(isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: isReady ? 'ready' : 'not_ready',
      database: health.components.database.status,
      redis: health.components.redis.status,
    });
  }
}
