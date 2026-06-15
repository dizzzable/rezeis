import { z } from 'zod'
import { api } from '@/lib/api'
import { unwrapPayloadOrArray } from '@/lib/api-utils'

const currencySchema = z.enum(['USD', 'RUB', 'USDT', 'XTR', 'TON', 'BTC', 'ETH', 'LTC', 'USDC', 'TRX'])
const paymentGatewayTypeSchema = z.enum(['TELEGRAM_STARS', 'YOOKASSA', 'PLATEGA', 'HELEKET', 'CRYPTOMUS', 'MULENPAY', 'CRYPTOPAY'])
const purchaseTypeSchema = z.enum(['NEW', 'ADDITIONAL', 'RENEW', 'UPGRADE'])
const purchaseChannelSchema = z.enum(['WEB', 'TELEGRAM', 'MINI_APP'])
const transactionStatusSchema = z.enum(['PENDING', 'COMPLETED', 'CANCELED', 'REFUNDED', 'FAILED'])
const paymentWebhookLifecycleStatusSchema = z.enum(['RECEIVED', 'ENQUEUED', 'PROCESSING', 'PROCESSED', 'FAILED'])

const paymentGatewaySchema = z.object({
  id: z.string(),
  type: paymentGatewayTypeSchema,
  orderIndex: z.number(),
  currency: currencySchema,
  isActive: z.boolean(),
  settings: z.record(z.string(), z.unknown()),
  isUsedInPricing: z.boolean(),
  activePlanDurationCount: z.number(),
  updatedAt: z.string(),
})

