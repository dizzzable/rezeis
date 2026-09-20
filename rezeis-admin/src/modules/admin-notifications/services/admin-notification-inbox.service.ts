import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { SystemEventsService, type SystemEventPayload } from '../../../common/services/system-events.service';
import { AdminNotificationCategory, getCategoryGate } from '../../push/admin-notification-categories';
import { resolveNotificationRoute } from '../../push/admin-notification-routes';
import { AdminNotificationPreferencesService } from '../../push/services/admin-notification-preferences.service';
import { RbacService } from '../../rbac/services/rbac.service';

/** How long an alert stays in the centre, whatever the operator does with it. */
export const NOTIFICATION_RETENTION_DAYS = 30;
/** And how many of them one operator keeps, newest first, however recent they are. */
export const NOTIFICATIONS_PER_ADMIN = 500;
/** The stored sentence, as long as a push body: these are alerts, not reports. */
const MESSAGE_LIMIT = 160;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InboxNotification {
  readonly id: string;
  readonly category: string;
  readonly severity: string;
  readonly type: string;
  readonly title: string;
  readonly message: string;
  readonly url: string;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface InboxPage {
  readonly items: readonly InboxNotification[];
  /** Pass back as `cursor` for the next page; `null` when this was the last one. */
  readonly nextCursor: string | null;
  /** Unread across the whole inbox, not just this page — the badge on the bell. */
  readonly unread: number;
}

interface AdminIdentity {
  readonly id: string;
  readonly role: import('@prisma/client').UserRole;
  readonly rbacRoleId: string | null;
}

/**
 * AdminNotificationInboxService
 * ─────────────────────────────
 * The panel's notification centre: the operator's own copy of every alert the
 * panel raised for them, kept instead of shown once and lost.
 *
 * WHAT IS FILED is decided in exactly one place — `resolveNotificationRoute` —
 * the same table that decides what goes out as web push. So the bell and the
 * phone show the same alerts, and an INFO event (every sign-in, every payment)
 * is not an alert in either of them.
 *
 * WHO GETS A COPY is decided when the event is raised, by the category's RBAC
 * gate and the operator's own preference, exactly as the push dispatcher
 * decides it — with one deliberate difference: push reaches admins who
 * subscribed a device, the centre reaches EVERY active admin the gate allows.
 * Not having a phone subscribed is not a reason to lose the record.
 *
 * Filing never blocks or breaks the raising action: the hook is called after
 * delivery, this returns a promise nobody awaits, and a failure is logged.
 */
@Injectable()
export class AdminNotificationInboxService implements OnModuleInit {
  private readonly logger = new Logger(AdminNotificationInboxService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly rbacService: RbacService,
    private readonly systemEvents: SystemEventsService,
    private readonly preferences: AdminNotificationPreferencesService,
  ) {}

  public onModuleInit(): void {
    this.systemEvents.registerHook((event) => {
      void this.fileEvent(event);
    });
  }

  /** Writes one copy of an alert for every admin entitled to it. */
  private async fileEvent(event: SystemEventPayload): Promise<void> {
    const route = resolveNotificationRoute(event);
    if (route === null) return;
    const gate = getCategoryGate(route.category);

    try {
      const admins = await this.prismaService.adminUser.findMany({
        where: { isActive: true },
        select: { id: true, role: true, rbacRoleId: true },
      });
      const recipients = await this.entitled(admins, route.category, gate);
      if (recipients.length === 0) return;

      const url = route.url(event);
      const message = event.message.slice(0, MESSAGE_LIMIT);
      await this.prismaService.adminNotification.createMany({
        data: recipients.map((adminId) => ({
          adminId,
          category: route.category,
          severity: event.severity,
          type: event.type,
          title: route.title,
          message,
          url,
        })),
      });
    } catch (err) {
      this.logger.warn(`Filing ${event.type} into the notification centre failed: ${(err as Error).message}`);
    }
  }

  private async entitled(
    admins: readonly AdminIdentity[],
    category: AdminNotificationCategory,
    gate: { readonly resource: string; readonly action: string },
  ): Promise<readonly string[]> {
    const verdicts = await Promise.all(
      admins.map(async (admin) => {
        const permitted = await this.rbacService.hasPermission(admin, gate.resource, gate.action);
        if (!permitted) return null;
        const enabled = await this.preferences.isEnabled(admin.id, category);
        return enabled ? admin.id : null;
      }),
    );
    return verdicts.filter((id): id is string => id !== null);
  }

  /**
   * One page of an operator's own alerts, newest first, and the unread total
   * over all of them. The cursor is the id of the last row of the page.
   */
  public async list(
    adminId: string,
    options: {
      readonly limit: number;
      readonly cursor?: string;
      readonly unreadOnly?: boolean;
      readonly category?: AdminNotificationCategory;
    },
  ): Promise<InboxPage> {
    // Both filters belong in the WHERE, not in a `.filter()` after reading:
    // a page is twenty rows, and filtering those would answer "no antifraud
    // alerts" for an inbox whose antifraud alerts are on page two.
    const where = {
      adminId,
      ...(options.unreadOnly === true ? { readAt: null } : {}),
      ...(options.category === undefined ? {} : { category: options.category }),
    };
    const rows = await this.prismaService.adminNotification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: options.limit + 1,
      ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
    });
    const page = rows.slice(0, options.limit);
    const unread = await this.unreadCount(adminId);
    return {
      items: page.map((row) => ({
        id: row.id,
        category: row.category,
        severity: row.severity,
        type: row.type,
        title: row.title,
        message: row.message,
        url: row.url,
        readAt: row.readAt === null ? null : row.readAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > options.limit ? (page[page.length - 1]?.id ?? null) : null,
      unread,
    };
  }

  public async unreadCount(adminId: string): Promise<number> {
    return this.prismaService.adminNotification.count({ where: { adminId, readAt: null } });
  }

  /**
   * Marks one alert read. Scoped by `adminId` in the WHERE, not checked after
   * reading: an id from the client can name another operator's copy, and
   * `updateMany` simply matches nothing then.
   */
  public async markRead(adminId: string, id: string): Promise<number> {
    const result = await this.prismaService.adminNotification.updateMany({
      where: { id, adminId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  public async markAllRead(adminId: string): Promise<number> {
    const result = await this.prismaService.adminNotification.updateMany({
      where: { adminId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  /** Deletes one alert — the operator's own copy, and nobody else's. */
  public async remove(adminId: string, id: string): Promise<number> {
    const result = await this.prismaService.adminNotification.deleteMany({ where: { id, adminId } });
    return result.count;
  }

  /** Clears the operator's inbox: everything, or only what they have read. */
  public async clear(adminId: string, options: { readonly readOnly: boolean }): Promise<number> {
    const result = await this.prismaService.adminNotification.deleteMany({
      where: { adminId, ...(options.readOnly ? { readAt: { not: null } } : {}) },
    });
    return result.count;
  }

  /**
   * Nightly, at 04:40 — ten minutes after the online samples are pruned, so the
   * two do not contend for the same window. Old alerts go, and an operator's
   * inbox is capped at its newest `NOTIFICATIONS_PER_ADMIN`, read or not: the
   * centre is the recent past, not an archive. The audit log keeps the history.
   */
  @Cron('40 4 * * *')
  public async prune(): Promise<void> {
    if (!shouldRunSchedules()) return;

    const cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * DAY_MS);
    const expired = await this.prismaService.adminNotification.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    let trimmed = 0;
    const overflowing = await this.prismaService.adminNotification.groupBy({
      by: ['adminId'],
      _count: { _all: true },
      having: { adminId: { _count: { gt: NOTIFICATIONS_PER_ADMIN } } },
    });
    for (const group of overflowing) {
      // The oldest row this admin keeps; everything before it goes.
      const [oldestKept] = await this.prismaService.adminNotification.findMany({
        where: { adminId: group.adminId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: NOTIFICATIONS_PER_ADMIN - 1,
        take: 1,
        select: { id: true, createdAt: true },
      });
      if (oldestKept === undefined) continue;
      const result = await this.prismaService.adminNotification.deleteMany({
        where: {
          adminId: group.adminId,
          OR: [
            { createdAt: { lt: oldestKept.createdAt } },
            { createdAt: oldestKept.createdAt, id: { lt: oldestKept.id } },
          ],
        },
      });
      trimmed += result.count;
    }

    if (expired.count > 0 || trimmed > 0) {
      this.logger.log(`Pruned notifications: ${expired.count} expired, ${trimmed} over the per-admin cap`);
    }
  }
}
