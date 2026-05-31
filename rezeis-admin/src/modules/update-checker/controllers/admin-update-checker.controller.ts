import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { ReportReiwaVersionDto } from '../dto/report-reiwa-version.dto';
import { UpdateCheckerService } from '../services/update-checker.service';

/**
 * Admin Update Checker — Phase 9.
 *
 * Permission model
 *   The endpoint is gated only by the regular admin JWT (not RBAC).
 *   Knowing whether the panel has an update available is a baseline
 *   capability for any signed-in operator; the resulting download
 *   URL points at GitHub, which is publicly visible anyway.
 */
@ApiTags('admin/update-checker')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/update-checker')
export class AdminUpdateCheckerController {
  public constructor(private readonly updateCheckerService: UpdateCheckerService) {}

  @Get('status')
  @ApiOperation({ summary: 'Returns the cached update-check result' })
  public getStatus(@Query('refresh') refresh?: string) {
    return this.updateCheckerService.getStatus(refresh === 'true');
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Forces a fresh check against the remote source' })
  public refresh() {
    return this.updateCheckerService.getStatus(true);
  }
}

/**
 * Internal version heartbeat — reiwa calls this on boot (and periodically)
 * to report its running version so the panel's Updates widget can show the
 * live reiwa version alongside the latest reiwa release. Guarded by the
 * internal API-token guard, same as every other `internal/*` route.
 */
@ApiTags('internal/update-checker')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/system')
export class InternalUpdateCheckerController {
  public constructor(private readonly updateCheckerService: UpdateCheckerService) {}

  @Post('reiwa-version')
  @ApiOperation({ summary: 'reiwa reports its running version' })
  public reportReiwaVersion(@Body() body: ReportReiwaVersionDto): { ok: true } {
    this.updateCheckerService.reportReiwaVersion(body.version);
    return { ok: true };
  }
}
