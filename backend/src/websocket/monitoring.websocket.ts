import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { ServerMonitoringService } from '../services/server-monitoring.service.js';
import { logger } from '../utils/logger.js';

/**
 * WebSocket message types for server monitoring
 */
export interface MonitoringWsMessage {
    type: 'subscribe' | 'unsubscribe' | 'ping';
    channel?: string;
}

export interface MonitoringWsResponse {
    type: 'servers:update' | 'overview:update' | 'pong' | 'error';
    timestamp: string;
    data?: unknown;
    error?: string;
}

/**
 * Client connection metadata
 */
interface ClientConnection {
    socket: WebSocket;
    subscribedChannels: Set<string>;
    isAlive: boolean;
    clientType: 'panel' | 'miniapp' | 'unknown';
}

/**
 * WebSocket handler for real-time server monitoring
 */
export class MonitoringWebSocketHandler {
    private clients: Map<string, ClientConnection> = new Map();
    private monitoringService: ServerMonitoringService;
    private broadcastInterval: NodeJS.Timeout | null = null;
    private readonly BROADCAST_INTERVAL_MS = 30000; // 30 seconds

    constructor(monitoringService: ServerMonitoringService) {
        this.monitoringService = monitoringService;
    }

    /**
     * Initialize WebSocket routes
     */
    registerRoutes(fastify: FastifyInstance): void {
        fastify.get('/monitoring', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
            const clientId = this.generateClientId();
            const clientType = this.detectClientType(req);

            logger.info({ clientId, clientType, ip: req.ip }, 'Monitoring WebSocket client connected');

            this.clients.set(clientId, {
                socket,
                subscribedChannels: new Set(),
                isAlive: true,
                clientType,
            });

            // Setup ping/pong for connection health
            this.setupHeartbeat(clientId);

            // Handle incoming messages
            socket.on('message', (message: Buffer) => {
                this.handleMessage(clientId, message.toString());
            });

            // Handle disconnect
            socket.on('close', () => {
                logger.info({ clientId }, 'Monitoring WebSocket client disconnected');
                this.clients.delete(clientId);
            });

            // Handle errors
            socket.on('error', (error: Error) => {
                logger.error({ error, clientId }, 'Monitoring WebSocket error');
            });

            // Send initial data
            this.sendInitialData(clientId);
        });

        // Start broadcasting updates
        this.startBroadcasting();

