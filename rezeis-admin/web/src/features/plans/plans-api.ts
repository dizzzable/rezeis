/**
 * Plans API: single source of truth for the `/admin/plans` endpoint.
 *
 * Why this file exists
 * ────────────────────
 * Before this refactor, eight call sites used the bare `['admin','plans']`
 * query key with five different fetcher shapes:
 *
 *   - plans-page                — full Plan[]
 *   - plan-form                 — `{id,name,isActive,isArchived}[]` for the picker
 *   - promocode-form            — full Plan[] (used as `enabled: rewardType==='SUBSCRIPTION'`)
 *   - imports-page              — `PlanOption[]` (transformed)
 *   - add-ons-page              — `PlanListItem[]` (subset)
 *   - user-detail-panel  ×2     — `Plan[]` cast as `any[]`
 *   - user-detail-page          — filtered `Plan[]` (only `isActive`)
 *
 * TanStack Query caches by reference equality on the query key, so all
 * eight subscriptions resolved to the same cache slot. The first
 * fetcher to mount won; subsequent components rendered with a shape
 * that disagreed with their type. Filters (`isActive`) silently leaked
 * across pages.
 *
 * The fix is the documented Query Options API + Query Key Factory
 * pattern recommended by TanStack maintainers (TkDodo). One canonical
 * fetcher per endpoint, parameterised cache key, type-safe re-use via
 * `queryOptions(...)`.
 *
 * References
 *   - https://tanstack.com/query/latest/docs/framework/angular/guides/query-options
 *   - https://tanstack.com/query/latest/docs/eslint/prefer-query-options
 *   - https://tkdodo.eu/blog/the-query-options-api
 */
import { queryOptions, useQuery, type UseQueryResult } from '@tanstack/react-query'

import { api } from '@/lib/api'

// ── Wire types ──────────────────────────────────────────────────────────────

export interface PlanDuration {
  readonly id: string
  readonly days: number
  readonly isActive: boolean
  readonly prices: ReadonlyArray<{
    readonly id: string
    readonly currency: string
    readonly price: number
  }>
}

export interface Plan {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly tag: string | null
  readonly icon: string | null
  readonly type: string
  readonly availability: string
  readonly trafficLimit: number
  readonly deviceLimit: number
  readonly trafficLimitStrategy: string
  readonly isActive: boolean
  readonly isArchived: boolean
  readonly orderIndex: number
  readonly internalSquads: ReadonlyArray<string>
  readonly externalSquad: string | null
  readonly durations: ReadonlyArray<PlanDuration>
  readonly replacementPlanIds: ReadonlyArray<string>
  readonly upgradeToPlanIds: ReadonlyArray<string>
  /**
   * Per-plan allow-list when `availability === 'ALLOWED'`. Only present
   * on plans that opt into the explicit-grants flow; absent for the
   * public catalog.
   */
  readonly allowedUserIds?: ReadonlyArray<string>
  /**
   * Trial-plan tunables, present only when `availability === 'TRIAL'`.
   */
  readonly trialSettings?: {
    readonly maxClaims: number
    readonly free: boolean
    readonly availabilityScope: 'ALL' | 'INVITED'
  }
}

export interface PlansListFilters {
  /**
   * When set, the consumer wants only plans matching this active flag.
   * Filtering happens client-side after a single network fetch — the
   * `/admin/plans` endpoint always returns the full list.
   */
  readonly active?: boolean
}

// ── Query Key Factory ───────────────────────────────────────────────────────

export const plansQueryKeys = {
  all: ['admin', 'plans'] as const,
  lists: () => [...plansQueryKeys.all, 'list'] as const,
  list: (filters: PlansListFilters | undefined) =>
    [...plansQueryKeys.lists(), filters ?? {}] as const,
}

// ── Fetcher ─────────────────────────────────────────────────────────────────

async function fetchPlans(signal?: AbortSignal): Promise<readonly Plan[]> {
  const response = await api.get<Plan[]>('/admin/plans', { signal })
  return response.data
}

// ── queryOptions builder ────────────────────────────────────────────────────

export function plansListOptions(filters?: PlansListFilters) {
  return queryOptions({
    queryKey: plansQueryKeys.list(filters),
    queryFn: ({ signal }) => fetchPlans(signal),
    // Plans rarely change — five-minute window is operator-friendly while
    // still letting an explicit invalidate refresh the catalog.
    staleTime: 5 * 60_000,
    select: (plans: readonly Plan[]): readonly Plan[] => {
      if (filters?.active === undefined) return plans
      return plans.filter((plan) => plan.isActive === filters.active)
    },
  })
}

// ── Hook ────────────────────────────────────────────────────────────────────

/**
 * Read the plan catalog. Pass `{ active: true }` to filter to active
 * plans (server still returns everything; filtering happens via
 * TanStack Query's `select` so the cache stays single-shape).
 *
 * `enabled` lets callers gate the fetch behind UI state — e.g. a form
 * that only needs the catalog when the user picks "subscription reward".
 */
export function usePlans(
  filters?: PlansListFilters,
  options?: { readonly enabled?: boolean },
): UseQueryResult<readonly Plan[]> {
  return useQuery({
    ...plansListOptions(filters),
    enabled: options?.enabled,
  })
}
