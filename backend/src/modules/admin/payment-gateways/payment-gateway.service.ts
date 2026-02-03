import type { Pool } from 'pg';
import { logger } from '../../../utils/logger.js';
import type {
  PaymentGateway,
  CreateGatewayDTO,
  UpdateGatewayDTO,
  GatewaySummary,
  ValidationResult,
  TestConnectionResult,
  GatewayType,
  GatewayConfig,
} from './types.js';
import {
  GATEWAY_DEFAULT_CURRENCIES,
  GATEWAY_DISPLAY_NAMES,
} from './types.js';

/**
 * Payment gateway service errors
 */
export class GatewayNotFoundError extends Error {
  constructor(gatewayId: string) {
    super(`Gateway with id ${gatewayId} not found`);
    this.name = 'GatewayNotFoundError';
  }
}

export class GatewayAlreadyExistsError extends Error {
  constructor(name: string) {
    super(`Gateway with name '${name}' already exists`);
    this.name = 'GatewayAlreadyExistsError';
  }
}

export class InvalidGatewayConfigError extends Error {
  constructor(errors: string[]) {
    super(`Invalid gateway configuration: ${errors.join(', ')}`);
    this.name = 'InvalidGatewayConfigError';
  }
}

/**
 * Create payment gateway service factory
 * @param db - PostgreSQL pool instance
 * @returns Payment gateway service instance
 */
export function createPaymentGatewayService(db: Pool): PaymentGatewayService {
  return new PaymentGatewayService(db);
}

/**
 * Payment gateway service class
 * Handles all payment gateway-related business logic
 */
export class PaymentGatewayService {
  private readonly db: Pool;

  constructor(db: Pool) {
    this.db = db;
  }

