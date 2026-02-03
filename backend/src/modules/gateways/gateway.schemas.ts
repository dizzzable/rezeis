import { z } from 'zod';

/**
 * Gateway config schema
 */
export const gatewayConfigSchema = z.object({
  // Stripe
  publishableKey: z.string().optional(),
  secretKey: z.string().optional(),
  webhookSecret: z.string().optional(),
  // PayPal
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  // Cryptomus
  apiKey: z.string().optional(),
  merchantId: z.string().optional(),
  // YooKassa
  shopId: z.string().optional(),
  secretKeyYookassa: z.string().optional(),
  // Custom
  endpoint: z.string().optional(),
  apiToken: z.string().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Gateway type schema
 */
export const gatewayTypeSchema = z.enum(['stripe', 'paypal', 'cryptomus', 'yookassa', 'custom']);

/**
 * Gateway response schema
 */
export const gatewaySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: gatewayTypeSchema,
  isActive: z.boolean(),
  isDefault: z.boolean(),
  config: gatewayConfigSchema,
  displayOrder: z.number(),
  iconUrl: z.string().optional(),
  description: z.string().optional(),
  supportedCurrencies: z.array(z.string()),
  minAmount: z.number().optional(),
  maxAmount: z.number().optional(),
  feePercent: z.number().optional(),
  feeFixed: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Create gateway schema
 */
export const createGatewaySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: gatewayTypeSchema,
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  config: gatewayConfigSchema.default({}),
  displayOrder: z.number().default(0),
  iconUrl: z.string().optional(),
  description: z.string().optional(),
  supportedCurrencies: z.array(z.string()).default(['USD']),
  minAmount: z.number().min(0).optional(),
  maxAmount: z.number().min(0).optional(),
  feePercent: z.number().min(0).max(100).optional(),
  feeFixed: z.number().min(0).optional(),
});

/**
 * Update gateway schema
 */
export const updateGatewaySchema = z.object({
  name: z.string().min(1).optional(),
  type: gatewayTypeSchema.optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  config: gatewayConfigSchema.optional(),
  displayOrder: z.number().optional(),
  iconUrl: z.string().optional(),
  description: z.string().optional(),
  supportedCurrencies: z.array(z.string()).optional(),
  minAmount: z.number().min(0).optional(),
  maxAmount: z.number().min(0).optional(),
  feePercent: z.number().min(0).max(100).optional(),
  feeFixed: z.number().min(0).optional(),
});

/**
 * Gateway params schema
 */
export const gatewayParamsSchema = z.object({
  id: z.string(),
});

/**
 * Gateway list response schema
 */
export const gatewaysListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(gatewaySchema),
  message: z.string().optional(),
});

/**
 * Gateway response wrapper schema
 */
export const gatewayResponseSchema = z.object({
  success: z.boolean(),
  data: gatewaySchema,
  message: z.string().optional(),
});

/**
 * Type definitions
 */
export type GatewayResponse = z.infer<typeof gatewaySchema>;
export type CreateGatewayInput = z.infer<typeof createGatewaySchema>;
export type UpdateGatewayInput = z.infer<typeof updateGatewaySchema>;
export type GatewayParams = z.infer<typeof gatewayParamsSchema>;
export type GatewayConfigInput = z.infer<typeof gatewayConfigSchema>;
export type GatewayType = z.infer<typeof gatewayTypeSchema>;
