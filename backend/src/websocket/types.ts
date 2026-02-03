import type WebSocket from 'ws';

/**
 * WebSocket connection type
 */
export type ConnectionType = 'client' | 'admin';

/**
 * WebSocket priority levels
 */
export type MessagePriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * WebSocket client interface
 */
export interface WebSocketClient {
  id: string;
  userId: string;
  connectionType: ConnectionType;
  socket: WebSocket;
  isAuthenticated: boolean;
  subscriptions: Set<string>;
  connectedAt: Date;
  lastPingAt: Date;
}

/**
 * WebSocket message structure
 */
export interface WebSocketMessage {
  type: string;
  payload: unknown;
  timestamp: number;
  correlationId?: string;
}

/**
 * WebSocket event payload
 */
export interface EventPayload {
  id: string;
  type: string;
  userId?: string;
  timestamp: Date;
  data: unknown;
  priority: MessagePriority;
}

/**
 * WebSocket channels enum
 */
export enum WebSocketChannels {
  USER_NOTIFICATIONS = 'user:notifications',
  USER_SUBSCRIPTIONS = 'user:subscriptions',
  USER_PAYMENTS = 'user:payments',
  USER_REFERRALS = 'user:referrals',
  USER_PARTNER = 'user:partner',

  ADMIN_DASHBOARD = 'admin:dashboard',
  ADMIN_USERS = 'admin:users',
  ADMIN_PAYMENTS = 'admin:payments',
  ADMIN_STATISTICS = 'admin:statistics',

  SYSTEM_BROADCAST = 'system:broadcast',
  SYSTEM_MAINTENANCE = 'system:maintenance',
}

/**
 * Event types enum
 */
export enum EventTypes {
  SUBSCRIPTION_CREATED = 'subscription:created',
  SUBSCRIPTION_EXPIRED = 'subscription:expired',
  SUBSCRIPTION_RENEWED = 'subscription:renewed',
  PAYMENT_RECEIVED = 'payment:received',
  PAYMENT_FAILED = 'payment:failed',
  REFERRAL_REGISTERED = 'referral:registered',
  POINTS_EARNED = 'points:earned',
  PARTNER_COMMISSION = 'partner:commission',
  PAYOUT_COMPLETED = 'payout:completed',
  MAINTENANCE_STARTED = 'system:maintenance:started',
  MAINTENANCE_ENDED = 'system:maintenance:ended',
  BROADCAST = 'system:broadcast',
}

/**
 * WebSocket connection query parameters
 */
export interface WebSocketQueryParams {
  token?: string;
  type?: ConnectionType;
}

/**
 * WebSocket stats
 */
export interface WebSocketStats {
  totalConnections: number;
  authenticatedConnections: number;
  clientConnections: number;
  adminConnections: number;
  subscriptionsByChannel: Record<string, number>;
}

/**
 * Pending notification for offline users
 */
export interface PendingNotification {
  id: string;
  userId: string;
  eventType: string;
  payload: unknown;
  priority: MessagePriority;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
  scheduledAt: Date;
}
