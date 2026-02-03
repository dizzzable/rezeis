/**
 * Admin Payment Gateways Module
 *
 * Provides CRUD operations for managing payment gateways in the admin panel
 */

// Export routes
export { adminPaymentGatewayRoutes } from './payment-gateway.routes.js';

// Export service
export {
  createPaymentGatewayService,
  PaymentGatewayService,
  GatewayNotFoundError,
  GatewayAlreadyExistsError,
  InvalidGatewayConfigError,
} from './payment-gateway.service.js';

// Export types
export type {
  GatewayType,
  GatewayStatus,
  CryptopayConfig,
  YooKassaConfig,
  HeleketConfig,
  Pal24Config,
  PlategaConfig,
  WataConfig,
  TelegramStarsConfig,
  GatewayConfig,
  PaymentGateway,
  CreateGatewayDTO,
  UpdateGatewayDTO,
  ValidationResult,
  TestConnectionResult,
  GatewaySummary,
  ConfigField,
} from './types.js';

// Export constants
export {
  GATEWAY_CONFIG_FIELDS,
  GATEWAY_DEFAULT_CURRENCIES,
  GATEWAY_DISPLAY_NAMES,
} from './types.js';