        logger.info('Monitoring WebSocket routes registered');
    }

    /**
     * Handle incoming WebSocket message
     */
    private handleMessage(clientId: string, message: string): void {
        try {
            const data = JSON.parse(message) as MonitoringWsMessage;
            const client = this.clients.get(clientId);

            if (!client) return;

            switch (data.type) {
                case 'subscribe':
                    if (data.channel) {
                        client.subscribedChannels.add(data.channel);
                        logger.debug({ clientId, channel: data.channel }, 'Client subscribed to channel');
                    }
                    break;

                case 'unsubscribe':
                    if (data.channel) {
                        client.subscribedChannels.delete(data.channel);
                        logger.debug({ clientId, channel: data.channel }, 'Client unsubscribed from channel');
                    }
                    break;

                case 'ping':
                    this.sendToClient(clientId, { type: 'pong', timestamp: new Date().toISOString() });
                    break;

                default:
                    logger.warn({ clientId, messageType: data.type }, 'Unknown message type');
            }
        } catch (error) {
            logger.error({ error, clientId, message }, 'Failed to parse WebSocket message');
            this.sendToClient(clientId, {
                type: 'error',
                timestamp: new Date().toISOString(),
                error: 'Invalid message format',
            });
        }
    }

    /**
     * Send initial data to newly connected client
     */
    private async sendInitialData(clientId: string): Promise<void> {
        try {
            const [servers, overview] = await Promise.all([
                this.monitoringService.getServersStats(),
                this.monitoringService.getOverview(),
            ]);

            this.sendToClient(clientId, {
                type: 'servers:update',
                timestamp: new Date().toISOString(),
                data: servers,
            });

            this.sendToClient(clientId, {
                type: 'overview:update',
                timestamp: new Date().toISOString(),
                data: overview,
            });
        } catch (error) {
            logger.error({ error, clientId }, 'Failed to send initial data');
        }
    }

    /**
     * Start periodic broadcasting of server updates
     */
    private startBroadcasting(): void {
        if (this.broadcastInterval) return;

        this.broadcastInterval = setInterval(async () => {
            if (this.clients.size === 0) return;

            try {
                const [servers, overview] = await Promise.all([
                    this.monitoringService.getServersStats(),
                    this.monitoringService.getOverview(),
                ]);

                this.broadcast({
                    type: 'servers:update',
                    timestamp: new Date().toISOString(),
                    data: servers,
                });

                this.broadcast({
                    type: 'overview:update',
                    timestamp: new Date().toISOString(),
                    data: overview,
                });
            } catch (error) {
                logger.error({ error }, 'Failed to broadcast monitoring updates');
            }
        }, this.BROADCAST_INTERVAL_MS);

        logger.info({ intervalMs: this.BROADCAST_INTERVAL_MS }, 'Monitoring broadcast started');
    }

    /**
     * Broadcast message to all connected clients
     */
    private broadcast(message: MonitoringWsResponse): void {
        const payload = JSON.stringify(message);

        for (const [clientId, client] of this.clients) {
            if (client.socket.readyState === 1) { // WebSocket.OPEN
                try {
                    client.socket.send(payload);
                } catch (error) {
                    logger.error({ error, clientId }, 'Failed to send broadcast message');
                }
            }
        }
    }

    /**
     * Send message to specific client
     */
    private sendToClient(clientId: string, message: MonitoringWsResponse): void {
        const client = this.clients.get(clientId);
        if (!client || client.socket.readyState !== 1) return;

        try {
            client.socket.send(JSON.stringify(message));
        } catch (error) {
            logger.error({ error, clientId }, 'Failed to send message to client');
        }
    }

    /**
     * Setup heartbeat/ping-pong for connection health
     */
    private setupHeartbeat(clientId: string): void {
        const interval = setInterval(() => {
            const client = this.clients.get(clientId);
            if (!client) {
                clearInterval(interval);
                return;
            }

            if (!client.isAlive) {
                client.socket.close();
                this.clients.delete(clientId);
                clearInterval(interval);
                return;
            }

            client.isAlive = false;
            try {
                // Send ping message via WebSocket protocol
                if (client.socket.readyState === 1) {
                    client.socket.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }));
                }
            } catch {
                client.socket.close();
                this.clients.delete(clientId);
                clearInterval(interval);
            }
        }, 30000);
    }

    /**
     * Generate unique client ID
     */
    private generateClientId(): string {
        return `mon-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Detect client type from request headers/user-agent
     */
    private detectClientType(req: FastifyRequest): 'panel' | 'miniapp' | 'unknown' {
        const headers = req.headers as Record<string, string | string[] | undefined>;
        const userAgent = String(headers['user-agent'] || '').toLowerCase();
        const referer = String(headers['referer'] || '').toLowerCase();

        if (userAgent.includes('telegram') || referer.includes('tgwebapp')) {
            return 'miniapp';
        }

        if (referer.includes('/admin') || referer.includes('/panel')) {
            return 'panel';
        }

        return 'unknown';
    }

    /**
     * Stop broadcasting and cleanup
     */
    stop(): void {
        if (this.broadcastInterval) {
            clearInterval(this.broadcastInterval);
            this.broadcastInterval = null;
        }

        for (const [_clientId, client] of this.clients) {
            try {
                client.socket.close();
            } catch {
                // Ignore errors during cleanup
            }
        }

        this.clients.clear();
        logger.info('Monitoring WebSocket handler stopped');
    }

    /**
     * Get current connection stats
     */
    getStats(): { totalConnections: number; panelConnections: number; miniappConnections: number } {
        let panelConnections = 0;
        let miniappConnections = 0;

        for (const client of this.clients.values()) {
            if (client.clientType === 'panel') panelConnections++;
            else if (client.clientType === 'miniapp') miniappConnections++;
        }

        return {
            totalConnections: this.clients.size,
            panelConnections,
            miniappConnections,
        };
    }
}
