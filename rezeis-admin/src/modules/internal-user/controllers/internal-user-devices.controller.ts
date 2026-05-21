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
  UseGuards,
} from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService } from '../../../common/services/system-events.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';

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
   * Reiwa calls: `GET /api/internal/user/:userId/devices`
   */
  @Get(':userId/devices')
  public async listDevices(@Param('userId') userId: string) {
    const subscription = await this.findActiveSubscription(userId);
    if (!subscription?.remnawaveId) {
      return { devices: [], total: 0 };
    }
    return this.remnawaveApiService.getPanelUserDevices(subscription.remnawaveId);
  }

  /**
   * Deletes a specific HWID device from the user's subscription profile
   * on Remnawave.
   *
   * Reiwa calls: `DELETE /api/internal/user/:userId/devices/:hwid`
   */
  @Delete(':userId/devices/:hwid')
  @HttpCode(HttpStatus.OK)
  public async deleteDevice(
    @Param('userId') userId: string,
    @Param('hwid') hwid: string,
  ) {
    const subscription = await this.findActiveSubscription(userId);
    if (!subscription?.remnawaveId) {
      throw new NotFoundException('No active subscription with a Remnawave profile');
    }

    const result = await this.remnawaveApiService.deletePanelUserDevice(
      subscription.remnawaveId,
      hwid,
    );

    this.events.info(
      'subscription.device_revoked' as any,
      'SUBSCRIPTION',
      `Device revoked by user: ${hwid}`,
      {
        userId,
        subscriptionId: subscription.id,
        remnawaveId: subscription.remnawaveId,
        hwid,
        remainingDevices: result.total,
      },
    );

    return { revoked: true, remainingDevices: result.total };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async findActiveSubscription(userId: string) {
    // Find the user's current active subscription that has a Remnawave profile
    const subscription = await this.prismaService.subscription.findFirst({
      where: {
        userId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.LIMITED] },
        remnawaveId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        remnawaveId: true,
      },
    });
    return subscription;
  }
}
