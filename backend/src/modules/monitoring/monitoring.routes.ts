import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { Pool } from 'pg';
import { MonitoringController } from './monitoring.controller.js';
import { CacheService } from '../../cache/cache.service.js';
import { MonitoringWebSocketHandler } from '../../websocket/monitoring.websocket.js';
import { ServerMonitoringService } from '../../services/server-monitoring.service.js';
import { getEnv } from '../../config/env.js';

/**
 * Configure monitoring routes
 */
export async function monitoringRoutes(
    fastify: FastifyInstance,
    options: FastifyPluginOptions
): Promise<void> {
    void options;
    const pool = fastify.pg as Pool;
    const cacheService = new CacheService();
    const controller = new MonitoringController(pool, cacheService);

    // Register WebSocket route if enabled
    const env = getEnv();
    if (env.FEATURE_WEBSOCKET_ENABLED) {
        const monitoringService = new ServerMonitoringService(pool, cacheService);
        const wsHandler = new MonitoringWebSocketHandler(monitoringService);
        wsHandler.registerRoutes(fastify);
    }

    // GET /api/monitoring/servers - Get all servers stats
    fastify.get('/servers', {
        schema: {
            tags: ['monitoring'],
            summary: 'Get all servers statistics',
            description: 'Get current statistics for all Remnawave servers',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    uuid: { type: 'string' },
                                    name: { type: 'string' },
                                    address: { type: 'string' },
                                    port: { type: 'number', nullable: true },
                                    countryCode: { type: 'string' },
                                    tags: { type: 'array', items: { type: 'string' } },
                                    isConnected: { type: 'boolean' },
                                    isDisabled: { type: 'boolean' },
                                    usersOnline: { type: 'number' },
                                    trafficUsedBytes: { type: 'number' },
                                    trafficLimitBytes: { type: 'number', nullable: true },
                                    loadPercentage: { type: 'number' },
                                    lastUpdated: { type: 'string', format: 'date-time' },
                                },
                            },
                        },
                    },
                },
            },
        },
        handler: controller.getServersStats.bind(controller),
    });

    // GET /api/monitoring/overview - Get monitoring overview
    fastify.get('/overview', {
        schema: {
            tags: ['monitoring'],
            summary: 'Get monitoring overview',
            description: 'Get aggregated overview statistics',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'object',
                            properties: {
                                totalServers: { type: 'number' },
                                onlineServers: { type: 'number' },
                                offlineServers: { type: 'number' },
                                totalUsersOnline: { type: 'number' },
                                averageLoadPercentage: { type: 'number' },
                                lastUpdated: { type: 'string', format: 'date-time' },
                            },
                        },
                    },
                },
            },
        },
        handler: controller.getOverview.bind(controller),
    });

    // GET /api/monitoring/servers/ranking - Get servers ranking
    fastify.get('/servers/ranking', {
        schema: {
            tags: ['monitoring'],
            summary: 'Get servers ranking',
            description: 'Get servers sorted by load (least loaded first)',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    uuid: { type: 'string' },
                                    name: { type: 'string' },
                                    countryCode: { type: 'string' },
                                    usersOnline: { type: 'number' },
                                    loadPercentage: { type: 'number' },
                                    isConnected: { type: 'boolean' },
                                },
                            },
                        },
                    },
                },
            },
        },
        handler: controller.getServersRanking.bind(controller),
    });

    // GET /api/monitoring/servers/recommended - Get recommended server
    fastify.get('/servers/recommended', {
        schema: {
            tags: ['monitoring'],
            summary: 'Get recommended server',
            description: 'Get the best server for new connections based on current load',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'object',
                            properties: {
                                serverId: { type: 'string' },
                                serverName: { type: 'string' },
                                countryCode: { type: 'string' },
                                reason: { type: 'string' },
                                score: { type: 'number' },
                                usersOnline: { type: 'number' },
                                loadPercentage: { type: 'number' },
                            },
                        },
                    },
                },
                404: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        error: { type: 'string' },
                    },
                },
            },
        },
        handler: controller.getRecommendedServer.bind(controller),
    });

    // GET /api/monitoring/servers/:id - Get specific server details
    fastify.get('/servers/:id', {
        schema: {
            tags: ['monitoring'],
            summary: 'Get server details',
            description: 'Get detailed information about a specific server',
            params: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                uuid: { type: 'string' },
                                name: { type: 'string' },
                                address: { type: 'string' },
                                port: { type: 'number', nullable: true },
                                countryCode: { type: 'string' },
                                tags: { type: 'array', items: { type: 'string' } },
                                isConnected: { type: 'boolean' },
                                isDisabled: { type: 'boolean' },
                                usersOnline: { type: 'number' },
                                trafficUsedBytes: { type: 'number' },
                                trafficLimitBytes: { type: 'number', nullable: true },
                                loadPercentage: { type: 'number' },
                                lastUpdated: { type: 'string', format: 'date-time' },
                            },
                        },
                    },
                },
                404: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        error: { type: 'string' },
                    },
                },
            },
        },
        handler: controller.getServerDetails.bind(controller),
    });

    // GET /api/monitoring/servers/:id/history - Get server history
    fastify.get('/servers/:id/history', {
        schema: {
            tags: ['monitoring'],
            summary: 'Get server history',
            description: 'Get historical data for a specific server (last 24 hours)',
            params: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    timestamp: { type: 'string', format: 'date-time' },
                                    usersOnline: { type: 'number' },
                                    trafficUsedBytes: { type: 'number' },
                                    loadPercentage: { type: 'number' },
                                },
                            },
                        },
                    },
                },
            },
        },
        handler: controller.getServerHistory.bind(controller),
    });

    // POST /api/monitoring/refresh - Force refresh server data
    fastify.post('/refresh', {
        schema: {
            tags: ['monitoring'],
            summary: 'Force refresh server data',
            description: 'Bypass cache and fetch fresh data from Remnawave',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        message: { type: 'string' },
                        data: {
                            type: 'array',
                            items: { type: 'object' },
                        },
                    },
                },
            },
        },
        handler: controller.forceRefresh.bind(controller),
    });

    // GET /api/monitoring/websocket-info - Get WebSocket connection info
    fastify.get('/websocket-info', {
        schema: {
            tags: ['monitoring'],
            summary: 'Get WebSocket information',
            description: 'Get WebSocket endpoint information for real-time updates',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'object',
                            properties: {
                                websocketEndpoint: { type: 'string' },
                                messageTypes: { type: 'array', items: { type: 'string' } },
                                updateInterval: { type: 'number' },
                            },
                        },
                    },
                },
            },
        },
        handler: controller.getWebSocketStats.bind(controller),
    });
}
