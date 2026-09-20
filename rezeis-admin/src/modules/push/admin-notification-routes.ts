/**
 * Which events become an admin notification, and what they say.
 *
 * ONE TABLE, TWO CHANNELS. A mapped event goes out as web push
 * (`AdminNotificationDispatcher`) and is written into the operator's
 * notification centre (`AdminNotificationInboxService`) — the same category,
 * the same title, the same deep link, so what the phone shows and what the
 * bell lists are the same alert, not two descriptions of it.
 *
 * What is NOT here is as deliberate: an INFO event is not an alert. The panel's
 * socket carries fourteen categories of them — every sign-in, every payment,
 * every device — and an inbox filled with those is an event log nobody reads.
 * Alerts are the mapped types plus ERROR-severity system events, gated per
 * category by an existing RBAC permission (`getCategoryGate`).
 */
import { EVENT_TYPES, type SystemEventPayload } from '../../common/services/system-events.service';
import { AdminNotificationCategory } from './admin-notification-categories';

export interface CategoryRoute {
  readonly category: AdminNotificationCategory;
  /** SPA deep-link the notification opens. May embed metadata (e.g. ticketId). */
  readonly url: (event: SystemEventPayload) => string;
  /** Short title shown on the OS notification and in the notification centre. */
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
 * fans out as. Only mapped types produce an admin notification. Categories are
 * gated by existing RBAC permissions (via `getCategoryGate`) plus per-admin
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

/** The route an event takes, or `null` when it is not an admin alert at all. */
export function resolveNotificationRoute(event: SystemEventPayload): CategoryRoute | null {
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
