import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { AdjustPartnerBalanceDto } from '../dto/adjust-partner-balance.dto';
import {
  PartnerAnalyticsRangeQueryDto,
  PartnerAnalyticsTimeseriesQueryDto,
  PartnerAnalyticsTopPartnersQueryDto,
} from '../dto/analytics-range-query.dto';
import { PartnerAnalyticsCohortQueryDto } from '../dto/analytics-cohort-query.dto';
import { BulkApproveWithdrawalsDto } from '../dto/bulk-approve-withdrawals.dto';
import {
  ListPartnersQueryDto,
  ListPartnerWithdrawalsQueryDto,
} from '../dto/list-partners-query.dto';
import { PartnerDetailPagingQueryDto } from '../dto/partner-detail-paging.dto';
import { ProcessPartnerWithdrawalDto } from '../dto/process-partner-withdrawal.dto';
import {
  PartnerCohortInterface,
  PartnerFunnelInterface,
  PartnerGatewayDistributionInterface,
  PartnerKpiInterface,
  PartnerLevelDistributionInterface,
  PartnerTimeseriesInterface,
  TopPartnersInterface,
  WithdrawalThroughputInterface,
} from '../interfaces/partner-analytics.interface';
import {
  PartnerAuditListInterface,
  PartnerDetailOverviewInterface,
  PartnerEarningsListInterface,
  PartnerReferralsListInterface,
  PartnerWithdrawalListInterface,
} from '../interfaces/partner-detail.interface';
import {
  PartnerInterface,
  PartnerStatsInterface,
  PartnerWithdrawalInterface,
} from '../interfaces/partner.interface';
import { AdminPartnerAnalyticsService } from '../services/admin-partner-analytics.service';
import { PartnerCsvExportService } from '../services/partner-csv-export.service';
import { PartnerDetailService } from '../services/partner-detail.service';
import { PartnersService } from '../services/partners.service';

@ApiTags('admin/partners')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/partners')
export class AdminPartnersController {
  public constructor(
    private readonly partnersService: PartnersService,
    private readonly partnerDetailService: PartnerDetailService,
    private readonly partnerAnalyticsService: AdminPartnerAnalyticsService,
    private readonly partnerCsvExportService: PartnerCsvExportService,
  ) {}

