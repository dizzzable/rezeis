import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
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
