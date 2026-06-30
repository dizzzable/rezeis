import { z } from 'zod'
import { api } from '@/lib/api'
import { unwrapPayloadOrArray } from '@/lib/api-utils'
import { createUserSearchSchema } from '@/features/users/user-search-schema'
import { buildUserSearchParams } from '@/features/users/user-search-request'

export const usersQueueKeySchema = z.enum(['recentRegistered', 'blacklist', 'invited'])

export type UsersQueueKey = z.infer<typeof usersQueueKeySchema>

const webAccountSchema = z.object({
  id: z.string(),
  login: z.string().nullable(),
  loginNormalized: z.string().nullable(),
  email: z.string().nullable(),
  emailNormalized: z.string().nullable(),
  emailVerifiedAt: z.string().nullable(),
  requiresPasswordChange: z.boolean(),
  linkPromptSnoozeUntil: z.string().nullable(),
  credentialsBootstrappedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const userModerationResultSchema = z.object({
  userId: z.string(),
  isBlocked: z.boolean(),
  changed: z.boolean(),
  action: z.enum(['BLOCK_USER', 'UNBLOCK_USER']),
  checkedAt: z.string(),
})
const userModerationHistorySchema = z.object({
  userId: z.string(),
  items: z.array(z.object({
    id: z.string(),
    action: z.enum(['BLOCK_USER', 'UNBLOCK_USER']),
    changed: z.boolean(),
    reasonProvided: z.boolean(),
    adminActorPresent: z.boolean(),
    createdAt: z.string(),
  })),
})
const userRoleReadinessSchema = z.object({
  checkedAt: z.string(),
  userId: z.string(),
  currentRole: z.string(),
  mutationEnabled: z.boolean(),
  checks: z.array(z.object({ code: z.string(), passed: z.boolean(), severity: z.enum(['INFO', 'WARNING', 'BLOCKER']), message: z.string() })),
})

const userRoleAdjustmentSchema = z.object({
  userId: z.string(),
  previousRole: z.string(),
  nextRole: z.string(),
  changed: z.boolean(),
  idempotentReplay: z.boolean(),
  checkedAt: z.string(),
})
const userCommercialReadinessSchema = z.object({
  checkedAt: z.string(),
  userId: z.string(),
  personalDiscount: z.number(),
  purchaseDiscount: z.number(),
  points: z.number(),
  maxSubscriptions: z.number(),
  mutationEnabled: z.boolean(),
  checks: z.array(z.object({ code: z.string(), passed: z.boolean(), severity: z.enum(['INFO', 'WARNING', 'BLOCKER']), message: z.string() })),
})

const commercialSnapshotSchema = z.object({
  personalDiscount: z.number(),
  purchaseDiscount: z.number(),
  points: z.number(),
  maxSubscriptions: z.number(),
})

const userCommercialAdjustmentSchema = z.object({
  userId: z.string(),
  changed: z.boolean(),
  idempotentReplay: z.boolean(),
  changedFields: z.array(z.enum(['personalDiscount', 'purchaseDiscount', 'points', 'maxSubscriptions'])),
  before: commercialSnapshotSchema,
  after: commercialSnapshotSchema,
  checkedAt: z.string(),
})
const userSupportMessageReadinessSchema = z.object({
  checkedAt: z.string(),
  userId: z.string(),
  contactAvailable: z.boolean(),
  isBlocked: z.boolean(),
  mutationEnabled: z.boolean(),
  checks: z.array(z.object({ code: z.string(), passed: z.boolean(), severity: z.enum(['INFO', 'WARNING', 'BLOCKER']), message: z.string() })),
})

const userSupportMessageDraftSchema = z.object({
  draftId: z.string(),
  userId: z.string(),
  contactAvailable: z.boolean(),
  deliveryEnabled: z.literal(false),
  idempotentReplay: z.boolean(),
  messagePreview: z.string(),
  messageLength: z.number(),
  reasonProvided: z.boolean(),
  createdAt: z.string(),
})

const userSupportMessageDeliverySchema = z.object({
  draftId: z.string(),
  userId: z.string(),
  deliveryState: z.enum(['delivered', 'definitely-not-delivered', 'delivery-status-uncertain']),
  delivered: z.boolean(),
  idempotentReplay: z.boolean(),
  telegramMessageId: z.number().nullable(),
  sentAt: z.string().nullable(),
})
const userWebAccountReadinessSchema = z.object({
  checkedAt: z.string(),
  userId: z.string(),
  hasLinkedWebAccount: z.boolean(),
  mutationEnabled: z.literal(false),
  checks: z.array(z.object({ code: z.string(), passed: z.boolean(), severity: z.enum(['INFO', 'WARNING', 'BLOCKER']), message: z.string() })),
})
const userWebAccountHistorySchema = z.object({
  checkedAt: z.string(),
  userId: z.string(),
  hasWebAccount: z.boolean(),
  emailVerified: z.boolean().nullable(),
  credentialsBootstrapped: z.boolean().nullable(),
  linkPromptSnoozed: z.boolean().nullable(),
  items: z.array(z.object({
    id: z.string(),
    purpose: z.string(),
    channel: z.string(),
    status: z.enum(['PENDING', 'CONSUMED', 'EXPIRED']),
    attemptsLeft: z.number(),
    createdAt: z.string(),
    expiresAt: z.string(),
  })),
})
const userWebAccountBootstrapSchema = z.object({
  checkedAt: z.string(),
  userId: z.string(),
  credentialsBootstrapped: z.boolean(),
  requiresPasswordChange: z.boolean(),
  changed: z.boolean(),
})

const identityDiagnosticsSchema = z.object({
  lookup: z.object({
    requestedIdentifier: z.object({
      type: z.enum(['userId', 'telegramId', 'email', 'login', 'referralCode']),
      value: z.string(),
    }),
    resolvedBy: z.enum(['userId', 'telegramId', 'email', 'login', 'referralCode']),
    resolvedViaLinkedWebAccount: z.boolean(),
  }),
  linkedWebAccount: z.object({
    status: z.enum([
      'absent',
      'ready',
      'email_unverified',
      'credentials_bootstrap_pending',
      'password_change_required',
      'attention_required',
    ]),
    hasLinkedWebAccount: z.boolean(),
    emailVerified: z.boolean().nullable(),
    credentialsBootstrapped: z.boolean().nullable(),
    requiresPasswordChange: z.boolean().nullable(),
    mismatchFlags: z.object({
      sessionEmailVsWebAccountEmail: z.boolean(),
      requestedEmailVsSessionEmail: z.boolean(),
      requestedEmailVsWebAccountEmail: z.boolean(),
      requestedLoginVsWebAccountLogin: z.boolean(),
    }),
    guidance: z.array(
      z.enum([
        'no_linked_web_account',
        'verify_email',
        'bootstrap_credentials',
        'require_password_change',
        'review_identity_mismatch',
        'linked_identity_ready',
      ]),
    ),
  }),
})

const userSessionSchema = z.object({
    id: z.string(),
    telegramId: z.string().nullable(),
    username: z.string().nullable(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    role: z.string(),
    language: z.string(),
    personalDiscount: z.number(),
    purchaseDiscount: z.number(),
    points: z.number(),
    maxSubscriptions: z.number(),
    isBlocked: z.boolean(),
    isBotBlocked: z.boolean(),
    isRulesAccepted: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    webAccount: webAccountSchema.nullable(),
  })

const subscriptionSummarySchema = z.object({
  subscription: z
    .object({
      id: z.string(),
      status: z.string(),
      isTrial: z.boolean(),
      plan: z
        .object({
          name: z.string().nullable(),
          type: z.string().nullable(),
        })
        .nullable(),
      trafficLimit: z.number().nullable(),
      deviceLimit: z.number(),
      startedAt: z.string().nullable(),
      expiresAt: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .nullable(),
})

const userSearchResultSchema = z.object({
  session: userSessionSchema,
  subscription: subscriptionSummarySchema.shape.subscription,
  identityDiagnostics: identityDiagnosticsSchema.optional(),
})

const emailVerificationChallengeSchema = z.object({
  webAccountId: z.string(),
  email: z.string(),
  challengeExpiresAt: z.string(),
})

const usersListItemSchema = z.object({
  id: z.string(),
  telegramId: z.string().nullable(),
  username: z.string().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  role: z.string(),
  isBlocked: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  webAccountContext: z
    .object({
      hasWebAccount: z.boolean(),
      emailVerifiedAt: z.string().nullable(),
      credentialsBootstrappedAt: z.string().nullable(),
      requiresPasswordChange: z.boolean(),
    })
    .optional(),
  invitedContext: z
    .object({
      invitedAt: z.string(),
      qualifiedAt: z.string().nullable(),
      qualifiedPurchaseChannel: z.string().nullable(),
      inviter: z.object({
        id: z.string(),
        username: z.string().nullable(),
        email: z.string().nullable(),
      }),
    })
    .optional(),
})

const usersListResultSchema = z.object({
  queue: usersQueueKeySchema,
  items: z.array(usersListItemSchema),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
})

const subscriptionDeviceSchema = z
  .object({
    deviceRef: z.string(),
    deviceName: z.string().nullable(),
    platform: z.string().nullable(),
    osVersion: z.string().nullable(),
    appVersion: z.string().nullable(),
    userAgent: z.string().nullable(),
    ipAddress: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
    createdAt: z.string().nullable(),
  })
  .passthrough()

const subscriptionDevicesResultSchema = z.object({
  devices: z.array(subscriptionDeviceSchema),
  deviceCount: z.number(),
  deviceLimit: z.number(),
  isLimitReached: z.boolean(),
  blockedMessage: z.string().nullable(),
  maxDevicesMessage: z.string().nullable(),
})

const accessDiagnosticsSchema = z.object({
  checkedAt: z.string(),
  accessState: z.enum(['READY', 'REVIEW', 'BLOCKED']),
  primaryReasonCode: z.string(),
  reasons: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
      message: z.string(),
    }),
  ),
  facts: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      value: z.string(),
    }),
  ),
  nextActions: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      target: z.enum(['USERS_SEARCH', 'SUBSCRIPTION_DEVICES', 'SUBSCRIPTION_QUOTE', 'PLATFORM_SETTINGS']),
    }),
  ),
})

