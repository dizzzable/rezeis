/**
 * Payment gateway types and interfaces for admin configuration
 */

/**
 * Gateway type enum - all supported payment gateways
 */
export type GatewayType =
  | 'cryptopay'
  | 'yookassa'
  | 'heleket'
  | 'pal24'
  | 'platega'
  | 'wata'
  | 'telegram-stars';

/**
 * Gateway status enum
 */
export type GatewayStatus = 'active' | 'inactive' | 'testing';

/**
 * Cryptopay gateway configuration
 */
export interface CryptopayConfig {
  /** API Key for authentication */
  apiKey: string;
  /** Network type: mainnet or testnet */
  network: 'mainnet' | 'testnet';
  /** Optional webhook secret for signature validation */
  webhookSecret?: string;
}

/**
 * YooKassa gateway configuration
 */
export interface YooKassaConfig {
  /** Shop ID from YooKassa */
  shopId: string;
  /** Secret API key */
  apiKey: string;
  /** Customer name for receipts */
  customer?: string;
  /** VAT code for tax purposes */
  vatCode?: number;
  /** Enable test mode */
  testMode?: boolean;
  /** Webhook secret for signature validation */
  webhookSecret?: string;
}

/**
 * Heleket gateway configuration
 */
export interface HeleketConfig {
  /** API Key for authentication */
  apiKey: string;
  /** Merchant ID */
  merchantId?: string;
  /** Default network for crypto payments */
  defaultNetwork?: string;
  /** Webhook secret for signature validation */
  webhookSecret?: string;
}

/**
 * Pal24 gateway configuration
 */
export interface Pal24Config {
  /** Merchant ID */
  merchantId: string;
  /** API Key */
  apiKey: string;
  /** Secret key for webhook signature validation */
  secretKey: string;
  /** Payment methods to enable */
  paymentMethods?: string[];
}

/**
 * Platega gateway configuration
 */
export interface PlategaConfig {
  /** Merchant ID */
  merchantId: string;
  /** API Key */
  apiKey: string;
  /** Secret key for signature validation */
  secretKey: string;
  /** Payment systems to enable */
  paymentSystems?: string[];
}

/**
 * WATA gateway configuration
 */
export interface WataConfig {
  /** API Key */
  apiKey: string;
  /** Merchant ID */
  merchantId: string;
  /** Secret key for webhook validation */
  secretKey: string;
  /** Enable test mode */
  testMode?: boolean;
}

/**
 * Telegram Stars gateway configuration
 */
export interface TelegramStarsConfig {
  /** Bot token for Telegram API */
  botToken: string;
  /** Provider token for payments (from @BotFather) */
  providerToken?: string;
  /** Secret token for webhook validation */
  webhookSecret?: string;
  /** Bot username */
  botUsername?: string;
}

/**
 * Union type for all gateway configurations
 */
export type GatewayConfig =
  | CryptopayConfig
  | YooKassaConfig
  | HeleketConfig
  | Pal24Config
  | PlategaConfig
  | WataConfig
  | TelegramStarsConfig;

/**
 * Payment gateway entity
 */
export interface PaymentGateway {
  /** Unique identifier (UUID) */
  id: string;
  /** Gateway type identifier */
  name: GatewayType;
  /** Display name for UI */
  displayName: string;
  /** Whether gateway is enabled */
  isEnabled: boolean;
  /** Display order for sorting */
  sortOrder: number;
  /** Gateway-specific configuration */
  config: GatewayConfig;
  /** Webhook secret for signature validation */
  webhookSecret?: string;
  /** Allowed IP addresses for webhooks */
  allowedIps?: string[];
  /** Gateway status */
  status: GatewayStatus;
  /** Description for admin UI */
  description?: string;
  /** Icon URL or identifier */
  icon?: string;
  /** Supported currencies */
  supportedCurrencies: string[];
  /** Minimum amount */
  minAmount?: number;
  /** Maximum amount */
  maxAmount?: number;
  /** Fee percentage */
  feePercent?: number;
  /** Fixed fee amount */
  feeFixed?: number;
  /** Creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt: Date;
}

/**
 * Create gateway DTO
 */
export interface CreateGatewayDTO {
  name: GatewayType;
  displayName: string;
  config: GatewayConfig;
  isEnabled?: boolean;
  sortOrder?: number;
  allowedIps?: string[];
  description?: string;
  supportedCurrencies?: string[];
  minAmount?: number;
  maxAmount?: number;
  feePercent?: number;
  feeFixed?: number;
}

/**
 * Update gateway DTO
 */
export interface UpdateGatewayDTO {
  displayName?: string;
  config?: Partial<GatewayConfig>;
  isEnabled?: boolean;
  sortOrder?: number;
  allowedIps?: string[];
  description?: string;
  supportedCurrencies?: string[];
  minAmount?: number;
  maxAmount?: number;
  feePercent?: number;
  feeFixed?: number;
}

/**
 * Gateway validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Gateway test result
 */
export interface TestConnectionResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
  responseTime?: number;
}

