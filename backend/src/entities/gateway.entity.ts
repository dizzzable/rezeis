/**
 * Gateway type enum
 */
export type GatewayType = 'stripe' | 'paypal' | 'cryptomus' | 'yookassa' | 'custom';

/**
 * Gateway configuration interface
 * Stores sensitive configuration for each gateway type
 */
export interface GatewayConfig {
  // Stripe
  publishableKey?: string;
  secretKey?: string;
  webhookSecret?: string;
  // PayPal
  clientId?: string;
  clientSecret?: string;
  // Cryptomus
  apiKey?: string;
  merchantId?: string;
  // YooKassa
  shopId?: string;
  secretKeyYookassa?: string;
  // Custom
  endpoint?: string;
  apiToken?: string;
  customFields?: Record<string, unknown>;
}

/**
 * Gateway entity interface
 */
export interface Gateway {
  id: string;
  name: string;
  type: GatewayType;
  isActive: boolean;
  isDefault: boolean;
  config: GatewayConfig;
  displayOrder: number;
  iconUrl?: string;
  description?: string;
  supportedCurrencies: string[];
  minAmount?: number;
  maxAmount?: number;
  feePercent?: number;
  feeFixed?: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create gateway DTO
 */
export type CreateGatewayDTO = Omit<Gateway, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Update gateway DTO
 */
export type UpdateGatewayDTO = Partial<Omit<Gateway, 'id' | 'createdAt' | 'updatedAt'>>;
