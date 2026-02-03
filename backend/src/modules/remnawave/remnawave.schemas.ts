import { z } from 'zod';

// Config schemas
export const remnawaveConfigSchema = z.object({
  id: z.string().uuid(),
  apiUrl: z.string().url(),
  apiToken: z.string(),
  isActive: z.boolean(),
  syncIntervalMinutes: z.number().int().min(1).max(1440),
  lastSyncAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const updateConfigSchema = z.object({
  apiUrl: z.string().url().optional(),
  apiToken: z.string().optional(),
  isActive: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(1).max(1440).optional(),
});

export const testConnectionSchema = z.object({
  apiUrl: z.string().url(),
  apiToken: z.string(),
});

// Server schemas
export const remnawaveServerSchema = z.object({
  id: z.string().uuid(),
  remnawaveId: z.string(),
  name: z.string(),
  address: z.string(),
  port: z.number().int().default(443),
  protocol: z.string().default('vless'),
  isActive: z.boolean(),
  trafficLimit: z.number().default(0),
  trafficUsed: z.number().default(0),
  lastSyncedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const updateServerSchema = z.object({
  name: z.string().optional(),
  address: z.string().optional(),
  port: z.number().int().optional(),
  protocol: z.string().optional(),
  isActive: z.boolean().optional(),
  trafficLimit: z.number().optional(),
});

export const serverFiltersSchema = z.object({
  isActive: z.boolean().optional(),
  protocol: z.string().optional(),
  search: z.string().optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(50),
});

// VPN Key schemas
export const userVpnKeySchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  subscriptionId: z.string().uuid().nullable(),
  serverId: z.string().uuid(),
  remnawaveUuid: z.string(),
  keyData: z.string(),
  isActive: z.boolean(),
  trafficUsed: z.number().default(0),
  trafficLimit: z.number().default(0),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const createKeySchema = z.object({
  userId: z.string().uuid(),
  subscriptionId: z.string().uuid().optional(),
  serverId: z.string().uuid(),
  trafficLimit: z.number().optional(),
  expiresAt: z.string().datetime().optional(),
});

export const updateKeySchema = z.object({
  isActive: z.boolean().optional(),
  trafficLimit: z.number().optional(),
  expiresAt: z.string().datetime().optional(),
});

export const keyFiltersSchema = z.object({
  userId: z.string().uuid().optional(),
  subscriptionId: z.string().uuid().optional(),
  serverId: z.string().uuid().optional(),
  isActive: z.boolean().optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(50),
});

// Sync log schemas
export const remnawaveSyncLogSchema = z.object({
  id: z.string().uuid(),
  syncType: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  details: z.record(z.string(), z.unknown()).default({}),
  errorMessage: z.string().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const syncLogFiltersSchema = z.object({
  syncType: z.string().optional(),
  status: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(50),
});

// Traffic stats schemas
export const serverTrafficStatSchema = z.object({
  serverId: z.string().uuid(),
  serverName: z.string(),
  trafficUsed: z.number(),
  trafficLimit: z.number(),
  keysCount: z.number(),
});

export const trafficStatsSchema = z.object({
  totalTrafficUsed: z.number(),
  totalTrafficLimit: z.number(),
  activeKeysCount: z.number(),
  inactiveKeysCount: z.number(),
  serverStats: z.array(serverTrafficStatSchema),
});

export const vpnKeyTrafficInfoSchema = z.object({
  keyId: z.string().uuid(),
  serverName: z.string(),
  trafficUsed: z.number(),
  trafficLimit: z.number(),
  isActive: z.boolean(),
  expiresAt: z.string().datetime().nullable(),
});

export const userTrafficStatsSchema = z.object({
  userId: z.string().uuid(),
  totalTrafficUsed: z.number(),
  totalTrafficLimit: z.number(),
  keys: z.array(vpnKeyTrafficInfoSchema),
});

// API response schemas
export const testConnectionResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  version: z.string().optional(),
});

export const syncResponseSchema = z.object({
  jobId: z.string().uuid(),
  status: z.string(),
  message: z.string(),
});

export const syncStatusSchema = z.object({
  isRunning: z.boolean(),
  lastSync: z.string().datetime().nullable(),
});

// Type exports
export type RemnawaveConfig = z.infer<typeof remnawaveConfigSchema>;
export type UpdateConfigInput = z.infer<typeof updateConfigSchema>;
export type TestConnectionInput = z.infer<typeof testConnectionSchema>;
export type RemnawaveServer = z.infer<typeof remnawaveServerSchema>;
export type UpdateServerInput = z.infer<typeof updateServerSchema>;
export type ServerFilters = z.infer<typeof serverFiltersSchema>;
export type UserVpnKey = z.infer<typeof userVpnKeySchema>;
export type CreateKeyInput = z.infer<typeof createKeySchema>;
export type UpdateKeyInput = z.infer<typeof updateKeySchema>;
export type KeyFilters = z.infer<typeof keyFiltersSchema>;
export type RemnawaveSyncLog = z.infer<typeof remnawaveSyncLogSchema>;
export type SyncLogFilters = z.infer<typeof syncLogFiltersSchema>;
export type TrafficStats = z.infer<typeof trafficStatsSchema>;
export type UserTrafficStats = z.infer<typeof userTrafficStatsSchema>;
export type TestConnectionResponse = z.infer<typeof testConnectionResponseSchema>;
export type SyncResponse = z.infer<typeof syncResponseSchema>;
export type SyncStatus = z.infer<typeof syncStatusSchema>;