const subscriptionsWorkbenchSchema = z.object({
  checkedAt: z.string(),
  totalCount: z.number().int().nonnegative(),
  currentSubscriptionId: z.string().nullable(),
  items: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      isTrial: z.boolean(),
      plan: z
        .object({
          name: z.string().nullable(),
          type: z.string().nullable(),
        })
        .nullable(),
      trafficLimit: z.number().nullable(),
      deviceLimit: z.number(),
      startedAt: z.string().nullable(),
      expiresAt: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
      isCurrentCandidate: z.boolean(),
      riskLevel: z.enum(['OK', 'WATCH', 'BLOCKED']),
      markers: z.array(
        z.object({
          code: z.string(),
          severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
          message: z.string(),
        }),
      ),
    }),
  ),
})

const selectedSubscriptionWorkbenchSchema = z.object({
  checkedAt: z.string(),
  subscription: subscriptionsWorkbenchSchema.shape.items.element,
  ownership: z.object({
    belongsToUser: z.boolean(),
    status: z.string(),
  }),
  entitlement: z.object({
    isActiveCandidate: z.boolean(),
    isExpired: z.boolean(),
    isUpcoming: z.boolean(),
    riskLevel: z.enum(['OK', 'WATCH', 'BLOCKED']),
    markers: z.array(
      z.object({
        code: z.string(),
        severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
        message: z.string(),
      }),
    ),
  }),
  capacity: z.object({
    deviceLimit: z.number(),
    trafficLimit: z.number().nullable(),
  }),
  nextActions: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      target: z.enum(['SUBSCRIPTIONS_WORKBENCH', 'ACCESS_DIAGNOSTICS', 'SUBSCRIPTION_QUOTE', 'USERS_SEARCH']),
    }),
  ),
})

