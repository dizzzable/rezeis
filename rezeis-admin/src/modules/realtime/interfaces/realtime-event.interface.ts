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
