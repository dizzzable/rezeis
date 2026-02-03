import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
 type PrismaServerWhereInput = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
 type PrismaVpnKeyWhereInput = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
 type PrismaSyncLogWhereInput = any;

// Type aliases for Prisma JSON value
type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
interface JsonObject { [key: string]: JsonValue; }
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface JsonArray extends Array<JsonValue> {}

// Type aliases for Prisma payload types
type RemnawaveServerPayload = {
    id: string;
    remnawave_id: string;
    name: string;
    address: string;
    port: number;
    protocol: string;
    is_active: boolean;
    traffic_limit: number;
    traffic_used: number;
    last_synced_at: Date | null;
    created_at: Date;
    updated_at: Date;
};

type UserVpnKeyPayload = {
    id: string;
    user_id: string;
    subscription_id: string | null;
    server_id: string;
    remnawave_uuid: string;
    key_data: string;
    is_active: boolean;
    traffic_used: number;
    traffic_limit: number;
    expires_at: Date | null;
    created_at: Date;
    updated_at: Date;
};

type RemnawaveSyncLogPayload = {
    id: string;
    sync_type: string;
    status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
    details: unknown;
    error_message: string | null;
    started_at: Date;
    completed_at: Date | null;
    created_at: Date;
};

type RemnawaveConfigPayload = {
    id: string;
    api_url: string;
    api_token: string;
    is_active: boolean;
    sync_interval_minutes: number;
    last_sync_at: Date | null;
    created_at: Date;
    updated_at: Date;
};

type SyncLogStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

/**
 * Repository error class
 */
export class RepositoryError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'RepositoryError';
    }
}

/**
 * Pagination options interface
 */
export interface PaginationOptions {
    page: number;
    limit: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated result interface
 */
export interface PaginatedResult<T> {
    data: T[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}

// ============================================
// RemnawaveConfig Repository
// ============================================

export interface RemnawaveConfigEntity {
    id: string;
    apiUrl: string;
    apiToken: string;
    isActive: boolean;
    syncIntervalMinutes: number;
    lastSyncAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface CreateRemnawaveConfigDto {
    apiUrl: string;
    apiToken: string;
    isActive?: boolean;
    syncIntervalMinutes?: number;
}

export interface UpdateRemnawaveConfigDto {
    apiUrl?: string;
    apiToken?: string;
    isActive?: boolean;
    syncIntervalMinutes?: number;
}

export class RemnawaveConfigPrismaRepository {
    async getConfig(): Promise<RemnawaveConfigEntity | null> {
        try {
            const config = await prisma.remnawaveConfig.findFirst();
            return config ? this.mapToEntity(config) : null;
        } catch (error) {
            logger.error({ error }, 'Failed to get Remnawave config');
            throw new RepositoryError('Failed to get Remnawave config', error);
        }
    }

    async create(data: CreateRemnawaveConfigDto): Promise<RemnawaveConfigEntity> {
        try {
            const config = await prisma.remnawaveConfig.create({
                data: {
                    api_url: data.apiUrl,
                    api_token: data.apiToken,
                    is_active: data.isActive ?? true,
                    sync_interval_minutes: data.syncIntervalMinutes ?? 60,
                },
            });
            return this.mapToEntity(config);
        } catch (error) {
            logger.error({ error, data }, 'Failed to create Remnawave config');
            throw new RepositoryError('Failed to create Remnawave config', error);
        }
    }

    async update(id: string, data: UpdateRemnawaveConfigDto): Promise<RemnawaveConfigEntity> {
        try {
            const config = await prisma.remnawaveConfig.update({
                where: { id },
                data: {
                    api_url: data.apiUrl,
                    api_token: data.apiToken,
                    is_active: data.isActive,
                    sync_interval_minutes: data.syncIntervalMinutes,
                    updated_at: new Date(),
                },
            });
            return this.mapToEntity(config);
        } catch (error) {
            logger.error({ error, id, data }, 'Failed to update Remnawave config');
            throw new RepositoryError('Failed to update Remnawave config', error);
        }
    }

