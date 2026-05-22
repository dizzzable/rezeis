import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RemnawaveConfigProfileInterface } from '../interfaces/remnawave-config-profile.interface';
import { RemnawaveHostInterface } from '../interfaces/remnawave-host.interface';
import { RemnawaveHwidStatsInterface } from '../interfaces/remnawave-hwid-stats.interface';
import { RemnawaveNodeInterface } from '../interfaces/remnawave-node.interface';
import { RemnawaveSquadOptionInterface } from '../interfaces/remnawave-squad-option.interface';
import { RemnawaveStatusInterface } from '../interfaces/remnawave-status.interface';
import {
  RemnawaveBandwidthStatsInterface,
  RemnawaveSystemRecapInterface,
  RemnawaveSystemStatsInterface,
} from '../interfaces/remnawave-system-stats.interface';
import { RemnawaveApiService } from '../services/remnawave-api.service';
import {
  GeoDistribution,
  OnlineTrendPoint,
  RemnawaveMetricsCollectorService,
} from '../services/remnawave-metrics-collector.service';
import {
  RemnawaveWebhookService,
  WebhookEventSummary,
} from '../services/remnawave-webhook.service';

@Controller('admin/remnawave')
@UseGuards(AdminJwtAuthGuard)
export class AdminRemnawaveController {
  public constructor(
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly metricsCollector: RemnawaveMetricsCollectorService,
    private readonly webhookService: RemnawaveWebhookService,
  ) {}

  // ── Status ─────────────────────────────────────────────────────────────────

  @Get('status')
  public async getStatus(): Promise<RemnawaveStatusInterface> {
    return this.remnawaveApiService.getStatus();
  }

  // ── System Stats ───────────────────────────────────────────────────────────

  @Get('system/stats')
  public async getSystemStats(): Promise<RemnawaveSystemStatsInterface | null> {
    return this.remnawaveApiService.getSystemStats();
  }

  @Get('system/recap')
  public async getSystemRecap(): Promise<RemnawaveSystemRecapInterface | null> {
    return this.remnawaveApiService.getSystemRecap();
  }

  @Get('system/bandwidth')
  public async getBandwidthStats(): Promise<RemnawaveBandwidthStatsInterface | null> {
    return this.remnawaveApiService.getBandwidthStats();
  }

  // ── Metrics (stored trends) ────────────────────────────────────────────────

  @Get('metrics/online-trend')
  public async getOnlineTrend(
    @Query('hours') hours?: string,
  ): Promise<OnlineTrendPoint[]> {
    const h = hours ? Math.min(parseInt(hours, 10) || 24, 168) : 24;
    return this.metricsCollector.getOnlineTrend(h);
  }

  @Get('metrics/activity-feed')
  public async getActivityFeed(
    @Query('limit') limit?: string,
  ): Promise<WebhookEventSummary[]> {
    const l = limit ? Math.min(parseInt(limit, 10) || 50, 100) : 50;
    return this.webhookService.getRecentEvents(l);
  }

  @Get('metrics/geo-distribution')
  public async getGeoDistribution(): Promise<GeoDistribution[]> {
    return this.metricsCollector.getGeoDistribution();
  }

  // ── Nodes ──────────────────────────────────────────────────────────────────

  @Get('nodes')
  public async getAllNodes(): Promise<RemnawaveNodeInterface[]> {
    return this.remnawaveApiService.getAllNodes();
  }

  @Post('nodes/:uuid/enable')
  public async enableNode(@Param('uuid') uuid: string): Promise<void> {
    await this.remnawaveApiService.enableNode(uuid);
  }

  @Post('nodes/:uuid/disable')
  public async disableNode(@Param('uuid') uuid: string): Promise<void> {
    await this.remnawaveApiService.disableNode(uuid);
  }

  @Post('nodes/:uuid/restart')
  public async restartNode(@Param('uuid') uuid: string): Promise<void> {
    await this.remnawaveApiService.restartNode(uuid);
  }

  @Post('nodes/:uuid/reset-traffic')
  public async resetNodeTraffic(@Param('uuid') uuid: string): Promise<void> {
    await this.remnawaveApiService.resetNodeTraffic(uuid);
  }

  // ── Hosts ──────────────────────────────────────────────────────────────────

  @Get('hosts')
  public async getAllHosts(): Promise<RemnawaveHostInterface[]> {
    return this.remnawaveApiService.getAllHosts();
  }

  // ── Squads ─────────────────────────────────────────────────────────────────

  @Get('internal-squads')
  public async getInternalSquads(): Promise<readonly RemnawaveSquadOptionInterface[]> {
    return this.remnawaveApiService.getInternalSquadOptions();
  }

  @Get('external-squads')
  public async getExternalSquads(): Promise<readonly RemnawaveSquadOptionInterface[]> {
    return this.remnawaveApiService.getExternalSquadOptions();
  }

  // ── Config Profiles ────────────────────────────────────────────────────────

  @Get('config-profiles')
  public async getConfigProfiles(): Promise<RemnawaveConfigProfileInterface[]> {
    return this.remnawaveApiService.getConfigProfiles();
  }

  // ── HWID ───────────────────────────────────────────────────────────────────

  @Get('hwid/stats')
  public async getHwidStats(): Promise<RemnawaveHwidStatsInterface | null> {
    return this.remnawaveApiService.getHwidStats();
  }
}

// ── Webhook Receiver (no JWT — uses HMAC signature) ──────────────────────────

@Controller('webhook/remnawave')
export class RemnawaveWebhookController {
  public constructor(private readonly webhookService: RemnawaveWebhookService) {}

  @Post()
  public async handleWebhook(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
  ): Promise<{ ok: boolean }> {
    const signature = req.headers['x-webhook-secret'] as string | undefined;
    const rawBody = JSON.stringify(body);

    if (!this.webhookService.validateSignature(rawBody, signature)) {
      return { ok: false };
    }

    const eventType = typeof body['event'] === 'string'
      ? body['event']
      : typeof body['type'] === 'string'
        ? body['type']
        : 'unknown';

    const sourceIp = req.ip ?? null;
    await this.webhookService.handleEvent(eventType, body, sourceIp);

    return { ok: true };
  }
}
