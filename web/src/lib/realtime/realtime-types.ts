/**
 * Wire types for the admin realtime channel.
 *
 * The frontend keeps these copies decoupled from the backend so we can
 * regenerate the Prisma client / refactor the gateway without breaking the
 * SPA build. The shape mirrors `RealtimeEventInterface` on the server.
 */

export type RealtimeSeverity = 'INFO' | 'WARNING' | 'ERROR';

export type RealtimeCategory =
  | 'USER'
  | 'AUTH'
  | 'SUBSCRIPTION'
  | 'PAYMENT'
  | 'REFERRAL'
  | 'PARTNER'
  | 'PROMOCODE'
  | 'SYSTEM';

export interface RealtimeEvent {
  type: string;
  category: RealtimeCategory;
  severity: RealtimeSeverity;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/** Topics the client may subscribe to; mirrors `REALTIME_TOPICS`. */
export const REALTIME_TOPICS: readonly RealtimeCategory[] = [
  'USER',
  'AUTH',
  'SUBSCRIPTION',
  'PAYMENT',
  'REFERRAL',
  'PARTNER',
  'PROMOCODE',
  'SYSTEM',
] as const;

/** Application-level close codes emitted by the server before disconnect. */
export const REALTIME_CLOSE = {
  AUTH_FAILURE: 4001,
  ADMIN_INACTIVE: 4002,
  TOKEN_VERSION_MISMATCH: 4003,
} as const;