    async updateLastSync(): Promise<void> {
        try {
            await prisma.remnawaveConfig.updateMany({
                data: {
                    last_sync_at: new Date(),
                    updated_at: new Date(),
                },
            });
        } catch (error) {
            logger.error({ error }, 'Failed to update last sync');
            throw new RepositoryError('Failed to update last sync', error);
        }
    }

    private mapToEntity(config: RemnawaveConfigPayload): RemnawaveConfigEntity {
        return {
            id: config.id,
            apiUrl: config.api_url,
            apiToken: config.api_token,
            isActive: config.is_active,
            syncIntervalMinutes: config.sync_interval_minutes,
            lastSyncAt: config.last_sync_at,
            createdAt: config.created_at,
            updatedAt: config.updated_at,
        };
    }
}

// ============================================
// RemnawaveServer Repository
// ============================================

export interface RemnawaveServerEntity {
    id: string;
    remnawaveId: string;
    name: string;
    address: string;
    port: number;
    protocol: string;
    isActive: boolean;
    trafficLimit: number;
    trafficUsed: number;
    lastSyncedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface CreateRemnawaveServerDto {
    remnawaveId: string;
    name: string;
    address: string;
    port?: number;
    protocol?: string;
    isActive?: boolean;
    trafficLimit?: number;
}

export interface UpdateRemnawaveServerDto {
    name?: string;
    address?: string;
    port?: number;
    protocol?: string;
    isActive?: boolean;
    trafficLimit?: number;
    trafficUsed?: number;
    lastSyncedAt?: Date;
}

export interface RemnawaveServerFilters {
    isActive?: boolean;
    protocol?: string;
    search?: string;
}

export class RemnawaveServerPrismaRepository {
    async findById(id: string): Promise<RemnawaveServerEntity | null> {
        try {
            const server = await prisma.remnawaveServer.findUnique({
                where: { id },
            });
            return server ? this.mapToEntity(server) : null;
        } catch (error) {
            logger.error({ error, id }, 'Failed to find server by ID');
            throw new RepositoryError('Failed to find server by ID', error);
        }
    }

    async findByRemnawaveId(remnawaveId: string): Promise<RemnawaveServerEntity | null> {
        try {
            const server = await prisma.remnawaveServer.findUnique({
                where: { remnawave_id: remnawaveId },
            });
            return server ? this.mapToEntity(server) : null;
        } catch (error) {
            logger.error({ error, remnawaveId }, 'Failed to find server by Remnawave ID');
            throw new RepositoryError('Failed to find server by Remnawave ID', error);
        }
    }

    async findActive(): Promise<RemnawaveServerEntity[]> {
        try {
            const servers = await prisma.remnawaveServer.findMany({
                where: { is_active: true },
                orderBy: { name: 'asc' },
            });
            return servers.map((s: RemnawaveServerPayload) => this.mapToEntity(s));
        } catch (error) {
            logger.error({ error }, 'Failed to find active servers');
            throw new RepositoryError('Failed to find active servers', error);
        }
    }

    async findWithFilters(
        filters: RemnawaveServerFilters,
        page = 1,
        limit = 50
    ): Promise<PaginatedResult<RemnawaveServerEntity>> {
        try {
            const where: PrismaServerWhereInput = {};

            if (filters.isActive !== undefined) {
                where.is_active = filters.isActive;
            }

            if (filters.protocol) {
                where.protocol = filters.protocol;
            }

            if (filters.search) {
                where.OR = [
                    { name: { contains: filters.search, mode: 'insensitive' as const } },
                    { address: { contains: filters.search, mode: 'insensitive' as const } },
                ];
            }

            const skip = (page - 1) * limit;

            const [servers, total] = await Promise.all([
                prisma.remnawaveServer.findMany({
                    where,
                    skip,
                    take: limit,
                    orderBy: { name: 'asc' },
                }),
                prisma.remnawaveServer.count({ where }),
            ]);

            return {
                data: servers.map((s: RemnawaveServerPayload) => this.mapToEntity(s)),
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            };
        } catch (error) {
            logger.error({ error, filters }, 'Failed to find servers with filters');
            throw new RepositoryError('Failed to find servers with filters', error);
        }
    }

