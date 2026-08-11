import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../rbac/guards/rbac.guard';
import { OlcrtcUpdateGatewayDto } from './dto/olcrtc-admin-gateway.dto';
import { OlcrtcCreateProfileDto, OlcrtcUpdateProfileDto } from './dto/olcrtc-admin-profile.dto';
import { OlcrtcCreateProviderAccountDto, OlcrtcUpdateProviderAccountDto } from './dto/olcrtc-admin-provider-account.dto';
import { OlcrtcUpdateRoomDto } from './dto/olcrtc-admin-room.dto';
import { OlcrtcUpdateSessionDto } from './dto/olcrtc-admin-session.dto';
import { OlcrtcAdminTrafficQueryDto } from './dto/olcrtc-admin-traffic-query.dto';
import { OlcrtcAdminOverview, OlcrtcAdminService, OlcrtcTrafficLedgerItem } from './olcrtc-admin.service';
import { OlcrtcLifecycleResult } from './olcrtc-lifecycle.service';

@Controller('admin/olcrtc')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('olcrtc', 'view')
export class OlcrtcAdminController {
  public constructor(private readonly olcrtcAdminService: OlcrtcAdminService) {}

  @Get('overview')
  public getOverview(): Promise<OlcrtcAdminOverview> {
    return this.olcrtcAdminService.getOverview();
  }

  @Get('traffic')
  public listTraffic(
    @Query() query: OlcrtcAdminTrafficQueryDto,
  ): Promise<{ readonly items: readonly OlcrtcTrafficLedgerItem[] }> {
    return this.olcrtcAdminService.listTrafficLedger(query);
  }

  @Post('provider-accounts')
  @RequirePermission('olcrtc', 'create')
  public createProviderAccount(
    @Body() body: OlcrtcCreateProviderAccountDto,
  ): Promise<Record<string, unknown>> {
    return this.olcrtcAdminService.createProviderAccount(body);
  }

  @Patch('provider-accounts/:id')
  @RequirePermission('olcrtc', 'edit')
  public updateProviderAccount(
    @Param('id') id: string,
    @Body() body: OlcrtcUpdateProviderAccountDto,
  ): Promise<Record<string, unknown>> {
    return this.olcrtcAdminService.updateProviderAccount(id, body);
  }

  @Post('profiles')
  @RequirePermission('olcrtc', 'create')
  public createProfile(@Body() body: OlcrtcCreateProfileDto): Promise<Record<string, unknown>> {
    return this.olcrtcAdminService.createProfile(body);
  }

  @Patch('profiles/:id')
  @RequirePermission('olcrtc', 'edit')
  public updateProfile(
    @Param('id') id: string,
    @Body() body: OlcrtcUpdateProfileDto,
  ): Promise<Record<string, unknown>> {
    return this.olcrtcAdminService.updateProfile(id, body);
  }

  @Patch('gateways/:id')
  @RequirePermission('olcrtc', 'edit')
  public updateGateway(
    @Param('id') id: string,
    @Body() body: OlcrtcUpdateGatewayDto,
  ): Promise<Record<string, unknown>> {
    return this.olcrtcAdminService.updateGateway(id, body);
  }

  @Patch('rooms/:id')
  @RequirePermission('olcrtc', 'edit')
  public updateRoom(
    @Param('id') id: string,
    @Body() body: OlcrtcUpdateRoomDto,
  ): Promise<Record<string, unknown>> {
    return this.olcrtcAdminService.updateRoom(id, body);
  }

  @Patch('sessions/:id')
  @RequirePermission('olcrtc', 'edit')
  public updateSession(
    @Param('id') id: string,
    @Body() body: OlcrtcUpdateSessionDto,
  ): Promise<Record<string, unknown>> {
    return this.olcrtcAdminService.updateSession(id, body);
  }

  @Post('lifecycle/run')
  @RequirePermission('olcrtc', 'run')
  public runLifecycle(): Promise<OlcrtcLifecycleResult> {
    return this.olcrtcAdminService.runLifecycleOnce();
  }
}
