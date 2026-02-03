/**
 * Remnawave integration entity types
 */

export interface RemnawaveConfig {
  id: string;
  apiUrl: string;
  apiToken: string;
  isActive: boolean;
  syncIntervalMinutes: number;
  lastSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RemnawaveSyncLog {
  id: string;
  syncType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  details: Record<string, unknown>;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}

// DTOs
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
  lastSyncedAt?: Date;
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
}

export interface CreateRemnawaveSyncLogDto {
  syncType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  details?: Record<string, unknown>;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface UpdateRemnawaveSyncLogDto {
  status?: 'pending' | 'running' | 'completed' | 'failed';
  details?: Record<string, unknown>;
  errorMessage?: string;
  completedAt?: Date;
}

// Filters
export interface RemnawaveServerFilters {
  isActive?: boolean;
  protocol?: string;
  search?: string;
}

export interface UserVpnKeyFilters {
  userId?: string;
  subscriptionId?: string;
  serverId?: string;
  isActive?: boolean;
}

export interface RemnawaveSyncLogFilters {
  syncType?: string;
  status?: string;
  startDate?: Date;
  endDate?: Date;
}

// Traffic statistics
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

// API Response types from Remnawave
export interface RemnawaveApiUser {
  uuid: string;
  username: string;
  status: 'active' | 'inactive' | 'expired';
  trafficUsed: number;
  trafficLimit: number;
  expiresAt: string | null;
}

export interface RemnawaveApiServer {
  id: string;
  name: string;
  address: string;
  port: number;
  protocol: string;
  status: 'active' | 'inactive';
}

export interface RemnawaveApiKey {
  uuid: string;
  userUuid: string;
  serverId: string;
  key: string;
  status: 'active' | 'revoked';
}