    async create(data: CreateRemnawaveServerDto): Promise<RemnawaveServerEntity> {
        try {
            const server = await prisma.remnawaveServer.create({
                data: {
                    remnawave_id: data.remnawaveId,
                    name: data.name,
                    address: data.address,
                    port: data.port ?? 443,
                    protocol: data.protocol ?? 'vless',
                    is_active: data.isActive ?? true,
                    traffic_limit: data.trafficLimit ?? 0,
                },
            });
            return this.mapToEntity(server);
        } catch (error) {
            logger.error({ error, data }, 'Failed to create server');
            throw new RepositoryError('Failed to create server', error);
        }
    }

    async update(id: string, data: UpdateRemnawaveServerDto): Promise<RemnawaveServerEntity> {
        try {
            const server = await prisma.remnawaveServer.update({
                where: { id },
                data: {
                    name: data.name,
                    address: data.address,
                    port: data.port,
                    protocol: data.protocol,
                    is_active: data.isActive,
                    traffic_limit: data.trafficLimit,
                    traffic_used: data.trafficUsed,
                    last_synced_at: data.lastSyncedAt,
                    updated_at: new Date(),
                },
            });
            return this.mapToEntity(server);
        } catch (error) {
            logger.error({ error, id, data }, 'Failed to update server');
            throw new RepositoryError('Failed to update server', error);
        }
    }

    async upsertByRemnawaveId(
        remnawaveId: string,
        data: CreateRemnawaveServerDto
    ): Promise<RemnawaveServerEntity> {
        try {
            const server = await prisma.remnawaveServer.upsert({
                where: { remnawave_id: remnawaveId },
                create: {
                    remnawave_id: remnawaveId,
                    name: data.name,
                    address: data.address,
                    port: data.port ?? 443,
                    protocol: data.protocol ?? 'vless',
                    is_active: data.isActive ?? true,
                    traffic_limit: data.trafficLimit ?? 0,
                },
                update: {
                    name: data.name,
                    address: data.address,
                    port: data.port,
                    protocol: data.protocol,
                    is_active: data.isActive,
                    traffic_limit: data.trafficLimit,
                    last_synced_at: new Date(),
                    updated_at: new Date(),
                },
            });
            return this.mapToEntity(server);
        } catch (error) {
            logger.error({ error, remnawaveId, data }, 'Failed to upsert server');
            throw new RepositoryError('Failed to upsert server', error);
        }
    }

    async updateTraffic(serverId: string, trafficUsed: number): Promise<void> {
        try {
            await prisma.remnawaveServer.update({
                where: { id: serverId },
                data: {
                    traffic_used: trafficUsed,
                    updated_at: new Date(),
                },
            });
        } catch (error) {
            logger.error({ error, serverId, trafficUsed }, 'Failed to update server traffic');
            throw new RepositoryError('Failed to update server traffic', error);
        }
    }

    async delete(id: string): Promise<boolean> {
        try {
            await prisma.remnawaveServer.delete({
                where: { id },
            });
            return true;
        } catch (error) {
            logger.error({ error, id }, 'Failed to delete server');
            throw new RepositoryError('Failed to delete server', error);
        }
    }

