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
import { expectArray } from '@/lib/api-utils'

// ── Wire types ──────────────────────────────────────────────────────────────

export interface PlanDuration {
  readonly id: string
  readonly days: number
  readonly isActive: boolean
  /**
   * Points a purchase of THIS duration earns when the plan's `cashbackMode`
   * is FIXED — a year and a month may differ. `null` under every other mode,
   * and under FIXED it reads as zero. Optional for the reason `cashbackMode`
   * on `Plan` gives.
   */
  readonly cashbackPoints?: number | null
  readonly prices: ReadonlyArray<{
    readonly id: string
    readonly currency: string
    /**
     * MAJOR units as a DECIMAL STRING, which is what the server actually
     * sends: the column is `Decimal(20, 8)` and `plan-record.util.ts` puts it
     * through `.toString()`. `"199"` is 199 whole units of `currency` — not
     * 199 minor units, and not a `number`.
     *
     * Declared `string` because `fetchPlans` CASTS the response (`expectArray`)
     * and transforms nothing, so `number` here was a claim tsc could never
     * check. It hid a `<` between two strings in the landing preview, where
     * `"100" < "20"` is true and the "cheapest" duration was whichever one
     * sorted first as text.
     *
     * PARSE AT THE POINT OF USE, and decide there what an unparseable price
     * means. No boundary-level default is right for every caller: a free plan
     * and a price this build cannot read are different facts, and
     * `Number(...) || 0` spells them the same.
     */
    readonly price: string
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
  /**
   * Whole gigabytes, or `null` for UNLIMITED.
   *
   * Not a theoretical absence: `plans-admin.normalizers.ts` WRITES `null` for
   * every `DEVICES` and every `UNLIMITED` plan, and the server's own
   * `AdminPlanInterface` has always declared it `number | null`. While this
   * side said `number`, the list page's `gb === 0` unlimited branch was
   * unreachable for exactly the two plan types that ARE unlimited, and every
   * one of their cards printed the literal text `null GB`.
   *
   * `null` and `0` are OPPOSITE encodings and must never be folded together
   * at the boundary: `null` is unlimited, `0` is a cap of zero gigabytes — no
   * traffic at all. `?? 0` turns unlimited into its opposite. WHICH of the two
   * a screen should show is a per-screen decision (the operator list keeps
   * them apart so a legacy zero is visible; the customer-facing card mirrors
   * the cabinet, which folds both into unlimited) — make it in the consumer.
   *
   * `deviceLimit` below is the OPPOSITE convention on purpose: there `<= 0` IS
   * the canonical unlimited, matching the panel's own `hwidDeviceLimit: 0`.
   * Do not harmonise the two.
   */
  readonly trafficLimit: number | null
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
   * How a purchase of this plan earns points. INHERIT follows the global
   * percent from Settings → Points; NONE excludes the plan; PERCENT reads
   * `cashbackPercent`; FIXED reads each duration's `cashbackPoints`.
   *
   * The server sends it on every plan. It is optional here for the reason
   * `trafficLimit` is `number | null` above: `fetchPlans` casts the response
   * and checks nothing, so absence is a state this code CAN see (a response
   * cached before the columns shipped, a panel mid-deploy talking to an API
   * that predates them), and every reader has to decide what it means rather
   * than have tsc pretend it cannot happen. It means INHERIT — the column's
   * own default — and the plan list and the editor both fold it that way.
   */
  readonly cashbackMode?: 'INHERIT' | 'NONE' | 'PERCENT' | 'FIXED'
  /** The plan's own percent, set under PERCENT only; `null` otherwise. */
  readonly cashbackPercent?: number | null
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
    readonly requireTelegramLink: boolean
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
  squadPropagation: (planId: string) =>
    [...plansQueryKeys.all, 'squad-propagation', planId] as const,
}

/**
 * What a plan save set in motion. Editing a plan's squads rewrites every
 * existing subscriber and queues a Remnawave push for each — this is the
 * receipt for that, returned by `PATCH /admin/plans/:id`.
 */
export interface PlanSquadPropagationSummary {
  /** `null` when the save did not change the plan's squads. */
  readonly propagationId: string | null
  readonly subscriptionsUpdated: number
  /**
   * Subscriptions on this plan left on their old squads because they had
   * diverged from the plan's previous set. Deliberate — but the operator has to
   * be told, or a rework that moved nothing looks exactly like one that had
   * nothing to move.
   */
  readonly subscriptionsSkippedDiverged: number
  readonly syncJobsCreated: number
}

/** Live progress of a plan's most recent squad propagation. */
export interface PlanSquadPropagationStatus {
  readonly planId: string
  readonly propagationId: string | null
  readonly queuedAt: string | null
  readonly total: number
  readonly pending: number
  readonly running: number
  readonly failed: number
  readonly completed: number
  readonly isComplete: boolean
}

export interface PlanUpdateResult extends Plan {
  readonly squadPropagation: PlanSquadPropagationSummary
}

// ── Fetcher ─────────────────────────────────────────────────────────────────

export async function fetchPlans(signal?: AbortSignal): Promise<readonly Plan[]> {
  const response = await api.get('/admin/plans', { signal })
  return expectArray<Plan>(response.data)
}

/**
 * Persist a new plan display order (index 0 → shown first in the cabinet).
 * `orderedIds` is the full list of plan ids in the desired order.
 */
export async function reorderPlans(orderedIds: readonly string[]): Promise<readonly Plan[]> {
  const response = await api.patch('/admin/plans/reorder', { orderedIds })
  return expectArray<Plan>(response.data)
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

export async function fetchPlanSquadPropagation(
  planId: string,
  signal?: AbortSignal,
): Promise<PlanSquadPropagationStatus> {
  const response = await api.get<PlanSquadPropagationStatus>(
    `/admin/plans/${planId}/squad-propagation`,
    { signal },
  )
  return response.data
}

/**
 * Follows a squad propagation until it finishes. Polling stops on its own the
 * moment the server reports `isComplete`, so an idle plans page makes no
 * requests — the query is only enabled while a propagation is being watched.
 */
export function usePlanSquadPropagation(
  planId: string | null,
): UseQueryResult<PlanSquadPropagationStatus> {
  return useQuery({
    queryKey: plansQueryKeys.squadPropagation(planId ?? ''),
    queryFn: ({ signal }) => fetchPlanSquadPropagation(planId as string, signal),
    enabled: planId !== null,
    refetchInterval: (query) => (query.state.data?.isComplete === false ? 3_000 : false),
    staleTime: 0,
  })
}
