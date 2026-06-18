import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { EnforceFraudSignalDto } from '../dto/enforce-fraud-signal.dto';
import { ListFraudSignalsQueryDto } from '../dto/list-fraud-signals.dto';
import { TransitionFraudSignalDto } from '../dto/transition-fraud-signal.dto';
import {
  FraudSignalInterface,
  ListFraudSignalsResult,
} from '../interfaces/fraud-signal.interface';
import { AntiFraudService } from '../services/anti-fraud.service';

interface FraudStatsResponse {
  readonly open: number;
  readonly acknowledged: number;
  readonly resolved: number;
  readonly dismissed: number;
  readonly bySeverity: { LOW: number; MEDIUM: number; HIGH: number };
}

@ApiTags('admin/fraud')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/fraud')
export class AdminFraudController {
  public constructor(private readonly antiFraudService: AntiFraudService) {}

  @Get('signals')
  @RequirePermission('fraud_signals', 'view')
  @ApiOperation({ summary: 'Lists fraud signals with cursor pagination and filters' })
  public listSignals(
    @Query() query: ListFraudSignalsQueryDto,
  ): Promise<ListFraudSignalsResult> {
    return this.antiFraudService.listSignals({
      status: query.status,
      severity: query.severity,
      code: query.code,
      limit: query.limit ?? 50,
      cursor: query.cursor ?? null,
    });
  }

  @Get('stats')
  @RequirePermission('fraud_signals', 'view')
  @ApiOperation({ summary: 'Aggregated counters for the fraud dashboard' })
  @ApiOkResponse({ description: 'Counters by status and (open) severity' })
  public getStats(): Promise<FraudStatsResponse> {
    return this.antiFraudService.getStats();
  }

  @Get('trend')
  @RequirePermission('fraud_signals', 'view')
  @ApiOperation({ summary: 'Severity-segmented signals-per-day trend' })
  public getTrend(@Query('days') days?: string) {
    const parsed = Number.parseInt(days ?? '14', 10);
    return this.antiFraudService.getTrend(Number.isFinite(parsed) ? parsed : 14);
  }

  @Get('top-offenders')
  @RequirePermission('fraud_signals', 'view')
  @ApiOperation({ summary: 'Top sharing offenders from open sharing signals' })
  public getTopOffenders(@Query('limit') limit?: string) {
    const parsed = Number.parseInt(limit ?? '10', 10);
    return this.antiFraudService.getTopOffenders(Number.isFinite(parsed) ? parsed : 10);
  }

  @Get('signals/:id')
  @RequirePermission('fraud_signals', 'view')
  @ApiOperation({ summary: 'Returns one fraud signal' })
  public getSignal(@Param('id') id: string): Promise<FraudSignalInterface> {
    return this.antiFraudService.getSignal(id);
  }

  @Post('signals/:id/transition')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('fraud_signals', 'resolve')
  @ApiOperation({ summary: 'Acknowledge / resolve / dismiss a fraud signal' })
  public transition(
    @Param('id') id: string,
    @Body() dto: TransitionFraudSignalDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<FraudSignalInterface> {
    return this.antiFraudService.transitionStatus({
      id,
      status: dto.status,
      note: dto.note ?? null,
      adminId: admin.id,
    });
  }

  @Post('detectors/run')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('fraud_signals', 'resolve')
  @ApiOperation({ summary: 'Manually triggers the detector run (in addition to the cron schedule)' })
  public async runDetectors(): Promise<{ ok: true; processed: number }> {
    const results = await this.antiFraudService.runDetectors();
    return { ok: true, processed: results.length };
  }

  @Get('signals/:id/live-ips')
  @RequirePermission('fraud_signals', 'view')
  @ApiOperation({ summary: 'Live per-node source IPs for the signal user (ip-control drilldown)' })
  public getLiveIps(@Param('id') id: string) {
    return this.antiFraudService.getSignalLiveIps(id);
  }

  @Post('signals/:id/enforce')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('fraud_signals', 'enforce')
  @ApiOperation({ summary: 'Drops the flagged user/IPs live connections via Remnawave ip-control' })
  public enforce(
    @Param('id') id: string,
    @Body() dto: EnforceFraudSignalDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    return this.antiFraudService.enforceDropConnections({
      signalId: id,
      mode: dto.mode ?? 'user',
      adminId: admin.id,
      requestMetadata: extractRequestMetadata(req),
    });
  }
}