    private mapToEntity(server: RemnawaveServerPayload): RemnawaveServerEntity {
        return {
            id: server.id,
            remnawaveId: server.remnawave_id,
            name: server.name,
            address: server.address,
            port: server.port,
            protocol: server.protocol,
            isActive: server.is_active,
            trafficLimit: server.traffic_limit,
            trafficUsed: server.traffic_used,
            lastSyncedAt: server.last_synced_at,
            createdAt: server.created_at,
            updatedAt: server.updated_at,
        };
    }
}

// ============================================
// UserVpnKey Repository
// ============================================

export interface UserVpnKeyEntity {
    id: string;
    userId: string;
    subscriptionId: string | null;
    serverId: string;
    remnawaveUuid: string;
    keyData: string;
    isActive: boolean;
    trafficUsed: number;
    trafficLimit: number;
    expiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface CreateUserVpnKeyDto {
    userId: string;
    subscriptionId?: string;
    serverId: string;
    remnawaveUuid: string;
    keyData: string;
    isActive?: boolean;
    trafficLimit?: number;
    expiresAt?: Date;
}

export interface UpdateUserVpnKeyDto {
    isActive?: boolean;
    trafficUsed?: number;
    trafficLimit?: number;
    expiresAt?: Date;
    keyData?: string;
}

export interface UserVpnKeyFilters {
    userId?: string;
    subscriptionId?: string;
    serverId?: string;
    isActive?: boolean;
}

export interface TrafficStats {
    totalTrafficUsed: number;
    totalTrafficLimit: number;
    activeKeysCount: number;
    inactiveKeysCount: number;
    serverStats: ServerTrafficStat[];
}

export interface ServerTrafficStat {
    serverId: string;
    serverName: string;
    trafficUsed: number;
    trafficLimit: number;
    keysCount: number;
}

export interface UserTrafficStats {
    userId: string;
    totalTrafficUsed: number;
    totalTrafficLimit: number;
    keys: VpnKeyTrafficInfo[];
}

export interface VpnKeyTrafficInfo {
    keyId: string;
    serverName: string;
    trafficUsed: number;
    trafficLimit: number;
    isActive: boolean;
    expiresAt: Date | null;
}

export class UserVpnKeyPrismaRepository {
    async findById(id: string): Promise<UserVpnKeyEntity | null> {
        try {
            const key = await prisma.userVpnKey.findUnique({
                where: { id },
            });
            return key ? this.mapToEntity(key) : null;
        } catch (error) {
            logger.error({ error, id }, 'Failed to find VPN key by ID');
            throw new RepositoryError('Failed to find VPN key by ID', error);
        }
    }

    async findByUserId(userId: string): Promise<UserVpnKeyEntity[]> {
        try {
            const keys = await prisma.userVpnKey.findMany({
                where: { user_id: userId },
                orderBy: { created_at: 'desc' },
            });
            return keys.map((k: UserVpnKeyPayload) => this.mapToEntity(k));
        } catch (error) {
            logger.error({ error, userId }, 'Failed to find VPN keys by user ID');
            throw new RepositoryError('Failed to find VPN keys by user ID', error);
        }
    }

    async findByRemnawaveUuid(uuid: string): Promise<UserVpnKeyEntity | null> {
        try {
            const key = await prisma.userVpnKey.findUnique({
                where: { remnawave_uuid: uuid },
            });
            return key ? this.mapToEntity(key) : null;
        } catch (error) {
            logger.error({ error, uuid }, 'Failed to find VPN key by Remnawave UUID');
            throw new RepositoryError('Failed to find VPN key by Remnawave UUID', error);
        }
    }

    async findBySubscriptionId(subscriptionId: string): Promise<UserVpnKeyEntity[]> {
        try {
            const keys = await prisma.userVpnKey.findMany({
                where: { subscription_id: subscriptionId },
            });
            return keys.map((k: UserVpnKeyPayload) => this.mapToEntity(k));
        } catch (error) {
            logger.error({ error, subscriptionId }, 'Failed to find VPN keys by subscription ID');
            throw new RepositoryError('Failed to find VPN keys by subscription ID', error);
        }
    }

