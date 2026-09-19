import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVENT_TYPES,
  SystemEventsService,
  type SystemEventPayload,
} from '../../../common/services/system-events.service';
import { RbacService } from '../../rbac/services/rbac.service';
import { AdminNotificationCategory, getCategoryGate } from '../admin-notification-categories';
import { AdminNotificationPreferencesService } from './admin-notification-preferences.service';
import { WebPushService } from './web-push.service';

interface CategoryRoute {
  readonly category: AdminNotificationCategory;
  /** SPA deep-link the notification opens. May embed metadata (e.g. ticketId). */
  readonly url: (event: SystemEventPayload) => string;
  /** Short title shown on the OS notification. */
  readonly title: string;
}

function metaString(event: SystemEventPayload, key: string): string | null {
  const value = event.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * An event a rule raised, whose words are the rule author's rather than the
 * panel's: everything a `system_event` action emits is filed under AUTOMATION
 * (`action-registry.ts`), and the rules' own types live under `automation.`
 * whatever category they carry — `automation.telegram_notify` goes out as
 * SYSTEM.
 */
function isRaisedByRule(event: SystemEventPayload): boolean {
  return event.category === 'AUTOMATION' || event.type.startsWith('automation.');
}

/** The most of a rule's name a push title shows: about what a lock screen fits. */
const RULE_NAME_IN_TITLE = 48;

/**
 * The title of a push about an event a rule raised: where it came from, by the
 * rule's own name — «Автоматизация «<rule>»» — and «Автоматизация» alone when
 * the event names no rule. One line, whatever the name holds: a control
 * character becomes a space, runs of space become one, and a long name is cut
 * by characters rather than by UTF-16 units, so an emoji is never split.
 */
function ruleEventTitle(event: SystemEventPayload): string {
  const raw = event.metadata?.['ruleName'];
  const name = (typeof raw === 'string' ? Array.from(raw) : [])
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length === 0) return 'Автоматизация';
  const chars = Array.from(name);
  const shown =
    chars.length > RULE_NAME_IN_TITLE ? `${chars.slice(0, RULE_NAME_IN_TITLE - 1).join('').trimEnd()}…` : name;
  return `Автоматизация «${shown}»`;
}

/**
 * Maps a `SystemEvents` event type to the admin notification category it
 * fans out as. Only mapped types produce an admin push. Categories are gated
 * by existing RBAC permissions (via `getCategoryGate`) plus per-admin
 * preferences.
 */
const EVENT_ROUTES: Readonly<Record<string, CategoryRoute>> = {
  [EVENT_TYPES.SUPPORT_TICKET_CREATED]: {
    category: 'support',
    url: (e) => {
      const id = metaString(e, 'ticketId');
      return id ? `/support-tickets?ticket=${encodeURIComponent(id)}` : '/support-tickets';
    },
    title: 'Поддержка',
  },
  [EVENT_TYPES.SUPPORT_TICKET_USER_REPLY]: {
    category: 'support',
    url: (e) => {
      const id = metaString(e, 'ticketId');
      return id ? `/support-tickets?ticket=${encodeURIComponent(id)}` : '/support-tickets';
    },
    title: 'Поддержка',
  },
  [EVENT_TYPES.PAYMENT_FAILED]: {
    category: 'payment',
    url: () => '/payments',
    title: 'Платёж',
  },
  [EVENT_TYPES.FRAUD_SIGNAL_OPENED]: {
    category: 'fraud',
    url: () => '/fraud',
    title: 'Антифрод',
  },
  [EVENT_TYPES.PARTNER_WITHDRAWAL_REQUESTED]: {
    category: 'withdrawal',
    url: () => '/partners#withdrawals',
    title: 'Запрос на вывод',
  },
};

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

  private resolveRoute(event: SystemEventPayload): CategoryRoute | null {
    // FIRST, before any route of the panel's own: an event a rule raised is
    // never titled as one of them. It used to reach the SYSTEM branch below as
    // SYSTEM + ERROR, and every subscribed admin's device showed the rule
    // author's sentence under «Система». It still goes out at ERROR only, under
    // the same gate and the same preference as a system alert — a toggle of its
    // own would need the notification settings screen — but it says which rule
    // raised it.
    if (isRaisedByRule(event)) {
      return event.severity === 'ERROR'
        ? { category: 'system', url: () => '/', title: ruleEventTitle(event) }
        : null;
    }
    const mapped = EVENT_ROUTES[event.type];
    if (mapped) return mapped;
    // Any ERROR-severity SYSTEM event becomes a low-noise `system` alert.
    if (event.category === 'SYSTEM' && event.severity === 'ERROR') {
      return { category: 'system', url: () => '/', title: 'Система' };
    }
    return null;
  }

  private async handleEvent(event: SystemEventPayload): Promise<void> {
    const route = this.resolveRoute(event);
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
