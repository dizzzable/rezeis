import type { Pool } from 'pg';
import { RemnawaveService, type RemnawaveNode } from './remnawave.service.js';
import { CacheService } from '../cache/cache.service.js';
import { logger } from '../utils/logger.js';

/**
 * Server monitoring data types
 */
export interface ServerStats {
    id: string;
    uuid: string;
    name: string;
    address: string;
    port: number | null;
    countryCode: string;
    tags: string[];
    isConnected: boolean;
    isDisabled: boolean;
    usersOnline: number;
    trafficUsedBytes: number;
    trafficLimitBytes: number | null;
    loadPercentage: number;
    lastUpdated: string;
}

export interface MonitoringOverview {
    totalServers: number;
    onlineServers: number;
    offlineServers: number;
    totalUsersOnline: number;
    averageLoadPercentage: number;
    lastUpdated: string;
}

export interface ServerHistoryPoint {
    timestamp: string;
    usersOnline: number;
    trafficUsedBytes: number;
    loadPercentage: number;
}

export interface ServerRecommendation {
    serverId: string;
    serverName: string;
    countryCode: string;
    reason: string;
    score: number;
    usersOnline: number;
    loadPercentage: number;
}

/**
 * Cache keys for server monitoring
 */
const CACHE_KEYS = {
    SERVERS_DATA: 'monitoring:servers:data',
    OVERVIEW: 'monitoring:overview',
    HISTORY: (serverId: string) => `monitoring:history:${serverId}`,
} as const;

const CACHE_TTL_SECONDS = 30;
const HISTORY_RETENTION_HOURS = 24;

/**
 * Service for monitoring Remnawave servers
 * Provides real-time and cached server statistics
 */
export class ServerMonitoringService {
    private readonly remnawaveService: RemnawaveService;
    private readonly cacheService: CacheService;
    private readonly pool: Pool;

    constructor(pool: Pool, cacheService: CacheService) {
        this.pool = pool;
        this.cacheService = cacheService;
        this.remnawaveService = new RemnawaveService(pool);
    }

    /**
     * Get current server statistics from Remnawave
     * Uses cache for 30 seconds to reduce API load
     */
    async getServersStats(): Promise<ServerStats[]> {
        const cached = await this.cacheService.get<ServerStats[]>(CACHE_KEYS.SERVERS_DATA);
        if (cached) {
            logger.debug('Returning cached servers data');
            return cached;
        }

        try {
            const nodes = await this.remnawaveService.getAllNodes();
            const stats = this.transformNodesToStats(nodes);

            await this.cacheService.set(CACHE_KEYS.SERVERS_DATA, stats, CACHE_TTL_SECONDS);
            await this.saveHistoryPoints(stats);

            return stats;
        } catch (error) {
            logger.error({ error }, 'Failed to fetch servers stats from Remnawave');
            throw error;
        }
    }

    /**
     * Get monitoring overview statistics
     */
    async getOverview(): Promise<MonitoringOverview> {
        const cached = await this.cacheService.get<MonitoringOverview>(CACHE_KEYS.OVERVIEW);
        if (cached) {
            return cached;
        }

        const servers = await this.getServersStats();
        const overview = this.calculateOverview(servers);

        await this.cacheService.set(CACHE_KEYS.OVERVIEW, overview, CACHE_TTL_SECONDS);

        return overview;
    }

    /**
     * Get server details by ID
     */
    async getServerDetails(serverId: string): Promise<ServerStats | null> {
        const servers = await this.getServersStats();
        return servers.find(s => s.id === serverId || s.uuid === serverId) || null;
    }

    /**
     * Get server load history for the last 24 hours
     */
    async getServerHistory(serverId: string): Promise<ServerHistoryPoint[]> {
        const cached = await this.cacheService.get<ServerHistoryPoint[]>(CACHE_KEYS.HISTORY(serverId));
        if (cached) {
            return cached;
        }

        const query = `
            SELECT 
                timestamp,
                users_online as "usersOnline",
                traffic_used_bytes as "trafficUsedBytes",
                load_percentage as "loadPercentage"
            FROM server_monitoring_history
            WHERE server_id = $1
            AND timestamp > NOW() - INTERVAL '${HISTORY_RETENTION_HOURS} hours'
            ORDER BY timestamp ASC
        `;

        const result = await this.pool.query(query, [serverId]);
        const history: ServerHistoryPoint[] = result.rows;

        await this.cacheService.set(CACHE_KEYS.HISTORY(serverId), history, 60);

        return history;
    }

