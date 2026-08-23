import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { RemediationCommandDto } from '../dto/remediation-command.dto';
import { AddOnEntitlementInspectionService } from '../services/add-on-entitlement-inspection.service';
import { AddOnEntitlementRemediationService } from '../services/add-on-entitlement-remediation.service';
import { EntitlementMetricsService } from '../services/entitlement-metrics.service';

/**
 * Admin remediation surface for durable add-on entitlements (T-013).
 *
 * Read: delivery/SLO metrics + per-subscription inspection (ledger, projection,
 * incidents, device plans; restricted HWID display). Mutations: retry sync,
 * force reconcile, acknowledge incident, compensating reversal, approve blocked
 * device plan — each on a distinct least-privilege permission with a mandatory
 * reason + command key and an immutable `AdminAuditLog` entry. No direct ledger
 * editing.
 *
 * `commandKey` is a real idempotency key on `reverse`, `acknowledge` and
 * `approve` — a replay of the same key produces one effect and the same
 * answer, enforced in `AddOnEntitlementRemediationService`, not here. On
 * `retry-sync` and `reconcile` it is ADVISORY: audited, not deduplicated,
 * because neither has a row to claim it against without a migration. That
 * split is spelled out on the service, and callers must not assume otherwise.
 */
@Controller('admin/add-on-entitlements')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
export class AdminAddOnEntitlementsController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly inspectionService: AddOnEntitlementInspectionService,
    private readonly metricsService: EntitlementMetricsService,
    private readonly remediationService: AddOnEntitlementRemediationService,
  ) {}

  @Get('metrics')
  @RequirePermission('add_on_entitlements', 'view')
  public async getMetrics() {
    return this.metricsService.collect();
  }

  @Get('subscriptions/:subscriptionId')
  @RequirePermission('add_on_entitlements', 'view')
  public async inspectSubscription(@Param('subscriptionId') subscriptionId: string) {
    return this.inspectionService.inspectSubscription(subscriptionId);
  }

  @Post('subscriptions/:subscriptionId/retry-sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('add_on_entitlements', 'run')
  public async retrySync(
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: RemediationCommandDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    // `commandKey` is ADVISORY here — audited below, not deduplicated. Replaying
    // it re-claims whatever is FAILED *now*, so the answer can differ.
    const result = await this.remediationService.retryProfileSync(subscriptionId);
    await this.audit(admin, req, 'add_on_entitlements.retry_sync', {
      subscriptionId,
      commandKey: body.commandKey,
      reason: body.reason,
      retried: result.retried,
    });
    return result;
  }

  @Post('subscriptions/:subscriptionId/reconcile')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('add_on_entitlements', 'resolve')
  public async reconcile(
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: RemediationCommandDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    // `commandKey` is ADVISORY here — audited below, not deduplicated. The push
    // itself does not double-apply (the recompute holds a row lock and reports
    // `changed: false`), but a replay answers differently from the first call.
    const result = await this.remediationService.forceReconcile(subscriptionId);
    await this.audit(admin, req, 'add_on_entitlements.force_reconcile', {
      subscriptionId,
      commandKey: body.commandKey,
      reason: body.reason,
      changed: result.changed,
      desiredRevision: result.desiredRevision,
    });
    return result;
  }

  @Post('incidents/:incidentId/acknowledge')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('add_on_entitlements', 'resolve')
  public async acknowledgeIncident(
    @Param('incidentId') incidentId: string,
    @Body() body: RemediationCommandDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const result = await this.remediationService.acknowledgeIncident(incidentId, {
      actorId: admin.id,
      commandKey: body.commandKey,
      reason: body.reason,
    });
    await this.audit(admin, req, 'add_on_entitlements.acknowledge_incident', {
      incidentId,
      commandKey: body.commandKey,
      reason: body.reason,
      changed: result.changed,
    });
    return result;
  }

  @Post('entitlements/:entitlementId/reverse')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('add_on_entitlements', 'enforce')
  public async reverseEntitlement(
    @Param('entitlementId') entitlementId: string,
    @Body() body: RemediationCommandDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const result = await this.remediationService.reverseEntitlement(entitlementId, {
      actorId: admin.id,
      commandKey: body.commandKey,
      reason: body.reason,
    });
    await this.audit(admin, req, 'add_on_entitlements.reverse', {
      entitlementId,
      commandKey: body.commandKey,
      reason: body.reason,
      state: result.state,
      changed: result.changed,
    });
    return result;
  }

  @Post('device-plans/:planId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('add_on_entitlements', 'moderate')
  public async approveDevicePlan(
    @Param('planId') planId: string,
    @Body() body: RemediationCommandDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const result = await this.remediationService.approveDevicePlan(planId, {
      actorId: admin.id,
      commandKey: body.commandKey,
      reason: body.reason,
    });
    // Audited BEFORE the refusal is thrown: an override that was asked for and
    // declined is still an operator action, and an audit trail that only
    // records the commands that worked is not an audit trail.
    await this.audit(admin, req, 'add_on_entitlements.approve_device_plan', {
      planId,
      commandKey: body.commandKey,
      reason: body.reason,
      status: result.status,
      declineReason: result.reason ?? null,
    });
    // A decline must not travel as 200. Everything else does: `DEFERRED`,
    // `BLOCKED`, `SUPERSEDED` and `REMEDIATION_REQUIRED` mean the override RAN
    // and reached that outcome, which is a result, not an error — the caller
    // branches on `status` (`add-on-entitlement-inspector.tsx` does).
    // `REFUSED` means nothing happened at all.
    if (result.status === 'REFUSED') {
      if (result.reason === 'PLAN_NOT_FOUND') {
        throw new NotFoundException('Device reduction plan not found');
      }
      throw new ConflictException(
        `Device reduction plan cannot be re-run: ${result.reason ?? 'REFUSED'}`,
      );
    }
    return result;
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