    async findWithFilters(
        filters: UserVpnKeyFilters,
        page = 1,
        limit = 50
    ): Promise<PaginatedResult<UserVpnKeyEntity>> {
        try {
            const where: PrismaVpnKeyWhereInput = {};

            if (filters.userId) {
                where.user_id = filters.userId;
            }

            if (filters.subscriptionId) {
                where.subscription_id = filters.subscriptionId;
            }

            if (filters.serverId) {
                where.server_id = filters.serverId;
            }

            if (filters.isActive !== undefined) {
                where.is_active = filters.isActive;
            }

            const skip = (page - 1) * limit;

            const [keys, total] = await Promise.all([
                prisma.userVpnKey.findMany({
                    where,
                    skip,
                    take: limit,
                    orderBy: { created_at: 'desc' },
                }),
                prisma.userVpnKey.count({ where }),
            ]);

            return {
                data: keys.map((k: UserVpnKeyPayload) => this.mapToEntity(k)),
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            };
        } catch (error) {
            logger.error({ error, filters }, 'Failed to find VPN keys with filters');
            throw new RepositoryError('Failed to find VPN keys with filters', error);
        }
    }

    async create(data: CreateUserVpnKeyDto): Promise<UserVpnKeyEntity> {
        try {
            const key = await prisma.userVpnKey.create({
                data: {
                    user_id: data.userId,
                    subscription_id: data.subscriptionId,
                    server_id: data.serverId,
                    remnawave_uuid: data.remnawaveUuid,
                    key_data: data.keyData,
                    is_active: data.isActive ?? true,
                    traffic_limit: data.trafficLimit ?? 0,
                    expires_at: data.expiresAt,
                },
            });
            return this.mapToEntity(key);
        } catch (error) {
            logger.error({ error, data }, 'Failed to create VPN key');
            throw new RepositoryError('Failed to create VPN key', error);
        }
    }

    async update(id: string, data: UpdateUserVpnKeyDto): Promise<UserVpnKeyEntity> {
        try {
            const key = await prisma.userVpnKey.update({
                where: { id },
                data: {
                    is_active: data.isActive,
                    traffic_used: data.trafficUsed,
                    traffic_limit: data.trafficLimit,
                    expires_at: data.expiresAt,
                    key_data: data.keyData,
                    updated_at: new Date(),
                },
            });
            return this.mapToEntity(key);
        } catch (error) {
            logger.error({ error, id, data }, 'Failed to update VPN key');
            throw new RepositoryError('Failed to update VPN key', error);
        }
    }

    async delete(id: string): Promise<boolean> {
        try {
            await prisma.userVpnKey.delete({
                where: { id },
            });
            return true;
        } catch (error) {
            logger.error({ error, id }, 'Failed to delete VPN key');
            throw new RepositoryError('Failed to delete VPN key', error);
        }
    }

    async getTrafficStats(): Promise<TrafficStats> {
        try {
            const stats = await prisma.userVpnKey.aggregate({
                _sum: {
                    traffic_used: true,
                    traffic_limit: true,
                },
                _count: {
                    id: true,
                },
                where: { is_active: true },
            });

            const inactiveCount = await prisma.userVpnKey.count({
                where: { is_active: false },
            });

            const serverStats = await prisma.remnawaveServer.findMany({
                include: {
                    vpn_keys: true,
                },
            });

            return {
                totalTrafficUsed: stats._sum.traffic_used ?? 0,
                totalTrafficLimit: stats._sum.traffic_limit ?? 0,
                activeKeysCount: stats._count.id ?? 0,
                inactiveKeysCount: inactiveCount,
                serverStats: serverStats.map((server: RemnawaveServerPayload & { vpn_keys: UserVpnKeyPayload[] }) => ({
                    serverId: server.id,
                    serverName: server.name,
                    trafficUsed: server.vpn_keys.reduce((sum: number, k: UserVpnKeyPayload) => sum + k.traffic_used, 0),
                    trafficLimit: server.vpn_keys.reduce((sum: number, k: UserVpnKeyPayload) => sum + k.traffic_limit, 0),
                    keysCount: server.vpn_keys.length,
                })),
            };
        } catch (error) {
            logger.error({ error }, 'Failed to get traffic stats');
            throw new RepositoryError('Failed to get traffic stats', error);
        }
    }

