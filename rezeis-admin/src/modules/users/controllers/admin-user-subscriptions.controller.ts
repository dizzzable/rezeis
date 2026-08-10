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
import { requirePanelDeviceList } from '../../remnawave/utils/panel-device-read.util';
import { SubscriptionDeletionService } from '../../subscriptions/services/subscription-deletion.service';
import { SubscriptionMutationsService } from '../../subscriptions/services/subscription-mutations.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { buildPlanSnapshot } from '../utils/plan-snapshot.util';

const REMNAWAVE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    private readonly subscriptionMutationsService: SubscriptionMutationsService,
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

    if (body.status !== undefined) {
      if (body.status !== SubscriptionStatus.ACTIVE && body.status !== SubscriptionStatus.DISABLED) {
        throw new BadRequestException('Only ACTIVE or DISABLED can be set by the subscription editor');
      }
      data.status = body.status;
    }

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
    if (body.trafficLimit !== undefined && assignedPlanId === null) {
      data.trafficLimit = Number(body.trafficLimit);
    }
    if (body.deviceLimit !== undefined && assignedPlanId === null) {
      data.deviceLimit = Number(body.deviceLimit);
    }
    if (body.expireDays !== undefined) {
      const days = Number(body.expireDays);
      const base = sub.expiresAt === null
        ? new Date()
        : new Date(Math.max(sub.expiresAt.getTime(), Date.now()));
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

    // Anything that changes the underlying profile shape must be propagated
    // to Remnawave. The local mutation and durable job live in one transaction;
    // a queue outage only delays the push because the sweep can recover PENDING.
    const requiresPanelPush =
      assignedPlanId !== null
      || body.trafficLimit !== undefined
      || body.deviceLimit !== undefined
      || body.expireDays !== undefined
      || body.expiresAt !== undefined
      || body.status !== undefined;
    const outcome = await this.prismaService.$transaction(async (tx) => {
      const updated = await tx.subscription.update({
        where: { id: subscriptionId },
        data,
      });
      // A generic editor update must never provision a second panel profile
      // for an imported/legacy row whose link is missing. Creation remains an
      // explicit "give subscription" flow; operators can repair a link before
      // pushing local edits upstream.
      if (!requiresPanelPush || updated.remnawaveId === null) {
        return {
          updated,
          syncJobId: null as string | null,
          remnawaveLinkRequired: requiresPanelPush && updated.remnawaveId === null,
        };
      }

      const syncJob = await tx.profileSyncJob.create({
        data: {
          subscriptionId: updated.id,
          action: SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          payload: {
            source: 'ADMIN_MUTATION',
            // Remnawave only receives status when the operator explicitly
            // changed it. Derived EXPIRED/LIMITED states must never be pushed.
            propagateStatus: body.status !== undefined,
          } as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      return { updated, syncJobId: syncJob.id, remnawaveLinkRequired: false };
    });

    if (outcome.syncJobId !== null) {
      try {
        await this.profileSyncQueueService.enqueue(outcome.syncJobId);
      } catch (error: unknown) {
        // The state and job are already durable. The periodic queue recovery
        // picks this up, so do not turn a successful edit into a false failure.
        this.systemEvents.warn(
          EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC,
          'SYSTEM',
          'Admin subscription update queued for deferred Remnawave sync',
          { subscriptionId, syncJobId: outcome.syncJobId, error: error instanceof Error ? error.message : String(error) },
        );
      }
    }

    return {
      ...outcome.updated,
      syncPending: outcome.syncJobId !== null,
      remnawaveLinkRequired: outcome.remnawaveLinkRequired,
    };
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

  /**
   * Explicitly repairs a legacy local-to-panel link. Generic edits never
   * create a profile for an unlinked row: that could duplicate an existing
   * imported user. The UUID is verified against the panel before persisting.
   */
  @Patch('subscriptions/:subscriptionId/remnawave-link')
  @RequirePermission('subscriptions', 'edit')
  public async linkRemnawaveProfile(
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: { remnawaveId?: unknown },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const remnawaveId = typeof body.remnawaveId === 'string' ? body.remnawaveId.trim() : '';
    if (!REMNAWAVE_UUID_PATTERN.test(remnawaveId)) {
      throw new BadRequestException('A valid Remnawave profile UUID is required');
    }

    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        id: true,
        userId: true,
        remnawaveId: true,
        configUrl: true,
        user: { select: { id: true, telegramId: true, email: true } },
      },
    });
    if (subscription === null) throw new NotFoundException('Subscription not found');
    if (subscription.remnawaveId !== null) {
      throw new BadRequestException('Subscription already has a Remnawave profile linked');
    }

    const alreadyLinked = await this.prismaService.subscription.findFirst({
      where: { remnawaveId, NOT: { id: subscriptionId } },
      select: { id: true },
    });
    if (alreadyLinked !== null) {
      throw new BadRequestException('This Remnawave profile is already linked to another subscription');
    }

    const panelUser = await this.remnawaveApiService.getPanelUser(remnawaveId);
    if (panelUser === null) throw new NotFoundException('Remnawave profile was not found');

    const expectedMarker = `reiwa_id: ${subscription.user.id}`;
    const markerMatches = panelUser.description
      ?.split(/\r?\n/)
      .some((line) => line.trim() === expectedMarker) ?? false;
    const telegramMatches =
      subscription.user.telegramId !== null &&
      panelUser.telegramId !== null &&
      subscription.user.telegramId.toString() === String(panelUser.telegramId);
    const emailMatches =
      subscription.user.email !== null &&
      panelUser.email !== null &&
      subscription.user.email.trim().toLowerCase() === panelUser.email.trim().toLowerCase();
    if (!markerMatches && !telegramMatches && !emailMatches) {
      throw new BadRequestException('Remnawave profile does not belong to this subscription user');
    }

    const linked = await this.prismaService.subscription.update({
      where: { id: subscriptionId },
      data: {
        remnawaveId,
        configUrl: panelUser.subscriptionUrl || subscription.configUrl,
      },
    });
    await this.auditLog(admin, req, 'user.subscription.remnawave_linked', {
      userId: subscription.userId,
      subscriptionId,
      previousRemnawaveId: subscription.remnawaveId,
      remnawaveId,
      ownershipVerifiedBy: markerMatches ? 'reiwa_id' : telegramMatches ? 'telegram_id' : 'email',
      configUrlChanged: (panelUser.subscriptionUrl || subscription.configUrl) !== subscription.configUrl,
    });
    return linked;
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
      select: { id: true, remnawaveId: true, remnawaveUserId: true, configUrl: true },
    });
    const panelIdentifier = await this.resolveDevicePanelIdentifier(sub);
    if (panelIdentifier === null) return { reset: false, message: 'No Remnawave profile linked' };
    await this.remnawaveApiService.resetPanelUserTraffic(panelIdentifier);
    return { reset: true };
  }

  @Post('subscriptions/:subscriptionId/sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'edit')
  public async syncSubscription(@Param('subscriptionId') subscriptionId: string) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { remnawaveId: true, remnawaveUserId: true, userId: true },
    });
    const panelIdentifier = remnawaveUserIdentifier(sub);
    if (panelIdentifier === null) return { synced: false, message: 'No Remnawave profile linked' };
    const panelUser = await this.remnawaveApiService.getPanelUser(panelIdentifier);
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

  /**
   * Device list for the operator's user panel.
   *
   * `deviceCount: 0` here means "this subscription has no Remnawave profile",
   * a fact we hold locally. A PANEL read that did not answer is NOT allowed to
   * produce the same payload — it used to, and an operator triaging "the
   * customer says they can't add a device" read a confident 0 while the panel
   * was down. `requirePanelDeviceList` turns that into a 5xx, which
   * `DevicesSection` in the admin SPA already renders as its
   * `devicesList.loadError` line instead of `devicesList.empty`.
   */
  @Get('subscriptions/:subscriptionId/devices')
  public async getDevices(@Param('subscriptionId') subscriptionId: string) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { id: true, remnawaveId: true, remnawaveUserId: true, configUrl: true },
    });
    const panelIdentifier = await this.resolveDevicePanelIdentifier(sub);
    if (panelIdentifier === null) return { devices: [], deviceCount: 0 };
    const result = requirePanelDeviceList(
      await this.remnawaveApiService.strictGetPanelUserDevices(panelIdentifier),
    );
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
        id: true,
        remnawaveId: true,
        remnawaveUserId: true,
        configUrl: true,
        userId: true,
        user: { select: { telegramId: true, username: true, name: true } },
      },
    });
    const panelIdentifier = await this.resolveDevicePanelIdentifier(sub);
    if (panelIdentifier === null) throw new NotFoundException('No Remnawave profile linked');
    const result = await this.remnawaveApiService.deletePanelUserDevice(panelIdentifier, hwid);

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

  private async resolveDevicePanelIdentifier(subscription: DeviceSubscription | null): Promise<number | string | null> {
    if (subscription?.remnawaveUserId !== null && subscription?.remnawaveUserId !== undefined) {
      return subscription.remnawaveUserId;
    }
    if (subscription === null) return null;

    const shortUuid = extractShortUuid(subscription.configUrl);
    if (shortUuid !== null) {
      const panelUser = await this.remnawaveApiService.resolveRemnawaveUser({ subscriptionUuid: shortUuid });
      if (panelUser?.id !== null && panelUser?.id !== undefined) {
        await this.prismaService.subscription.update({
          where: { id: subscription.id },
          data: { remnawaveUserId: panelUser.id },
        });
        return panelUser.id;
      }
    }

    return subscription.remnawaveId;
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

    if (body.isTrial === true) {
      const granted = await this.subscriptionMutationsService.grantTrial({
        userId: user.id,
        planId: plan.id,
        durationDays: body.durationDays,
      });
      const subscription = await this.prismaService.subscription.findUniqueOrThrow({
        where: { id: granted.subscriptionId },
      });
      await this.auditLog(admin, req, 'user.subscription.given', {
        userId: user.id,
        subscriptionId: subscription.id,
        planId: plan.id,
        durationDays: body.durationDays,
        isTrial: true,
      });
      return subscription;
    }

    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + body.durationDays * 24 * 60 * 60 * 1000);

    const subscription = await this.prismaService.subscription.create({
      data: {
        userId: user.id,
        status: SubscriptionStatus.ACTIVE,
        isTrial: false,
        planSnapshot: buildPlanSnapshot(plan),
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

    const granted = await this.subscriptionMutationsService.grantTrial({
      userId: user.id,
      planId: trialPlan.id,
      durationDays: duration.days,
    });
    const subscription = await this.prismaService.subscription.findUniqueOrThrow({
      where: { id: granted.subscriptionId },
    });

    await this.auditLog(admin, req, 'user.trial.granted', {
      userId: user.id,
      subscriptionId: subscription.id,
    });

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

function remnawaveUserIdentifier(subscription: { remnawaveUserId: number | null; remnawaveId: string | null } | null): number | string | null {
  return subscription?.remnawaveUserId ?? subscription?.remnawaveId ?? null;
}

type DeviceSubscription = {
  readonly id: string;
  readonly remnawaveId: string | null;
  readonly remnawaveUserId: number | null;
  readonly configUrl: string | null;
};

function extractShortUuid(configUrl: string | null | undefined): string | null {
  if (configUrl === null || configUrl === undefined || configUrl.trim().length === 0) return null;
  try {
    const url = new URL(configUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1];
    return lastSegment && lastSegment.length > 0 ? lastSegment : null;
  } catch {
    const segments = configUrl.split('?')[0]?.split('/').filter(Boolean) ?? [];
    const lastSegment = segments[segments.length - 1];
    return lastSegment && lastSegment.length > 0 ? lastSegment : null;
  }
}
