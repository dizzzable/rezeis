/**
 * InternalUserDevicesController
 * ─────────────────────────────
 * Handles device management requests from reiwa (user-facing BFF).
 *
 * When a user deletes a device through reiwa:
 *   1. Reiwa calls `DELETE /api/internal/user/:userId/devices/:hwid`
 *   2. We find the user's current subscription (by reiwa id)
 *   3. We call Remnawave API to delete the HWID
 *   4. We emit a system event for the admin notification feed
 *
 * Auth: InternalAdminAuthGuard (Bearer token from api_tokens table).
 */
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { buildUserReferenceWhere } from '../utils/user-reference.util';

@Controller('internal/user')
@UseGuards(InternalAdminAuthGuard)
export class InternalUserDevicesController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly events: SystemEventsService,
  ) {}

  /**
   * Lists HWID devices for the user's current/active subscription.
   *
   * Reiwa calls: `GET /api/internal/user/:userRef/devices` where
   * `:userRef` is a reiwa_id (CUID) or a telegramId.
   */
  @Get(':userRef/devices')
  public async listDevices(@Param('userRef') userRef: string) {
    const subscription = await this.findActiveSubscription(userRef);
    if (!subscription?.remnawaveId) {
      return { devices: [], total: 0 };
    }
    return this.remnawaveApiService.getPanelUserDevices(subscription.remnawaveId);
  }

  /**
   * Deletes a specific HWID device from the user's subscription profile
   * on Remnawave.
   *
   * Reiwa calls: `DELETE /api/internal/user/:userRef/devices/:hwid`
   */
  @Delete(':userRef/devices/:hwid')
  @HttpCode(HttpStatus.OK)
  public async deleteDevice(
    @Param('userRef') userRef: string,
    @Param('hwid') hwid: string,
  ) {
    const subscription = await this.findActiveSubscription(userRef);
    if (!subscription?.remnawaveId) {
      throw new NotFoundException('No active subscription with a Remnawave profile');
    }
    const userId = subscription.userId;

    const result = await this.remnawaveApiService.deletePanelUserDevice(
      subscription.remnawaveId,
      hwid,
    );

    // Resolve user info for rich Telegram notification
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { telegramId: true, username: true, name: true },
    });

    this.events.info(
      EVENT_TYPES.SUBSCRIPTION_DEVICE_REVOKED,
      'DEVICE',
      `Device revoked by user: ${hwid}`,
      {
        userId,
        telegramId: user?.telegramId ? String(user.telegramId) : null,
        userName: user?.name ?? user?.username ?? userId,
        username: user?.username ?? null,
        subscriptionId: subscription.id,
        remnawaveId: subscription.remnawaveId,
        hwid,
        remainingDevices: result.total,
      },
    );

    return { revoked: true, remainingDevices: result.total };
  }

  // ── Per-subscription endpoints ─────────────────────────────────────────
  //
  // The cabinet shows a device list scoped to the *currently selected*
  // subscription card, so these variants take an explicit subscriptionId and
  // verify it belongs to the resolved user before touching the panel.

  /**
   * Lists HWID devices for a SPECIFIC subscription of the user.
   *
   * Reiwa calls: `GET /api/internal/user/:userRef/subscriptions/:subscriptionId/devices`
   */
  @Get(':userRef/subscriptions/:subscriptionId/devices')
  public async listSubscriptionDevices(
    @Param('userRef') userRef: string,
    @Param('subscriptionId') subscriptionId: string,
  ) {
    const subscription = await this.findOwnedSubscription(userRef, subscriptionId);
    if (!subscription?.remnawaveId) {
      return { devices: [], total: 0 };
    }
    return this.remnawaveApiService.getPanelUserDevices(subscription.remnawaveId);
  }

  /**
   * Deletes a specific HWID device from a SPECIFIC subscription.
   *
   * Reiwa calls: `DELETE /api/internal/user/:userRef/subscriptions/:subscriptionId/devices/:hwid`
   */
  @Delete(':userRef/subscriptions/:subscriptionId/devices/:hwid')
  @HttpCode(HttpStatus.OK)
  public async deleteSubscriptionDevice(
    @Param('userRef') userRef: string,
    @Param('subscriptionId') subscriptionId: string,
    @Param('hwid') hwid: string,
  ) {
    const subscription = await this.findOwnedSubscription(userRef, subscriptionId);
    if (!subscription?.remnawaveId) {
      throw new NotFoundException('No subscription with a Remnawave profile');
    }
    const result = await this.remnawaveApiService.deletePanelUserDevice(
      subscription.remnawaveId,
      hwid,
    );
    await this.emitDeviceRevoked(subscription, hwid, result.total);
    return { revoked: true, remainingDevices: result.total };
  }

  /**
   * Regenerates the subscription link for a SPECIFIC subscription: the panel
   * rotates the short UUID (old links die), we wipe all HWID devices for that
   * profile, and we persist the new URL on our subscription row so the cabinet
   * "Connect"/"Copy" actions use the fresh link.
   *
   * Reiwa calls: `POST /api/internal/user/:userRef/subscriptions/:subscriptionId/regenerate`
   */
  @Post(':userRef/subscriptions/:subscriptionId/regenerate')
  @HttpCode(HttpStatus.OK)
  public async regenerateSubscription(
    @Param('userRef') userRef: string,
    @Param('subscriptionId') subscriptionId: string,
  ) {
    const subscription = await this.findOwnedSubscription(userRef, subscriptionId);
    if (!subscription?.remnawaveId) {
      throw new NotFoundException('No subscription with a Remnawave profile');
    }

    // 1. Rotate the subscription link (revoke old short UUID).
    const { subscriptionUrl } = await this.remnawaveApiService.regeneratePanelUserSubscription(
      subscription.remnawaveId,
    );

    // 2. Wipe every device bound to this profile so freed slots are reusable.
    await this.remnawaveApiService.deleteAllPanelUserDevices(subscription.remnawaveId);

    // 3. Persist the new URL so the cabinet uses it immediately.
    if (subscriptionUrl !== null) {
      await this.prismaService.subscription.update({
        where: { id: subscription.id },
        data: { configUrl: subscriptionUrl },
      });
    }

    this.events.info(
      EVENT_TYPES.SUBSCRIPTION_DEVICE_REVOKED,
      'DEVICE',
      `Subscription link regenerated by user (all devices revoked)`,
      {
        userId: subscription.userId,
        subscriptionId: subscription.id,
        remnawaveId: subscription.remnawaveId,
      },
    );

    return { regenerated: true, url: subscriptionUrl };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /** Emits the user-facing device-revoked event for the notification feed. */
  private async emitDeviceRevoked(
    subscription: { id: string; userId: string; remnawaveId: string | null },
    hwid: string,
    remainingDevices: number,
  ): Promise<void> {
    const user = await this.prismaService.user.findUnique({
      where: { id: subscription.userId },
      select: { telegramId: true, username: true, name: true },
    });
    this.events.info(
      EVENT_TYPES.SUBSCRIPTION_DEVICE_REVOKED,
      'DEVICE',
      `Device revoked by user: ${hwid}`,
      {
        userId: subscription.userId,
        telegramId: user?.telegramId ? String(user.telegramId) : null,
        userName: user?.name ?? user?.username ?? subscription.userId,
        username: user?.username ?? null,
        subscriptionId: subscription.id,
        remnawaveId: subscription.remnawaveId,
        hwid,
        remainingDevices,
      },
    );
  }

  /**
   * Resolves a subscription by id and verifies it belongs to the referenced
   * user. Returns `null` if the user or subscription is missing or not owned.
   */
  private async findOwnedSubscription(userRef: string, subscriptionId: string) {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(userRef),
      select: { id: true },
    });
    if (user === null) {
      return null;
    }
    const subscription = await this.prismaService.subscription.findFirst({
      where: { id: subscriptionId, userId: user.id },
      select: { id: true, userId: true, remnawaveId: true },
    });
    return subscription;
  }

  private async findActiveSubscription(userRef: string) {
    // Resolve the reference (reiwa_id CUID or telegramId) to the
    // canonical reiwa_id, then find the active Remnawave-backed sub.
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(userRef),
      select: { id: true },
    });
    if (user === null) {
      return null;
    }
    const subscription = await this.prismaService.subscription.findFirst({
      where: {
        userId: user.id,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.LIMITED] },
        remnawaveId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        remnawaveId: true,
      },
    });
    return subscription;
  }
}
