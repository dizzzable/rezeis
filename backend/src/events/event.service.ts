import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import { wsServer } from '../websocket/websocket.server.js';
import { pubSubService } from '../websocket/pubsub.service.js';
import { getValkey } from '../config/redis.js';
import type {
  EventPayload,
  MessagePriority,
  PendingNotification,
} from '../websocket/types.js';
import { EventTypes } from '../websocket/types.js';

/**
 * Subscription event data
 */
export interface SubscriptionEventData {
  subscriptionId: string;
  planId: string;
  planName: string;
  expiresAt: string;
}

/**
 * Payment event data
 */
export interface PaymentEventData {
  paymentId: string;
  amount: number;
  currency: string;
  status: string;
}

/**
 * Referral event data
 */
export interface ReferralEventData {
  referralId: string;
  referralName: string;
  bonusAmount?: number;
}

/**
 * Points event data
 */
export interface PointsEventData {
  amount: number;
  source: string;
  totalPoints: number;
}

/**
 * Partner commission event data
 */
export interface PartnerCommissionEventData {
  commission: number;
  currency: string;
  orderId: string;
}

/**
 * Event service error
 */
export class EventServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'EventServiceError';
  }
}

/**
 * Event service for generating and handling real-time events
 */
export class EventService {
  private readonly pendingNotificationsKey = 'pending:notifications';
  private readonly valkey = getValkey();

  /**
   * Create an event payload
   */
  private createEvent(
    type: string,
    data: unknown,
    userId?: string,
    priority: MessagePriority = 'normal'
  ): EventPayload {
    return {
      id: randomUUID(),
      type,
      userId,
      timestamp: new Date(),
      data,
      priority,
    };
  }

  /**
   * Emit subscription created event
   */
  async emitSubscriptionCreated(userId: string, subscription: SubscriptionEventData): Promise<void> {
    const event = this.createEvent(
      EventTypes.SUBSCRIPTION_CREATED,
      subscription,
      userId,
      'high'
    );
    await this.handleEvent(event);
  }

  /**
   * Emit subscription expired event
   */
  async emitSubscriptionExpired(userId: string, subscriptionId: string): Promise<void> {
    const event = this.createEvent(
      EventTypes.SUBSCRIPTION_EXPIRED,
      { subscriptionId },
      userId,
      'high'
    );
    await this.handleEvent(event);
  }

  /**
   * Emit subscription renewed event
   */
  async emitSubscriptionRenewed(userId: string, subscription: SubscriptionEventData): Promise<void> {
    const event = this.createEvent(
      EventTypes.SUBSCRIPTION_RENEWED,
      subscription,
      userId,
      'normal'
    );
    await this.handleEvent(event);
  }

  /**
   * Emit payment received event
   */
  async emitPaymentReceived(userId: string, payment: PaymentEventData): Promise<void> {
    const event = this.createEvent(
      EventTypes.PAYMENT_RECEIVED,
      payment,
      userId,
      'normal'
    );
    await this.handleEvent(event);
  }

  /**
   * Emit payment failed event
   */
  async emitPaymentFailed(userId: string, paymentId: string, reason: string): Promise<void> {
    const event = this.createEvent(
      EventTypes.PAYMENT_FAILED,
      { paymentId, reason },
      userId,
      'high'
    );
    await this.handleEvent(event);
  }

  /**
   * Emit referral registered event
   */
  async emitReferralRegistered(userId: string, referral: ReferralEventData): Promise<void> {
    const event = this.createEvent(
      EventTypes.REFERRAL_REGISTERED,
      referral,
      userId,
      'normal'
    );
    await this.handleEvent(event);
  }

  /**
   * Emit points earned event
   */
  async emitPointsEarned(userId: string, amount: number, source: string, totalPoints: number): Promise<void> {
    const event = this.createEvent(
      EventTypes.POINTS_EARNED,
      { amount, source, totalPoints },
      userId,
      'normal'
    );
    await this.handleEvent(event);
  }

  /**
   * Emit partner commission event
   */
  async emitPartnerCommission(userId: string, commission: number, orderId: string, currency: string): Promise<void> {
    const event = this.createEvent(
      EventTypes.PARTNER_COMMISSION,
      { commission, orderId, currency },
      userId,
      'normal'
    );
    await this.handleEvent(event);
  }

  /**
   * Emit payout completed event
   */
  async emitPayoutCompleted(userId: string, payoutId: string, amount: number, currency: string): Promise<void> {
    const event = this.createEvent(
      EventTypes.PAYOUT_COMPLETED,
      { payoutId, amount, currency },
      userId,
      'normal'
    );
    await this.handleEvent(event);
  }