const deviceProvisioningChallengeSchema = z.object({
  id: z.string(),
  status: z.enum(['PENDING', 'CONSUMED', 'EXPIRED', 'REVOKED']),
  reason: z.string().nullable(),
  expiresAt: z.string(),
  consumedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  attemptsLeft: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const deviceProvisioningChallengesSchema = z.object({
  userId: z.string(),
  subscriptionId: z.string(),
  activeChallenge: deviceProvisioningChallengeSchema.nullable(),
  items: z.array(deviceProvisioningChallengeSchema),
})

const subscriptionLimitsSnapshotSchema = z.object({
  trafficLimit: z.number().nullable(),
  deviceLimit: z.number(),
})

const subscriptionLimitsAdjustmentSchema = z.object({
  userId: z.string(),
  subscriptionId: z.string(),
  changed: z.boolean(),
  idempotentReplay: z.boolean(),
  changedFields: z.array(z.enum(['trafficLimit', 'deviceLimit'])),
  providerMutation: z.boolean(),
  before: subscriptionLimitsSnapshotSchema,
  after: subscriptionLimitsSnapshotSchema,
  checkedAt: z.string(),
})

const subscriptionMutationRequestSchema = z.object({
  requestId: z.string(),
  action: z.enum(['RENEW', 'EXTEND', 'TRAFFIC_RESET', 'LIMIT_CHANGE']),
  status: z.literal('PLANNED'),
  executionEnabled: z.boolean(),
  reasonRequired: z.literal(true),
  reasonProvided: z.boolean(),
  idempotencyKeyPresent: z.boolean(),
  trafficLimit: z.number().nullable().optional(),
  deviceLimit: z.number().nullable().optional(),
  durationDays: z.number().nullable().optional(),
  targetPlanId: z.string().nullable().optional(),
  createdAt: z.string(),
})

const selectedSubscriptionPlanAssignmentReadinessSchema = z.object({
  userId: z.string(),
  subscriptionId: z.string(),
  targetPlanId: z.string(),
  currentPlanId: z.string().nullable(),
  targetPlanName: z.string().nullable(),
  plannedTrafficLimit: z.number().nullable(),
  plannedDeviceLimit: z.number().nullable(),
  plannedInternalSquadsCount: z.number(),
  plannedExternalSquadPresent: z.boolean(),
  executionEnabled: z.boolean(),
  checks: z.array(z.object({ code: z.string(), passed: z.boolean(), severity: z.enum(['INFO', 'WARNING', 'BLOCKER']), message: z.string() })),
})
const selectedSubscriptionPlanAssignmentExecutionSchema = z.object({
  userId: z.string(),
  subscriptionId: z.string(),
  targetPlanId: z.string(),
  status: z.enum(['EXECUTED', 'BLOCKED']),
  providerMutation: z.boolean(),
  databaseMutation: z.boolean(),
  nextCurrentSubscriptionId: z.string().nullable().optional(),
  checkedAt: z.string(),
})
const selectedSubscriptionStatusChangeReadinessSchema = z.object({
  userId: z.string(),
  subscriptionId: z.string(),
  desiredStatus: z.enum(['ACTIVE', 'DISABLED']),
  executionEnabled: z.boolean(),
  checks: z.array(z.object({ code: z.string(), passed: z.boolean(), severity: z.enum(['INFO', 'WARNING', 'BLOCKER']), message: z.string() })),
  checkedAt: z.string(),
})
const selectedSubscriptionStatusChangeExecutionSchema = z.object({
  userId: z.string(),
  subscriptionId: z.string(),
  desiredStatus: z.enum(['ACTIVE', 'DISABLED']),
  status: z.enum(['EXECUTED', 'BLOCKED']),
  providerMutation: z.boolean(),
  databaseMutation: z.boolean(),
  checkedAt: z.string(),
})

const subscriptionMutationRequestHistorySchema = z.object({
  items: z.array(z.object({
    requestId: z.string(),
    action: z.enum(['RENEW', 'EXTEND', 'TRAFFIC_RESET', 'LIMIT_CHANGE']),
    status: z.literal('PLANNED'),
    executionEnabled: z.boolean(),
    idempotencyKeyPresent: z.boolean(),
    createdAt: z.string(),
  })),
})

const subscriptionMutationRequestDetailSchema = z.object({
  requestId: z.string(),
  action: z.enum(['RENEW', 'EXTEND', 'TRAFFIC_RESET', 'LIMIT_CHANGE']),
  status: z.enum(['PLANNED', 'EXECUTED']),
  executionEnabled: z.boolean(),
  idempotencyKeyPresent: z.boolean(),
  trafficLimit: z.number().nullable(),
  deviceLimit: z.number().nullable(),
  durationDays: z.number().nullable(),
  createdAt: z.string(),
  checks: z.array(z.object({
    code: z.string(),
    passed: z.boolean(),
    severity: z.enum(['INFO', 'WARNING', 'BLOCKER']),
    message: z.string(),
  })),
})
const subscriptionMutationPreflightSchema = subscriptionMutationRequestDetailSchema.extend({
  preflightReady: z.boolean(),
  executorPlan: z.object({
    providerMutation: z.boolean(),
    paymentMutation: z.literal(false),
    databaseMutation: z.boolean(),
    nextRequiredSlice: z.string(),
  }),
})
const subscriptionMutationExecutionSchema = z.object({
  requestId: z.string(),
  action: z.enum(['RENEW', 'EXTEND', 'TRAFFIC_RESET', 'LIMIT_CHANGE', 'BLOCKED']),
  status: z.enum(['EXECUTED', 'BLOCKED']),
  providerMutation: z.boolean(),
  databaseMutation: z.boolean(),
  checkedAt: z.string(),
})

const revokeSubscriptionDeviceResultSchema = z
  .object({
    devices: z.array(subscriptionDeviceSchema),
    deviceCount: z.number(),
    deviceLimit: z.number(),
    isLimitReached: z.boolean(),
    blockedMessage: z.string().nullable(),
    maxDevicesMessage: z.string().nullable(),
  })
  .passthrough()
  .nullable()
  .optional()

const usersActivityTransactionSchema = z.object({
  id: z.string(),
  paymentId: z.string(),
  userId: z.string(),
  subscriptionId: z.string().nullable(),
  status: z.string(),
  purchaseType: z.string(),
  channel: z.string(),
  gatewayType: z.string(),
  currency: z.string(),
  amount: z.string(),
  paymentAsset: z.string().nullable().optional(),
  gatewayId: z.string().nullable().optional(),
  planSnapshot: z.unknown().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const usersActivityTransactionsResultSchema = z.object({
  items: z.array(usersActivityTransactionSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
})

const usersNotificationActivityItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: z.string(),
  title: z.string(),
  message: z.string(),
  isRead: z.boolean(),
  readAt: z.string().nullable(),
  readSource: z.string().nullable(),
  createdAt: z.string(),
})

const usersActivityNotificationsResultSchema = z.object({
  items: z.array(usersNotificationActivityItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
})

const subscriptionRenewalReadinessSchema = z.object({
  checkedAt: z.string(),
  subscriptionId: z.string(),
  isReady: z.boolean(),
  mutationEnabled: z.literal(false),
  checks: z.array(z.object({
    code: z.string(),
    passed: z.boolean(),
    severity: z.enum(['INFO', 'WARNING', 'BLOCKER']),
    message: z.string(),
  })),
})

type UserSearchFormValues = z.infer<ReturnType<typeof createUserSearchSchema>>

const unwrapPayload = unwrapPayloadOrArray

async function searchUser(values: UserSearchFormValues): Promise<z.infer<typeof userSearchResultSchema>> {
  const response = await api.get('/admin/users/search', {
    params: buildUserSearchParams(values),
  })
  return userSearchResultSchema.parse(unwrapPayload(response.data))
}

async function listUsers(input: {
  readonly queue: UsersQueueKey
  readonly limit?: number
  readonly cursor?: string | null
}): Promise<z.infer<typeof usersListResultSchema>> {
  const response = await api.get('/admin/users', {
    params: {
      queue: input.queue,
      limit: input.limit,
      cursor: input.cursor ?? undefined,
    },
  })
  return usersListResultSchema.parse(unwrapPayload(response.data))
}

async function listCurrentSubscriptionDevices(values: UserSearchFormValues): Promise<z.infer<typeof subscriptionDevicesResultSchema>> {
  const response = await api.get('/admin/users/subscription/devices', {
    params: buildUserSearchParams(values),
  })
  return subscriptionDevicesResultSchema.parse(unwrapPayload(response.data))
}

async function getAccessDiagnostics(values: UserSearchFormValues): Promise<z.infer<typeof accessDiagnosticsSchema>> {
  const response = await api.get('/admin/users/access-diagnostics', {
    params: buildUserSearchParams(values),
  })
  return accessDiagnosticsSchema.parse(unwrapPayload(response.data))
}

async function getSubscriptionsWorkbench(values: UserSearchFormValues): Promise<z.infer<typeof subscriptionsWorkbenchSchema>> {
  const response = await api.get('/admin/users/subscriptions', {
    params: buildUserSearchParams(values),
  })
  return subscriptionsWorkbenchSchema.parse(unwrapPayload(response.data))
}

async function getSelectedSubscriptionWorkbench(input: {
  readonly userId: string
  readonly subscriptionId: string
}): Promise<z.infer<typeof selectedSubscriptionWorkbenchSchema>> {
  const response = await api.get('/admin/users/subscriptions/selected', {
    params: input,
  })
  return selectedSubscriptionWorkbenchSchema.parse(unwrapPayload(response.data))
}

async function listSelectedSubscriptionDevices(input: {
  readonly userId: string
  readonly subscriptionId: string
}): Promise<z.infer<typeof subscriptionDevicesResultSchema>> {
  const response = await api.get('/admin/users/subscriptions/selected/devices', {
    params: input,
  })
  return subscriptionDevicesResultSchema.parse(unwrapPayload(response.data))
}

async function revokeSelectedSubscriptionDevice(input: {
  readonly userId: string
  readonly subscriptionId: string
  readonly deviceRef: string
}): Promise<z.infer<typeof revokeSubscriptionDeviceResultSchema>> {
  const response = await api.delete(
    `/admin/users/subscriptions/selected/devices/${encodeURIComponent(input.deviceRef)}`,
    {
      params: {
        userId: input.userId,
        subscriptionId: input.subscriptionId,
      },
    },
  )
  return revokeSubscriptionDeviceResultSchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function getSelectedSubscriptionRenewalReadiness(input: {
  readonly userId: string
  readonly subscriptionId: string
}): Promise<z.infer<typeof subscriptionRenewalReadinessSchema>> {
  const response = await api.get('/admin/users/subscriptions/selected/renewal-readiness', { params: input })
  return subscriptionRenewalReadinessSchema.parse(unwrapPayload(response.data))
}

async function getSelectedSubscriptionPlanAssignmentReadiness(input: {
  readonly userId: string
  readonly subscriptionId: string
  readonly targetPlanId: string
}): Promise<z.infer<typeof selectedSubscriptionPlanAssignmentReadinessSchema>> {
  const response = await api.get('/admin/users/subscriptions/selected/plan-assignment-readiness', { params: input })
  return selectedSubscriptionPlanAssignmentReadinessSchema.parse(unwrapPayload(response.data))
}

async function executeSelectedSubscriptionPlanAssignment(input: {
  readonly userId: string
  readonly subscriptionId: string
  readonly targetPlanId: string
  readonly reason: string
  readonly resetTraffic?: boolean
}): Promise<z.infer<typeof selectedSubscriptionPlanAssignmentExecutionSchema>> {
  const response = await api.post('/admin/users/subscriptions/selected/plan-assignment', { reason: input.reason, resetTraffic: input.resetTraffic }, { params: { userId: input.userId, subscriptionId: input.subscriptionId, targetPlanId: input.targetPlanId } })
  return selectedSubscriptionPlanAssignmentExecutionSchema.parse(unwrapPayload(response.data))
}

async function getSelectedSubscriptionStatusChangeReadiness(input: {
  readonly userId: string
  readonly subscriptionId: string
  readonly desiredStatus: 'ACTIVE' | 'DISABLED'
}): Promise<z.infer<typeof selectedSubscriptionStatusChangeReadinessSchema>> {
  const response = await api.get('/admin/users/subscriptions/selected/status-change-readiness', { params: input })
  return selectedSubscriptionStatusChangeReadinessSchema.parse(unwrapPayload(response.data))
}

async function executeSelectedSubscriptionStatusChange(input: {
  readonly userId: string
  readonly subscriptionId: string
  readonly desiredStatus: 'ACTIVE' | 'DISABLED'
  readonly reason: string
}): Promise<z.infer<typeof selectedSubscriptionStatusChangeExecutionSchema>> {
  const response = await api.post('/admin/users/subscriptions/selected/status-change', { reason: input.reason }, { params: { userId: input.userId, subscriptionId: input.subscriptionId, desiredStatus: input.desiredStatus } })
  return selectedSubscriptionStatusChangeExecutionSchema.parse(unwrapPayload(response.data))
}

async function updateSelectedSubscriptionLimits(input: {
  readonly userId: string
  readonly subscriptionId: string
  readonly trafficLimit?: number | null
  readonly deviceLimit?: number
  readonly reason: string
  readonly idempotencyKey?: string
}): Promise<z.infer<typeof subscriptionLimitsAdjustmentSchema>> {
  const response = await api.patch(
    '/admin/users/subscriptions/selected/limits',
    {
      trafficLimit: input.trafficLimit,
      deviceLimit: input.deviceLimit,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    },
    {
      params: {
        userId: input.userId,
        subscriptionId: input.subscriptionId,
      },
    },
  )
  return subscriptionLimitsAdjustmentSchema.parse(unwrapPayload(response.data))
}

async function createSelectedSubscriptionMutationRequest(input: {
  readonly userId: string
  readonly subscriptionId: string
  readonly action: 'RENEW' | 'EXTEND' | 'TRAFFIC_RESET' | 'LIMIT_CHANGE'
  readonly reason: string
  readonly idempotencyKey?: string
  readonly trafficLimit?: number
  readonly deviceLimit?: number
  readonly durationDays?: number
  readonly targetPlanId?: string
}): Promise<z.infer<typeof subscriptionMutationRequestSchema>> {
  const response = await api.post(
    '/admin/users/subscriptions/selected/mutation-requests',
    {
      action: input.action,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      trafficLimit: input.trafficLimit,
      deviceLimit: input.deviceLimit,
      durationDays: input.durationDays,
      targetPlanId: input.targetPlanId,
    },
    {
      params: {
        userId: input.userId,
        subscriptionId: input.subscriptionId,
      },
    },
  )
  return subscriptionMutationRequestSchema.parse(unwrapPayload(response.data))
}

async function listSelectedSubscriptionMutationRequests(input: {
  readonly userId: string
  readonly subscriptionId: string
}): Promise<z.infer<typeof subscriptionMutationRequestHistorySchema>> {
  const response = await api.get('/admin/users/subscriptions/selected/mutation-requests', { params: input })
  return subscriptionMutationRequestHistorySchema.parse(unwrapPayload(response.data))
}

async function getSelectedSubscriptionMutationRequestDetail(input: {
  readonly userId: string
  readonly subscriptionId: string
  readonly requestId: string
}): Promise<z.infer<typeof subscriptionMutationRequestDetailSchema>> {
  const response = await api.get(`/admin/users/subscriptions/selected/mutation-requests/${encodeURIComponent(input.requestId)}`, {
    params: {
      userId: input.userId,
      subscriptionId: input.subscriptionId,
    },
  })
  return subscriptionMutationRequestDetailSchema.parse(unwrapPayload(response.data))
}

async function getSelectedSubscriptionMutationPreflight(input: {
  readonly userId: string
  readonly subscriptionId: string
  readonly requestId: string
}): Promise<z.infer<typeof subscriptionMutationPreflightSchema>> {
  const response = await api.get(`/admin/users/subscriptions/selected/mutation-requests/${encodeURIComponent(input.requestId)}/preflight`, {
    params: {
      userId: input.userId,
      subscriptionId: input.subscriptionId,
    },
  })
  return subscriptionMutationPreflightSchema.parse(unwrapPayload(response.data))
}

async function executeSelectedSubscriptionMutationRequest(input: {
  readonly userId: string
  readonly subscriptionId: string
  readonly requestId: string
}): Promise<z.infer<typeof subscriptionMutationExecutionSchema>> {
  const response = await api.post(`/admin/users/subscriptions/selected/mutation-requests/${encodeURIComponent(input.requestId)}/execute`, null, {
    params: { userId: input.userId, subscriptionId: input.subscriptionId },
  })
  return subscriptionMutationExecutionSchema.parse(unwrapPayload(response.data))
}

async function listDeviceProvisioningChallenges(input: {
  readonly userId: string
  readonly subscriptionId: string
}): Promise<z.infer<typeof deviceProvisioningChallengesSchema>> {
  const response = await api.get('/admin/users/device-provisioning-challenges', {
    params: input,
  })
  return deviceProvisioningChallengesSchema.parse(unwrapPayload(response.data))
}

async function issueDeviceProvisioningChallenge(input: {
  readonly userId: string
  readonly subscriptionId: string
  readonly reason?: string
}): Promise<z.infer<typeof deviceProvisioningChallengeSchema>> {
  const response = await api.post(
    '/admin/users/device-provisioning-challenges',
    { reason: input.reason },
    {
      params: {
        userId: input.userId,
        subscriptionId: input.subscriptionId,
      },
    },
  )
  return deviceProvisioningChallengeSchema.parse(unwrapPayload(response.data))
}

async function revokeDeviceProvisioningChallenge(input: {
  readonly userId: string
  readonly subscriptionId: string
  readonly challengeId: string
}): Promise<z.infer<typeof deviceProvisioningChallengeSchema>> {
  const response = await api.patch(
    `/admin/users/device-provisioning-challenges/${encodeURIComponent(input.challengeId)}/revoke`,
    undefined,
    {
      params: {
        userId: input.userId,
        subscriptionId: input.subscriptionId,
      },
    },
  )
  return deviceProvisioningChallengeSchema.parse(unwrapPayload(response.data))
}

async function listUserActivityTransactions(input: {
  readonly values: UserSearchFormValues
  readonly limit?: number
  readonly page?: number
}): Promise<z.infer<typeof usersActivityTransactionsResultSchema>> {
  const response = await api.get('/admin/users/activity/transactions', {
    params: {
      ...buildUserSearchParams(input.values),
      limit: input.limit,
      page: input.page,
    },
  })
  return usersActivityTransactionsResultSchema.parse(unwrapPayload(response.data))
}

async function listUserActivityNotifications(input: {
  readonly values: UserSearchFormValues
  readonly limit?: number
  readonly page?: number
}): Promise<z.infer<typeof usersActivityNotificationsResultSchema>> {
  const response = await api.get('/admin/users/activity/notifications', {
    params: {
      ...buildUserSearchParams(input.values),
      limit: input.limit,
      page: input.page,
    },
  })
  return usersActivityNotificationsResultSchema.parse(unwrapPayload(response.data))
}

async function revokeCurrentSubscriptionDevice(input: {
  readonly deviceRef: string
  readonly values: UserSearchFormValues
}): Promise<z.infer<typeof revokeSubscriptionDeviceResultSchema>> {
  const response = await api.delete(`/admin/users/subscription/devices/${encodeURIComponent(input.deviceRef)}`, {
    params: {
      ...buildUserSearchParams(input.values),
    },
  })
  return revokeSubscriptionDeviceResultSchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function acceptRules(input: {
  readonly userId: string
}): Promise<z.infer<typeof userSessionSchema>> {
  const response = await api.patch('/admin/users/session/rules-acceptance', undefined, {
    params: {
      userId: input.userId,
    },
  })
  return userSessionSchema.parse(unwrapPayload(response.data))
}

async function setUserBlockedState(input: {
  readonly userId: string
  readonly isBlocked: boolean
  readonly reason?: string
}): Promise<z.infer<typeof userModerationResultSchema>> {
  const action = input.isBlocked ? 'block' : 'unblock'
  const response = await api.patch(`/admin/users/${encodeURIComponent(input.userId)}/${action}`, {
    reason: input.reason,
  })
  return userModerationResultSchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function listUserModerationHistory(userId: string): Promise<z.infer<typeof userModerationHistorySchema>> {
const response = await api.get(`/admin/users/${encodeURIComponent(userId)}/moderation-history`)
return userModerationHistorySchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function getUserRoleReadiness(userId: string): Promise<z.infer<typeof userRoleReadinessSchema>> {
const response = await api.get(`/admin/users/${encodeURIComponent(userId)}/role-readiness`)
return userRoleReadinessSchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function updateUserRole(input: {
  readonly userId: string
  readonly role: 'USER' | 'ADMIN' | 'DEV'
  readonly reason: string
  readonly idempotencyKey?: string
}): Promise<z.infer<typeof userRoleAdjustmentSchema>> {
  const response = await api.patch(`/admin/users/${encodeURIComponent(input.userId)}/role`, {
    role: input.role,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  })
  return userRoleAdjustmentSchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function getUserCommercialReadiness(userId: string): Promise<z.infer<typeof userCommercialReadinessSchema>> {
const response = await api.get(`/admin/users/${encodeURIComponent(userId)}/commercial-readiness`)
return userCommercialReadinessSchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function updateUserCommercialProfile(input: {
  readonly userId: string
  readonly personalDiscount?: number
  readonly purchaseDiscount?: number
  readonly points?: number
  readonly maxSubscriptions?: number
  readonly reason: string
  readonly idempotencyKey?: string
}): Promise<z.infer<typeof userCommercialAdjustmentSchema>> {
  const response = await api.patch(`/admin/users/${encodeURIComponent(input.userId)}/commercial-profile`, {
    personalDiscount: input.personalDiscount,
    purchaseDiscount: input.purchaseDiscount,
    points: input.points,
    maxSubscriptions: input.maxSubscriptions,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  })
  return userCommercialAdjustmentSchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function getUserSupportMessageReadiness(userId: string): Promise<z.infer<typeof userSupportMessageReadinessSchema>> {
  const response = await api.get(`/admin/users/${encodeURIComponent(userId)}/support-message-readiness`)
  return userSupportMessageReadinessSchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function createUserSupportMessageDraft(input: {
  readonly userId: string
  readonly message: string
  readonly reason: string
  readonly idempotencyKey?: string
}): Promise<z.infer<typeof userSupportMessageDraftSchema>> {
  const response = await api.post(`/admin/users/${encodeURIComponent(input.userId)}/support-message-drafts`, {
    message: input.message,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  })
  return userSupportMessageDraftSchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function sendUserSupportMessageDraft(input: {
  readonly userId: string
  readonly draftId: string
  readonly reason?: string
  readonly idempotencyKey?: string
}): Promise<z.infer<typeof userSupportMessageDeliverySchema>> {
  const response = await api.post(`/admin/users/${encodeURIComponent(input.userId)}/support-message-drafts/${encodeURIComponent(input.draftId)}/send`, {
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  })
  return userSupportMessageDeliverySchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function getUserWebAccountReadiness(userId: string): Promise<z.infer<typeof userWebAccountReadinessSchema>> {
  const response = await api.get(`/admin/users/${encodeURIComponent(userId)}/web-account-readiness`)
  return userWebAccountReadinessSchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function getUserWebAccountHistory(userId: string): Promise<z.infer<typeof userWebAccountHistorySchema>> {
  const response = await api.get(`/admin/users/${encodeURIComponent(userId)}/web-account-history`)
  return userWebAccountHistorySchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function bootstrapWebAccountCredentials(input: {
  readonly userId: string
  readonly login: string
  readonly password: string
  readonly reason: string
  readonly idempotencyKey?: string
}): Promise<z.infer<typeof userWebAccountBootstrapSchema>> {
  const response = await api.post(`/admin/users/${encodeURIComponent(input.userId)}/web-account/credentials-bootstrap`, {
    login: input.login,
    password: input.password,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  })
  return userWebAccountBootstrapSchema.parse(response.data == null ? null : unwrapPayload(response.data))
}

async function snoozeWebAccountLinkPrompt(input: {
  readonly userId: string
}): Promise<z.infer<typeof userSessionSchema>> {
  const response = await api.patch('/admin/users/session/web-account-link-prompt-snooze', undefined, {
    params: {
      userId: input.userId,
    },
  })
  return userSessionSchema.parse(unwrapPayload(response.data))
}

async function issueWebAccountEmailVerificationChallenge(input: {
  readonly userId: string
}): Promise<z.infer<typeof emailVerificationChallengeSchema>> {
  const response = await api.patch('/admin/users/session/web-account-email-verification-challenge', undefined, {
    params: {
      userId: input.userId,
    },
  })
  return emailVerificationChallengeSchema.parse(unwrapPayload(response.data))
}

const accountMergeSummarySchema = z.object({
  userId: z.string(),
  login: z.string().nullable(),
  telegramId: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string(),
  isBlocked: z.boolean(),
  hasWebAccount: z.boolean(),
  hasTrialGrant: z.boolean(),
  subscriptions: z.object({ total: z.number(), active: z.number(), trial: z.number() }),
  transactionsCount: z.number(),
  partner: z.object({ isPartner: z.boolean(), balanceMinor: z.number() }),
  createdAt: z.string(),
})

const accountMergePreviewSchema = z.object({
  current: accountMergeSummarySchema,
  counterpart: accountMergeSummarySchema,
  conflicts: z.array(z.string()),
})

const accountMergeResultSchema = z.object({
  mergedUserId: z.string(),
  movedCounts: z.object({
    subscriptions: z.number(),
    transactions: z.number(),
    partnerTransactions: z.number(),
  }),
  remnawaveSubscriptionIds: z.array(z.string()),
})

export type AccountMergeSummary = z.infer<typeof accountMergeSummarySchema>
export type AccountMergePreview = z.infer<typeof accountMergePreviewSchema>
export type AccountMergeResult = z.infer<typeof accountMergeResultSchema>

export interface AccountMergeChoices {
  readonly keepLogin?: 'source' | 'target'
  readonly keepTelegram?: 'source' | 'target'
  readonly keepEmail?: 'source' | 'target'
  readonly currentSubscriptionId?: string
}

async function getAccountMergePreview(input: {
  readonly userId: string
  readonly ref: string
}): Promise<AccountMergePreview> {
  const response = await api.get(`/admin/users/${encodeURIComponent(input.userId)}/merge-preview`, {
    params: { ref: input.ref },
  })
  return accountMergePreviewSchema.parse(unwrapPayload(response.data))
}

async function mergeAccounts(input: {
  readonly sourceId: string
  readonly targetId: string
  readonly choices: AccountMergeChoices
  readonly confirm: boolean
}): Promise<AccountMergeResult> {
  const response = await api.post('/admin/users/merge', input)
  return accountMergeResultSchema.parse(unwrapPayload(response.data))
}

export const usersApi = {
  searchUser,
  getAccountMergePreview,
  mergeAccounts,
  listUsers,
  listCurrentSubscriptionDevices,
  getAccessDiagnostics,
  getSubscriptionsWorkbench,
  getSelectedSubscriptionWorkbench,
  listSelectedSubscriptionDevices,
  revokeSelectedSubscriptionDevice,
listUserModerationHistory,
getUserRoleReadiness,
  updateUserRole,
getUserCommercialReadiness,
  updateUserCommercialProfile,
  getUserSupportMessageReadiness,
  createUserSupportMessageDraft,
  sendUserSupportMessageDraft,
  getUserWebAccountReadiness,
  getUserWebAccountHistory,
  bootstrapWebAccountCredentials,
  getSelectedSubscriptionRenewalReadiness,
  getSelectedSubscriptionPlanAssignmentReadiness,
  executeSelectedSubscriptionPlanAssignment,
  getSelectedSubscriptionStatusChangeReadiness,
  executeSelectedSubscriptionStatusChange,
  updateSelectedSubscriptionLimits,
  createSelectedSubscriptionMutationRequest,
  listSelectedSubscriptionMutationRequests,
  getSelectedSubscriptionMutationRequestDetail,
  getSelectedSubscriptionMutationPreflight,
  executeSelectedSubscriptionMutationRequest,
  listDeviceProvisioningChallenges,
  issueDeviceProvisioningChallenge,
  revokeDeviceProvisioningChallenge,
  listUserActivityTransactions,
  listUserActivityNotifications,
  revokeCurrentSubscriptionDevice,
  setUserBlockedState,
  acceptRules,
  snoozeWebAccountLinkPrompt,
  issueWebAccountEmailVerificationChallenge,
}
