import { GlideClient } from '@valkey/valkey-glide';
import { logger } from '../utils/logger.js';
import { getEnv } from '../config/env.js';
import type { EventPayload } from './types.js';

/**
 * Pub/Sub service error
 */
export class PubSubServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PubSubServiceError';
  }
}

/**
 * Valkey Pub/Sub channels
 */
export const PubSubChannels = {
  WS_BROADCAST: 'ws:broadcast',
  WS_USER_MESSAGE: 'ws:user:',
  WS_ADMIN_MESSAGE: 'ws:admin',
  EVENTS_ALL: 'events:all',
} as const;

/**
 * Valkey Pub/Sub service for scaling WebSocket across multiple instances
 * Note: Valkey-Glide has limited Pub/Sub support. This is a simplified implementation.
 */
export class PubSubService {
  private client: GlideClient | null = null;
  private handlers: Map<string, ((message: string) => void)[]> = new Map();
  private isInitialized = false;

  /**
   * Initialize Valkey Pub/Sub connections
   * Note: Valkey-Glide has limited Pub/Sub support in the current version.
   * This implementation provides the interface for future full implementation.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    const env = getEnv();
    const host = env.VALKEY_HOST || 'localhost';
    const port = env.VALKEY_PORT || 6379;
    const password = env.VALKEY_PASSWORD;

    const clientConfig = {
      addresses: [{ host, port }],
      ...(password && { password }),
      clientName: 'rezeis-pubsub',
    };

    try {
      // Create client for pub/sub operations
      this.client = await GlideClient.createClient(clientConfig);

      logger.info('Valkey Pub/Sub client initialized (limited support in Valkey-Glide)');

      this.isInitialized = true;
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Valkey Pub/Sub');
      throw new PubSubServiceError('Failed to initialize Pub/Sub', err);
    }
  }

  /**
   * Subscribe to a Valkey channel
   * Note: Valkey-Glide has limited Pub/Sub support. Messages are not received in real-time.
   */
  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    if (!this.client) {
      throw new PubSubServiceError('Pub/Sub not initialized');
    }

    try {
      // Store handler for potential future use
      if (!this.handlers.has(channel)) {
        this.handlers.set(channel, []);
      }
      this.handlers.get(channel)?.push(handler);

      logger.warn({ channel }, 'Pub/Sub subscribe is limited in Valkey-Glide - messages not received in real-time');
    } catch (err) {
      logger.error({ err, channel }, 'Failed to subscribe to Valkey channel');
      throw new PubSubServiceError('Failed to subscribe', err);
    }
  }

  /**
   * Unsubscribe from a Valkey channel
   */
  async unsubscribe(channel: string): Promise<void> {
    if (!this.client) return;

    try {
      this.handlers.delete(channel);
      logger.debug({ channel }, 'Unsubscribed from Valkey channel');
    } catch (err) {
      logger.error({ err, channel }, 'Failed to unsubscribe from Valkey channel');
    }
  }

  /**
   * Publish a message to a Valkey channel
   * Note: Publishing is supported but message delivery may be limited
   */
  async publish(channel: string, message: string): Promise<void> {
    if (!this.client) {
      throw new PubSubServiceError('Pub/Sub not initialized');
    }

    try {
      await this.client.publish(message, channel);
      logger.debug({ channel }, 'Published message to Valkey channel');
    } catch (err) {
      logger.error({ err, channel }, 'Failed to publish to Valkey channel');
      throw new PubSubServiceError('Failed to publish', err);
    }
  }

  /**
   * Publish an event to all instances
   */
  async publishEvent(event: EventPayload): Promise<void> {
    const message = JSON.stringify(event);
    await this.publish(PubSubChannels.EVENTS_ALL, message);

    // Also publish to user-specific channel if applicable
    if (event.userId) {
      await this.publish(`${PubSubChannels.WS_USER_MESSAGE}${event.userId}`, message);
    }
  }

  /**
   * Broadcast a message to all WebSocket clients across all instances
   */
  async broadcast(message: unknown): Promise<void> {
    const payload = JSON.stringify({ type: 'broadcast', data: message });
    await this.publish(PubSubChannels.WS_BROADCAST, payload);
  }

  /**
   * Send message to a specific user across all instances
   */
  async sendToUser(userId: string, message: unknown): Promise<void> {
    const payload = JSON.stringify({ type: 'user:message', data: message });
    await this.publish(`${PubSubChannels.WS_USER_MESSAGE}${userId}`, payload);
  }

  /**
   * Send message to all admin connections across all instances
   */
  async sendToAdmins(message: unknown): Promise<void> {
    const payload = JSON.stringify({ type: 'admin:message', data: message });
    await this.publish(PubSubChannels.WS_ADMIN_MESSAGE, payload);
  }

  /**
   * Setup event relay to WebSocket server
   * Note: This is a placeholder due to Valkey-Glide Pub/Sub limitations
   */
  setupEventRelay(_broadcastFn: (event: EventPayload) => Promise<void>): () => void {
    // Note: Valkey-Glide doesn't support real-time Pub/Sub message receiving in the current version
    // This functionality would need to be implemented using a different approach
    logger.warn('Event relay setup is limited due to Valkey-Glide Pub/Sub constraints');

    // Return cleanup function
    return () => {
      // Cleanup any resources if needed
    };
  }

  /**
   * Close Pub/Sub connections
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.isInitialized = false;
    logger.info('Valkey Pub/Sub connections closed');
  }

  /**
   * Check if Pub/Sub is initialized
   */
  getIsInitialized(): boolean {
    return this.isInitialized;
  }
}

// Export singleton instance
export const pubSubService = new PubSubService();