  /**
   * Emit maintenance started event
   */
  async emitMaintenanceStarted(message: string): Promise<void> {
    const event = this.createEvent(
      EventTypes.MAINTENANCE_STARTED,
      { message },
      undefined,
      'critical'
    );
    await this.handleEvent(event);
  }

  /**
   * Emit maintenance ended event
   */
  async emitMaintenanceEnded(message: string): Promise<void> {
    const event = this.createEvent(
      EventTypes.MAINTENANCE_ENDED,
      { message },
      undefined,
      'normal'
    );
    await this.handleEvent(event);
  }

  /**
   * Emit broadcast event
   */
  async emitBroadcast(message: string, title?: string): Promise<void> {
    const event = this.createEvent(
      EventTypes.BROADCAST,
      { message, title },
      undefined,
      'high'
    );
    await this.handleEvent(event);
  }

  /**
   * Handle an event - dispatch to WebSocket and queue for offline users
   */
  async handleEvent(event: EventPayload): Promise<void> {
    try {
      // Dispatch to local WebSocket clients
      await this.dispatchToWebSocket(event);

      // Publish to Redis for other instances
      await pubSubService.publishEvent(event);

      // Queue for offline users if user-specific
      if (event.userId) {
        await this.queueForOffline(event);
      }

      logger.debug({ eventType: event.type, eventId: event.id }, 'Event handled');
    } catch (err) {
      logger.error({ err, event }, 'Error handling event');
      throw new EventServiceError('Failed to handle event', err);
    }
  }

  /**
   * Dispatch event to WebSocket clients
   */
  private async dispatchToWebSocket(event: EventPayload): Promise<void> {
    await wsServer.emitEvent(event);
  }

  /**
   * Queue event for offline users in Valkey
   */
  private async queueForOffline(event: EventPayload): Promise<void> {
    if (!event.userId) return;

    try {
      // Check if user is online
      const isOnline = await this.isUserOnline(event.userId);

      if (!isOnline) {
        // Store in Redis for later delivery
        const pending: PendingNotification = {
          id: randomUUID(),
          userId: event.userId,
          eventType: event.type,
          payload: event.data,
          priority: event.priority,
          retryCount: 0,
          maxRetries: 3,
          createdAt: new Date(),
          scheduledAt: new Date(),
        };

        await this.valkey.lpush(
          `${this.pendingNotificationsKey}:${event.userId}`,
          [JSON.stringify(pending)]
        );

        // Set expiration (7 days)
        await this.valkey.expire(`${this.pendingNotificationsKey}:${event.userId}`, 7 * 24 * 60 * 60);

        logger.debug({ userId: event.userId, eventType: event.type }, 'Queued event for offline user');
      }
    } catch (err) {
      logger.error({ err, event }, 'Error queuing event for offline user');
    }
  }

  /**
   * Check if user is currently online
   */
  private async isUserOnline(userId: string): Promise<boolean> {
    // This is a simple check - in production you might want to use a more robust method
    // For now, we check if the user has any active WebSocket connections
    void userId;
    const stats = wsServer.getStats();
    return stats !== null && stats.totalConnections > 0;
  }

  /**
   * Convert GlideString to string
   */
  private gs(value: import('@valkey/valkey-glide').GlideString): string {
    if (Buffer.isBuffer(value)) {
      return value.toString('utf-8');
    }
    return String(value);
  }

  /**
   * Get pending notifications for a user
   */
  async getPendingNotifications(userId: string): Promise<PendingNotification[]> {
    try {
      const items = await this.valkey.lrange(`${this.pendingNotificationsKey}:${userId}`, 0, -1);
      return items.map((item) => JSON.parse(this.gs(item)) as PendingNotification);
    } catch (err) {
      logger.error({ err, userId }, 'Error getting pending notifications');
      return [];
    }
  }

  /**
   * Clear pending notifications for a user
   */
  async clearPendingNotifications(userId: string): Promise<void> {
    try {
      await this.valkey.del([`${this.pendingNotificationsKey}:${userId}`]);
    } catch (err) {
      logger.error({ err, userId }, 'Error clearing pending notifications');
    }
  }

  /**
   * Process pending notifications for a user who just came online
   */
  async processPendingNotifications(userId: string): Promise<void> {
    try {
      const pending = await this.getPendingNotifications(userId);

      if (pending.length === 0) return;

      logger.info({ userId, count: pending.length }, 'Processing pending notifications');

      for (const notification of pending) {
        const event: EventPayload = {
          id: notification.id,
          type: notification.eventType,
          userId: notification.userId,
          timestamp: notification.createdAt,
          data: notification.payload,
          priority: notification.priority,
        };

        await this.dispatchToWebSocket(event);
      }

      // Clear after processing
      await this.clearPendingNotifications(userId);
    } catch (err) {
      logger.error({ err, userId }, 'Error processing pending notifications');
    }
  }
}

// Export singleton instance
export const eventService = new EventService();