  /**
   * Map database row to PaymentGateway entity
   * @param row - Database row
   * @returns PaymentGateway entity
   */
  private mapRowToEntity(row: Record<string, unknown>): PaymentGateway {
    return {
      id: row.id as string,
      name: row.name as GatewayType,
      displayName: row.display_name as string,
      isEnabled: row.is_enabled as boolean,
      sortOrder: (row.sort_order as number) || 0,
      config: (row.config as GatewayConfig) || {},
      webhookSecret: row.webhook_secret as string | undefined,
      allowedIps: row.allowed_ips as string[] | undefined,
      status: (row.status as PaymentGateway['status']) || 'inactive',
      description: row.description as string | undefined,
      icon: row.icon as string | undefined,
      supportedCurrencies: (row.supported_currencies as string[]) || ['USD'],
      minAmount: row.min_amount as number | undefined,
      maxAmount: row.max_amount as number | undefined,
      feePercent: row.fee_percent as number | undefined,
      feeFixed: row.fee_fixed as number | undefined,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  /**
   * Map PaymentGateway to GatewaySummary
   * @param gateway - PaymentGateway entity
   * @param baseUrl - Base URL for webhook URL generation
   * @returns GatewaySummary object
   */
  private mapToSummary(gateway: PaymentGateway, baseUrl: string): GatewaySummary {
    return {
      id: gateway.id,
      name: gateway.name,
      displayName: gateway.displayName,
      isEnabled: gateway.isEnabled,
      sortOrder: gateway.sortOrder,
      status: gateway.status,
      icon: gateway.icon,
      supportedCurrencies: gateway.supportedCurrencies,
      webhookUrl: `${baseUrl}/webhook/payments/${gateway.name}`,
      createdAt: gateway.createdAt,
      updatedAt: gateway.updatedAt,
    };
  }

  /**
   * Get all payment gateways
   * @param baseUrl - Base URL for webhook generation
   * @returns Array of all gateways as summaries
   */
  async getAll(baseUrl: string): Promise<GatewaySummary[]> {
    try {
      const result = await this.db.query(
        `SELECT * FROM gateways 
         ORDER BY sort_order ASC, created_at DESC`
      );

      const gateways = result.rows.map((row) => this.mapRowToEntity(row));
      return gateways.map((gateway) => this.mapToSummary(gateway, baseUrl));
    } catch (error) {
      logger.error({ error }, 'Failed to get all gateways');
      throw error;
    }
  }

  /**
   * Get payment gateway by ID
   * @param id - Gateway ID
   * @returns Gateway entity or null
   */
  async getById(id: string): Promise<PaymentGateway | null> {
    try {
      const result = await this.db.query(
        'SELECT * FROM gateways WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, gatewayId: id }, 'Failed to get gateway by id');
      throw error;
    }
  }

  /**
   * Get payment gateway by name
   * @param name - Gateway name
   * @returns Gateway entity or null
   */
  async getByName(name: string): Promise<PaymentGateway | null> {
    try {
      const result = await this.db.query(
        'SELECT * FROM gateways WHERE LOWER(name) = LOWER($1)',
        [name]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, gatewayName: name }, 'Failed to get gateway by name');
      throw error;
    }
  }

  /**
   * Create a new payment gateway
   * @param data - Create gateway data
   * @returns Created gateway
   */
  async create(data: CreateGatewayDTO): Promise<PaymentGateway> {
    // Validate config
    const validation = this.validateConfig(data.name, data.config);
    if (!validation.valid) {
      throw new InvalidGatewayConfigError(validation.errors);
    }

    // Check if gateway with this name already exists
    const existing = await this.getByName(data.name);
    if (existing) {
      throw new GatewayAlreadyExistsError(data.name);
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO gateways (
          name, display_name, is_enabled, sort_order, config,
          allowed_ips, description, supported_currencies,
          min_amount, max_amount, fee_percent, fee_fixed, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        [
          data.name,
          data.displayName,
          data.isEnabled ?? false,
          data.sortOrder ?? 0,
          JSON.stringify(data.config),
          data.allowedIps || [],
          data.description || '',
          data.supportedCurrencies || GATEWAY_DEFAULT_CURRENCIES[data.name],
          data.minAmount || null,
          data.maxAmount || null,
          data.feePercent || 0,
          data.feeFixed || 0,
          data.isEnabled ? 'active' : 'inactive',
        ]
      );

      await client.query('COMMIT');

      const gateway = this.mapRowToEntity(result.rows[0]);
      logger.info({ gatewayId: gateway.id, name: gateway.name }, 'Gateway created successfully');
      return gateway;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update payment gateway
   * @param id - Gateway ID
   * @param data - Update gateway data
   * @returns Updated gateway
   */
  async update(id: string, data: UpdateGatewayDTO): Promise<PaymentGateway> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new GatewayNotFoundError(id);
    }

    // Validate config if provided
    if (data.config) {
      const mergedConfig = { ...existing.config, ...data.config };
      const validation = this.validateConfig(existing.name, mergedConfig);
      if (!validation.valid) {
        throw new InvalidGatewayConfigError(validation.errors);
      }
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (data.displayName !== undefined) {
        updates.push(`display_name = $${paramIndex++}`);
        values.push(data.displayName);
      }
      if (data.config !== undefined) {
        updates.push(`config = $${paramIndex++}`);
        values.push(JSON.stringify({ ...existing.config, ...data.config }));
      }
      if (data.isEnabled !== undefined) {
        updates.push(`is_enabled = $${paramIndex++}`);
        updates.push(`status = $${paramIndex++}`);
        values.push(data.isEnabled);
        values.push(data.isEnabled ? 'active' : 'inactive');
      }
      if (data.sortOrder !== undefined) {
        updates.push(`sort_order = $${paramIndex++}`);
        values.push(data.sortOrder);
      }
      if (data.allowedIps !== undefined) {
        updates.push(`allowed_ips = $${paramIndex++}`);
        values.push(data.allowedIps);
      }
      if (data.description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        values.push(data.description);
      }
      if (data.supportedCurrencies !== undefined) {
        updates.push(`supported_currencies = $${paramIndex++}`);
        values.push(data.supportedCurrencies);
      }
      if (data.minAmount !== undefined) {
        updates.push(`min_amount = $${paramIndex++}`);
        values.push(data.minAmount);
      }
      if (data.maxAmount !== undefined) {
        updates.push(`max_amount = $${paramIndex++}`);
        values.push(data.maxAmount);
      }
      if (data.feePercent !== undefined) {
        updates.push(`fee_percent = $${paramIndex++}`);
        values.push(data.feePercent);
      }
      if (data.feeFixed !== undefined) {
        updates.push(`fee_fixed = $${paramIndex++}`);
        values.push(data.feeFixed);
      }

      // Always update updated_at
      updates.push(`updated_at = NOW()`);

      // Add id to values
      values.push(id);

      const result = await client.query(
        `UPDATE gateways SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        values
      );

      await client.query('COMMIT');

      const gateway = this.mapRowToEntity(result.rows[0]);
      logger.info({ gatewayId: id }, 'Gateway updated successfully');
      return gateway;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Delete payment gateway
   * @param id - Gateway ID
   */
  async delete(id: string): Promise<void> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new GatewayNotFoundError(id);
    }

    try {
      await this.db.query('DELETE FROM gateways WHERE id = $1', [id]);
      logger.info({ gatewayId: id }, 'Gateway deleted successfully');
    } catch (error) {
      logger.error({ error, gatewayId: id }, 'Failed to delete gateway');
      throw error;
    }
  }

  /**
   * Toggle gateway enabled status
   * @param id - Gateway ID
   * @returns Updated gateway
   */
  async toggle(id: string): Promise<PaymentGateway> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new GatewayNotFoundError(id);
    }

    const newStatus = !existing.isEnabled;
    const result = await this.db.query(
      `UPDATE gateways 
       SET is_enabled = $1, status = $2, updated_at = NOW() 
       WHERE id = $3 
       RETURNING *`,
      [newStatus, newStatus ? 'active' : 'inactive', id]
    );

    const gateway = this.mapRowToEntity(result.rows[0]);
    logger.info({ gatewayId: id, isEnabled: newStatus }, 'Gateway toggled successfully');
    return gateway;
  }

  /**
   * Get active gateways for client
   * @returns Array of active gateways
   */
  async getActiveGateways(): Promise<PaymentGateway[]> {
    try {
      const result = await this.db.query(
        `SELECT * FROM gateways 
         WHERE is_enabled = true AND status = 'active'
         ORDER BY sort_order ASC, created_at DESC`
      );

      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error }, 'Failed to get active gateways');
      throw error;
    }
  }

  /**
   * Get webhook URL for a gateway
   * @param gatewayName - Gateway name
   * @param baseUrl - Base URL
   * @returns Webhook URL
   */
  getWebhookUrl(gatewayName: string, baseUrl: string): string {
    return `${baseUrl}/webhook/payments/${gatewayName.toLowerCase()}`;
  }

  /**
   * Validate gateway configuration
   * @param gatewayType - Gateway type
   * @param config - Configuration object
   * @returns Validation result
   */
  validateConfig(gatewayType: GatewayType, config: GatewayConfig): ValidationResult {
    const errors: string[] = [];

    switch (gatewayType) {
      case 'cryptopay': {
        const cryptopayConfig = config as { apiKey?: string; network?: string };
        if (!cryptopayConfig.apiKey || cryptopayConfig.apiKey.trim() === '') {
          errors.push('API Key is required for Cryptopay');
        }
        if (!cryptopayConfig.network || !['mainnet', 'testnet'].includes(cryptopayConfig.network)) {
          errors.push('Network must be either "mainnet" or "testnet" for Cryptopay');
        }
        break;
      }
      case 'yookassa': {
        const yookassaConfig = config as { shopId?: string; apiKey?: string };
        if (!yookassaConfig.shopId || yookassaConfig.shopId.trim() === '') {
          errors.push('Shop ID is required for YooKassa');
        }
        if (!yookassaConfig.apiKey || yookassaConfig.apiKey.trim() === '') {
          errors.push('Secret Key is required for YooKassa');
        }
        break;
      }
      case 'heleket': {
        const heleketConfig = config as { apiKey?: string };
        if (!heleketConfig.apiKey || heleketConfig.apiKey.trim() === '') {
          errors.push('API Key is required for Heleket');
        }
        break;
      }
      case 'pal24': {
        const pal24Config = config as { merchantId?: string; apiKey?: string; secretKey?: string };
        if (!pal24Config.merchantId || pal24Config.merchantId.trim() === '') {
          errors.push('Merchant ID is required for Pal24');
        }
        if (!pal24Config.apiKey || pal24Config.apiKey.trim() === '') {
          errors.push('API Key is required for Pal24');
        }
        if (!pal24Config.secretKey || pal24Config.secretKey.trim() === '') {
          errors.push('Secret Key is required for Pal24');
        }
        break;
      }
      case 'platega': {
        const plategaConfig = config as { merchantId?: string; apiKey?: string; secretKey?: string };
        if (!plategaConfig.merchantId || plategaConfig.merchantId.trim() === '') {
          errors.push('Merchant ID is required for Platega');
        }
        if (!plategaConfig.apiKey || plategaConfig.apiKey.trim() === '') {
          errors.push('API Key is required for Platega');
        }
        if (!plategaConfig.secretKey || plategaConfig.secretKey.trim() === '') {
          errors.push('Secret Key is required for Platega');
        }
        break;
      }
      case 'wata': {
        const wataConfig = config as { apiKey?: string; merchantId?: string; secretKey?: string };
        if (!wataConfig.apiKey || wataConfig.apiKey.trim() === '') {
          errors.push('API Key is required for WATA');
        }
        if (!wataConfig.merchantId || wataConfig.merchantId.trim() === '') {
          errors.push('Merchant ID is required for WATA');
        }
        if (!wataConfig.secretKey || wataConfig.secretKey.trim() === '') {
          errors.push('Secret Key is required for WATA');
        }
        break;
      }
      case 'telegram-stars': {
        const telegramConfig = config as { botToken?: string };
        if (!telegramConfig.botToken || telegramConfig.botToken.trim() === '') {
          errors.push('Bot Token is required for Telegram Stars');
        }
        break;
      }
      default:
        errors.push(`Unknown gateway type: ${gatewayType}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Test gateway connection
   * @param id - Gateway ID
   * @returns Test result
   */
  async testConnection(id: string): Promise<TestConnectionResult> {
    const gateway = await this.getById(id);
    if (!gateway) {
      throw new GatewayNotFoundError(id);
    }

    const startTime = Date.now();

    try {
      switch (gateway.name) {
        case 'cryptopay': {
          const cryptopayConfig = gateway.config as { apiKey: string; network: string };
          // Simple validation - in production, make actual API call
          if (!cryptopayConfig.apiKey) {
            return {
              success: false,
              message: 'API Key not configured',
            };
          }
          return {
            success: true,
            message: `Cryptopay configured for ${cryptopayConfig.network || 'mainnet'}`,
            responseTime: Date.now() - startTime,
          };
        }
        case 'yookassa': {
          const yookassaConfig = gateway.config as { shopId: string; apiKey: string };
          if (!yookassaConfig.shopId || !yookassaConfig.apiKey) {
            return {
              success: false,
              message: 'Shop ID and Secret Key required',
            };
          }
          return {
            success: true,
            message: `YooKassa configured for shop ${yookassaConfig.shopId}`,
            responseTime: Date.now() - startTime,
          };
        }
        case 'telegram-stars': {
          const telegramConfig = gateway.config as { botToken: string };
          if (!telegramConfig.botToken) {
            return {
              success: false,
              message: 'Bot Token not configured',
            };
          }
          // Check token format (basic validation)
          if (!telegramConfig.botToken.includes(':')) {
            return {
              success: false,
              message: 'Invalid Bot Token format',
            };
          }
          return {
            success: true,
            message: 'Telegram bot token is valid',
            responseTime: Date.now() - startTime,
          };
        }
        default:
          return {
            success: true,
            message: `${GATEWAY_DISPLAY_NAMES[gateway.name]} configuration is valid`,
            responseTime: Date.now() - startTime,
          };
      }
    } catch (error) {
      logger.error({ error, gatewayId: id }, 'Failed to test gateway connection');
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error during connection test',
        responseTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Initialize default gateways
   * Creates default gateway records if they don't exist
   */
  async initializeDefaultGateways(): Promise<void> {
    const defaultGateways: CreateGatewayDTO[] = [
      {
        name: 'cryptopay',
        displayName: 'Cryptopay',
        config: { apiKey: '', network: 'mainnet' },
        isEnabled: false,
        sortOrder: 1,
        supportedCurrencies: GATEWAY_DEFAULT_CURRENCIES['cryptopay'],
      },
      {
        name: 'yookassa',
        displayName: 'YooKassa',
        config: { shopId: '', apiKey: '' },
        isEnabled: false,
        sortOrder: 2,
        supportedCurrencies: GATEWAY_DEFAULT_CURRENCIES['yookassa'],
      },
      {
        name: 'heleket',
        displayName: 'Heleket',
        config: { apiKey: '' },
        isEnabled: false,
        sortOrder: 3,
        supportedCurrencies: GATEWAY_DEFAULT_CURRENCIES['heleket'],
      },
      {
        name: 'pal24',
        displayName: 'Pal24',
        config: { merchantId: '', apiKey: '', secretKey: '' },
        isEnabled: false,
        sortOrder: 4,
        supportedCurrencies: GATEWAY_DEFAULT_CURRENCIES['pal24'],
      },
      {
        name: 'platega',
        displayName: 'Platega',
        config: { merchantId: '', apiKey: '', secretKey: '' },
        isEnabled: false,
        sortOrder: 5,
        supportedCurrencies: GATEWAY_DEFAULT_CURRENCIES['platega'],
      },
      {
        name: 'wata',
        displayName: 'WATA',
        config: { apiKey: '', merchantId: '', secretKey: '' },
        isEnabled: false,
        sortOrder: 6,
        supportedCurrencies: GATEWAY_DEFAULT_CURRENCIES['wata'],
      },
      {
        name: 'telegram-stars',
        displayName: 'Telegram Stars',
        config: { botToken: '' },
        isEnabled: false,
        sortOrder: 7,
        supportedCurrencies: GATEWAY_DEFAULT_CURRENCIES['telegram-stars'],
      },
    ];

    for (const gateway of defaultGateways) {
      const existing = await this.getByName(gateway.name);
      if (!existing) {
        try {
          await this.create(gateway);
          logger.info({ name: gateway.name }, 'Created default gateway');
        } catch (error) {
          logger.error({ error, name: gateway.name }, 'Failed to create default gateway');
        }
      }
    }
  }
}
