import { Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { AutoRenewScheduler } from '../auto-renew.scheduler';

/**
 * Operator surface for the auto-renewal pipeline. Lets the admin observe
 * the last cron tick and trigger an out-of-band cycle when investigating
 * support reports.
 */
@ApiTags('admin/auto-renew')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/auto-renew')
export class AdminAutoRenewController {
  public constructor(private readonly autoRenewScheduler: AutoRenewScheduler) {}

  @Get('status')
  @ApiOperation({ summary: 'Last cycle result + cron schedule snapshot' })
  public status() {
    return this.autoRenewScheduler.getStatus();
  }

  @Post('run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the cycle synchronously and return its result' })
  public run() {
    return this.autoRenewScheduler.runOnce();
  }
}