    /**
     * Get recommended server for new connections
     * Based on lowest users count and online status
     */
    async getRecommendedServer(): Promise<ServerRecommendation | null> {
        const servers = await this.getServersStats();

        const availableServers = servers.filter(
            s => s.isConnected && !s.isDisabled
        );

        if (availableServers.length === 0) {
            return null;
        }

        const sorted = availableServers.sort((a, b) => {
            if (a.usersOnline !== b.usersOnline) {
                return a.usersOnline - b.usersOnline;
            }
            return a.loadPercentage - b.loadPercentage;
        });

        const best = sorted[0];

        return {
            serverId: best.uuid,
            serverName: best.name,
            countryCode: best.countryCode,
            reason: `Lowest load: ${best.usersOnline} users online`,
            score: this.calculateRecommendationScore(best),
            usersOnline: best.usersOnline,
            loadPercentage: best.loadPercentage,
        };
    }

    /**
     * Get all available servers sorted by load (for miniapp)
     */
    async getServersRanking(): Promise<ServerStats[]> {
        const servers = await this.getServersStats();

        return servers
            .filter(s => s.isConnected && !s.isDisabled)
            .sort((a, b) => {
                if (a.usersOnline !== b.usersOnline) {
                    return a.usersOnline - b.usersOnline;
                }
                return a.loadPercentage - b.loadPercentage;
            });
    }

    /**
     * Force refresh server data (bypass cache)
     */
    async forceRefresh(): Promise<ServerStats[]> {
        await this.cacheService.delete(CACHE_KEYS.SERVERS_DATA);
        await this.cacheService.delete(CACHE_KEYS.OVERVIEW);
        return this.getServersStats();
    }

    /**
     * Transform Remnawave nodes to our server stats format
     */
    private transformNodesToStats(nodes: RemnawaveNode[]): ServerStats[] {
        return nodes.map(node => ({
            id: node.uuid,
            uuid: node.uuid,
            name: node.name,
            address: node.address,
            port: node.port,
            countryCode: node.countryCode,
            tags: node.tags || [],
            isConnected: node.isConnected,
            isDisabled: node.isDisabled,
            usersOnline: node.usersOnline || 0,
            trafficUsedBytes: node.trafficUsedBytes || 0,
            trafficLimitBytes: node.trafficLimitBytes,
            loadPercentage: this.calculateLoadPercentage(node),
            lastUpdated: new Date().toISOString(),
        }));
    }

    /**
     * Calculate server load percentage
     */
    private calculateLoadPercentage(node: RemnawaveNode): number {
        if (!node.trafficLimitBytes || node.trafficLimitBytes === 0) {
            return 0;
        }
        return Math.min(100, Math.round((node.trafficUsedBytes || 0) / node.trafficLimitBytes * 100));
    }

    /**
     * Calculate overview statistics
     */
    private calculateOverview(servers: ServerStats[]): MonitoringOverview {
        const onlineServers = servers.filter(s => s.isConnected && !s.isDisabled);
        const totalUsers = servers.reduce((sum, s) => sum + s.usersOnline, 0);
        const avgLoad = servers.length > 0
            ? Math.round(servers.reduce((sum, s) => sum + s.loadPercentage, 0) / servers.length)
            : 0;

        return {
            totalServers: servers.length,
            onlineServers: onlineServers.length,
            offlineServers: servers.length - onlineServers.length,
            totalUsersOnline: totalUsers,
            averageLoadPercentage: avgLoad,
            lastUpdated: new Date().toISOString(),
        };
    }

    /**
     * Calculate recommendation score (0-100, higher is better)
     */
    private calculateRecommendationScore(server: ServerStats): number {
        let score = 100;

        // Penalty for users online (max -50 points)
        score -= Math.min(50, server.usersOnline * 2);

        // Penalty for load percentage (max -30 points)
        score -= Math.min(30, server.loadPercentage * 0.3);

        // Bonus for being online (+20)
        if (server.isConnected && !server.isDisabled) {
            score += 20;
        }

        return Math.max(0, Math.min(100, score));
    }

    /**
     * Save history points to database
     */
    private async saveHistoryPoints(stats: ServerStats[]): Promise<void> {
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            const query = `
                INSERT INTO server_monitoring_history 
                (server_id, timestamp, users_online, traffic_used_bytes, load_percentage)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (server_id, timestamp) DO NOTHING
            `;

            const timestamp = new Date();
            timestamp.setSeconds(0, 0);

            for (const stat of stats) {
                await client.query(query, [
                    stat.uuid,
                    timestamp.toISOString(),
                    stat.usersOnline,
                    stat.trafficUsedBytes,
                    stat.loadPercentage,
                ]);
            }

            // Clean old history
            await client.query(
                `DELETE FROM server_monitoring_history WHERE timestamp < NOW() - INTERVAL '${HISTORY_RETENTION_HOURS} hours'`
            );

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error({ error }, 'Failed to save history points');
        } finally {
            client.release();
        }
    }
}

/**
 * Factory function to create ServerMonitoringService instance
 */
export function createServerMonitoringService(
    pool: Pool,
    cacheService: CacheService
): ServerMonitoringService {
    return new ServerMonitoringService(pool, cacheService);
}
