import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { MonitoringWebSocketHandler } from './monitoring.websocket.js';
import { ServerMonitoringService } from '../services/server-monitoring.service.js';
import { getPool } from '../config/database.js';
import { CacheService } from '../cache/cache.service.js';
import type { ConnectionType, WebSocketMessage } from './types.js';

/**
 * Client connection metadata
 */
interface ClientConnection {
  socket: WebSocket;
  userId: string;
  connectionType: ConnectionType;
  isAuthenticated: boolean;
  subscriptions: Set<string>;
  connectedAt: Date;
}

/**
 * WebSocket server instance
 */
class WebSocketServer {
  private clients: Map<string, ClientConnection> = new Map();
  private userClientMap: Map<string, string[]> = new Map();
  private channelSubscribers: Map<string, Set<string>> = new Map();
  private monitoringHandler: MonitoringWebSocketHandler | null = null;

  /**
   * Initialize monitoring WebSocket handler
   */
  initializeMonitoringHandler(handler: MonitoringWebSocketHandler): void {
    this.monitoringHandler = handler;
  }

  /**
   * Generate unique client ID
   */
  static generateClientId(): string {
    return `ws-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Handle new WebSocket connection
   */
  async handleConnection(socket: WebSocket, clientId: string, connectionType: ConnectionType): Promise<void> {
    const client: ClientConnection = {
      socket,
      userId: '',
      connectionType,
      isAuthenticated: false,
      subscriptions: new Set(),
      connectedAt: new Date(),
    };

    this.clients.set(clientId, client);

    // Handle incoming messages
    socket.on('message', (data: Buffer) => {
      this.handleMessage(clientId, data.toString());
    });

    // Handle disconnect
    socket.on('close', () => {
      this.handleDisconnect(clientId);
    });

    // Handle errors
    socket.on('error', (error: Error) => {
      logger.error({ error, clientId }, 'WebSocket error');
    });
  }

  /**
   * Handle incoming message from client
   */
  private handleMessage(clientId: string, message: string): void {
    try {
      const data = JSON.parse(message) as { type: string; payload?: unknown };
      const client = this.clients.get(clientId);

      if (!client) return;

      switch (data.type) {
        case 'auth':
          this.handleAuth(clientId, data.payload as { userId: string; token: string });
          break;
        case 'subscribe':
          this.handleSubscribe(clientId, data.payload as { channel: string });
          break;
        case 'unsubscribe':
          this.handleUnsubscribe(clientId, data.payload as { channel: string });
          break;
        case 'ping':
          this.sendToClient(clientId, { type: 'pong', timestamp: Date.now() });
          break;
        default:
          logger.warn({ clientId, messageType: data.type }, 'Unknown message type');
      }
    } catch (error) {
      logger.error({ error, clientId, message }, 'Failed to parse WebSocket message');
    }
  }

  /**
   * Handle client authentication
   */
  private handleAuth(clientId: string, payload: { userId: string; token: string }): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // In a real implementation, verify the token
    client.userId = payload.userId;
    client.isAuthenticated = true;

    // Map user to client ID
    const userClients = this.userClientMap.get(payload.userId) || [];
    userClients.push(clientId);
    this.userClientMap.set(payload.userId, userClients);

    this.sendToClient(clientId, {
      type: 'auth:success',
      timestamp: Date.now(),
      payload: { clientId },
    });

    logger.info({ clientId, userId: payload.userId }, 'Client authenticated');
  }

  /**
   * Handle channel subscription
   */
  private handleSubscribe(clientId: string, payload: { channel: string }): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const { channel } = payload;
    client.subscriptions.add(channel);

    // Add to channel subscribers
    const subscribers = this.channelSubscribers.get(channel) || new Set();
    subscribers.add(clientId);
    this.channelSubscribers.set(channel, subscribers);

    this.sendToClient(clientId, {
      type: 'subscribe:success',
      timestamp: Date.now(),
      payload: { channel },
    });
  }

  /**
   * Handle channel unsubscription
   */
  private handleUnsubscribe(clientId: string, payload: { channel: string }): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const { channel } = payload;
    client.subscriptions.delete(channel);

    // Remove from channel subscribers
    const subscribers = this.channelSubscribers.get(channel);
    if (subscribers) {
      subscribers.delete(clientId);
    }

    this.sendToClient(clientId, {
      type: 'unsubscribe:success',
      timestamp: Date.now(),
      payload: { channel },
    });
  }

  /**
   * Handle client disconnect
   */
  private handleDisconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Remove from user mapping
    if (client.userId) {
      const userClients = this.userClientMap.get(client.userId) || [];
      const index = userClients.indexOf(clientId);
      if (index > -1) {
        userClients.splice(index, 1);
      }
      if (userClients.length === 0) {
        this.userClientMap.delete(client.userId);
      } else {
        this.userClientMap.set(client.userId, userClients);
      }
    }

    // Remove from channel subscribers
    for (const channel of client.subscriptions) {
      const subscribers = this.channelSubscribers.get(channel);
      if (subscribers) {
        subscribers.delete(clientId);
      }
    }

    this.clients.delete(clientId);
    logger.info({ clientId, userId: client.userId }, 'Client disconnected');
  }

  /**
   * Send message to specific client
   */
  private sendToClient(clientId: string, message: unknown): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    try {
      if (client.socket.readyState === 1) { // WebSocket.OPEN
        client.socket.send(JSON.stringify(message));
      }
    } catch (error) {
      logger.error({ error, clientId }, 'Failed to send message to client');
    }
  }

  /**
   * Get list of all connected clients
   */
  getClients(): Array<{
    id: string;
    userId: string;
    connectionType: ConnectionType;
    isAuthenticated: boolean;
    subscriptions: string[];
    connectedAt: string;
  }> {
    const result = [];
    for (const [clientId, client] of this.clients) {
      result.push({
        id: clientId,
        userId: client.userId,
        connectionType: client.connectionType,
        isAuthenticated: client.isAuthenticated,
        subscriptions: Array.from(client.subscriptions),
        connectedAt: client.connectedAt.toISOString(),
      });
    }
    return result;
  }

  /**
   * Broadcast message to all connected clients
   */
  async broadcast(message: WebSocketMessage): Promise<void> {
    const payload = JSON.stringify(message);

    for (const [clientId, client] of this.clients) {
      if (client.socket.readyState === 1) { // WebSocket.OPEN
        try {
          client.socket.send(payload);
        } catch (error) {
          logger.error({ error, clientId }, 'Failed to broadcast message');
        }
      }
    }
  }

  /**
   * Send message to specific user
   */
  async sendToUser(userId: string, message: WebSocketMessage): Promise<void> {
    const clientIds = this.userClientMap.get(userId);
    if (!clientIds) return;

    const payload = JSON.stringify(message);

    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client && client.socket.readyState === 1) {
        try {
          client.socket.send(payload);
        } catch (error) {
          logger.error({ error, clientId, userId }, 'Failed to send message to user');
        }
      }
    }
  }

  /**
   * Broadcast message to channel subscribers
   */
  async broadcastToChannel(channel: string, message: WebSocketMessage): Promise<void> {
    const subscriberIds = this.channelSubscribers.get(channel);
    if (!subscriberIds) return;

    const payload = JSON.stringify(message);

    for (const clientId of subscriberIds) {
      const client = this.clients.get(clientId);
      if (client && client.socket.readyState === 1) {
        try {
          client.socket.send(payload);
        } catch (error) {
          logger.error({ error, clientId, channel }, 'Failed to broadcast to channel');
        }
      }
    }
  }

  /**
   * Disconnect a specific client
   */
  async disconnectClient(clientId: string): Promise<boolean> {
    const client = this.clients.get(clientId);
    if (!client) return false;

    try {
      client.socket.close();
      this.handleDisconnect(clientId);
      return true;
    } catch (error) {
      logger.error({ error, clientId }, 'Failed to disconnect client');
      return false;
    }
  }

  /**
   * Emit event to all connected clients
   */
  async emitEvent(event: unknown): Promise<void> {
    // Event relay is handled by the monitoring handler
    if (this.monitoringHandler) {
      // Broadcast to all connected clients
      const stats = this.monitoringHandler.getStats();
      logger.debug({ stats, event }, 'Emitting event to WebSocket clients');
    }
  }

  /**
   * Get monitoring handler stats
   */
  getStats(): { totalConnections: number; panelConnections: number; miniappConnections: number; authenticatedConnections: number; clientConnections: number; adminConnections: number; subscriptionsByChannel: Record<string, number> } {
    const monitoringStats = this.monitoringHandler?.getStats();

    // Calculate subscriptions by channel
    const subscriptionsByChannel: Record<string, number> = {};
    for (const [channel, subscribers] of this.channelSubscribers) {
      subscriptionsByChannel[channel] = subscribers.size;
    }

    let authenticatedConnections = 0;
    let clientConnections = 0;
    let adminConnections = 0;

    for (const client of this.clients.values()) {
      if (client.isAuthenticated) authenticatedConnections++;
      if (client.connectionType === 'client') clientConnections++;
      if (client.connectionType === 'admin') adminConnections++;
    }

    return {
      totalConnections: this.clients.size,
      authenticatedConnections,
      clientConnections,
      adminConnections,
      panelConnections: monitoringStats?.panelConnections || 0,
      miniappConnections: monitoringStats?.miniappConnections || 0,
      subscriptionsByChannel,
    };
  }
}

/**
 * Global WebSocket server instance
 */
export const wsServer = new WebSocketServer();

/**
 * Create and configure WebSocket server
 */
export async function createWebSocketServer(): Promise<FastifyInstance> {
  const env = getEnv();

  const app = Fastify({
    logger: env.NODE_ENV === 'development',
    trustProxy: true,
  });

  // Register CORS
  const corsOrigins = env.CORS_ORIGINS 
    ? env.CORS_ORIGINS.split(',').map(o => o.trim())
    : env.NODE_ENV === 'development';

  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });

  // Register WebSocket plugin
  await app.register(websocket);

  // Register monitoring WebSocket routes
  const pool = getPool();
  const cacheService = new CacheService();
  const monitoringService = new ServerMonitoringService(pool, cacheService);
  const monitoringHandler = new MonitoringWebSocketHandler(monitoringService);
  monitoringHandler.registerRoutes(app);
  wsServer.initializeMonitoringHandler(monitoringHandler);

  // Health check endpoint
  app.get('/health', async () => ({
    status: 'ok',
    service: 'websocket',
    connections: monitoringHandler.getStats(),
  }));

  return app;
}

/**
 * Start WebSocket server on dedicated port
 */
export async function startWebSocketServer(): Promise<void> {
  const env = getEnv();

  if (!env.FEATURE_WEBSOCKET_ENABLED) {
    logger.info('WebSocket server is disabled');
    return;
  }

  try {
    const app = await createWebSocketServer();
    const port = env.APP_WEBSOCKET_PORT;

    await app.listen({ port, host: '0.0.0.0' });

    logger.info(`🔌 WebSocket server running on port ${port}`);
  } catch (error) {
    logger.error({ error }, 'Failed to start WebSocket server');
    process.exit(1);
  }
}

export { WebSocketServer };
