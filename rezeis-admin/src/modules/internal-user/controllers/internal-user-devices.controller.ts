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
  BadGatewayException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
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
import { requirePanelDeviceList } from '../../remnawave/utils/panel-device-read.util';
import { buildUserReferenceWhere } from '../utils/user-reference.util';

@Controller('internal/user')
@UseGuards(InternalAdminAuthGuard)
export class InternalUserDevicesController {
  private readonly logger = new Logger(InternalUserDevicesController.name);

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
   *
   * The empty list below is a LOCAL fact — this user has no Remnawave-backed
   * subscription, so there is nothing that could hold a device — and stays an
   * empty list. Only the PANEL read is allowed to fail loudly
   * (`requirePanelDeviceList`), because only that one can be wrong about it.
   */
  @Get(':userRef/devices')
  public async listDevices(@Param('userRef') userRef: string) {
    const subscription = await this.findActiveSubscription(userRef);
    const panelIdentifier = await this.resolvePanelIdentifier(subscription);
    if (panelIdentifier === null) {
      return { devices: [], total: 0 };
    }
    const outcome = await this.remnawaveApiService.strictGetPanelUserDevices(
      panelIdentifier,
    );
    return requirePanelDeviceList(outcome);
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
    const panelIdentifier = await this.resolvePanelIdentifier(subscription);
    if (panelIdentifier === null) {
      throw new NotFoundException('No active subscription with a Remnawave profile');
    }
    const userId = subscription.userId;

    const result = await this.remnawaveApiService.deletePanelUserDevice(
      panelIdentifier,
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
    const panelIdentifier = await this.resolvePanelIdentifier(subscription);
    if (panelIdentifier === null) {
      return { devices: [], total: 0 };
    }
    const outcome = await this.remnawaveApiService.strictGetPanelUserDevices(
      panelIdentifier,
    );
    return requirePanelDeviceList(outcome);
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
    const panelIdentifier = await this.resolvePanelIdentifier(subscription);
    if (panelIdentifier === null) {
      throw new NotFoundException('No subscription with a Remnawave profile');
    }
    const result = await this.remnawaveApiService.deletePanelUserDevice(
      panelIdentifier,
      hwid,
    );
    await this.emitDeviceRevoked(subscription, hwid, result.total);
    return { revoked: true, remainingDevices: result.total };
  }

  /**
   * Regenerates the subscription link for a SPECIFIC subscription: the panel
   * rotates the short UUID (old links die), we persist the new URL on our
   * subscription row so the cabinet "Connect"/"Copy" actions use the fresh
   * link, and we wipe all HWID devices for that profile.
   *
   * Reiwa calls: `POST /api/internal/user/:userRef/subscriptions/:subscriptionId/regenerate`
   *
   * ORDER IS LOAD-BEARING. The panel rotates the short uuid inside step 1, so
   * the moment that call returns, every link we have ever handed this customer
   * — including the `configUrl` in our own row — is dead. The rotation cannot
   * be undone or repeated back to the old value. Therefore the ONLY correct
   * next statement is the one that writes the replacement down; anything else
   * placed in front of it is a window in which a failure leaves the panel
   * rotated and our database still serving the dead link, with the cabinet
   * cheerfully handing it to the customer.
   *
   * That window used to be real: the device wipe ran second and goes through a
   * transport that THROWS on any failure (a 500, a timeout, a restart), so a
   * blip aborted the request before the persist, which used to be the third
   * step — and the new URL, which the revoke response had already handed us,
   * was simply dropped. The fix is the ordering: persist the moment the value
   * is known.
   *
   * Safe because the persisted value is authoritative the instant step 1
   * returns — it is the panel's OWN new `subscriptionUrl`, present and
   * required in the revoke response on both 2.7.4 and 2.8.0
   * (`RevokeUserSubscriptionResponseDto.response.subscriptionUrl`). Nothing
   * later in this method can change it: the device wipe touches HWID bindings,
   * not the subscription link.
   *
   * If the PERSIST itself fails there is no dead-link-free outcome left, so it
   * is reported rather than hidden: the request fails (the customer is never
   * told "regenerated" while we serve a stale link), an ERROR event tells the
   * operator which subscription needs a panel re-sync, and the customer's
   * retry re-rotates and re-persists — a transient database blip self-heals on
   * the next attempt.
   *
   * One window is NOT closable here and is left deliberately: if the revoke
   * call itself times out AFTER the panel processed it, the link is rotated
   * and the reply that carried its replacement never arrived. No ordering
   * fixes that (the panel offers no idempotency key on this action); the
   * customer's retry rotates again and stores the URL it gets back.
   */
  @Post(':userRef/subscriptions/:subscriptionId/regenerate')
  @HttpCode(HttpStatus.OK)
  public async regenerateSubscription(
    @Param('userRef') userRef: string,
    @Param('subscriptionId') subscriptionId: string,
  ) {
    const subscription = await this.findOwnedSubscription(userRef, subscriptionId);
    const panelIdentifier = await this.resolvePanelIdentifier(subscription);
    if (panelIdentifier === null) {
      throw new NotFoundException('No subscription with a Remnawave profile');
    }

    // 1. Rotate the subscription link (revoke old short UUID). Every existing
    //    client link is dead from here on.
    const { subscriptionUrl } = await this.remnawaveApiService.regeneratePanelUserSubscription(
      panelIdentifier,
    );

    // 2. Persist the new URL — FIRST, before anything else that can fail.
    if (subscriptionUrl === null) {
      // The panel rotated the link and did not tell us the replacement. Both
      // target versions declare `subscriptionUrl` required on this response,
      // so this is a contract break, not a normal branch — and it leaves our
      // stored link dead with nothing to put in its place. The old code
      // treated it as "nothing to persist" and returned success.
      this.reportRegenerateLinkLost(subscription, 'panel omitted the new subscription URL');
      throw new BadGatewayException(
        'The Remnawave panel rotated the subscription link but did not return the new one',
      );
    }
    try {
      await this.prismaService.subscription.update({
        where: { id: subscription.id },
        data: { configUrl: subscriptionUrl },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      // The URL goes to the server log ONLY — it is a bearer link, and the
      // event card is delivered to an operator chat. The repair an operator
      // needs is `POST /admin/users/subscriptions/:id/sync`, which re-reads
      // the URL from the panel.
      this.logger.error(
        `Regenerate: panel rotated ${subscription.id} but persisting the new URL failed ` +
          `(${message}); new URL: ${subscriptionUrl}`,
      );
      this.reportRegenerateLinkLost(subscription, `persisting the new URL failed: ${message}`);
      throw err;
    }

    // 3. Wipe every device bound to this profile so freed slots are reusable.
    //    Secondary cleanup: the link is already rotated AND stored, so a
    //    failure here must not be reported as a failed regeneration — that
    //    would push the customer into retrying (and re-rotating) a link that
    //    already works. It is reported as an incomplete wipe instead, and the
    //    leftover devices are now honestly visible in the device list.
    let devicesCleared = true;
    try {
      await this.remnawaveApiService.deleteAllPanelUserDevices(panelIdentifier);
    } catch (err: unknown) {
      devicesCleared = false;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.warn(
        `Regenerate: new link persisted for ${subscription.id} but clearing bound devices failed: ${message}`,
      );
    }

    this.events.info(
      EVENT_TYPES.SUBSCRIPTION_DEVICE_REVOKED,
      'DEVICE',
      devicesCleared
        ? `Subscription link regenerated by user (all devices revoked)`
        : `Subscription link regenerated by user (devices NOT cleared — panel refused)`,
      {
        userId: subscription.userId,
        subscriptionId: subscription.id,
        remnawaveId: subscription.remnawaveId,
        devicesCleared,
      },
    );

    return { regenerated: true, url: subscriptionUrl, devicesCleared };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Announces the one state this endpoint cannot repair by itself: the panel
   * has rotated the subscription link and our row still holds the dead one.
   *
   * ERROR severity on purpose — every reader of `configUrl` (cabinet "Connect"
   * and "Copy", the bot, any re-send of the link) is now serving a URL that
   * cannot connect, and nothing in the system will notice on its own. The
   * repair is `POST /admin/users/subscriptions/:id/sync`, which re-reads the
   * panel's `subscriptionUrl` and writes it back.
   */
  private reportRegenerateLinkLost(
    subscription: { id: string; userId: string; remnawaveId: string | null },
    reason: string,
  ): void {
    this.events.error(
      EVENT_TYPES.SUBSCRIPTION_SYNCED,
      'SUBSCRIPTION',
      `Subscription link regenerated on the panel but NOT stored — the saved link is dead until a panel sync (${reason})`,
      {
        userId: subscription.userId,
        subscriptionId: subscription.id,
        remnawaveId: subscription.remnawaveId,
        source: 'INTERNAL_USER_REGENERATE',
        repair: 'POST /admin/users/subscriptions/:id/sync',
      },
    );
  }

  /** Emits the user-facing device-revoked event for the notification feed. */
  private async emitDeviceRevoked(
    subscription: { id: string; userId: string; remnawaveId: string | null; remnawaveUserId: number | null },
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
      select: { id: true, userId: true, remnawaveId: true, remnawaveUserId: true, configUrl: true },
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
        OR: [{ remnawaveUserId: { not: null } }, { remnawaveId: { not: null } }],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        remnawaveId: true,
        remnawaveUserId: true,
        configUrl: true,
      },
    });
    return subscription;
  }

  private async resolvePanelIdentifier(subscription: DeviceSubscription | null): Promise<number | string | null> {
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
}

type DeviceSubscription = {
  readonly id: string;
  readonly remnawaveId: string | null;
  readonly remnawaveUserId: number | null;
  readonly configUrl: string | null;
};

function extractShortUuid(configUrl: string | null): string | null {
  if (configUrl === null || configUrl.trim().length === 0) return null;
  try {
    const url = new URL(configUrl);
    const lastSegment = url.pathname.split('/').filter(Boolean).at(-1);
    return lastSegment && lastSegment.length > 0 ? lastSegment : null;
  } catch {
    const lastSegment = configUrl.split('?')[0]?.split('/').filter(Boolean).at(-1);
    return lastSegment && lastSegment.length > 0 ? lastSegment : null;
  }
}