    async getUserTrafficStats(userId: string): Promise<UserTrafficStats> {
        try {
            const keys = await prisma.userVpnKey.findMany({
                where: { user_id: userId },
                include: {
                    server: true,
                },
                orderBy: { created_at: 'desc' },
            });

            const keyInfos: VpnKeyTrafficInfo[] = keys.map((k: UserVpnKeyPayload & { server: RemnawaveServerPayload }) => ({
                keyId: k.id,
                serverName: k.server.name,
                trafficUsed: k.traffic_used,
                trafficLimit: k.traffic_limit,
                isActive: k.is_active,
                expiresAt: k.expires_at,
            }));

            return {
                userId,
                totalTrafficUsed: keyInfos.reduce((sum: number, k: VpnKeyTrafficInfo) => sum + k.trafficUsed, 0),
                totalTrafficLimit: keyInfos.reduce((sum: number, k: VpnKeyTrafficInfo) => sum + k.trafficLimit, 0),
                keys: keyInfos,
            };
        } catch (error) {
            logger.error({ error, userId }, 'Failed to get user traffic stats');
            throw new RepositoryError('Failed to get user traffic stats', error);
        }
    }

    async deactivateBySubscriptionId(subscriptionId: string): Promise<void> {
        try {
            await prisma.userVpnKey.updateMany({
                where: { subscription_id: subscriptionId },
                data: {
                    is_active: false,
                    updated_at: new Date(),
                },
            });
        } catch (error) {
            logger.error({ error, subscriptionId }, 'Failed to deactivate VPN keys by subscription');
            throw new RepositoryError('Failed to deactivate VPN keys by subscription', error);
        }
    }

    async deleteBySubscriptionId(subscriptionId: string): Promise<void> {
        try {
            await prisma.userVpnKey.deleteMany({
                where: { subscription_id: subscriptionId },
            });
        } catch (error) {
            logger.error({ error, subscriptionId }, 'Failed to delete VPN keys by subscription');
            throw new RepositoryError('Failed to delete VPN keys by subscription', error);
        }
    }

    private mapToEntity(key: UserVpnKeyPayload): UserVpnKeyEntity {
        return {
            id: key.id,
            userId: key.user_id,
            subscriptionId: key.subscription_id,
            serverId: key.server_id,
            remnawaveUuid: key.remnawave_uuid,
            keyData: key.key_data,
            isActive: key.is_active,
            trafficUsed: key.traffic_used,
            trafficLimit: key.traffic_limit,
            expiresAt: key.expires_at,
            createdAt: key.created_at,
            updatedAt: key.updated_at,
        };
    }
}

// ============================================
// RemnawaveSyncLog Repository
// ============================================

export interface RemnawaveSyncLogEntity {
    id: string;
    syncType: string;
    status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
    details: Record<string, unknown>;
    errorMessage: string | null;
    startedAt: Date;
    completedAt: Date | null;
    createdAt: Date;
}

export interface CreateRemnawaveSyncLogDto {
    syncType: string;
    status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
    details?: Record<string, unknown>;
    errorMessage?: string;
    startedAt?: Date;
    completedAt?: Date;
}

export interface UpdateRemnawaveSyncLogDto {
    status?: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
    details?: Record<string, unknown>;
    errorMessage?: string;
    completedAt?: Date;
}

export interface RemnawaveSyncLogFilters {
    syncType?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
}

export class RemnawaveSyncLogPrismaRepository {
    async findById(id: string): Promise<RemnawaveSyncLogEntity | null> {
        try {
            const log = await prisma.remnawaveSyncLog.findUnique({
                where: { id },
            });
            return log ? this.mapToEntity(log) : null;
        } catch (error) {
            logger.error({ error, id }, 'Failed to find sync log by ID');
            throw new RepositoryError('Failed to find sync log by ID', error);
        }
    }

