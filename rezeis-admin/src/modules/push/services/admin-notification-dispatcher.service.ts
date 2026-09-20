import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, type SystemEventPayload } from '../../../common/services/system-events.service';
import { RbacService } from '../../rbac/services/rbac.service';
import { getCategoryGate } from '../admin-notification-categories';
import { resolveNotificationRoute } from '../admin-notification-routes';
import { AdminNotificationPreferencesService } from './admin-notification-preferences.service';
import { WebPushService } from './web-push.service';

/**
 * AdminNotificationDispatcher
 * ───────────────────────────
 * Subscribes once to `SystemEventsService` and fans mapped events out to
 * admins as browser/phone web-push, in addition to the existing
 * Telegram/webhook/realtime delivery. An admin receives a category only when
 * they are subscribed AND hold the category's gating RBAC permission AND have
 * the category enabled in preferences (default enabled). Delivery is
 * best-effort and never blocks the originating action.
 */
@Injectable()
export class AdminNotificationDispatcher implements OnModuleInit {
  private readonly logger = new Logger(AdminNotificationDispatcher.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly webPushService: WebPushService,
    private readonly rbacService: RbacService,
    private readonly systemEvents: SystemEventsService,
    private readonly preferences: AdminNotificationPreferencesService,
  ) {}

  public onModuleInit(): void {
    this.systemEvents.registerHook((event) => {
      void this.handleEvent(event);
    });
  }

  private async handleEvent(event: SystemEventPayload): Promise<void> {
    const route = resolveNotificationRoute(event);
    if (route === null) return;
    const gate = getCategoryGate(route.category);

    try {
      const subscribers = await this.prismaService.adminWebPushSubscription.findMany({
        distinct: ['adminId'],
        select: { adminId: true },
      });
      if (subscribers.length === 0) return;

      const admins = await this.prismaService.adminUser.findMany({
        where: { id: { in: subscribers.map((s) => s.adminId) }, isActive: true },
        select: { id: true, role: true, rbacRoleId: true },
      });

      const body = event.message.slice(0, 160);
      const url = route.url(event);
      await Promise.all(
        admins.map(async (admin) => {
          const permitted = await this.rbacService.hasPermission(admin, gate.resource, gate.action);
          if (!permitted) return;
          const enabled = await this.preferences.isEnabled(admin.id, route.category);
          if (!enabled) return;
          await this.webPushService.sendToAdmin({
            adminId: admin.id,
            title: route.title,
            body,
            url,
          });
        }),
      );
    } catch (err) {
      this.logger.warn(`Admin push dispatch failed for ${event.type}: ${(err as Error).message}`);
    }
  }
}
