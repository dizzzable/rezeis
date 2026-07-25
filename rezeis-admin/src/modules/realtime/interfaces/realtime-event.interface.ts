/**
 * Stable event payload contract pushed over the admin WebSocket channel.
 *
 * Mirrors `SystemEventPayload` from the system-events bus but is namespaced
 * to the realtime module so the frontend `useRealtimeUpdates` hook can rely
 * on a fixed shape without coupling to internal audit/log structures.
 */
import type {
  SystemEventCategory,
  SystemEventSeverity,
} from '../../../common/services/system-events.service';

export interface RealtimeEventInterface {
  /** Machine-readable event type (e.g. `payment.completed`). */
  readonly type: string;
  /** Logical bucket the event belongs to. */
  readonly category: SystemEventCategory;
  /** Severity hint for UI surfaces (toast colour, list badge). */
  readonly severity: SystemEventSeverity;
  /** Operator-friendly summary line. */
  readonly message: string;
  /**
   * Structured metadata. May contain `subscriptionId`, `userId`, `paymentId`
   * etc. Frontend code MUST treat this as opaque and only read documented
   * keys.
   */
  readonly metadata?: Record<string, unknown>;
  /** ISO timestamp when the event was emitted by the bus. */
  readonly timestamp: string;
}

/**
 * Channel topics the frontend can subscribe to. Mirrors the categories
 * emitted by SystemEventsService so subscribers can opt-in by domain.
 */
export const REALTIME_TOPICS = [
  'USER',
  'AUTH',
  'SUBSCRIPTION',
  'DEVICE',
  'PAYMENT',
  'REFERRAL',
  'PARTNER',
  'PROMOCODE',
  'SUPPORT',
  'FRAUD',
  'NODE',
  'REMNAWAVE',
  'SYSTEM',
] as const satisfies readonly SystemEventCategory[];

export type RealtimeTopic = (typeof REALTIME_TOPICS)[number];

/**
 * RBAC gate for each realtime topic: the `resource:view` permission an admin
 * must hold to *receive* events in that topic. Without this, a restricted
 * operator subscribed to (or defaulting into) the firehose would see
 * money-affecting / fraud / partner events they have no permission to view in
 * the UI — a lateral information-disclosure leak over the socket. `SYSTEM`
 * maps to `dashboard:view`, the baseline every panel operator holds.
 */
export const REALTIME_TOPIC_PERMISSION: Readonly<
  Record<RealtimeTopic, { readonly resource: string; readonly action: string }>
> = {
  USER: { resource: 'users', action: 'view' },
  AUTH: { resource: 'audit', action: 'view' },
  SUBSCRIPTION: { resource: 'subscriptions', action: 'view' },
  DEVICE: { resource: 'subscriptions', action: 'view' },
  PAYMENT: { resource: 'payments', action: 'view' },
  REFERRAL: { resource: 'referrals', action: 'view' },
  PARTNER: { resource: 'partners', action: 'view' },
  PROMOCODE: { resource: 'promocodes', action: 'view' },
  SUPPORT: { resource: 'support_tickets', action: 'view' },
  FRAUD: { resource: 'fraud_signals', action: 'view' },
  NODE: { resource: 'remnawave', action: 'view' },
  REMNAWAVE: { resource: 'remnawave', action: 'view' },
  SYSTEM: { resource: 'dashboard', action: 'view' },
};
