import { api } from '@/lib/api'

// ── Types ────────────────────────────────────────────────────────────────────

export type WebhookDeliveryStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'RETRYING'

export interface WebhookSubscription {
  id: string
  name: string
  url: string
  /** Plaintext secret — only present in create / regenerate responses. */
  secret: string | null
  eventTypes: readonly string[]
  description: string | null
  isActive: boolean
  createdById: string | null
  lastDeliveredAt: string | null
  consecutiveFailures: number
  totalDeliveries: number
  totalFailures: number
  autoDisabledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WebhookDelivery {
  id: string
  subscriptionId: string
  subscriptionName: string
  eventType: string
  status: WebhookDeliveryStatus
  attempt: number
  httpStatus: number | null
  responseBody: string | null
  errorMessage: string | null
  durationMs: number | null
  nextRetryAt: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface WebhookDeliveryDetail extends WebhookDelivery {
  payload: unknown
}

export interface CreateSubscriptionPayload {
  name: string
  url: string
  eventTypes: string[]
  description?: string
  isActive?: boolean
}

export interface UpdateSubscriptionPayload {
  name?: string
  url?: string
  eventTypes?: string[]
  description?: string
  isActive?: boolean
}

export interface ListDeliveriesQuery {
  subscriptionId?: string
  status?: WebhookDeliveryStatus
  eventType?: string
  cursor?: string
  limit?: number
}

interface SubscriptionsListResponse {
  items: readonly WebhookSubscription[]
  total: number
}

interface DeliveriesListResponse {
  items: readonly WebhookDelivery[]
  nextCursor: string | null
}

interface EventCatalogResponse {
  events: readonly string[]
}

const BASE = '/admin/webhooks'

// ── Catalog ─────────────────────────────────────────────────────────────────

export async function getWebhookEventCatalog(): Promise<readonly string[]> {
  const response = await api.get<EventCatalogResponse>(`${BASE}/event-catalog`)
  return response.data.events
}

// ── Subscriptions ───────────────────────────────────────────────────────────

export async function listWebhookSubscriptions(): Promise<SubscriptionsListResponse> {
  const response = await api.get<SubscriptionsListResponse>(`${BASE}/subscriptions`)
  return response.data
}

export async function getWebhookSubscription(id: string): Promise<WebhookSubscription> {
  const response = await api.get<WebhookSubscription>(`${BASE}/subscriptions/${id}`)
  return response.data
}

export async function createWebhookSubscription(
  payload: CreateSubscriptionPayload,
): Promise<WebhookSubscription> {
  const response = await api.post<WebhookSubscription>(`${BASE}/subscriptions`, payload)
  return response.data
}

export async function updateWebhookSubscription(
  id: string,
  payload: UpdateSubscriptionPayload,
): Promise<WebhookSubscription> {
  const response = await api.patch<WebhookSubscription>(`${BASE}/subscriptions/${id}`, payload)
  return response.data
}

export async function deleteWebhookSubscription(id: string): Promise<void> {
  await api.delete(`${BASE}/subscriptions/${id}`)
}

export async function regenerateWebhookSecret(id: string): Promise<WebhookSubscription> {
  const response = await api.post<WebhookSubscription>(
    `${BASE}/subscriptions/${id}/regenerate-secret`,
  )
  return response.data
}

export async function testWebhookSubscription(
  id: string,
): Promise<{ deliveryId: string }> {
  const response = await api.post<{ deliveryId: string }>(`${BASE}/subscriptions/${id}/test`)
  return response.data
}

// ── Deliveries ─────────────────────────────────────────────────────────────

export async function listWebhookDeliveries(
  query: ListDeliveriesQuery = {},
): Promise<DeliveriesListResponse> {
  const params = new URLSearchParams()
  if (query.subscriptionId) params.set('subscriptionId', query.subscriptionId)
  if (query.status) params.set('status', query.status)
  if (query.eventType) params.set('eventType', query.eventType)
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.limit) params.set('limit', query.limit.toString())
  const qs = params.toString()
  const response = await api.get<DeliveriesListResponse>(
    `${BASE}/deliveries${qs ? `?${qs}` : ''}`,
  )
  return response.data
}

export async function getWebhookDelivery(id: string): Promise<WebhookDeliveryDetail> {
  const response = await api.get<WebhookDeliveryDetail>(`${BASE}/deliveries/${id}`)
  return response.data
}

export async function replayWebhookDelivery(id: string): Promise<{ newDeliveryId: string }> {
  const response = await api.post<{ newDeliveryId: string }>(
    `${BASE}/deliveries/${id}/replay`,
  )
  return response.data
}
