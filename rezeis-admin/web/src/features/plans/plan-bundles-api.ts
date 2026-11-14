/**
 * Plan bundles API: the plans page's «Объединить тарифы» grouping.
 *
 * A bundle is not a product — it has no price and no checkout. It says which
 * plans a customer may hold together and receive ONE merged subscription link
 * for; the admin panel only needs to store and edit that grouping.
 */
import { queryOptions, useQuery, type UseQueryResult } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { expectArray } from '@/lib/api-utils'

// ── Wire types ──────────────────────────────────────────────────────────────

export interface PlanBundle {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly isActive: boolean
  readonly orderIndex: number
  /** Member plan ids, in the plans' own display order. */
  readonly planIds: readonly string[]
  /**
   * The plan row this grouping is issued as («объединённая подписка»), or
   * `null` for a grouping created before the plan existed (saved once, it gets
   * one).
   */
  readonly planId: string | null
  /** Device limit of that plan — ONE number for the whole merged subscription. */
  readonly deviceLimit: number | null
  /**
   * The member plan whose name, traffic and expiry the VPN app shows on the
   * merged link. Always one of `planIds` and never an unlimited plan while a
   * limited member exists: the operator's choice, or the bundle's default (its
   * first limited plan).
   */
  readonly visiblePlanId: string | null
  /**
   * Legacy, always empty: the server still serialises the field, but a grouping
   * links exactly two plans and their two traffic lines are captioned by the
   * bot's own texts, so nothing can carry a caption any more. The panel never
   * sends it and never draws a field for it.
   */
  readonly memberTrafficLabels: readonly { readonly planId: string; readonly label: string }[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PlanBundleInput {
  readonly name: string
  readonly description?: string | null
  readonly isActive?: boolean
  readonly planIds: readonly string[]
  /** `null` clears the choice back to the bundle's default. */
  readonly visiblePlanId?: string | null
  /**
   * Device limit for the merged subscription. Both member profiles get it, and
   * an existing customer holding two of the bundle's plans has both updated.
   */
  readonly deviceLimit?: number
  /**
   * Kept on the wire for older clients only: two plans leave no traffic line to
   * caption, so the server refuses any caption and the panel does not send one.
   */
  readonly memberTrafficLabels?: readonly { readonly planId: string; readonly label: string }[]
}

// ── Query keys ──────────────────────────────────────────────────────────────

/**
 * Under `['admin', 'plan-bundles']`, NOT under the plans key: a bundle edit says
 * nothing about a plan's own row, and invalidating the whole plans list for it
 * would throw away a five-minute cache every time an operator renames a group.
 */
export const planBundlesQueryKeys = {
  all: ['admin', 'plan-bundles'] as const,
  lists: () => [...planBundlesQueryKeys.all, 'list'] as const,
}

// ── Fetchers ────────────────────────────────────────────────────────────────

export async function fetchPlanBundles(signal?: AbortSignal): Promise<readonly PlanBundle[]> {
  const response = await api.get('/admin/plan-bundles', { signal })
  return expectArray<PlanBundle>(response.data)
}

export async function createPlanBundle(input: PlanBundleInput): Promise<PlanBundle> {
  const response = await api.post<PlanBundle>('/admin/plan-bundles', input)
  return response.data
}

export async function updatePlanBundle(
  id: string,
  input: Partial<PlanBundleInput>,
): Promise<PlanBundle> {
  const response = await api.patch<PlanBundle>(`/admin/plan-bundles/${id}`, input)
  return response.data
}

export async function deletePlanBundle(id: string): Promise<void> {
  await api.delete(`/admin/plan-bundles/${id}`)
}

// ── Query options + hook ────────────────────────────────────────────────────

export function planBundlesListOptions() {
  return queryOptions({
    queryKey: planBundlesQueryKeys.lists(),
    queryFn: ({ signal }) => fetchPlanBundles(signal),
    // Groupings change only when an operator edits them, and every mutation
    // here invalidates this key explicitly.
    staleTime: 5 * 60_000,
  })
}

export function usePlanBundles(): UseQueryResult<readonly PlanBundle[]> {
  return useQuery(planBundlesListOptions())
}
