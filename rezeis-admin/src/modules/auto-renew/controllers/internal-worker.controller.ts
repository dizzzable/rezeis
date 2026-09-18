import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { AutoRenewService } from '../auto-renew.service';

interface ExpiryAlertsResultInterface {
  readonly expired: number;
  readonly warnings3d: number;
  readonly warnings1d: number;
  readonly cycleAt: string;
}

/**
 * InternalWorkerController
 * ────────────────────────
 * Exposes the auto-renew cycle to reiwa's external worker process. The
 * upstream `AutoRenewScheduler` already runs on its own cron inside
 * rezeis-admin; this endpoint is for situations where reiwa wants to
 * force a cycle (e.g. after a known mass-purchase or to compensate for
 * a stalled scheduler in dev).
 */
@ApiTags('internal/worker')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/worker')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalWorkerController {
  public constructor(private readonly autoRenewService: AutoRenewService) {}

  @Get('expiry-alerts')
  @ApiOperation({ summary: 'Run a single auto-renew cycle and return the counters' })
  public async expiryAlerts(): Promise<ExpiryAlertsResultInterface> {
    const result = await this.autoRenewService.runCycle();
    return { ...result, cycleAt: new Date().toISOString() };
  }
}
