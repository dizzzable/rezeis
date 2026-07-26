import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  CreateCampaignDto,
  CreatePlacementDto,
  UpdateCampaignDto,
  UpdatePlacementDto,
  SetFxRateDto,
} from '../dto/advertising.dto';
import { FxRateService } from '../../fx/fx-rate.service';
import { AdvertisingCampaignService } from '../services/advertising-campaign.service';
import { AdMetricsService } from '../services/ad-metrics.service';

@ApiTags('admin/advertising')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/advertising')
export class AdminAdvertisingController {
  public constructor(
    private readonly campaignService: AdvertisingCampaignService,
    private readonly metricsService: AdMetricsService,
    private readonly prismaService: PrismaService,
    private readonly fxRateService: FxRateService,
  ) {}

  @Get('overview')
  @RequirePermission('advertising', 'view')
  @ApiOperation({ summary: 'Top-level advertising-cabinet totals' })
  public getOverview() {
    return this.metricsService.getOverview();
  }

  /**
   * Reporting exchange rates. Fiat and listed coins are fetched automatically;
   * this exists for what no exchange quotes — Telegram Stars above all — because
   * without a rate that revenue can only be reported as unconverted.
   */
  @Get('fx-rates')
  @RequirePermission('advertising', 'view')
  @ApiOperation({ summary: 'Reporting currency and the known exchange rates' })
  public async listFxRates() {
    const base = this.fxRateService.getBaseCurrency();
    const rates = await this.prismaService.fxRate.findMany({
      where: { base },
      orderBy: [{ source: 'asc' }, { quote: 'asc' }],
      select: { quote: true, rate: true, source: true, fetchedAt: true },
    });
    return {
      base,
      rates: rates.map((r) => ({
        quote: r.quote,
        rate: Number(r.rate),
        source: r.source,
        fetchedAt: r.fetchedAt.toISOString(),
      })),
    };
  }

  @Post('fx-rates')
  @RequirePermission('advertising', 'edit')
  @ApiOperation({ summary: 'Sets an operator-owned rate (never overwritten by the auto-refresh)' })
  public async setFxRate(@Body() input: SetFxRateDto) {
    await this.fxRateService.setManualRate(input.quote, input.rate);
    return { ok: true };
  }

  @Get('campaigns')
  @RequirePermission('advertising', 'view')
  @ApiOperation({ summary: 'List campaigns with their placements' })
  public listCampaigns() {
    return this.campaignService.listCampaigns();
  }

  @Get('campaigns/:id')
  @RequirePermission('advertising', 'view')
  public getCampaign(@Param('id') id: string) {
    return this.campaignService.getCampaign(id);
  }

  @Post('campaigns')
  @RequirePermission('advertising', 'create')
  public async createCampaign(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
    @Body() input: CreateCampaignDto,
  ) {
    const campaign = await this.campaignService.createCampaign(input, admin.id);
    await this.audit(admin, req, 'advertising.campaign.created', { campaignId: campaign.id });
    return campaign;
  }

  @Patch('campaigns/:id')
  @RequirePermission('advertising', 'edit')
  public async updateCampaign(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() input: UpdateCampaignDto,
  ) {
    const campaign = await this.campaignService.updateCampaign(id, input);
    await this.audit(admin, req, 'advertising.campaign.updated', { campaignId: id });
    return campaign;
  }

  @Post('placements')
  @RequirePermission('advertising', 'create')
  public async createPlacement(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
    @Body() input: CreatePlacementDto,
  ) {
    const placement = await this.campaignService.createPlacement(input);
    await this.audit(admin, req, 'advertising.placement.created', { placementId: placement.id });
    return placement;
  }

  @Patch('placements/:id')
  @RequirePermission('advertising', 'edit')
  public async updatePlacement(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() input: UpdatePlacementDto,
  ) {
    const placement = await this.campaignService.updatePlacement(id, input);
    await this.audit(admin, req, 'advertising.placement.updated', { placementId: id });
    return placement;
  }

  @Delete('placements/:id')
  @RequirePermission('advertising', 'delete')
  public async deletePlacement(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    const result = await this.campaignService.deletePlacement(id);
    await this.audit(admin, req, 'advertising.placement.deleted', { placementId: id, ...result });
    return result;
  }

  @Get('placements/:id/metrics')
  @RequirePermission('advertising', 'view')
  public getPlacementMetrics(@Param('id') id: string) {
    return this.metricsService.getPlacementMetrics(id);
  }

  @Get('placements/:id/chart-data')
  @RequirePermission('advertising', 'view')
  public getPlacementChartData(@Param('id') id: string, @Query('days') days?: string) {
    const parsed = Number(days);
    const window = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 90) : 14;
    return this.metricsService.getPlacementChartData(id, window);
  }

  private async audit(
    admin: CurrentAdminInterface,
    req: Request,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const rm = extractRequestMetadata(req);
    await this.prismaService.adminAuditLog.create({
      data: {
        action,
        ipAddress: rm.remoteAddress,
        userAgent: rm.userAgent,
        metadata: { requestId: rm.requestId, ...metadata } as Prisma.InputJsonObject,
        adminUser: { connect: { id: admin.id } },
      },
    });
  }
}
