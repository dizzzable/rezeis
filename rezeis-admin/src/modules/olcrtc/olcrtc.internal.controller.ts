import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { InternalAdminAuthGuard } from '../auth/guards/internal-admin-auth.guard';
import {
  OlcrtcClaimSessionDto,
  OlcrtcGatewayHeartbeatDto,
  OlcrtcSessionReportDto,
  OlcrtcTrafficReportDto,
} from './dto/olcrtc-agent.dto';
import { OlcrtcUserQueryDto } from './dto/olcrtc-user-query.dto';
import { OlcrtcSubscriptionPayload } from './interfaces/olcrtc-subscription.interface';
import { OlcrtcProvisioningService } from './olcrtc-provisioning.service';

@Controller('internal/olcrtc')
@UseGuards(InternalAdminAuthGuard)
export class OlcrtcInternalController {
  public constructor(private readonly olcrtcProvisioningService: OlcrtcProvisioningService) {}

  @Get('subscription')
  public async getSubscription(
    @Query() query: OlcrtcUserQueryDto,
  ): Promise<OlcrtcSubscriptionPayload> {
    return this.olcrtcProvisioningService.getSubscription(query);
  }

  @Post('subscription/provision')
  public async provisionSubscription(
    @Query() query: OlcrtcUserQueryDto,
  ): Promise<OlcrtcSubscriptionPayload> {
    return this.olcrtcProvisioningService.provisionSubscription(query);
  }

  @Post('gateways/heartbeat')
  public async recordGatewayHeartbeat(
    @Body() body: OlcrtcGatewayHeartbeatDto,
  ): Promise<Record<string, unknown>> {
    return this.olcrtcProvisioningService.recordGatewayHeartbeat(body);
  }

  @Post('sessions/claim')
  public async claimSession(
    @Body() body: OlcrtcClaimSessionDto,
  ): Promise<Record<string, unknown> | null> {
    return this.olcrtcProvisioningService.claimAgentSession(body);
  }

  @Post('sessions/:sessionId/report')
  public async reportSession(
    @Param('sessionId') sessionId: string,
    @Body() body: OlcrtcSessionReportDto,
  ): Promise<Record<string, unknown>> {
    return this.olcrtcProvisioningService.reportAgentSession(sessionId, body);
  }

  @Post('sessions/:sessionId/traffic')
  public async recordTraffic(
    @Param('sessionId') sessionId: string,
    @Body() body: OlcrtcTrafficReportDto,
  ): Promise<Record<string, unknown>> {
    return this.olcrtcProvisioningService.recordTraffic(sessionId, body);
  }
}
