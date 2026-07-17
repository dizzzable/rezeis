import { Body, Controller, Get, Param, Post, Query, RawBodyRequest, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { RemnawaveConfigProfileInterface } from '../interfaces/remnawave-config-profile.interface';
import {
  RemnawaveHealthInterface,
  RemnawaveHwidTopUserInterface,
  RemnawaveInfraProviderInterface,
  RemnawaveNodePluginInterface,
  RemnawaveSnippetInterface,
  RemnawaveSubpageConfigInterface,
  RemnawaveSubscriptionRequestEntryInterface,
  RemnawaveSubscriptionRequestStatsInterface,
  RemnawaveSubscriptionSettingsInterface,
  RemnawaveSubscriptionTemplateInterface,
  RemnawaveUserSummaryInterface,
} from '../interfaces/remnawave-extended.interface';
import { RemnawaveHostInterface } from '../interfaces/remnawave-host.interface';
import { RemnawaveHwidStatsInterface } from '../interfaces/remnawave-hwid-stats.interface';
import { RemnawaveNodeInterface } from '../interfaces/remnawave-node.interface';
import {
  RemnawaveExternalSquadDetailInterface,
  RemnawaveInternalSquadDetailInterface,
} from '../interfaces/remnawave-squad-detail.interface';
import { RemnawaveSquadOptionInterface } from '../interfaces/remnawave-squad-option.interface';
import { RemnawaveStatusInterface } from '../interfaces/remnawave-status.interface';
import {
  RemnawaveBandwidthStatsInterface,
  RemnawaveSystemRecapInterface,
  RemnawaveSystemStatsInterface,
} from '../interfaces/remnawave-system-stats.interface';
import { RemnawaveApiService, type RemnawaveNodeUserIps, type RemnawaveUserNodeIps, type RemnawaveDropConnectionsInput } from '../services/remnawave-api.service';
import {
  GeoDistribution,
  OnlineTrendPoint,
  RemnawaveMetricsCollectorService,
} from '../services/remnawave-metrics-collector.service';
import { RemnawaveCapabilities, RemnawaveVersionService } from '../services/remnawave-version.service';
import {
  RemnawaveWebhookService,
  WebhookEventSummary,
} from '../services/remnawave-webhook.service';
import { Public } from '../../../common/decorators/public.decorator';

@Controller('admin/remnawave')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('remnawave', 'view')
export class AdminRemnawaveController {
  public constructor(
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly metricsCollector: RemnawaveMetricsCollectorService,
    private readonly webhookService: RemnawaveWebhookService,
    private readonly versionService: RemnawaveVersionService,
  ) {}

  // ── Version & capabilities ──────────────────────────────────────────────────

  @Get('version')
  public async getCapabilities(): Promise<RemnawaveCapabilities> {
    return this.versionService.getCapabilities();
  }

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
  @RequirePermission('remnawave', 'edit')
  public async enableNode(@Param('uuid') uuid: string): Promise<void> {
    await this.remnawaveApiService.enableNode(uuid);
  }

  @Post('nodes/:uuid/disable')
  @RequirePermission('remnawave', 'edit')
  public async disableNode(@Param('uuid') uuid: string): Promise<void> {
    await this.remnawaveApiService.disableNode(uuid);
  }

  @Post('nodes/:uuid/restart')
  @RequirePermission('remnawave', 'edit')
  public async restartNode(@Param('uuid') uuid: string): Promise<void> {
    await this.remnawaveApiService.restartNode(uuid);
  }

  @Post('nodes/:uuid/reset-traffic')
  @RequirePermission('remnawave', 'edit')
  public async resetNodeTraffic(@Param('uuid') uuid: string): Promise<void> {
    await this.remnawaveApiService.resetNodeTraffic(uuid);
  }

  // ── Hosts ──────────────────────────────────────────────────────────────────

  @Get('hosts')
  public async getAllHosts(): Promise<RemnawaveHostInterface[]> {
    return this.remnawaveApiService.getAllHosts();
  }

  // ── Squads ─────────────────────────────────────────────────────────────────
  //
  // The admin "Remnawave → Squads" page consumes the *detail* shape (with
  // `membersCount` / `inboundsCount` counters that mirror Remnawave's own
  // UI). The plan-builder selects use the simpler `{uuid, name}` option
  // shape — it lives at `options/*` and is unchanged.

  @Get('internal-squads')
  public async getInternalSquads(): Promise<readonly RemnawaveInternalSquadDetailInterface[]> {
    return this.remnawaveApiService.getInternalSquadDetails();
  }

  @Get('external-squads')
  public async getExternalSquads(): Promise<readonly RemnawaveExternalSquadDetailInterface[]> {
    return this.remnawaveApiService.getExternalSquadDetails();
  }

  @Get('options/internal-squads')
  public async getInternalSquadOptions(): Promise<readonly RemnawaveSquadOptionInterface[]> {
    return this.remnawaveApiService.getInternalSquadOptions();
  }

  @Get('options/external-squads')
  public async getExternalSquadOptions(): Promise<readonly RemnawaveSquadOptionInterface[]> {
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

  @Get('hwid/top-users')
  public async getHwidTopUsers(): Promise<readonly RemnawaveHwidTopUserInterface[]> {
    return this.remnawaveApiService.getHwidTopUsers();
  }

  // ── Health ─────────────────────────────────────────────────────────────────

  @Get('system/health')
  public async getRemnawaveHealth(): Promise<RemnawaveHealthInterface | null> {
    return this.remnawaveApiService.getRemnawaveHealth();
  }

  // ── Subscription request history ───────────────────────────────────────────

  @Get('subscription-request-history/stats')
  public async getSubscriptionRequestHistoryStats(): Promise<RemnawaveSubscriptionRequestStatsInterface | null> {
    return this.remnawaveApiService.getSubscriptionRequestHistoryStats();
  }

  @Get('subscription-request-history')
  public async getSubscriptionRequestHistory(
    @Query('userUuid') userUuid?: string,
    @Query('limit') limit?: string,
  ): Promise<readonly RemnawaveSubscriptionRequestEntryInterface[]> {
    const parsedLimit = typeof limit === 'string' ? Math.min(parseInt(limit, 10) || 100, 500) : undefined;
    return this.remnawaveApiService.getSubscriptionRequestHistory({
      userUuid,
      limit: parsedLimit,
    });
  }

  // ── Catalog ────────────────────────────────────────────────────────────────

  @Get('snippets')
  public async getSnippets(): Promise<readonly RemnawaveSnippetInterface[]> {
    return this.remnawaveApiService.getSnippets();
  }

  @Get('subscription-page-configs')
  public async getSubscriptionPageConfigs(): Promise<readonly RemnawaveSubpageConfigInterface[]> {
    return this.remnawaveApiService.getSubscriptionPageConfigs();
  }

  @Get('subscription-templates')
  public async getSubscriptionTemplates(): Promise<readonly RemnawaveSubscriptionTemplateInterface[]> {
    return this.remnawaveApiService.getSubscriptionTemplates();
  }

  @Get('subscription-settings')
  public async getSubscriptionSettings(): Promise<RemnawaveSubscriptionSettingsInterface | null> {
    return this.remnawaveApiService.getSubscriptionSettings();
  }

  // ── Costs ──────────────────────────────────────────────────────────────────

  @Get('infra/providers')
  public async getInfraProviders(): Promise<readonly RemnawaveInfraProviderInterface[]> {
    return this.remnawaveApiService.getInfraProviders();
  }

  // ── Settings (read-only) ───────────────────────────────────────────────────

  @Get('node-plugins')
  public async getNodePlugins(): Promise<readonly RemnawaveNodePluginInterface[]> {
    return this.remnawaveApiService.getNodePlugins();
  }

  // ── User search ────────────────────────────────────────────────────────────

  @Get('users/resolve')
  public async resolveRemnawaveUser(
    @Query('telegramId') telegramId?: string,
    @Query('username') username?: string,
    @Query('email') email?: string,
    @Query('subscriptionUuid') subscriptionUuid?: string,
  ): Promise<RemnawaveUserSummaryInterface | null> {
    return this.remnawaveApiService.resolveRemnawaveUser({
      telegramId,
      username,
      email,
      subscriptionUuid,
    });
  }

  // ── Hosts (mutations beyond CRUD) ─────────────────────────────────────────

  @Post('hosts/reorder')
  @RequirePermission('remnawave', 'edit')
  public async reorderHosts(@Body() body: { readonly uuids: readonly string[] }): Promise<{ ok: true }> {
    await this.remnawaveApiService.reorderHosts(body?.uuids ?? []);
    return { ok: true };
  }

  // ── Live (ip-control: active sessions / source IPs) ─────────────────────────
  //
  // Matured on Remnawave 2.8+ (see RemnawaveVersionService.liveIpControl). The
  // SPA only surfaces the Live tab when the capability is on, but the routes
  // stay reachable so an operator can probe a single node/user on demand.

  @Get('live/node/:uuid')
  public async getNodeLiveSessions(
    @Param('uuid') uuid: string,
  ): Promise<readonly RemnawaveNodeUserIps[]> {
    return this.remnawaveApiService.fetchUsersIpsForNode(uuid);
  }

  @Get('live/user/:uuid')
  public async getUserLiveSessions(
    @Param('uuid') uuid: string,
  ): Promise<readonly RemnawaveUserNodeIps[]> {
    return this.remnawaveApiService.fetchUserIps(uuid);
  }

  @Post('live/drop-connections')
  @RequirePermission('remnawave', 'edit')
  public async dropConnections(
    @Body() body: RemnawaveDropConnectionsInput,
  ): Promise<{ ok: boolean }> {
    return this.remnawaveApiService.dropConnections(body);
  }
}

// ── Webhook Receiver (no JWT — uses HMAC signature) ──────────────────────────

@Controller('webhook/remnawave')
@Public()
export class RemnawaveWebhookController {
  public constructor(private readonly webhookService: RemnawaveWebhookService) {}

  @Post()
  public async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, unknown>,
  ): Promise<{ ok: boolean }> {
    // Remnawave signs the payload with HMAC-SHA256 over the JSON body and
    // sends it in `X-Remnawave-Signature`, per the official backend-contract.
    // Older/custom senders used `x-webhook-secret`, so we accept that as a
    // fallback for backward compatibility.
    const signature =
      (req.headers['x-remnawave-signature'] as string | undefined) ??
      (req.headers['x-webhook-secret'] as string | undefined);
    // Verify over the EXACT bytes Remnawave signed. Re-serialising the parsed
    // body (`JSON.stringify(body)`) can reorder keys / change spacing /
    // escaping, so the recomputed HMAC would never match and every event would
    // be silently dropped — which is exactly the "feed stays empty" symptom.
    // `rawBody` is populated by Nest (`rawBody: true` in main.ts).
    const rawBody =
      req.rawBody !== undefined ? req.rawBody.toString('utf8') : JSON.stringify(body);

    if (!this.webhookService.validateSignature(rawBody, signature)) {
      this.webhookService.logRejectedSignature(Boolean(signature), req.ip ?? null);
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