  // ── List & stats ────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List partners' })
  public list(
    @Query() query: ListPartnersQueryDto,
  ): Promise<readonly PartnerInterface[]> {
    return this.partnersService.listPartners(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Bounded partner stats snapshot' })
  public getStats(): Promise<PartnerStatsInterface> {
    return this.partnersService.getStats();
  }

  // ── Withdrawals (admin) ────────────────────────────────────────────────

  @Get('withdrawals')
  @ApiOperation({ summary: 'List partner withdrawals' })
  public listWithdrawals(
    @Query() query: ListPartnerWithdrawalsQueryDto,
  ): Promise<readonly PartnerWithdrawalInterface[]> {
    return this.partnersService.listWithdrawals(query);
  }

  @Post('withdrawals/:withdrawalId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a pending partner withdrawal' })
  public approve(
    @Param('withdrawalId') withdrawalId: string,
    @Body() dto: ProcessPartnerWithdrawalDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<PartnerWithdrawalInterface> {
    return this.partnersService.approveWithdrawal({
      withdrawalId,
      dto,
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Post('withdrawals/:withdrawalId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a pending partner withdrawal (restores balance)' })
  public reject(
    @Param('withdrawalId') withdrawalId: string,
    @Body() dto: ProcessPartnerWithdrawalDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<PartnerWithdrawalInterface> {
    return this.partnersService.rejectWithdrawal({
      withdrawalId,
      dto,
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Post('withdrawals/bulk-approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve multiple pending withdrawals in a single operator action' })
  public bulkApproveWithdrawals(
    @Body() dto: BulkApproveWithdrawalsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<{
    readonly approved: number;
    readonly failed: number;
    readonly errors: ReadonlyArray<{ id: string; error: string }>;
  }> {
    return this.partnersService.bulkApproveWithdrawals({
      withdrawalIds: dto.withdrawalIds,
      adminComment: dto.adminComment ?? null,
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  // ── Partner detail (drawer) ────────────────────────────────────────────

  @Get(':partnerId/overview')
  @ApiOperation({ summary: 'Partner overview with metrics aggregates' })
  public getOverview(
    @Param('partnerId') partnerId: string,
  ): Promise<PartnerDetailOverviewInterface> {
    return this.partnerDetailService.getOverview(partnerId);
  }

  @Get(':partnerId/earnings')
  @ApiOperation({ summary: 'Partner earnings ledger' })
  public listPartnerEarnings(
    @Param('partnerId') partnerId: string,
    @Query() query: PartnerDetailPagingQueryDto,
  ): Promise<PartnerEarningsListInterface> {
    return this.partnerDetailService.listEarnings(partnerId, query);
  }

  @Get(':partnerId/referrals')
  @ApiOperation({ summary: 'Partner referral graph (L1/L2/L3)' })
  public listPartnerReferrals(
    @Param('partnerId') partnerId: string,
    @Query() query: PartnerDetailPagingQueryDto,
  ): Promise<PartnerReferralsListInterface> {
    return this.partnerDetailService.listReferrals(partnerId, query);
  }

  @Get(':partnerId/withdrawals')
  @ApiOperation({ summary: 'Per-partner withdrawal history' })
  public listPartnerWithdrawals(
    @Param('partnerId') partnerId: string,
    @Query() query: PartnerDetailPagingQueryDto,
  ): Promise<PartnerWithdrawalListInterface> {
    return this.partnerDetailService.listWithdrawals(partnerId, query);
  }

  @Get(':partnerId/audit')
  @ApiOperation({ summary: 'Audit-log entries for this partner' })
  public listPartnerAudit(
    @Param('partnerId') partnerId: string,
    @Query() query: PartnerDetailPagingQueryDto,
  ): Promise<PartnerAuditListInterface> {
    return this.partnerDetailService.listAuditEvents(partnerId, query);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  @Post(':partnerId/toggle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle partner active/inactive status' })
  public toggle(
    @Param('partnerId') partnerId: string,
  ): Promise<PartnerInterface> {
    return this.partnersService.togglePartnerStatus(partnerId);
  }

  @Post(':partnerId/adjust-balance')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually adjust partner balance (positive = credit, negative = debit)' })
  public adjustBalance(
    @Param('partnerId') partnerId: string,
    @Body() dto: AdjustPartnerBalanceDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<PartnerInterface> {
    return this.partnersService.adjustBalance({
      partnerId,
      amount: dto.amount,
      reason: dto.reason ?? null,
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  // ── Analytics ──────────────────────────────────────────────────────────

  @Get('analytics/funnel')
  @ApiOperation({ summary: 'Activation/earning/withdrawal funnel for the configured range' })
  public getAnalyticsFunnel(
    @Query() query: PartnerAnalyticsRangeQueryDto,
  ): Promise<PartnerFunnelInterface> {
    return this.partnerAnalyticsService.getFunnel(query);
  }

  @Get('analytics/timeseries')
  @ApiOperation({ summary: 'Bucketed time-series of earnings, withdrawals, new partners' })
  public getAnalyticsTimeseries(
    @Query() query: PartnerAnalyticsTimeseriesQueryDto,
  ): Promise<PartnerTimeseriesInterface> {
    return this.partnerAnalyticsService.getTimeseries(query);
  }

  @Get('analytics/top-partners')
  @ApiOperation({ summary: 'Top-N partners by earnings within range' })
  public getAnalyticsTopPartners(
    @Query() query: PartnerAnalyticsTopPartnersQueryDto,
  ): Promise<TopPartnersInterface> {
    return this.partnerAnalyticsService.getTopPartners(query);
  }

  @Get('analytics/level-distribution')
  @ApiOperation({ summary: 'Earnings distribution across L1/L2/L3' })
  public getAnalyticsLevelDistribution(
    @Query() query: PartnerAnalyticsRangeQueryDto,
  ): Promise<PartnerLevelDistributionInterface> {
    return this.partnerAnalyticsService.getLevelDistribution(query);
  }

  @Get('analytics/gateway-distribution')
  @ApiOperation({ summary: 'Earnings distribution across payment gateways' })
  public getAnalyticsGatewayDistribution(
    @Query() query: PartnerAnalyticsRangeQueryDto,
  ): Promise<PartnerGatewayDistributionInterface> {
    return this.partnerAnalyticsService.getGatewayDistribution(query);
  }

  @Get('analytics/withdrawal-throughput')
  @ApiOperation({ summary: 'Withdrawal throughput, approval rate, decision latency' })
  public getAnalyticsWithdrawalThroughput(
    @Query() query: PartnerAnalyticsRangeQueryDto,
  ): Promise<WithdrawalThroughputInterface> {
    return this.partnerAnalyticsService.getWithdrawalThroughput(query);
  }

  @Get('analytics/kpis')
  @ApiOperation({ summary: 'AOV, EPAP, activation rate, and repeat-purchase contribution' })
  public getAnalyticsKpis(
    @Query() query: PartnerAnalyticsRangeQueryDto,
  ): Promise<PartnerKpiInterface> {
    return this.partnerAnalyticsService.getKpis(query);
  }

  @Get('analytics/cohorts')
  @ApiOperation({ summary: 'Weekly cohort retention matrix' })
  public getAnalyticsCohorts(
    @Query() query: PartnerAnalyticsCohortQueryDto,
  ): Promise<PartnerCohortInterface> {
    return this.partnerAnalyticsService.getCohortRetention(query);
  }

  // ── CSV exports ────────────────────────────────────────────────────────

  @Get('export/partners.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="partners.csv"')
  @ApiOperation({ summary: 'Export the partner directory as streaming CSV' })
  public exportPartnersCsv(): StreamableFile {
    return new StreamableFile(this.partnerCsvExportService.streamPartners(), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="partners.csv"',
    });
  }

  @Get('export/top-partners.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="top-partners.csv"')
  @ApiOperation({ summary: 'Export the leaderboard as CSV' })
  public async exportTopPartnersCsv(
    @Query() query: PartnerAnalyticsRangeQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const csv = await this.partnerCsvExportService.exportTopPartners(query);
    response.send(csv);
  }

  @Get('export/withdrawals.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="partner-withdrawals.csv"')
  @ApiOperation({ summary: 'Export withdrawals as streaming CSV' })
  public exportWithdrawalsCsv(
    @Query() query: PartnerAnalyticsRangeQueryDto,
  ): StreamableFile {
    return new StreamableFile(this.partnerCsvExportService.streamWithdrawals(query), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="partner-withdrawals.csv"',
    });
  }

  @Get(':partnerId/export/earnings.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="partner-earnings.csv"')
  @ApiOperation({ summary: 'Export this partner earnings ledger as streaming CSV' })
  public exportEarningsCsv(@Param('partnerId') partnerId: string): StreamableFile {
    return new StreamableFile(this.partnerCsvExportService.streamEarnings(partnerId), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="partner-earnings.csv"',
    });
  }
}
