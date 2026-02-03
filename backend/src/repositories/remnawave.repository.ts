import { Pool } from 'pg';
import { BaseRepository } from './base.repository.js';
import {
  RemnawaveConfig,
  RemnawaveServer,
  UserVpnKey,
  RemnawaveSyncLog,
  CreateRemnawaveConfigDto,
  UpdateRemnawaveConfigDto,
  CreateRemnawaveServerDto,
  UpdateRemnawaveServerDto,
  CreateUserVpnKeyDto,
  UpdateUserVpnKeyDto,
  CreateRemnawaveSyncLogDto,
  UpdateRemnawaveSyncLogDto,
  RemnawaveServerFilters,
  UserVpnKeyFilters,
  RemnawaveSyncLogFilters,
  TrafficStats,
  UserTrafficStats,
  VpnKeyTrafficInfo,
} from '../entities/remnawave.entity.js';

export class RemnawaveConfigRepository extends BaseRepository<
  RemnawaveConfig,
  CreateRemnawaveConfigDto,
  UpdateRemnawaveConfigDto
> {
  protected readonly tableName = 'remnawave_config';

  constructor(pool: Pool) {
    super(pool);
  }

  protected mapRowToEntity(row: Record<string, unknown>): RemnawaveConfig {
    return {
      id: row.id as string,
      apiUrl: row.api_url as string,
      apiToken: row.api_token as string,
      isActive: row.is_active as boolean,
      syncIntervalMinutes: row.sync_interval_minutes as number,
      lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at as string) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  protected mapPartialRowToEntity(row: Record<string, unknown>): Partial<RemnawaveConfig> {
    const entity: Partial<RemnawaveConfig> = {};
    if (row.id !== undefined) entity.id = row.id as string;
    if (row.api_url !== undefined) entity.apiUrl = row.api_url as string;
    if (row.api_token !== undefined) entity.apiToken = row.api_token as string;
    if (row.is_active !== undefined) entity.isActive = row.is_active as boolean;
    if (row.sync_interval_minutes !== undefined) entity.syncIntervalMinutes = row.sync_interval_minutes as number;
    if (row.last_sync_at !== undefined) entity.lastSyncAt = row.last_sync_at ? new Date(row.last_sync_at as string) : null;
    if (row.created_at !== undefined) entity.createdAt = new Date(row.created_at as string);
    if (row.updated_at !== undefined) entity.updatedAt = new Date(row.updated_at as string);
    return entity;
  }

  async getConfig(): Promise<RemnawaveConfig | null> {
    const result = await this.query('SELECT * FROM remnawave_config LIMIT 1');
    return result.rows.length > 0 ? this.mapRowToEntity(result.rows[0]) : null;
  }

  async updateLastSync(): Promise<void> {
    await this.query(
      'UPDATE remnawave_config SET last_sync_at = NOW(), updated_at = NOW()'
    );
  }
}

export class RemnawaveServerRepository extends BaseRepository<
  RemnawaveServer,
  CreateRemnawaveServerDto,
  UpdateRemnawaveServerDto
> {
  protected readonly tableName = 'remnawave_servers';

  constructor(pool: Pool) {
    super(pool);
  }

  protected mapRowToEntity(row: Record<string, unknown>): RemnawaveServer {
    return {
      id: row.id as string,
      remnawaveId: row.remnawave_id as string,
      name: row.name as string,
      address: row.address as string,
      port: row.port as number,
      protocol: row.protocol as string,
      isActive: row.is_active as boolean,
      trafficLimit: row.traffic_limit as number,
      trafficUsed: row.traffic_used as number,
      lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at as string) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  protected mapPartialRowToEntity(row: Record<string, unknown>): Partial<RemnawaveServer> {
    const entity: Partial<RemnawaveServer> = {};
    if (row.id !== undefined) entity.id = row.id as string;
    if (row.remnawave_id !== undefined) entity.remnawaveId = row.remnawave_id as string;
    if (row.name !== undefined) entity.name = row.name as string;
    if (row.address !== undefined) entity.address = row.address as string;
    if (row.port !== undefined) entity.port = row.port as number;
    if (row.protocol !== undefined) entity.protocol = row.protocol as string;
    if (row.is_active !== undefined) entity.isActive = row.is_active as boolean;
    if (row.traffic_limit !== undefined) entity.trafficLimit = row.traffic_limit as number;
    if (row.traffic_used !== undefined) entity.trafficUsed = row.traffic_used as number;
    if (row.last_synced_at !== undefined) entity.lastSyncedAt = row.last_synced_at ? new Date(row.last_synced_at as string) : null;
    if (row.created_at !== undefined) entity.createdAt = new Date(row.created_at as string);
    if (row.updated_at !== undefined) entity.updatedAt = new Date(row.updated_at as string);
    return entity;
  }

  async findByRemnawaveId(remnawaveId: string): Promise<RemnawaveServer | null> {
    const result = await this.query(
      'SELECT * FROM remnawave_servers WHERE remnawave_id = $1',
      [remnawaveId]
    );
    return result.rows.length > 0 ? this.mapRowToEntity(result.rows[0]) : null;
  }

  async findActive(): Promise<RemnawaveServer[]> {
    const result = await this.query(
      'SELECT * FROM remnawave_servers WHERE is_active = true ORDER BY name'
    );
    return result.rows.map(row => this.mapRowToEntity(row));
  }

  async findWithFilters(filters: RemnawaveServerFilters, page = 1, limit = 50): Promise<{ data: RemnawaveServer[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters.isActive !== undefined) {
      conditions.push(`is_active = $${paramIndex++}`);
      values.push(filters.isActive);
    }

    if (filters.protocol) {
      conditions.push(`protocol = $${paramIndex++}`);
      values.push(filters.protocol);
    }

    if (filters.search) {
      conditions.push(`(name ILIKE $${paramIndex} OR address ILIKE $${paramIndex})`);
      values.push(`%${filters.search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countResult = await this.query(
      `SELECT COUNT(*) FROM remnawave_servers ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].count as string, 10);

    const dataResult = await this.query(
      `SELECT * FROM remnawave_servers ${whereClause} ORDER BY name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset]
    );

    return {
      data: dataResult.rows.map(row => this.mapRowToEntity(row)),
      total,
    };
  }

  async upsertByRemnawaveId(remnawaveId: string, data: CreateRemnawaveServerDto): Promise<RemnawaveServer> {
    const existing = await this.findByRemnawaveId(remnawaveId);
    
    if (existing) {
      return this.update(existing.id, {
        ...data,
        lastSyncedAt: new Date(),
      });
    }

    return this.create({
      ...data,
      remnawaveId,
    });
  }

  async updateTraffic(serverId: string, trafficUsed: number): Promise<void> {
    await this.query(
      'UPDATE remnawave_servers SET traffic_used = $1, updated_at = NOW() WHERE id = $2',
      [trafficUsed, serverId]
    );
  }
}

export class UserVpnKeyRepository extends BaseRepository<
  UserVpnKey,
  CreateUserVpnKeyDto,
  UpdateUserVpnKeyDto
> {
  protected readonly tableName = 'user_vpn_keys';

  constructor(pool: Pool) {
    super(pool);
  }

  protected mapRowToEntity(row: Record<string, unknown>): UserVpnKey {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      subscriptionId: row.subscription_id as string | null,
      serverId: row.server_id as string,
      remnawaveUuid: row.remnawave_uuid as string,
      keyData: row.key_data as string,
      isActive: row.is_active as boolean,
      trafficUsed: row.traffic_used as number,
      trafficLimit: row.traffic_limit as number,
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  protected mapPartialRowToEntity(row: Record<string, unknown>): Partial<UserVpnKey> {
    const entity: Partial<UserVpnKey> = {};
    if (row.id !== undefined) entity.id = row.id as string;
    if (row.user_id !== undefined) entity.userId = row.user_id as string;
    if (row.subscription_id !== undefined) entity.subscriptionId = row.subscription_id as string | null;
    if (row.server_id !== undefined) entity.serverId = row.server_id as string;
    if (row.remnawave_uuid !== undefined) entity.remnawaveUuid = row.remnawave_uuid as string;
    if (row.key_data !== undefined) entity.keyData = row.key_data as string;
    if (row.is_active !== undefined) entity.isActive = row.is_active as boolean;
    if (row.traffic_used !== undefined) entity.trafficUsed = row.traffic_used as number;
    if (row.traffic_limit !== undefined) entity.trafficLimit = row.traffic_limit as number;
    if (row.expires_at !== undefined) entity.expiresAt = row.expires_at ? new Date(row.expires_at as string) : null;
    if (row.created_at !== undefined) entity.createdAt = new Date(row.created_at as string);
    if (row.updated_at !== undefined) entity.updatedAt = new Date(row.updated_at as string);
    return entity;
  }

  async findByUserId(userId: string): Promise<UserVpnKey[]> {
    const result = await this.query(
      'SELECT * FROM user_vpn_keys WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows.map(row => this.mapRowToEntity(row));
  }

  async findByRemnawaveUuid(uuid: string): Promise<UserVpnKey | null> {
    const result = await this.query(
      'SELECT * FROM user_vpn_keys WHERE remnawave_uuid = $1',
      [uuid]
    );
    return result.rows.length > 0 ? this.mapRowToEntity(result.rows[0]) : null;
  }

  async findBySubscriptionId(subscriptionId: string): Promise<UserVpnKey[]> {
    const result = await this.query(
      'SELECT * FROM user_vpn_keys WHERE subscription_id = $1',
      [subscriptionId]
    );
    return result.rows.map(row => this.mapRowToEntity(row));
  }

  async findWithFilters(filters: UserVpnKeyFilters, page = 1, limit = 50): Promise<{ data: UserVpnKey[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      values.push(filters.userId);
    }

    if (filters.subscriptionId) {
      conditions.push(`subscription_id = $${paramIndex++}`);
      values.push(filters.subscriptionId);
    }

    if (filters.serverId) {
      conditions.push(`server_id = $${paramIndex++}`);
      values.push(filters.serverId);
    }

    if (filters.isActive !== undefined) {
      conditions.push(`is_active = $${paramIndex++}`);
      values.push(filters.isActive);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countResult = await this.query(
      `SELECT COUNT(*) FROM user_vpn_keys ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].count as string, 10);

    const dataResult = await this.query(
      `SELECT * FROM user_vpn_keys ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset]
    );

    return {
      data: dataResult.rows.map(row => this.mapRowToEntity(row)),
      total,
    };
  }

  async getTrafficStats(): Promise<TrafficStats> {
    const statsResult = await this.query(`
      SELECT 
        COALESCE(SUM(traffic_used), 0) as total_used,
        COALESCE(SUM(traffic_limit), 0) as total_limit,
        COUNT(*) FILTER (WHERE is_active = true) as active_count,
        COUNT(*) FILTER (WHERE is_active = false) as inactive_count
      FROM user_vpn_keys
    `);

    const serverStatsResult = await this.query(`
      SELECT 
        s.id as server_id,
        s.name as server_name,
        COALESCE(SUM(k.traffic_used), 0) as traffic_used,
        COALESCE(SUM(k.traffic_limit), 0) as traffic_limit,
        COUNT(k.id) as keys_count
      FROM remnawave_servers s
      LEFT JOIN user_vpn_keys k ON s.id = k.server_id
      GROUP BY s.id, s.name
      ORDER BY s.name
    `);

    return {
      totalTrafficUsed: parseInt(statsResult.rows[0].total_used as string, 10),
      totalTrafficLimit: parseInt(statsResult.rows[0].total_limit as string, 10),
      activeKeysCount: parseInt(statsResult.rows[0].active_count as string, 10),
      inactiveKeysCount: parseInt(statsResult.rows[0].inactive_count as string, 10),
      serverStats: serverStatsResult.rows.map(row => ({
        serverId: row.server_id as string,
        serverName: row.server_name as string,
        trafficUsed: parseInt(row.traffic_used as string, 10),
        trafficLimit: parseInt(row.traffic_limit as string, 10),
        keysCount: parseInt(row.keys_count as string, 10),
      })),
    };
  }

  async getUserTrafficStats(userId: string): Promise<UserTrafficStats> {
    const result = await this.query(`
      SELECT 
        k.*,
        s.name as server_name
      FROM user_vpn_keys k
      JOIN remnawave_servers s ON k.server_id = s.id
      WHERE k.user_id = $1
      ORDER BY k.created_at DESC
    `, [userId]);

    const keys: VpnKeyTrafficInfo[] = result.rows.map(row => ({
      keyId: row.id as string,
      serverName: row.server_name as string,
      trafficUsed: row.traffic_used as number,
      trafficLimit: row.traffic_limit as number,
      isActive: row.is_active as boolean,
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    }));

    const totalTrafficUsed = keys.reduce((sum, key) => sum + key.trafficUsed, 0);
    const totalTrafficLimit = keys.reduce((sum, key) => sum + key.trafficLimit, 0);

    return {
      userId,
      totalTrafficUsed,
      totalTrafficLimit,
      keys,
    };
  }

  async deactivateBySubscriptionId(subscriptionId: string): Promise<void> {
    await this.query(
      'UPDATE user_vpn_keys SET is_active = false, updated_at = NOW() WHERE subscription_id = $1',
      [subscriptionId]
    );
  }

  async deleteBySubscriptionId(subscriptionId: string): Promise<void> {
    await this.query(
      'DELETE FROM user_vpn_keys WHERE subscription_id = $1',
      [subscriptionId]
    );
  }
}

export class RemnawaveSyncLogRepository extends BaseRepository<
  RemnawaveSyncLog,
  CreateRemnawaveSyncLogDto,
  UpdateRemnawaveSyncLogDto
> {
  protected readonly tableName = 'remnawave_sync_logs';

  constructor(pool: Pool) {
    super(pool);
  }

  protected mapRowToEntity(row: Record<string, unknown>): RemnawaveSyncLog {
    return {
      id: row.id as string,
      syncType: row.sync_type as string,
      status: row.status as 'pending' | 'running' | 'completed' | 'failed',
      details: (row.details as Record<string, unknown>) || {},
      errorMessage: row.error_message as string | null,
      startedAt: new Date(row.started_at as string),
      completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
      createdAt: new Date(row.created_at as string),
    };
  }

  protected mapPartialRowToEntity(row: Record<string, unknown>): Partial<RemnawaveSyncLog> {
    const entity: Partial<RemnawaveSyncLog> = {};
    if (row.id !== undefined) entity.id = row.id as string;
    if (row.sync_type !== undefined) entity.syncType = row.sync_type as string;
    if (row.status !== undefined) entity.status = row.status as 'pending' | 'running' | 'completed' | 'failed';
    if (row.details !== undefined) entity.details = row.details as Record<string, unknown>;
    if (row.error_message !== undefined) entity.errorMessage = row.error_message as string | null;
    if (row.started_at !== undefined) entity.startedAt = new Date(row.started_at as string);
    if (row.completed_at !== undefined) entity.completedAt = row.completed_at ? new Date(row.completed_at as string) : null;
    if (row.created_at !== undefined) entity.createdAt = new Date(row.created_at as string);
    return entity;
  }

  async findWithFilters(filters: RemnawaveSyncLogFilters, page = 1, limit = 50): Promise<{ data: RemnawaveSyncLog[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters.syncType) {
      conditions.push(`sync_type = $${paramIndex++}`);
      values.push(filters.syncType);
    }

    if (filters.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(filters.status);
    }

    if (filters.startDate) {
      conditions.push(`started_at >= $${paramIndex++}`);
      values.push(filters.startDate);
    }

    if (filters.endDate) {
      conditions.push(`started_at <= $${paramIndex++}`);
      values.push(filters.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countResult = await this.query(
      `SELECT COUNT(*) FROM remnawave_sync_logs ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].count as string, 10);

    const dataResult = await this.query(
      `SELECT * FROM remnawave_sync_logs ${whereClause} ORDER BY started_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset]
    );

    return {
      data: dataResult.rows.map(row => this.mapRowToEntity(row)),
      total,
    };
  }

  async findRecent(limit = 10): Promise<RemnawaveSyncLog[]> {
    const result = await this.query(
      'SELECT * FROM remnawave_sync_logs ORDER BY started_at DESC LIMIT $1',
      [limit]
    );
    return result.rows.map(row => this.mapRowToEntity(row));
  }

  async isSyncRunning(): Promise<boolean> {
    const result = await this.query(
      "SELECT COUNT(*) as count FROM remnawave_sync_logs WHERE status = 'running'"
    );
    return parseInt(result.rows[0].count as string, 10) > 0;
  }
}