/**
 * Gateway summary for list view
 */
export interface GatewaySummary {
  id: string;
  name: GatewayType;
  displayName: string;
  isEnabled: boolean;
  sortOrder: number;
  status: GatewayStatus;
  icon?: string;
  supportedCurrencies: string[];
  webhookUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Gateway config field definition for UI forms
 */
export interface ConfigField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select' | 'checkbox' | 'array';
  required: boolean;
  options?: string[];
  placeholder?: string;
  description?: string;
}

/**
 * Gateway config fields map
 */
export const GATEWAY_CONFIG_FIELDS: Record<GatewayType, ConfigField[]> = {
  cryptopay: [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Enter Cryptopay API key' },
    { name: 'network', label: 'Network', type: 'select', required: true, options: ['mainnet', 'testnet'] },
    { name: 'webhookSecret', label: 'Webhook Secret', type: 'password', required: false, placeholder: 'Optional webhook secret' },
  ],
  yookassa: [
    { name: 'shopId', label: 'Shop ID', type: 'text', required: true, placeholder: 'YooKassa shop ID' },
    { name: 'apiKey', label: 'Secret Key', type: 'password', required: true, placeholder: 'YooKassa secret key' },
    { name: 'customer', label: 'Customer Name', type: 'text', required: false, placeholder: 'For receipts' },
    { name: 'vatCode', label: 'VAT Code', type: 'number', required: false },
    { name: 'testMode', label: 'Test Mode', type: 'checkbox', required: false },
  ],
  heleket: [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    { name: 'merchantId', label: 'Merchant ID', type: 'text', required: false },
    { name: 'defaultNetwork', label: 'Default Network', type: 'text', required: false, placeholder: 'e.g., BTC, ETH' },
  ],
  pal24: [
    { name: 'merchantId', label: 'Merchant ID', type: 'text', required: true },
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    { name: 'secretKey', label: 'Secret Key', type: 'password', required: true },
  ],
  platega: [
    { name: 'merchantId', label: 'Merchant ID', type: 'text', required: true },
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    { name: 'secretKey', label: 'Secret Key', type: 'password', required: true },
  ],
  wata: [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    { name: 'merchantId', label: 'Merchant ID', type: 'text', required: true },
    { name: 'secretKey', label: 'Secret Key', type: 'password', required: true },
    { name: 'testMode', label: 'Test Mode', type: 'checkbox', required: false },
  ],
  'telegram-stars': [
    { name: 'botToken', label: 'Bot Token', type: 'password', required: true, placeholder: 'From @BotFather' },
    { name: 'providerToken', label: 'Provider Token', type: 'password', required: false, placeholder: 'For card payments (optional)' },
    { name: 'botUsername', label: 'Bot Username', type: 'text', required: false, placeholder: '@your_bot' },
  ],
};

/**
 * Default supported currencies by gateway
 */
export const GATEWAY_DEFAULT_CURRENCIES: Record<GatewayType, string[]> = {
  cryptopay: ['BTC', 'ETH', 'USDT', 'USDC'],
  yookassa: ['RUB', 'USD', 'EUR'],
  heleket: ['BTC', 'ETH', 'USDT', 'USDC', 'TRX'],
  pal24: ['RUB', 'USD', 'EUR'],
  platega: ['RUB', 'USD', 'EUR'],
  wata: ['RUB', 'USD', 'EUR'],
  'telegram-stars': ['XTR'],
};

/**
 * Gateway display names
 */
export const GATEWAY_DISPLAY_NAMES: Record<GatewayType, string> = {
  cryptopay: 'Cryptopay',
  yookassa: 'YooKassa',
  heleket: 'Heleket',
  pal24: 'Pal24',
  platega: 'Platega',
  wata: 'WATA',
  'telegram-stars': 'Telegram Stars',
};
