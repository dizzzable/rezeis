import { Body, Controller, Get, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import type { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import type { ConnectHelpSettingsView } from '../../connect-signal/connect-help-settings';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { ConnectHelpLogQueryDto } from '../dto/connect-help-log-query.dto';
import { UpdateConnectHelpSettingsDto } from '../dto/update-connect-help-settings.dto';
import { ConnectHelpSettingsService } from '../services/connect-help-settings.service';
import {
  ConnectHelpStatusService,
  type ConnectHelpLogPage,
  type ConnectHelpStatusView,
} from '../services/connect-help-status.service';

/**
 * «Уведомления» → «Пользовательские» → «Помощь с подключением».
 *
 * Existing permissions only: reading is `notifications:view`, like the rest of
 * the page; saving is `settings:edit`, what the page's other switches require
 * (`PATCH /admin/settings/notifications`).
 */
@ApiTags('admin/connect-help')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('notifications', 'view')
@Controller('admin/connect-help')
export class AdminConnectHelpController {
  public constructor(
    private readonly settingsService: ConnectHelpSettingsService,
    private readonly statusService: ConnectHelpStatusService,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Read the «Помощь с подключением» switches' })
  public getSettings(): Promise<ConnectHelpSettingsView> {
    return this.settingsService.read();
  }

  @Patch('settings')
  @RequirePermission('settings', 'edit')
  @ApiOperation({ summary: 'Change the «Помощь с подключением» switches' })
  public updateSettings(
    @Body() body: UpdateConnectHelpSettingsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<ConnectHelpSettingsView> {
    return this.settingsService.update({
      patch: {
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.delayHours === undefined ? {} : { delayHours: body.delayHours }),
        ...(body.includeTrials === undefined ? {} : { includeTrials: body.includeTrials }),
      },
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Get('status')
  @ApiOperation({ summary: 'The connection signal, the last cycle and the templates' })
  public getStatus(): Promise<ConnectHelpStatusView> {
    return this.statusService.status();
  }

  @Get('log')
  @ApiOperation({ summary: 'Every decision, newest first (cursor-paginated)' })
  public getLog(@Query() query: ConnectHelpLogQueryDto): Promise<ConnectHelpLogPage> {
    return this.statusService.log({
      cursor: query.cursor,
      outcome: query.outcome,
      limit: query.limit,
    });
  }
}