const paymentTransactionSchema = z.object({
  id: z.string(),
  paymentId: z.string(),
  userId: z.string(),
  subscriptionId: z.string().nullable(),
  status: transactionStatusSchema,
  purchaseType: purchaseTypeSchema,
  channel: purchaseChannelSchema,
  gatewayType: paymentGatewayTypeSchema,
  currency: currencySchema,
  amount: z.string(),
  paymentAsset: z.string().nullable(),
  gatewayId: z.string().nullable(),
  planSnapshot: z.unknown(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
const paymentDiscountHistoryItemSchema = z.object({ transactionId: z.string(), userId: z.string(), status: z.string(), discountSource: z.string(), discountPercent: z.number(), originalAmount: z.string(), finalAmount: z.string(), createdAt: z.string() })
const paymentDiscountHistorySchema = z.object({ items: z.array(paymentDiscountHistoryItemSchema) })

const paymentCheckoutSchema = z.object({
  paymentId: z.string(),
  transactionStatus: transactionStatusSchema,
  gatewayType: paymentGatewayTypeSchema,
  purchaseType: purchaseTypeSchema,
  amount: z.string(),
  currency: currencySchema,
  checkoutUrl: z.string().nullable(),
  providerMode: z.string(),
  createdAt: z.string(),
})

const paymentWebhookEventSchema = z.object({
  id: z.string(),
  gatewayType: paymentGatewayTypeSchema,
  paymentId: z.string(),
  providerEventId: z.string(),
  eventStatus: z.string().nullable(),
  status: paymentWebhookLifecycleStatusSchema,
  attempts: z.number(),
  reconciliationAttempts: z.number(),
  replayCount: z.number(),
  lastError: z.string().nullable(),
  receivedAt: z.string(),
  processedAt: z.string().nullable(),
  lastTransitionAt: z.string(),
  lastReplayedAt: z.string().nullable(),
})

const paymentWebhookEventDetailSchema = paymentWebhookEventSchema.extend({
  payloadHash: z.string().nullable(),
  redactedPayload: z.unknown(),
  rawPayload: z.unknown().nullable(),
})

const paymentReconciliationHealthSchema = z.object({
  queue: z.object({
    waiting: z.number(),
    active: z.number(),
    delayed: z.number(),
    completed: z.number(),
    failed: z.number(),
  }),
  eventsByStatus: z.record(paymentWebhookLifecycleStatusSchema, z.number()),
  profileSyncJobs: z.object({
    pending: z.number(),
    processing: z.number(),
    completed: z.number(),
    failed: z.number(),
    retryReady: z.number(),
    retryScheduled: z.number(),
  }).default({ pending: 0, processing: 0, completed: 0, failed: 0, retryReady: 0, retryScheduled: 0 }),
  staleProcessingCount: z.number(),
  staleEnqueuedCount: z.number(),
  generatedAt: z.string(),
})
const profileSyncJobExecutionSchema = z.object({
  jobId: z.string().nullable(),
  status: z.enum(['NOOP', 'NO_PENDING_JOB', 'COMPLETED', 'BLOCKED', 'FAILED', 'RETRY_SCHEDULED']),
  operation: z.string().nullable().optional(),
  action: z.string().nullable().optional(),
  subscriptionId: z.string().nullable().optional(),
  providerMutation: z.boolean(),
  checkedAt: z.string(),
  reason: z.string().nullable(),
})
const profileSyncJobBatchExecutionSchema = z.object({ attempted: z.number(), completed: z.number(), failed: z.number(), blocked: z.number(), checkedAt: z.string() })
const profileSyncProblemJobsSchema = z.object({
  items: z.array(z.object({
    jobId: z.string(),
    subscriptionId: z.string(),
    action: z.string(),
    status: z.string(),
    attempts: z.number(),
    maxAttempts: z.number(),
    nextRetryAt: z.string().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
})
const profileSyncRetryResetSchema = z.object({ jobId: z.string(), status: z.enum(['RETRY_RESET', 'BLOCKED']), checkedAt: z.string(), reason: z.string().nullable() })
const profileSyncEnqueueSchema = z.object({ jobId: z.string(), queueJobId: z.string(), enqueued: z.boolean(), alreadyQueued: z.boolean() })
const profileSyncCompensationNoteSchema = z.object({ jobId: z.string(), status: z.enum(['NOTE_RECORDED', 'BLOCKED']), checkedAt: z.string(), reason: z.string().nullable() })
const profileSyncForceLinkSchema = z.object({ subscriptionId: z.string(), status: z.enum(['LINKED', 'BLOCKED']), remnawaveUserUuid: z.string(), providerStatus: z.string().nullable(), checkedAt: z.string(), reason: z.string().nullable() })
const profileSyncCompensationPolicySchema = z.object({
  compensationEnabled: z.literal(false),
  terminalFailureDefinition: z.string(),
  operatorOptions: z.array(z.object({ code: z.string(), label: z.string(), implemented: z.boolean(), notes: z.array(z.string()) })),
})

const paymentOpsAlertSettingsSchema = z.object({
  enabled: z.boolean(),
  chatId: z.string().nullable(),
  threadId: z.string().nullable(),
  hashtag: z.string().nullable(),
})

const paymentRefundReadinessSchema = z.object({
  checkedAt: z.string(),
  transactionId: z.string(),
  status: transactionStatusSchema,
  gatewayType: paymentGatewayTypeSchema,
  amount: z.string(),
  currency: currencySchema,
  refundEnabled: z.literal(false),
  checks: z.array(z.object({ code: z.string(), passed: z.boolean(), severity: z.enum(['INFO', 'WARNING', 'BLOCKER']), message: z.string() })),
})
const paymentRefundRequestSchema = z.object({
  requestId: z.string(),
  transactionId: z.string(),
  status: z.literal('PLANNED'),
  executionEnabled: z.boolean(),
  gatewayType: paymentGatewayTypeSchema,
  transactionStatus: transactionStatusSchema,
  amount: z.string(),
  currency: currencySchema,
  reason: z.string(),
  idempotencyKey: z.string().nullable(),
  refundAddressProvided: z.boolean(),
  isSubtract: z.boolean().nullable(),
  checkedAt: z.string(),
})
const paymentRefundRequestHistorySchema = z.object({
  transactionId: z.string(),
  items: z.array(z.object({
    requestId: z.string(),
    status: z.literal('PLANNED'),
    executionEnabled: z.literal(false),
    gatewayType: z.string(),
    transactionStatus: z.string(),
    amount: z.string(),
    currency: z.string(),
    reasonProvided: z.boolean(),
    idempotencyKey: z.string().nullable(),
    refundAddressProvided: z.boolean(),
    isSubtract: z.boolean().nullable(),
    createdAt: z.string(),
  })),
})
const paymentRefundRequestDetailSchema = paymentRefundRequestHistorySchema.shape.items.element.extend({
  transactionId: z.string(),
  checks: z.array(z.object({ code: z.string(), passed: z.boolean(), severity: z.enum(['INFO', 'WARNING', 'BLOCKER']), message: z.string() })),
})
const paymentRefundRequestPreflightSchema = paymentRefundRequestDetailSchema.extend({
  preflightReady: z.boolean(),
  providerAdapter: z.enum(['YOOKASSA', 'UNSUPPORTED']),
  nextRequiredSlice: z.string(),
})
const paymentRefundExecutionSchema = z.object({
  transactionId: z.string(),
  requestId: z.string(),
  status: z.literal('REFUNDED'),
  gatewayRefundId: z.string().nullable(),
  providerStatus: z.string().nullable(),
  checkedAt: z.string(),
})
const paymentRefundExecutionHistorySchema = z.object({
  transactionId: z.string(),
  requestId: z.string(),
  items: z.array(z.object({
    gatewayType: z.string(),
    gatewayRefundId: z.string().nullable(),
    providerStatus: z.string().nullable(),
    createdAt: z.string(),
  })),
})
const paymentManualCorrectionPolicySchema = z.object({
  generatedAt: z.string(),
  mutationEnabled: z.literal(false),
  correctionTypes: z.array(z.object({
    code: z.string(),
    label: z.string(),
    riskLevel: z.enum(['MEDIUM', 'HIGH', 'CRITICAL']),
    blockers: z.array(z.string()),
    requiredControls: z.array(z.string()),
  })),
})
const paymentDisputePolicySchema = z.object({
  generatedAt: z.string(),
  providerIntegrationEnabled: z.literal(false),
  supportedGateways: z.array(z.string()),
  blockers: z.array(z.string()),
  requiredControls: z.array(z.string()),
})
const paymentReconciliationPolicySchema = z.object({
  generatedAt: z.string(),
  mutationEnabled: z.literal(false),
  exceptionTypes: z.array(z.object({
    code: z.string(),
    label: z.string(),
    riskLevel: z.enum(['MEDIUM', 'HIGH', 'CRITICAL']),
    requiredEvidence: z.array(z.string()),
    blockers: z.array(z.string()),
  })),
})
const paymentCorrectionNoteSchema = z.object({
  id: z.string(),
  transactionId: z.string(),
  adminActorPresent: z.boolean(),
  note: z.string(),
  idempotencyKey: z.string().nullable(),
  createdAt: z.string(),
})
const paymentCorrectionNoteHistorySchema = z.object({
  transactionId: z.string(),
  items: z.array(paymentCorrectionNoteSchema),
})
const paymentDisputeRecordSchema = z.object({
  id: z.string(),
  transactionId: z.string(),
  status: z.string(),
  reason: z.string(),
  providerCaseId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  createdAt: z.string(),
})
const paymentDisputeRecordHistorySchema = z.object({
  transactionId: z.string(),
  items: z.array(paymentDisputeRecordSchema),
})
const paymentReconciliationExceptionSchema = z.object({
  id: z.string(),
  transactionId: z.string(),
  type: z.string(),
  status: z.string(),
  reason: z.string(),
  evidenceProvided: z.boolean(),
  idempotencyKey: z.string().nullable(),
  createdAt: z.string(),
})
const paymentReconciliationExceptionHistorySchema = z.object({
  transactionId: z.string(),
  items: z.array(paymentReconciliationExceptionSchema),
})
const paymentCorrectionRequestSchema = z.object({
  id: z.string(),
  transactionId: z.string(),
  type: z.string(),
  requestedAmount: z.string().nullable(),
  requestedStatus: z.string().nullable(),
  status: z.literal('PLANNED'),
  executionEnabled: z.boolean(),
  idempotencyKey: z.string().nullable(),
  createdAt: z.string(),
})
const paymentCorrectionRequestHistorySchema = z.object({
  transactionId: z.string(),
  items: z.array(paymentCorrectionRequestSchema),
})
const paymentCorrectionRequestReadinessSchema = paymentCorrectionRequestSchema.extend({
  checks: z.array(z.object({
    code: z.string(),
    passed: z.boolean(),
    severity: z.enum(['INFO', 'WARNING', 'BLOCKER']),
    message: z.string(),
  })),
})
const paymentCorrectionExecutionSchema = z.object({
  transactionId: z.string(),
  requestId: z.string(),
  status: z.enum(['EXECUTED', 'BLOCKED']),
  previousAmount: z.string().nullable(),
  newAmount: z.string().nullable(),
  checkedAt: z.string(),
})
const paymentRefundGatewayCapabilitiesSchema = z.object({
  generatedAt: z.string(),
  gateways: z.array(z.object({
    gatewayType: z.string(),
    refundSupported: z.boolean(),
    adapterStatus: z.enum(['SHIPPED', 'BLOCKED']),
    blockers: z.array(z.string()),
  })),
})

const unwrapPayload = unwrapPayloadOrArray

export type PaymentGateway = z.infer<typeof paymentGatewaySchema>
export type PaymentTransaction = z.infer<typeof paymentTransactionSchema>
export type PaymentDiscountHistoryItem = z.infer<typeof paymentDiscountHistoryItemSchema>
export type PaymentCheckout = z.infer<typeof paymentCheckoutSchema>
export type PaymentGatewayType = z.infer<typeof paymentGatewayTypeSchema>
export type TransactionStatus = z.infer<typeof transactionStatusSchema>
export type PurchaseType = z.infer<typeof purchaseTypeSchema>
export type PurchaseChannel = z.infer<typeof purchaseChannelSchema>
export type PaymentWebhookLifecycleStatus = z.infer<typeof paymentWebhookLifecycleStatusSchema>
export type PaymentWebhookEvent = z.infer<typeof paymentWebhookEventSchema>
export type PaymentWebhookEventDetail = z.infer<typeof paymentWebhookEventDetailSchema>
export type PaymentRefundRequest = z.infer<typeof paymentRefundRequestSchema>
export type PaymentRefundRequestHistory = z.infer<typeof paymentRefundRequestHistorySchema>
export type PaymentRefundRequestDetail = z.infer<typeof paymentRefundRequestDetailSchema>
export type PaymentRefundRequestPreflight = z.infer<typeof paymentRefundRequestPreflightSchema>
export type PaymentRefundExecution = z.infer<typeof paymentRefundExecutionSchema>
export type PaymentRefundExecutionHistory = z.infer<typeof paymentRefundExecutionHistorySchema>
export type PaymentManualCorrectionPolicy = z.infer<typeof paymentManualCorrectionPolicySchema>
export type PaymentDisputePolicy = z.infer<typeof paymentDisputePolicySchema>
export type PaymentReconciliationPolicy = z.infer<typeof paymentReconciliationPolicySchema>
export type PaymentCorrectionNote = z.infer<typeof paymentCorrectionNoteSchema>
export type PaymentCorrectionNoteHistory = z.infer<typeof paymentCorrectionNoteHistorySchema>
export type PaymentDisputeRecord = z.infer<typeof paymentDisputeRecordSchema>
export type PaymentDisputeRecordHistory = z.infer<typeof paymentDisputeRecordHistorySchema>
export type PaymentReconciliationException = z.infer<typeof paymentReconciliationExceptionSchema>
export type PaymentReconciliationExceptionHistory = z.infer<typeof paymentReconciliationExceptionHistorySchema>
export type PaymentCorrectionRequest = z.infer<typeof paymentCorrectionRequestSchema>
export type PaymentCorrectionRequestHistory = z.infer<typeof paymentCorrectionRequestHistorySchema>
export type PaymentCorrectionRequestReadiness = z.infer<typeof paymentCorrectionRequestReadinessSchema>
export type PaymentCorrectionExecution = z.infer<typeof paymentCorrectionExecutionSchema>
export type PaymentRefundGatewayCapabilities = z.infer<typeof paymentRefundGatewayCapabilitiesSchema>
export type PaymentReconciliationHealth = z.infer<typeof paymentReconciliationHealthSchema>
export type ProfileSyncJobExecution = z.infer<typeof profileSyncJobExecutionSchema>
export type ProfileSyncJobBatchExecution = z.infer<typeof profileSyncJobBatchExecutionSchema>
export type ProfileSyncProblemJobs = z.infer<typeof profileSyncProblemJobsSchema>
export type ProfileSyncRetryReset = z.infer<typeof profileSyncRetryResetSchema>
export type ProfileSyncEnqueue = z.infer<typeof profileSyncEnqueueSchema>
export type ProfileSyncCompensationNote = z.infer<typeof profileSyncCompensationNoteSchema>
export type ProfileSyncForceLink = z.infer<typeof profileSyncForceLinkSchema>
export type ProfileSyncCompensationPolicy = z.infer<typeof profileSyncCompensationPolicySchema>
export type PaymentOpsAlertSettings = z.infer<typeof paymentOpsAlertSettingsSchema>
export type PaymentRefundReadiness = z.infer<typeof paymentRefundReadinessSchema>

export const paymentApi = {
  gatewayTypes: paymentGatewayTypeSchema.options,
  currencies: currencySchema.options,
  statuses: transactionStatusSchema.options,
  webhookStatuses: paymentWebhookLifecycleStatusSchema.options,
  purchaseTypes: purchaseTypeSchema.options,
  purchaseChannels: purchaseChannelSchema.options,

  async listGateways(): Promise<readonly PaymentGateway[]> {
    const response = await api.get('/admin/payments/gateways')
    return z.array(paymentGatewaySchema).parse(unwrapPayload(response.data))
  },

  async updateGateway(
    gatewayId: string,
    payload: {
      readonly type?: PaymentGatewayType
      readonly currency?: z.infer<typeof currencySchema>
      readonly isActive?: boolean
      readonly orderIndex?: number
      readonly settings?: Record<string, unknown> | null
    },
  ): Promise<PaymentGateway> {
    const response = await api.patch(`/admin/payments/gateways/${gatewayId}`, payload)
    return paymentGatewaySchema.parse(unwrapPayload(response.data))
  },

  async moveGateway(gatewayId: string, direction: 'up' | 'down'): Promise<PaymentGateway> {
    const response = await api.patch(`/admin/payments/gateways/${gatewayId}/move`, { direction })
    return paymentGatewaySchema.parse(unwrapPayload(response.data))
  },

  async createGatewayDefaults(): Promise<readonly PaymentGateway[]> {
    const response = await api.post('/admin/payments/gateways/defaults')
    return z.array(paymentGatewaySchema).parse(unwrapPayload(response.data))
  },

  async listTransactions(filters: {
    readonly userId?: string
    readonly status?: TransactionStatus
    readonly gatewayType?: PaymentGatewayType
    readonly purchaseType?: PurchaseType
    readonly limit?: number
  }): Promise<readonly PaymentTransaction[]> {
    const query = new URLSearchParams()
    if (filters.userId) {
      query.set('userId', filters.userId)
    }
    if (filters.status) {
      query.set('status', filters.status)
    }
    if (filters.gatewayType) {
      query.set('gatewayType', filters.gatewayType)
    }
    if (filters.purchaseType) {
      query.set('purchaseType', filters.purchaseType)
    }
    if (filters.limit !== undefined) {
      query.set('limit', String(filters.limit))
    }
    const queryString = query.toString()
    const path = queryString.length > 0 ? `/admin/payments/transactions?${queryString}` : '/admin/payments/transactions'
    const response = await api.get(path)
    return z.array(paymentTransactionSchema).parse(unwrapPayload(response.data))
  },

  async listDiscountHistory(): Promise<readonly PaymentDiscountHistoryItem[]> {
    const response = await api.get('/admin/payments/transactions/discount-history')
    return paymentDiscountHistorySchema.parse(unwrapPayload(response.data)).items
  },

  async createDraft(payload: {
    readonly userId: string
    readonly purchaseType: PurchaseType
    readonly planId: string
    readonly durationDays: number
    readonly gatewayType: PaymentGatewayType
    readonly sourceSubscriptionId?: string
    readonly channel?: PurchaseChannel
  }): Promise<PaymentTransaction> {
    const response = await api.post('/admin/payments/transactions/draft', payload)
    return paymentTransactionSchema.parse(unwrapPayload(response.data))
  },

  async getRefundReadiness(transactionId: string): Promise<PaymentRefundReadiness> {
    const response = await api.get(`/admin/payments/transactions/${transactionId}/refund-readiness`)
    return paymentRefundReadinessSchema.parse(unwrapPayload(response.data))
  },

  async createRefundRequest(input: { readonly transactionId: string; readonly reason: string; readonly idempotencyKey?: string; readonly refundAddress?: string; readonly isSubtract?: boolean }): Promise<PaymentRefundRequest> {
    const response = await api.post(`/admin/payments/transactions/${encodeURIComponent(input.transactionId)}/refund-requests`, {
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      refundAddress: input.refundAddress,
      isSubtract: input.isSubtract,
    })
    return paymentRefundRequestSchema.parse(unwrapPayload(response.data))
  },

  async listRefundRequests(transactionId: string): Promise<PaymentRefundRequestHistory> {
    const response = await api.get(`/admin/payments/transactions/${encodeURIComponent(transactionId)}/refund-requests`)
    return paymentRefundRequestHistorySchema.parse(unwrapPayload(response.data))
  },

  async getRefundRequestDetail(transactionId: string, requestId: string): Promise<PaymentRefundRequestDetail> {
    const response = await api.get(`/admin/payments/transactions/${encodeURIComponent(transactionId)}/refund-requests/${encodeURIComponent(requestId)}`)
    return paymentRefundRequestDetailSchema.parse(unwrapPayload(response.data))
  },

  async getRefundRequestPreflight(transactionId: string, requestId: string): Promise<PaymentRefundRequestPreflight> {
    const response = await api.get(`/admin/payments/transactions/${encodeURIComponent(transactionId)}/refund-requests/${encodeURIComponent(requestId)}/preflight`)
    return paymentRefundRequestPreflightSchema.parse(unwrapPayload(response.data))
  },

  async executeRefundRequest(transactionId: string, requestId: string): Promise<PaymentRefundExecution> {
    const response = await api.post(`/admin/payments/transactions/${encodeURIComponent(transactionId)}/refund-requests/${encodeURIComponent(requestId)}/execute`)
    return paymentRefundExecutionSchema.parse(unwrapPayload(response.data))
  },

  async listRefundExecutions(transactionId: string, requestId: string): Promise<PaymentRefundExecutionHistory> {
    const response = await api.get(`/admin/payments/transactions/${encodeURIComponent(transactionId)}/refund-requests/${encodeURIComponent(requestId)}/executions`)
    return paymentRefundExecutionHistorySchema.parse(unwrapPayload(response.data))
  },

  async getManualCorrectionPolicy(): Promise<PaymentManualCorrectionPolicy> {
    const response = await api.get('/admin/payments/transactions/manual-corrections/policy')
    return paymentManualCorrectionPolicySchema.parse(unwrapPayload(response.data))
  },

  async getDisputePolicy(): Promise<PaymentDisputePolicy> {
    const response = await api.get('/admin/payments/transactions/disputes/policy')
    return paymentDisputePolicySchema.parse(unwrapPayload(response.data))
  },

  async getReconciliationPolicy(): Promise<PaymentReconciliationPolicy> {
    const response = await api.get('/admin/payments/transactions/reconciliation/policy')
    return paymentReconciliationPolicySchema.parse(unwrapPayload(response.data))
  },

  async createCorrectionNote(input: { readonly transactionId: string; readonly note: string; readonly idempotencyKey?: string }): Promise<PaymentCorrectionNote> {
    const response = await api.post(`/admin/payments/transactions/${encodeURIComponent(input.transactionId)}/correction-notes`, { note: input.note, idempotencyKey: input.idempotencyKey })
    return paymentCorrectionNoteSchema.parse(unwrapPayload(response.data))
  },

  async listCorrectionNotes(transactionId: string): Promise<PaymentCorrectionNoteHistory> {
    const response = await api.get(`/admin/payments/transactions/${encodeURIComponent(transactionId)}/correction-notes`)
    return paymentCorrectionNoteHistorySchema.parse(unwrapPayload(response.data))
  },

  async createDisputeRecord(input: { readonly transactionId: string; readonly reason: string; readonly providerCaseId?: string; readonly idempotencyKey?: string }): Promise<PaymentDisputeRecord> {
    const response = await api.post(`/admin/payments/transactions/${encodeURIComponent(input.transactionId)}/dispute-records`, { reason: input.reason, providerCaseId: input.providerCaseId, idempotencyKey: input.idempotencyKey })
    return paymentDisputeRecordSchema.parse(unwrapPayload(response.data))
  },

  async listDisputeRecords(transactionId: string): Promise<PaymentDisputeRecordHistory> {
    const response = await api.get(`/admin/payments/transactions/${encodeURIComponent(transactionId)}/dispute-records`)
    return paymentDisputeRecordHistorySchema.parse(unwrapPayload(response.data))
  },

  async createReconciliationException(input: { readonly transactionId: string; readonly type: string; readonly reason: string; readonly evidenceNote?: string; readonly idempotencyKey?: string }): Promise<PaymentReconciliationException> {
    const response = await api.post(`/admin/payments/transactions/${encodeURIComponent(input.transactionId)}/reconciliation-exceptions`, { type: input.type, reason: input.reason, evidenceNote: input.evidenceNote, idempotencyKey: input.idempotencyKey })
    return paymentReconciliationExceptionSchema.parse(unwrapPayload(response.data))
  },

  async listReconciliationExceptions(transactionId: string): Promise<PaymentReconciliationExceptionHistory> {
    const response = await api.get(`/admin/payments/transactions/${encodeURIComponent(transactionId)}/reconciliation-exceptions`)
    return paymentReconciliationExceptionHistorySchema.parse(unwrapPayload(response.data))
  },

  async createCorrectionRequest(input: { readonly transactionId: string; readonly type: string; readonly reason: string; readonly requestedAmount?: string; readonly requestedStatus?: string; readonly idempotencyKey?: string }): Promise<PaymentCorrectionRequest> {
    const response = await api.post(`/admin/payments/transactions/${encodeURIComponent(input.transactionId)}/correction-requests`, { type: input.type, reason: input.reason, requestedAmount: input.requestedAmount, requestedStatus: input.requestedStatus, idempotencyKey: input.idempotencyKey })
    return paymentCorrectionRequestSchema.parse(unwrapPayload(response.data))
  },

  async listCorrectionRequests(transactionId: string): Promise<PaymentCorrectionRequestHistory> {
    const response = await api.get(`/admin/payments/transactions/${encodeURIComponent(transactionId)}/correction-requests`)
    return paymentCorrectionRequestHistorySchema.parse(unwrapPayload(response.data))
  },

  async getCorrectionRequestReadiness(transactionId: string, requestId: string): Promise<PaymentCorrectionRequestReadiness> {
    const response = await api.get(`/admin/payments/transactions/${encodeURIComponent(transactionId)}/correction-requests/${encodeURIComponent(requestId)}/readiness`)
    return paymentCorrectionRequestReadinessSchema.parse(unwrapPayload(response.data))
  },

  async executeCorrectionRequest(transactionId: string, requestId: string): Promise<PaymentCorrectionExecution> {
    const response = await api.post(`/admin/payments/transactions/${encodeURIComponent(transactionId)}/correction-requests/${encodeURIComponent(requestId)}/execute`)
    return paymentCorrectionExecutionSchema.parse(unwrapPayload(response.data))
  },

  async getRefundGatewayCapabilities(): Promise<PaymentRefundGatewayCapabilities> {
    const response = await api.get('/admin/payments/transactions/refund-gateways/capabilities')
    return paymentRefundGatewayCapabilitiesSchema.parse(unwrapPayload(response.data))
  },

  async checkout(payload: {
    readonly userId: string
    readonly purchaseType: PurchaseType
    readonly planId: string
    readonly durationDays: number
    readonly gatewayType: PaymentGatewayType
    readonly subscriptionId?: string
    readonly channel?: PurchaseChannel
  }): Promise<PaymentCheckout> {
    const response = await api.post('/admin/payments/transactions/checkout', payload)
    return paymentCheckoutSchema.parse(unwrapPayload(response.data))
  },

  async listWebhookEvents(filters: {
    readonly gatewayType?: PaymentGatewayType
    readonly status?: PaymentWebhookLifecycleStatus
    readonly paymentId?: string
    readonly providerEventId?: string
    readonly limit?: number
  }): Promise<readonly PaymentWebhookEvent[]> {
    const query = new URLSearchParams()
    if (filters.gatewayType) {
      query.set('gatewayType', filters.gatewayType)
    }
    if (filters.status) {
      query.set('status', filters.status)
    }
    if (filters.paymentId) {
      query.set('paymentId', filters.paymentId)
    }
    if (filters.providerEventId) {
      query.set('providerEventId', filters.providerEventId)
    }
    if (filters.limit !== undefined) {
      query.set('limit', String(filters.limit))
    }
    const queryString = query.toString()
    const path = queryString.length > 0 ? `/admin/payments/webhooks/events?${queryString}` : '/admin/payments/webhooks/events'
    const response = await api.get(path)
    return z.array(paymentWebhookEventSchema).parse(unwrapPayload(response.data))
  },

  async getWebhookEvent(eventId: string, includeRaw = false): Promise<PaymentWebhookEventDetail> {
    const query = includeRaw ? '?includeRaw=true' : ''
    const response = await api.get(`/admin/payments/webhooks/events/${eventId}${query}`)
    return paymentWebhookEventDetailSchema.parse(unwrapPayload(response.data))
  },

  async replayWebhookEvent(payload: {
    readonly eventId: string
    readonly reason: string
    readonly force: boolean
  }): Promise<{ readonly event: PaymentWebhookEvent; readonly alreadyQueued: boolean }> {
    const response = await api.post(`/admin/payments/webhooks/events/${payload.eventId}/replay`, {
      reason: payload.reason,
      force: payload.force,
    })
    const parsedPayload = z.object({
      event: paymentWebhookEventSchema,
      alreadyQueued: z.boolean(),
    }).parse(unwrapPayload(response.data))
    return parsedPayload
  },

  async getReconciliationHealth(): Promise<PaymentReconciliationHealth> {
    const response = await api.get('/admin/payments/reconciliation/health')
    return paymentReconciliationHealthSchema.parse(unwrapPayload(response.data))
  },

  async processNextProfileSyncJob(): Promise<ProfileSyncJobExecution> {
    const response = await api.post('/admin/payments/reconciliation/profile-sync-jobs/process-next')
    return profileSyncJobExecutionSchema.parse(unwrapPayload(response.data))
  },

  async processProfileSyncJobBatch(): Promise<ProfileSyncJobBatchExecution> {
    const response = await api.post('/admin/payments/reconciliation/profile-sync-jobs/process-batch')
    return profileSyncJobBatchExecutionSchema.parse(unwrapPayload(response.data))
  },

  async listProfileSyncProblemJobs(): Promise<ProfileSyncProblemJobs> {
    const response = await api.get('/admin/payments/reconciliation/profile-sync-jobs/problems')
    return profileSyncProblemJobsSchema.parse(unwrapPayload(response.data))
  },

  async resetProfileSyncJobRetry(jobId: string): Promise<ProfileSyncRetryReset> {
    const response = await api.post(`/admin/payments/reconciliation/profile-sync-jobs/${encodeURIComponent(jobId)}/reset-retry`)
    return profileSyncRetryResetSchema.parse(unwrapPayload(response.data))
  },

  async enqueueProfileSyncJob(jobId: string): Promise<ProfileSyncEnqueue> {
    const response = await api.post(`/admin/payments/reconciliation/profile-sync-jobs/${encodeURIComponent(jobId)}/enqueue`)
    return profileSyncEnqueueSchema.parse(unwrapPayload(response.data))
  },

async recordProfileSyncCompensationNote(jobId: string, note: string): Promise<ProfileSyncCompensationNote> {
const response = await api.post(`/admin/payments/reconciliation/profile-sync-jobs/${encodeURIComponent(jobId)}/compensation-notes`, { note })
return profileSyncCompensationNoteSchema.parse(unwrapPayload(response.data))
},
async forceLinkProfileSync(input: { readonly subscriptionId: string; readonly remnawaveUserUuid: string; readonly reason: string }): Promise<ProfileSyncForceLink> {
const response = await api.post('/admin/payments/reconciliation/profile-sync-jobs/force-link', input)
return profileSyncForceLinkSchema.parse(unwrapPayload(response.data))
},

  async getProfileSyncCompensationPolicy(): Promise<ProfileSyncCompensationPolicy> {
    const response = await api.get('/admin/payments/reconciliation/profile-sync-jobs/compensation-policy')
    return profileSyncCompensationPolicySchema.parse(unwrapPayload(response.data))
  },

  async getPaymentOpsAlertSettings(): Promise<PaymentOpsAlertSettings> {
    const response = await api.get('/admin/settings/system-notifications/payment-ops')
    return paymentOpsAlertSettingsSchema.parse(unwrapPayload(response.data))
  },

  async updatePaymentOpsAlertSettings(payload: Partial<PaymentOpsAlertSettings>): Promise<PaymentOpsAlertSettings> {
    const response = await api.patch('/admin/settings/system-notifications/payment-ops', payload)
    return paymentOpsAlertSettingsSchema.parse(unwrapPayload(response.data))
  },

  async sendPaymentOpsAlertTest(note: string): Promise<void> {
    await api.post('/admin/settings/system-notifications/payment-ops/test', { note })
  },
}
