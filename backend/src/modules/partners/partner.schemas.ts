import { z } from 'zod';

/**
 * Partner ID params schema
 */
export const partnerParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

/**
 * Payout ID params schema
 */
export const payoutParamsSchema = {
  type: 'object',
  required: ['id', 'payoutId'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    payoutId: { type: 'string', format: 'uuid' },
  },
} as const;

/**
 * Create partner schema
 */
export const createPartnerSchema = {
  type: 'object',
  required: ['userId'],
  properties: {
    userId: { type: 'string', format: 'uuid' },
    commissionRate: { type: 'number', minimum: 0, maximum: 100, default: 10 },
    payoutMethod: { type: 'string', enum: ['bank_transfer', 'paypal', 'crypto', 'other'] },
    payoutDetails: { type: 'object' },
  },
} as const;

/**
 * Update partner schema
 */
export const updatePartnerSchema = {
  type: 'object',
  properties: {
    commissionRate: { type: 'number', minimum: 0, maximum: 100 },
    payoutMethod: { type: 'string', enum: ['bank_transfer', 'paypal', 'crypto', 'other'] },
    payoutDetails: { type: 'object' },
    status: { type: 'string', enum: ['pending', 'active', 'suspended', 'rejected'] },
  },
} as const;

/**
 * Partner filters schema
 */
export const partnerFiltersSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pending', 'active', 'suspended', 'rejected'] },
    search: { type: 'string' },
    page: { type: 'number', minimum: 1, default: 1 },
    limit: { type: 'number', minimum: 1, maximum: 100, default: 10 },
    sortBy: { type: 'string', default: 'createdAt' },
    sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
  },
} as const;

/**
 * Create payout schema
 */
export const createPayoutSchema = {
  type: 'object',
  required: ['amount', 'method'],
  properties: {
    amount: { type: 'number', minimum: 0.01 },
    method: { type: 'string', enum: ['bank_transfer', 'paypal', 'crypto', 'other'] },
    notes: { type: 'string' },
  },
} as const;

/**
 * Process payout schema
 */
export const processPayoutSchema = {
  type: 'object',
  properties: {
    transactionId: { type: 'string' },
    notes: { type: 'string' },
  },
} as const;

/**
 * Earning filters schema
 */
export const earningFiltersSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pending', 'approved', 'paid', 'cancelled'] },
    page: { type: 'number', minimum: 1, default: 1 },
    limit: { type: 'number', minimum: 1, maximum: 100, default: 10 },
  },
} as const;

/**
 * Payout filters schema
 */
export const payoutFiltersSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'] },
    page: { type: 'number', minimum: 1, default: 1 },
    limit: { type: 'number', minimum: 1, maximum: 100, default: 10 },
  },
} as const;

/**
 * Partner response schema
 */
export const partnerResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    userId: { type: 'string' },
    commissionRate: { type: 'number' },
    totalEarnings: { type: 'number' },
    paidEarnings: { type: 'number' },
    pendingEarnings: { type: 'number' },
    referralCode: { type: 'string' },
    referralCount: { type: 'number' },
    payoutMethod: { type: 'string', nullable: true },
    payoutDetails: { type: 'object' },
    status: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/**
 * Partner list response schema
 */
export const partnerListResponseSchema = {
  type: 'object',
  properties: {
    data: { type: 'array', items: partnerResponseSchema },
    total: { type: 'number' },
    page: { type: 'number' },
    limit: { type: 'number' },
    totalPages: { type: 'number' },
  },
} as const;

/**
 * Partner stats response schema
 */
export const partnerStatsResponseSchema = {
  type: 'object',
  properties: {
    totalPartners: { type: 'number' },
    pendingPartners: { type: 'number' },
    activePartners: { type: 'number' },
    suspendedPartners: { type: 'number' },
    totalEarnings: { type: 'number' },
    totalPaid: { type: 'number' },
    totalPending: { type: 'number' },
    totalReferrals: { type: 'number' },
  },
} as const;

/**
 * Zod schemas for validation
 */
export const createPartnerBodySchema = z.object({
  userId: z.string().uuid(),
  commissionRate: z.number().min(0).max(100).optional(),
  payoutMethod: z.enum(['bank_transfer', 'paypal', 'crypto', 'other']).optional(),
  payoutDetails: z.record(z.string(), z.unknown()).optional(),
});

export const updatePartnerBodySchema = z.object({
  commissionRate: z.number().min(0).max(100).optional(),
  payoutMethod: z.enum(['bank_transfer', 'paypal', 'crypto', 'other']).optional(),
  payoutDetails: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['pending', 'active', 'suspended', 'rejected']).optional(),
});

export const partnerIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const payoutIdParamsSchema = z.object({
  id: z.string().uuid(),
  payoutId: z.string().uuid(),
});

export const partnerFiltersQuerySchema = z.object({
  status: z.enum(['pending', 'active', 'suspended', 'rejected']).optional(),
  search: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  sortBy: z.string().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const createPayoutBodySchema = z.object({
  amount: z.number().min(0.01),
  method: z.enum(['bank_transfer', 'paypal', 'crypto', 'other']),
  notes: z.string().optional(),
});

export const processPayoutBodySchema = z.object({
  transactionId: z.string().optional(),
  notes: z.string().optional(),
});

export const earningFiltersQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'paid', 'cancelled']).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
});

export const payoutFiltersQuerySchema = z.object({
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled']).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
});

export type CreatePartnerBody = z.infer<typeof createPartnerBodySchema>;
export type UpdatePartnerBody = z.infer<typeof updatePartnerBodySchema>;
export type PartnerIdParams = z.infer<typeof partnerIdParamsSchema>;
export type PayoutIdParams = z.infer<typeof payoutIdParamsSchema>;
export type PartnerFiltersQuery = z.infer<typeof partnerFiltersQuerySchema>;
export type CreatePayoutBody = z.infer<typeof createPayoutBodySchema>;
export type ProcessPayoutBody = z.infer<typeof processPayoutBodySchema>;
export type EarningFiltersQuery = z.infer<typeof earningFiltersQuerySchema>;
export type PayoutFiltersQuery = z.infer<typeof payoutFiltersQuerySchema>;