    async findWithFilters(
        filters: RemnawaveSyncLogFilters,
        page = 1,
        limit = 50
    ): Promise<PaginatedResult<RemnawaveSyncLogEntity>> {
        try {
            const where: PrismaSyncLogWhereInput = {};

            if (filters.syncType) {
                where.sync_type = filters.syncType;
            }

            if (filters.status) {
                where.status = filters.status as SyncLogStatus;
            }

            if (filters.startDate || filters.endDate) {
                where.started_at = {};
                if (filters.startDate) {
                    where.started_at.gte = filters.startDate;
                }
                if (filters.endDate) {
                    where.started_at.lte = filters.endDate;
                }
            }

            const skip = (page - 1) * limit;

            const [logs, total] = await Promise.all([
                prisma.remnawaveSyncLog.findMany({
                    where,
                    skip,
                    take: limit,
                    orderBy: { started_at: 'desc' },
                }),
                prisma.remnawaveSyncLog.count({ where }),
            ]);

            return {
                data: logs.map((l: RemnawaveSyncLogPayload) => this.mapToEntity(l)),
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            };
        } catch (error) {
            logger.error({ error, filters }, 'Failed to find sync logs with filters');
            throw new RepositoryError('Failed to find sync logs with filters', error);
        }
    }

    async findRecent(limit = 10): Promise<RemnawaveSyncLogEntity[]> {
        try {
            const logs = await prisma.remnawaveSyncLog.findMany({
                orderBy: { started_at: 'desc' },
                take: limit,
            });
            return logs.map((l: RemnawaveSyncLogPayload) => this.mapToEntity(l));
        } catch (error) {
            logger.error({ error }, 'Failed to find recent sync logs');
            throw new RepositoryError('Failed to find recent sync logs', error);
        }
    }

    async isSyncRunning(): Promise<boolean> {
        try {
            const count = await prisma.remnawaveSyncLog.count({
                where: { status: 'RUNNING' },
            });
            return count > 0;
        } catch (error) {
            logger.error({ error }, 'Failed to check if sync is running');
            throw new RepositoryError('Failed to check if sync is running', error);
        }
    }

    async create(data: CreateRemnawaveSyncLogDto): Promise<RemnawaveSyncLogEntity> {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const log = await prisma.remnawaveSyncLog.create({
                data: {
                    sync_type: data.syncType,
                    status: data.status,
                    details: (data.details ?? {}) as unknown as any,
                    error_message: data.errorMessage ?? null,
                    started_at: data.startedAt ?? new Date(),
                    completed_at: data.completedAt ?? null,
                } as any,
            });
            return this.mapToEntity(log);
        } catch (error) {
            logger.error({ error, data }, 'Failed to create sync log');
            throw new RepositoryError('Failed to create sync log', error);
        }
    }

    async update(id: string, data: UpdateRemnawaveSyncLogDto): Promise<RemnawaveSyncLogEntity> {
        try {
            // Build update data dynamically
            const updateData: Record<string, unknown> = {};
            if (data.status) updateData.status = data.status;
            if (data.details !== undefined) updateData.details = data.details as Record<string, unknown>;
            if (data.errorMessage !== undefined) updateData.error_message = data.errorMessage;
            if (data.completedAt !== undefined) updateData.completed_at = data.completedAt;

            const log = await prisma.remnawaveSyncLog.update({
                where: { id },
                data: updateData as Record<string, unknown>,
            });
            return this.mapToEntity(log);
        } catch (error) {
            logger.error({ error, id, data }, 'Failed to update sync log');
            throw new RepositoryError('Failed to update sync log', error);
        }
    }

    async delete(id: string): Promise<boolean> {
        try {
            await prisma.remnawaveSyncLog.delete({
                where: { id },
            });
            return true;
        } catch (error) {
            logger.error({ error, id }, 'Failed to delete sync log');
            throw new RepositoryError('Failed to delete sync log', error);
        }
    }

    private mapToEntity(log: RemnawaveSyncLogPayload): RemnawaveSyncLogEntity {
        return {
            id: log.id,
            syncType: log.sync_type,
            status: log.status,
            details: (log.details as Record<string, unknown>) ?? {},
            errorMessage: log.error_message,
            startedAt: log.started_at,
            completedAt: log.completed_at,
            createdAt: log.created_at,
        };
    }
}
