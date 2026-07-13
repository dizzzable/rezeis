/**
 * AdminUserSubscriptionsController
 * ────────────────────────────────
 * Subscription-related operations carved out of
 * `admin-user-management.controller.ts` so each controller stays focused
 * on a single domain. All routes share the `/admin/users` prefix and
 * `AdminJwtAuthGuard`, so the admin SPA continues to call the same paths
 * without any client-side changes.
 *
 * Covers:
 *   - Per-subscription mutations (status, limits, expiry, squads, delete)
 *   - Traffic reset / panel sync
 *   - Device list / revoke
 *   - "Give subscription" / "Grant trial" flows attached to a user by
 *     Telegram id
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Prisma, SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';
import { Request } from 'express';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { SubscriptionDeletionService } from '../../subscriptions/services/subscription-deletion.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { buildPlanSnapshot } from '../utils/plan-snapshot.util';

@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('subscriptions', 'view')
export class AdminUserSubscriptionsController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly systemEvents: SystemEventsService,
    private readonly subscriptionDeletionService: SubscriptionDeletionService,
  ) {}

  // ── Subscription Mutations ─────────────────────────────────────────────

  @Patch('subscriptions/:subscriptionId')
  @RequirePermission('subscriptions', 'edit')
  public async updateSubscription(
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const sub = await this.prismaService.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new NotFoundException('Subscription not found');

    const data: Prisma.SubscriptionUpdateInput = {};
    let assignedPlanId: string | null = null;

    if (body.planId !== undefined && body.planId !== null) {
      const planId = String(body.planId);
      const plan = await this.prismaService.plan.findUnique({ where: { id: planId } });
      if (!plan) throw new NotFoundException('Plan not found');
      data.planSnapshot = buildPlanSnapshot(plan);
      // Plans dictate the limits/squads at the moment of assignment.
      data.trafficLimit = plan.trafficLimit;
      data.deviceLimit = plan.deviceLimit;
      data.internalSquads = Array.isArray(plan.internalSquads) ? [...plan.internalSquads] : [];
      data.externalSquad = plan.externalSquad ?? null;
      assignedPlanId = plan.id;
    }
    if (body.status !== undefined) data.status = body.status as SubscriptionStatus;
    if (body.trafficLimit !== undefined && assignedPlanId === null) {
      data.trafficLimit = Number(body.trafficLimit);
    }
    if (body.deviceLimit !== undefined && assignedPlanId === null) {
      data.deviceLimit = Number(body.deviceLimit);
    }
    if (body.expireDays !== undefined) {
      const days = Number(body.expireDays);
      const base = sub.expiresAt ?? new Date();
      const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
      if (newExpiry.getTime() < Date.now()) {
        throw new BadRequestException(
          'Resulting expiry date would be in the past. Use a larger positive value or a smaller negative value.',
        );
      }
      data.expiresAt = newExpiry;
    }
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      data.expiresAt = new Date(String(body.expiresAt));
    }

    const updated = await this.prismaService.subscription.update({
      where: { id: subscriptionId },
      data,
    });

    // Anything that changes the underlying profile shape must be propagated
    // to Remnawave. We only enqueue if there is something to push.
    const requiresPanelPush =
      assignedPlanId !== null
      || body.trafficLimit !== undefined
      || body.deviceLimit !== undefined
      || body.expireDays !== undefined
      || body.expiresAt !== undefined
      || body.status !== undefined;
    if (requiresPanelPush) {
      await this.enqueueSubscriptionSync(updated.id, updated.remnawaveId);
    }

    return updated;
  }

  @Patch('subscriptions/:subscriptionId/squads')
  @RequirePermission('subscriptions', 'edit')
  public async updateSquads(
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: { internalSquads?: string[]; externalSquad?: string | null },
  ) {
    const sub = await this.prismaService.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new NotFoundException('Subscription not found');
    const data: Prisma.SubscriptionUpdateInput = {};
    if (body.internalSquads !== undefined) data.internalSquads = body.internalSquads;
    if (body.externalSquad !== undefined) data.externalSquad = body.externalSquad;
    const updated = await this.prismaService.subscription.update({
      where: { id: subscriptionId },
      data,
    });
    await this.enqueueSubscriptionSync(updated.id, updated.remnawaveId);
    return updated;
  }

  @Delete('subscriptions/:subscriptionId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'delete')
  public async deleteSubscription(
    @Param('subscriptionId') subscriptionId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const result = await this.subscriptionDeletionService.deleteByOperator(subscriptionId);

    await this.auditLog(admin, req, 'user.subscription.deleted', {
      userId: result.userId,
      subscriptionId,
      hadRemnawaveProfile: result.hadRemnawaveProfile,
    });

    return { deleted: true };
  }

  // ── Remnawave panel actions ────────────────────────────────────────────

  @Post('subscriptions/:subscriptionId/reset-traffic')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'edit')
  public async resetTraffic(@Param('subscriptionId') subscriptionId: string) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { remnawaveId: true },
    });
    if (!sub?.remnawaveId) return { reset: false, message: 'No Remnawave profile linked' };
    await this.remnawaveApiService.resetPanelUserTraffic(sub.remnawaveId);
    return { reset: true };
  }

  @Post('subscriptions/:subscriptionId/sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'edit')
  public async syncSubscription(@Param('subscriptionId') subscriptionId: string) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { remnawaveId: true, userId: true },
    });
    if (!sub?.remnawaveId) return { synced: false, message: 'No Remnawave profile linked' };
    const panelUser = await this.remnawaveApiService.getPanelUser(sub.remnawaveId);
    if (!panelUser) return { synced: false, message: 'Profile not found on panel' };
    await this.prismaService.subscription.update({
      where: { id: subscriptionId },
      data: {
        expiresAt: new Date(panelUser.expireAt),
        configUrl: panelUser.subscriptionUrl,
      },
    });
    return { synced: true };
  }

  @Get('subscriptions/:subscriptionId/devices')
  public async getDevices(@Param('subscriptionId') subscriptionId: string) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { remnawaveId: true },
    });
    if (!sub?.remnawaveId) return { devices: [], deviceCount: 0 };
    const result = await this.remnawaveApiService.getPanelUserDevices(sub.remnawaveId);
    return { devices: result.devices, deviceCount: result.total };
  }

  @Delete('subscriptions/:subscriptionId/devices/:hwid')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'delete')
  public async revokeDevice(
    @Param('subscriptionId') subscriptionId: string,
    @Param('hwid') hwid: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        remnawaveId: true,
        userId: true,
        user: { select: { telegramId: true, username: true, name: true } },
      },
    });
    if (!sub?.remnawaveId) throw new NotFoundException('No Remnawave profile linked');
    const result = await this.remnawaveApiService.deletePanelUserDevice(sub.remnawaveId, hwid);

    this.systemEvents.info(
      EVENT_TYPES.SUBSCRIPTION_DEVICE_REVOKED,
      'DEVICE',
      `Device revoked by admin: ${hwid}`,
      {
        userId: sub.userId,
        telegramId: sub.user?.telegramId ? String(sub.user.telegramId) : null,
        userName: sub.user?.name ?? sub.user?.username ?? sub.userId,
        username: sub.user?.username ?? null,
        subscriptionId,
        remnawaveId: sub.remnawaveId,
        hwid,
        remainingDevices: result.total,
        source: 'ADMIN_PANEL',
        adminId: admin.id,
      },
    );

    return { revoked: true, remainingDevices: result.total };
  }

  // ── Give Subscription / Grant Trial ────────────────────────────────────

  @Post(':telegramId/give-subscription')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'create')
  public async giveSubscription(
    @Param('telegramId') telegramId: string,
    @Body() body: { planId: string; durationDays: number; isTrial?: boolean },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const plan = await this.prismaService.plan.findUnique({ where: { id: body.planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + body.durationDays * 24 * 60 * 60 * 1000);

    const subscription = await this.prismaService.subscription.create({
      data: {
        userId: user.id,
        status: SubscriptionStatus.ACTIVE,
        isTrial: body.isTrial ?? false,
        planSnapshot: {
          id: plan.id,
          name: plan.name,
          tag: plan.tag,
          type: plan.type,
          trafficLimit: plan.trafficLimit,
          deviceLimit: plan.deviceLimit,
          trafficLimitStrategy: plan.trafficLimitStrategy,
          internalSquads: plan.internalSquads,
          externalSquad: plan.externalSquad,
        } as unknown as Prisma.InputJsonValue,
        trafficLimit: plan.trafficLimit,
        deviceLimit: plan.deviceLimit,
        internalSquads: plan.internalSquads,
        externalSquad: plan.externalSquad,
        startedAt,
        expiresAt,
      },
    });

    await this.auditLog(admin, req, 'user.subscription.given', {
      userId: user.id,
      subscriptionId: subscription.id,
      planId: plan.id,
      durationDays: body.durationDays,
    });

    // Enqueue sync-job so the worker creates the Remnawave profile.
    await this.enqueueSubscriptionSync(subscription.id, subscription.remnawaveId);

    return subscription;
  }

  @Post(':telegramId/grant-trial')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'create')
  public async grantTrial(
    @Param('telegramId') telegramId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const trialPlan = await this.prismaService.plan.findFirst({
      where: { availability: 'TRIAL', isActive: true, isArchived: false },
      include: { durations: true },
    });
    if (!trialPlan) throw new BadRequestException('No active trial plan configured');
    const duration = trialPlan.durations[0];
    if (!duration) throw new BadRequestException('Trial plan has no duration configured');

    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + duration.days * 24 * 60 * 60 * 1000);

    const subscription = await this.prismaService.subscription.create({
      data: {
        userId: user.id,
        status: SubscriptionStatus.ACTIVE,
        isTrial: true,
        planSnapshot: {
          id: trialPlan.id,
          name: trialPlan.name,
          tag: trialPlan.tag,
          type: trialPlan.type,
          trafficLimit: trialPlan.trafficLimit,
          deviceLimit: trialPlan.deviceLimit,
          trafficLimitStrategy: trialPlan.trafficLimitStrategy,
          internalSquads: trialPlan.internalSquads,
          externalSquad: trialPlan.externalSquad,
        } as unknown as Prisma.InputJsonValue,
        trafficLimit: trialPlan.trafficLimit,
        deviceLimit: trialPlan.deviceLimit,
        internalSquads: trialPlan.internalSquads,
        externalSquad: trialPlan.externalSquad,
        startedAt,
        expiresAt,
      },
    });

    await this.auditLog(admin, req, 'user.trial.granted', {
      userId: user.id,
      subscriptionId: subscription.id,
    });

    // Enqueue sync-job so the worker creates the Remnawave profile.
    await this.enqueueSubscriptionSync(subscription.id, subscription.remnawaveId);

    return subscription;
  }

  // ── Mass sync ──────────────────────────────────────────────────────────

  /**
   * Enqueues a profile-sync for every non-deleted subscription owned by
   * the user. Donor parity: `RemnawaveService.sync_profiles_by_telegram_id`
   * in altshop, except we key the lookup by `User.id` (CUID) — our reiwa
   * id is the stable cross-channel identifier, regardless of whether the
   * user has a `telegramId` at all.
   */
  @Post(':telegramId/sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'edit')
  public async syncAllUserSubscriptions(
    @Param('telegramId') telegramId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const subscriptions = await this.prismaService.subscription.findMany({
      where: {
        userId: user.id,
        NOT: { status: SubscriptionStatus.DELETED },
      },
      select: { id: true, remnawaveId: true },
    });
    for (const subscription of subscriptions) {
      await this.enqueueSubscriptionSync(subscription.id, subscription.remnawaveId);
    }
    await this.auditLog(admin, req, 'user.sync.requested', {
      userId: user.id,
      enqueuedCount: subscriptions.length,
    });
    return { enqueued: subscriptions.length };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Enqueues a profile-sync job for a single subscription.
   *
   * - If the subscription has no `remnawaveId` yet → CREATE.
   * - Otherwise → UPDATE.
   *
   * The actual call into Remnawave happens in the BullMQ worker
   * (`ProfileSyncProcessor`), keeping HTTP latency low and giving us
   * automatic retry/backoff on transient panel errors.
   */
  private async enqueueSubscriptionSync(
    subscriptionId: string,
    remnawaveId: string | null,
  ): Promise<void> {
    const job = await this.prismaService.profileSyncJob.create({
      data: {
        subscriptionId,
        action: remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: { source: 'ADMIN_MUTATION' } as Prisma.InputJsonObject,
      },
    });
    await this.profileSyncQueueService.enqueue(job.id);
  }

  private async findUserByTelegramId(telegramId: string) {
    const isNumeric = /^\d+$/.test(telegramId);
    const user = isNumeric
      ? await this.prismaService.user.findFirst({
          where: { telegramId: BigInt(telegramId) },
        })
      : await this.prismaService.user.findUnique({
          where: { id: telegramId },
        });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async auditLog(
    admin: CurrentAdminInterface,
    req: Request,
    action: string,
    metadata: Record<string, unknown>,
  ) {
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
