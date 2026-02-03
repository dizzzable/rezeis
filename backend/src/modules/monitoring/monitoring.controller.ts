import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { ServerMonitoringService } from '../../services/server-monitoring.service.js';
import { CacheService } from '../../cache/cache.service.js';
import { logger } from '../../utils/logger.js';

/**
 * Controller for server monitoring endpoints
 */
export class MonitoringController {
    private readonly monitoringService: ServerMonitoringService;

    constructor(pool: Pool, cacheService: CacheService) {
        this.monitoringService = new ServerMonitoringService(pool, cacheService);
    }

    /**
     * Get all servers statistics
     * GET /api/monitoring/servers
     */
    async getServersStats(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const servers = await this.monitoringService.getServersStats();

            reply.send({
                success: true,
                data: servers,
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get servers stats');
            reply.status(500).send({
                success: false,
                error: 'Failed to get servers statistics',
            });
        }
    }

    /**
     * Get monitoring overview
     * GET /api/monitoring/overview
     */
    async getOverview(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const overview = await this.monitoringService.getOverview();

            reply.send({
                success: true,
                data: overview,
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get monitoring overview');
            reply.status(500).send({
                success: false,
                error: 'Failed to get monitoring overview',
            });
        }
    }

    /**
     * Get specific server details
     * GET /api/monitoring/servers/:id
     */
    async getServerDetails(
        request: FastifyRequest<{ Params: { id: string } }>,
        reply: FastifyReply
    ): Promise<void> {
        try {
            const { id } = request.params;
            const server = await this.monitoringService.getServerDetails(id);

            if (!server) {
                reply.status(404).send({
                    success: false,
                    error: 'Server not found',
                });
                return;
            }

            reply.send({
                success: true,
                data: server,
            });
        } catch (error) {
            logger.error({ error, params: request.params }, 'Failed to get server details');
            reply.status(500).send({
                success: false,
                error: 'Failed to get server details',
            });
        }
    }

    /**
     * Get server history
     * GET /api/monitoring/servers/:id/history
     */
    async getServerHistory(
        request: FastifyRequest<{ Params: { id: string } }>,
        reply: FastifyReply
    ): Promise<void> {
        try {
            const { id } = request.params;
            const history = await this.monitoringService.getServerHistory(id);

            reply.send({
                success: true,
                data: history,
            });
        } catch (error) {
            logger.error({ error, params: request.params }, 'Failed to get server history');
            reply.status(500).send({
                success: false,
                error: 'Failed to get server history',
            });
        }
    }

    /**
     * Get recommended server
     * GET /api/monitoring/servers/recommended
     */
    async getRecommendedServer(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const recommendation = await this.monitoringService.getRecommendedServer();

            if (!recommendation) {
                reply.status(404).send({
                    success: false,
                    error: 'No available servers found',
                });
                return;
            }

            reply.send({
                success: true,
                data: recommendation,
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get recommended server');
            reply.status(500).send({
                success: false,
                error: 'Failed to get recommended server',
            });
        }
    }

    /**
     * Get servers ranking (sorted by load)
     * GET /api/monitoring/servers/ranking
     */
    async getServersRanking(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const ranking = await this.monitoringService.getServersRanking();

            reply.send({
                success: true,
                data: ranking,
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get servers ranking');
            reply.status(500).send({
                success: false,
                error: 'Failed to get servers ranking',
            });
        }
    }

    /**
     * Force refresh server data
     * POST /api/monitoring/refresh
     */
    async forceRefresh(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            const servers = await this.monitoringService.forceRefresh();

            reply.send({
                success: true,
                data: servers,
                message: 'Server data refreshed successfully',
            });
        } catch (error) {
            logger.error({ error }, 'Failed to refresh server data');
            reply.status(500).send({
                success: false,
                error: 'Failed to refresh server data',
            });
        }
    }

    /**
     * Get WebSocket connection stats
     * GET /api/monitoring/websocket-stats
     */
    async getWebSocketStats(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
        try {
            // This will be populated by the WebSocket handler
            reply.send({
                success: true,
                data: {
                    websocketEndpoint: '/ws/monitoring',
                    messageTypes: ['servers:update', 'overview:update', 'ping', 'pong'],
                    updateInterval: 30000,
                },
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get WebSocket stats');
            reply.status(500).send({
                success: false,
                error: 'Failed to get WebSocket stats',
            });
        }
    }
}
