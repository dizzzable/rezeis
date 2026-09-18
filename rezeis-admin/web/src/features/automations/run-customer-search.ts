import { api } from '@/lib/api'

/**
 * run-customer-search
 * ───────────────────
 * The customer a test run of a rule is about, found by what the operator
 * remembers of them — the same list the Users page reads (`GET /admin/users`,
 * `users:view`), eight rows at a time.
 *
 * The row is the subset `features/support-tickets/user-picker-dialog.tsx` reads
 * too. The id sent onwards is always `User.id`, never the Telegram id: the run
 * names its customer by `triggerData.userId`, which is the panel's own id.
 */
export interface RunCustomer {
  readonly id: string
  readonly telegramId: string | null
  readonly username: string | null
  readonly email: string | null
  readonly name: string | null
  readonly login: string | null
  readonly isBlocked: boolean
}

export const RUN_CUSTOMER_LIMIT = 8

/**
 * What an operator typed, as the users list matches it.
 *
 * WITHOUT THE LEADING "@". An operator copies a customer's handle as it is
 * shown everywhere — `@ivan` — and the list matches `username` by `contains`
 * on the bare `ivan` it stores, so "@ivan" found nobody at all.
 */
export function customerSearchTerm(raw: string): string {
  return raw.trim().replace(/^@+/, '').trim()
}

export async function searchCustomers(search: string, signal?: AbortSignal): Promise<RunCustomer[]> {
  const response = await api.get<{ items?: RunCustomer[] }>('/admin/users', {
    params: { search: customerSearchTerm(search), limit: RUN_CUSTOMER_LIMIT },
    signal,
  })
  return Array.isArray(response.data?.items) ? response.data.items : []
}

/** What to call a customer, preferring what an operator recognises. */
export function customerName(customer: RunCustomer): string {
  if (customer.name && customer.name.trim().length > 0) return customer.name
  if (customer.username) return `@${customer.username}`
  if (customer.login) return customer.login
  if (customer.email) return customer.email
  return customer.telegramId ?? customer.id
}

/** The rest of what identifies them, so two similar names stay apart. */
export function customerDetail(customer: RunCustomer): string {
  const name = customerName(customer)
  const parts: string[] = []
  if (customer.username && name !== `@${customer.username}`) parts.push(`@${customer.username}`)
  if (customer.login && name !== customer.login) parts.push(customer.login)
  if (customer.email && name !== customer.email) parts.push(customer.email)
  if (customer.telegramId && name !== customer.telegramId) parts.push(customer.telegramId)
  return parts.length > 0 ? parts.join(' · ') : customer.id
}
