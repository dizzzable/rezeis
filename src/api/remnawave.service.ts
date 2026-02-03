import apiClient from './client';
import type { PaginatedResult } from '@/types/entity.types';

export interface RemnawaveConfig {
  id: string;
  apiUrl: string;
  apiToken: string;
  isActive: boolean;
  syncIntervalMinutes: number;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemnawaveServer {
  id: string;
  remnawaveId: string;
  name: string;
  address: string;
  port: number;
  protocol: string;
  isActive: boolean;
  trafficLimit: number;
  trafficUsed: number;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserVpnKey {
  id: string;
  userId: string;
  subscriptionId: string | null;
  serverId: string;
  remnawaveUuid: string;
  keyData: string;
  isActive: boolean;
  trafficUsed: number;
  trafficLimit: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemnawaveSyncLog {
  id: string;
  syncType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  details: Record<string, unknown>;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
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

export interface UpdateConfigInput {
  apiUrl?: string;
  apiToken?: string;
  isActive?: boolean;
  syncIntervalMinutes?: number;
}

export interface CreateKeyInput {
  userId: string;
  subscriptionId?: string;
  serverId: string;
  trafficLimit?: number;
  expiresAt?: string;
}

export interface UpdateKeyInput {
  isActive?: boolean;
  trafficLimit?: number;
  expiresAt?: string;
}

export interface ServerFilters {
  isActive?: boolean;
  protocol?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface KeyFilters {
  userId?: string;
  subscriptionId?: string;
  serverId?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
}

export interface SyncLogFilters {
  syncType?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

class RemnawaveService {
  // Config
  async getConfig(): Promise<RemnawaveConfig> {
    const response = await apiClient.get<RemnawaveConfig>('/remnawave/config');
    return response.data;
  }

  async updateConfig(data: UpdateConfigInput): Promise<RemnawaveConfig> {
    const response = await apiClient.put<RemnawaveConfig>('/remnawave/config', data);
    return response.data;
  }

  async testConnection(apiUrl: string, apiToken: string): Promise<{ success: boolean; message: string; version?: string }> {
    const response = await apiClient.post('/remnawave/config/test', { apiUrl, apiToken });
    return response.data;
  }

  // Servers
  async getServers(filters: ServerFilters = {}): Promise<PaginatedResult<RemnawaveServer>> {
    const response = await apiClient.get('/remnawave/servers', { params: filters });
    return response.data;
  }

  async getServer(id: string): Promise<RemnawaveServer> {
    const response = await apiClient.get<RemnawaveServer>(`/remnawave/servers/${id}`);
    return response.data;
  }

  async updateServer(id: string, data: Partial<RemnawaveServer>): Promise<RemnawaveServer> {
    const response = await apiClient.patch<RemnawaveServer>(`/remnawave/servers/${id}`, data);
    return response.data;
  }

  async syncServers(): Promise<{ synced: number; created: number; updated: number }> {
    const response = await apiClient.post('/remnawave/servers/sync');
    return response.data;
  }

  // Keys
  async getKeys(filters: KeyFilters = {}): Promise<PaginatedResult<UserVpnKey>> {
    const response = await apiClient.get('/remnawave/keys', { params: filters });
    return response.data;
  }

  async getUserKeys(userId: string): Promise<UserVpnKey[]> {
    const response = await apiClient.get<UserVpnKey[]>(`/remnawave/keys/user/${userId}`);
    return response.data;
  }

  async getKey(id: string): Promise<UserVpnKey> {
    const response = await apiClient.get<UserVpnKey>(`/remnawave/keys/${id}`);
    return response.data;
  }

  async createKey(data: CreateKeyInput): Promise<UserVpnKey> {
    const response = await apiClient.post<UserVpnKey>('/remnawave/keys', data);
    return response.data;
  }

  async updateKey(id: string, data: UpdateKeyInput): Promise<UserVpnKey> {
    const response = await apiClient.patch<UserVpnKey>(`/remnawave/keys/${id}`, data);
    return response.data;
  }

  async deleteKey(id: string): Promise<void> {
    await apiClient.delete(`/remnawave/keys/${id}`);
  }

  async syncKey(id: string): Promise<UserVpnKey> {
    const response = await apiClient.post<UserVpnKey>(`/remnawave/keys/${id}/sync`);
    return response.data;
  }

  // Traffic
  async getTrafficStats(): Promise<TrafficStats> {
    const response = await apiClient.get<TrafficStats>('/remnawave/traffic');
    return response.data;
  }

  async getUserTraffic(userId: string): Promise<{ userId: string; totalTrafficUsed: number; totalTrafficLimit: number; keys: unknown[] }> {
    const response = await apiClient.get(`/remnawave/traffic/user/${userId}`);
    return response.data;
  }

  // Sync
  async triggerSync(type: 'full' | 'servers' | 'keys' | 'traffic' = 'full'): Promise<{ jobId: string }> {
    const response = await apiClient.post('/remnawave/sync', { type });
    return response.data;
  }

  async getSyncLogs(filters: SyncLogFilters = {}): Promise<PaginatedResult<RemnawaveSyncLog>> {
    const response = await apiClient.get('/remnawave/sync/logs', { params: filters });
    return response.data;
  }

  async getSyncStatus(): Promise<{ isRunning: boolean; lastSync: string | null }> {
    const response = await apiClient.get('/remnawave/sync/status');
    return response.data;
  }

  // ==================== MULTI-SUBSCRIPTION SYNC (Super Admin) ====================

  /**
   * Get all Remnawave users by Telegram ID
   */
  async getUsersByTelegramId(telegramId: string): Promise<{
    success: boolean;
    data: {
      telegramId: string;
      users: Array<{
        uuid: string;
        shortUuid: string;
        username: string;
        telegramId: number | null;
        status: string;
        subscriptionUrl: string;
        expireAt: string | null;
        trafficUsed: number;
        trafficLimit: number;
        isLinked: boolean;
        linkId: string | null;
        isPrimary: boolean;
      }>;
      totalCount: number;
      linkedCount: number;
    };
  }> {
    const response = await apiClient.get(`/remnawave/users/by-telegram/${telegramId}`);
    return response.data;
  }

  /**
   * Synchronize all Remnawave users with rezeis
   */
  async syncAllUsers(): Promise<{
    success: boolean;
    data: {
      report: {
        totalProcessed: number;
        linked: number;
        created: number;
        skipped: number;
        errors: number;
        startedAt: string;
        completedAt: string;
        durationMs: number;
      };
      details: Array<{
        telegramId: string;
        remnawaveUuid: string;
        username: string;
        status: 'linked' | 'created' | 'skipped' | 'error';
        message: string;
      }>;
    };
  }> {
    const response = await apiClient.post('/remnawave/sync/users');
    return response.data;
  }

  /**
   * Link Telegram ID to a Remnawave profile
   */
  async linkTelegramToUser(
    uuid: string,
    telegramId: string,
    userId?: string
  ): Promise<{
    success: boolean;
    data: {
      telegramId: string;
      remnawaveUuid: string;
      username: string;
      status: 'linked' | 'created';
      message: string;
    };
  }> {
    const response = await apiClient.post(`/remnawave/users/${uuid}/link-telegram`, {
      telegramId,
      userId,
    });
    return response.data;
  }

  /**
   * Get all user links with pagination
   */
  async getUserLinks(params: { page?: number; limit?: number } = {}): Promise<{
    success: boolean;
    data: {
      data: Array<{
        id: string;
        userId: string;
        telegramId: string;
        remnawaveUuid: string;
        remnawaveUsername: string | null;
        isPrimary: boolean;
        createdAt: string;
        userUsername?: string;
      }>;
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  }> {
    const response = await apiClient.get('/remnawave/user-links', { params });
    return response.data;
  }

  /**
   * Set a link as primary
   */
  async setPrimaryLink(linkId: string, userId: string): Promise<{
    success: boolean;
    message: string;
  }> {
    const response = await apiClient.patch(`/remnawave/user-links/${linkId}/primary`, {
      userId,
    });
    return response.data;
  }

  /**
   * Delete a user link
   */
  async deleteLink(linkId: string): Promise<{
    success: boolean;
    message: string;
  }> {
    const response = await apiClient.delete(`/remnawave/user-links/${linkId}`);
    return response.data;
  }
}

export const remnawaveService = new RemnawaveService();
