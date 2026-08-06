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
import {
  CreateFraudExemptionDto,
  ListFraudExemptionsQueryDto,
} from '../dto/create-fraud-exemption.dto';
import { EnforceFraudSignalDto } from '../dto/enforce-fraud-signal.dto';
import { ListFraudSignalsQueryDto } from '../dto/list-fraud-signals.dto';
import { TransitionFraudSignalDto } from '../dto/transition-fraud-signal.dto';
import { DetectorAccuracyReport } from '../interfaces/detector-accuracy.interface';
import {
  FraudSignalInterface,
  ListFraudSignalsResult,
} from '../interfaces/fraud-signal.interface';
import {
  AntiFraudService,
  type FraudExemptionInterface,
  type PendingFraudCandidateInterface,
} from '../services/anti-fraud.service';
import { DetectorAccuracyService } from '../services/detector-accuracy.service';

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
  public constructor(
    private readonly antiFraudService: AntiFraudService,
    private readonly detectorAccuracyService: DetectorAccuracyService,
  ) {}

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

  /**
   * Per-detector-code accuracy over a window: opened, still open, resolved
   * (split by whether a human or the detector run closed it) and dismissed as a
   * false positive.
   *
   * `view`, matching every other read on this controller — checked against the
   * neighbours and not guessed. It is strictly read-only: the service behind it
   * issues nothing but `groupBy`, so an operator can look at their own
   * dismissal rate without that being an action on any signal.
   */
  @Get('detector-accuracy')
  @RequirePermission('fraud_signals', 'view')
  @ApiOperation({ summary: 'Per-detector dismissal / resolution counts over a window' })
  @ApiOkResponse({ description: 'Counts and false-positive rate per detector code' })
  public getDetectorAccuracy(@Query('days') days?: string): Promise<DetectorAccuracyReport> {
    const parsed = Number.parseInt(days ?? '30', 10);
    return this.detectorAccuracyService.getReport(Number.isFinite(parsed) ? parsed : 30);
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

  // ── Held candidates & exemptions ───────────────────────────────────────

  /**
   * Everything the detectors saw and declined to file — conditions still
   * gathering evidence and conditions an exemption is swallowing.
   *
   * `view`, like every other read here: this surface only ever tells an
   * operator what is NOT being reported, which is information a read-only role
   * needs more than most.
   */
  @Get('pending')
  @RequirePermission('fraud_signals', 'view')
  @ApiOperation({ summary: 'Candidates held back for sustained evidence or by an exemption' })
  public getPending(@Query('limit') limit?: string): Promise<readonly PendingFraudCandidateInterface[]> {
    const parsed = Number.parseInt(limit ?? '50', 10);
    return this.antiFraudService.listPendingCandidates(Number.isFinite(parsed) ? parsed : 50);
  }

  @Get('exemptions')
  @RequirePermission('fraud_signals', 'view')
  @ApiOperation({ summary: 'Lists anti-fraud exemptions (history included by default)' })
  public listExemptions(
    @Query() query: ListFraudExemptionsQueryDto,
  ): Promise<readonly FraudExemptionInterface[]> {
    return this.antiFraudService.listExemptions({
      userId: query.userId,
      activeOnly: query.activeOnly === true,
      limit: 100,
    });
  }

  /**
   * `resolve`, not a new action and not `enforce`.
   *
   * Checked against the neighbours rather than guessed: reads on this
   * controller take `view`, `enforce` is reserved for the one destructive panel
   * call (`ip-control` drop), and `resolve` is what gates
   * `POST /signals/:id/transition` — i.e. "Dismiss — false positive". An
   * exemption is that same judgement made durable and forward-looking, so it
   * belongs to whoever is already trusted to make it once.
   */
  @Post('exemptions')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('fraud_signals', 'resolve')
  @ApiOperation({ summary: 'Exempts a user from specific detector codes until a date' })
  public createExemption(
    @Body() dto: CreateFraudExemptionDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<FraudExemptionInterface> {
    return this.antiFraudService.createExemption({
      userId: dto.userId,
      codes: dto.codes,
      reason: dto.reason,
      expiresAt: new Date(dto.expiresAt),
      adminId: admin.id,
      requestMetadata: extractRequestMetadata(req),
    });
  }

  @Post('exemptions/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('fraud_signals', 'resolve')
  @ApiOperation({ summary: 'Revokes an exemption (the row is kept for the audit trail)' })
  public revokeExemption(
    @Param('id') id: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<FraudExemptionInterface> {
    return this.antiFraudService.revokeExemption({
      id,
      adminId: admin.id,
      requestMetadata: extractRequestMetadata(req),
    });
  }
}
