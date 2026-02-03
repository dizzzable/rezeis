import { GlideClient } from '@valkey/valkey-glide';
import type { BaseClient, GlideString } from '@valkey/valkey-glide';
import { getEnv } from './env.js';
import { logger } from '../utils/logger.js';

/**
 * Valkey configuration options
 */
export interface ValkeyConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  maxConnections: number;
  requestTimeout: number;
  connectionTimeout: number;
}

/**
 * Default Valkey configuration
 */
const defaultConfig: Partial<ValkeyConfig> = {
  db: 0,
  maxConnections: 10,
  requestTimeout: 5000,
  connectionTimeout: 10000,
};

/**
 * Parse Valkey URL into configuration
 * @param url - Valkey connection URL
 * @returns Parsed configuration
 */
function parseValkeyUrl(url: string): Partial<ValkeyConfig> {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port, 10) || 6379,
      password: parsed.password || undefined,
      db: parseInt(parsed.pathname.slice(1), 10) || 0,
    };
  } catch {
    return {
      host: 'localhost',
      port: 6379,
    };
  }
}

/**
 * Convert GlideString to string
 */
export function toString(value: GlideString): string {
  if (Buffer.isBuffer(value)) {
    return value.toString('utf-8');
  }
  return String(value);
}

/**
 * Valkey client wrapper
 * Manages Valkey client instance and provides connection pooling
 */
class ValkeyClientWrapper {
  private client: BaseClient | null = null;
  private readonly config: ValkeyConfig;
  private isInitialized = false;

  constructor(config: ValkeyConfig) {
    this.config = config;
  }

  /**
   * Initialize the Valkey client
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      const host = this.config.host;
      const port = this.config.port;
      const password = this.config.password;

      // Create client configuration
      const clientConfig = {
        addresses: [{ host, port }],
        ...(password && { password }),
        clientName: 'rezeis-backend',
        requestTimeout: this.config.requestTimeout,
        connectionTimeout: this.config.connectionTimeout,
      };

      // Use standalone client
      this.client = await GlideClient.createClient(clientConfig);

      logger.info(`Valkey client connected to ${host}:${port}`);
      this.isInitialized = true;
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Valkey client');
      throw error;
    }
  }

  /**
   * Get the Valkey client instance
   * @returns Valkey client
   */
  getClient(): BaseClient {
    if (!this.client) {
      throw new Error('Valkey client not initialized. Call initialize() first.');
    }
    return this.client;
  }

  /**
   * Close the Valkey client connection
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.isInitialized = false;
      logger.info('Valkey client connection closed');
    }
  }

  /**
   * Check if client is initialized
   */
  getIsInitialized(): boolean {
    return this.isInitialized;
  }
}

/**
 * Primary Valkey client instance
 */
let valkeyClient: BaseClient | null = null;

/**
 * Valkey client wrapper instance
 */
let valkeyWrapper: ValkeyClientWrapper | null = null;

/**
 * Initialize Valkey connection
 * @returns Valkey client instance
 */
export async function initializeValkey(): Promise<BaseClient> {
  const env = getEnv();
  const parsedConfig = parseValkeyUrl(env.VALKEY_URL || 'valkey://localhost:6379');

  const config: ValkeyConfig = {
    ...defaultConfig,
    ...parsedConfig,
    maxConnections: env.VALKEY_MAX_CONNECTIONS || 10,
  } as ValkeyConfig;

  // Initialize wrapper
  valkeyWrapper = new ValkeyClientWrapper(config);
  await valkeyWrapper.initialize();

  valkeyClient = valkeyWrapper.getClient();
  return valkeyClient;
}

/**
 * Get Valkey client instance
 * @returns Valkey client
 * @throws Error if Valkey is not initialized
 */
export function getValkey(): BaseClient {
  if (!valkeyClient) {
    throw new Error('Valkey not initialized. Call initializeValkey() first.');
  }
  return valkeyClient;
}

/**
 * Close Valkey connection
 */
export async function closeValkey(): Promise<void> {
  if (valkeyWrapper) {
    await valkeyWrapper.close();
    valkeyWrapper = null;
    valkeyClient = null;
  }
}

/**
 * Test Valkey connection
 * @returns True if connection is successful
 */
export async function testValkeyConnection(): Promise<boolean> {
  try {
    const valkey = getValkey();
    // Use get on a test key to verify connection
    await valkey.get('__test_connection__');
    logger.info('Valkey connection test successful');
    return true;
  } catch (error) {
    logger.error({ error }, 'Valkey connection test failed');
    return false;
  }
}

/**
 * Get Valkey server information
 * @returns Server info string (simplified)
 */
export async function getValkeyInfo(): Promise<string> {
  try {
    // Note: Valkey-Glide doesn't expose INFO command directly
    // Return simplified info based on what we can detect
    return 'Valkey server info not available via Glide client';
  } catch (error) {
    logger.error({ error }, 'Failed to get Valkey info');
    return '';
  }
}

/**
 * Get Valkey memory usage
 * @returns Memory usage in bytes (approximate)
 */
export async function getValkeyMemoryUsage(): Promise<number> {
  try {
    // Note: Valkey-Glide doesn't expose INFO command directly
    // Return 0 as we cannot determine memory usage
    return 0;
  } catch (error) {
    logger.error({ error }, 'Failed to get Valkey memory usage');
    return 0;
  }
}

/**
 * Get Valkey statistics
 * @returns Valkey statistics (simplified)
 */
export async function getValkeyStats(): Promise<{
  connectedClients: number;
  usedMemory: number;
  keyspaceHits: number;
  keyspaceMisses: number;
  hitRate: number;
}> {
  try {
    // Note: Valkey-Glide doesn't expose INFO command directly
    // Return default values
    return {
      connectedClients: 0,
      usedMemory: 0,
      keyspaceHits: 0,
      keyspaceMisses: 0,
      hitRate: 0,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to get Valkey stats');
    return {
      connectedClients: 0,
      usedMemory: 0,
      keyspaceHits: 0,
      keyspaceMisses: 0,
      hitRate: 0,
    };
  }
}

// Backward compatibility aliases
export const initializeRedis = initializeValkey;
export const getRedis = getValkey;
export const closeRedis = closeValkey;
export const testRedisConnection = testValkeyConnection;
export const testRedisPool = testValkeyConnection;
export const getRedisInfo = getValkeyInfo;
export const getRedisMemoryUsage = getValkeyMemoryUsage;
export const getRedisStats = getValkeyStats;

// Export types
export type { BaseClient as ValkeyClient };
export type { BaseClient as RedisClient };
export type { GlideString };
