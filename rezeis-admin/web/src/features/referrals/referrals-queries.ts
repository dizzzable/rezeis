import { skipToken, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { referralsAdminApi, type ReferralInvite, type ReferralReward } from '@/features/referrals/referrals-api'
import { api } from '@/lib/api'

/**
 * WHAT THIS FILE IS ALLOWED TO CALL.
 *
 * Every hook below is backed by a handler `AdminReferralsController` actually
 * declares. It did not used to be: five hooks
 * (`useReferralSummaryQuery`, `useReferralQualificationAuditQuery`, the two
 * exchange-policy ones, and `useReferralSnapshotQuery`, which fanned out into
 * three of them) called `/admin/referrals/summary`,
 * `/admin/referrals/qualification-audit` and `/admin/referrals/exchange-policy`
 * — paths the controller has never declared in any spelling. Each would have
 * parsed a 404 body through a schema invented for it, so the first caller to
 * touch one got a zod error out of a route that does not exist.
 *
 * They are DELETED rather than left with a comment. A hook that compiles,
 * type-checks and offers a plausible name is an invitation, and the comment
 * warning against it is only ever read by somebody who already suspects. The
 * fetchers themselves survive in `referrals-api.ts` — that file is where the
 * route census in `referrals-api-wire-contract.test.ts` reads them, and
 * `KNOWN_ABSENT_ROUTES` there is what turns red the day any of the four
 * endpoints is added. That is the right place for the record; this is not.
 *
 * `useReferralSnapshotQuery` went with them for a second reason on top of the
 * dead routes: it collapsed five independent loads into one `isPending`/`error`
 * pair, so a single failing endpoint blanked everything. The user card renders
 * invites and rewards as separately-failing blocks, which is the opposite
 * arrangement and the one the referrals page settled on today.
 */

const referralRouteUserIdSchema = z.object({
  /**
   * CUID, not UUID. `User.id` is `@default(cuid())` (`prisma/schema.prisma`,
   * `model User`), and so is every id this feature passes around —
   * `ReferralInvite.id`, `Referral.id`, `ReferralReward.id`. The
   * `z.string().uuid()` this replaces rejected every real user id, so
   * `readReferralsRouteSelection` answered `isValid: false` for `?userId=` of
   * an actual user and `isValid: true` only for an id no user can have.
   *
   * Length-bounded rather than pattern-matched: cuid1 (`c` + 24 chars) and
   * cuid2 (variable, 24 by default) are both in the database, `z.cuid()`
   * accepts only the former, and this guard exists to keep an empty or
   * obviously-junk query string out of a URL path — not to re-derive the id
   * format.
   */
  userId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
})

export interface ReferralsRouteSelection {
  readonly userId: string | null
  readonly isValid: boolean
}

export function readReferralsRouteSelection(searchParams: URLSearchParams): ReferralsRouteSelection {
  const rawUserId: string | null = searchParams.get('userId')
  if (typeof rawUserId !== 'string') {
    return { userId: null, isValid: true }
  }

  const userId: string = rawUserId.trim()
  if (userId.length === 0) {
    return { userId: null, isValid: true }
  }

  const validation = referralRouteUserIdSchema.safeParse({ userId })
  if (!validation.success) {
    return { userId, isValid: false }
  }

  return {
    userId: validation.data.userId,
    isValid: true,
  }
}

/**
 * `GET /admin/referrals/invite-capacity/:userId` —
 * `ReferralInviteLimitsService.getCapacity`.
 *
 * `totalSlots` and `remainingSlots` are NULLABLE and null means UNLIMITED, not
 * zero: the service returns `{ totalSlots: null, usedSlots: 0, remainingSlots:
 * null, canCreateInvite: true }` for a user who holds the VIP bypass, for a
 * program with slots switched off, and for one with no `initialSlots`
 * configured. Reading either as a number and comparing it to `usedSlots` would
 * lock exactly those users out of the one thing the endpoint says they may do.
 *
 * `canCreateInvite` is therefore the answer, and the two counts are only there
 * to name the limit out loud. It is computed server-side from the per-user
 * override layered over the global limits, which is the arithmetic this client
 * must not re-do.
 */
const referralInviteCapacitySchema = z.object({
  /** Null = unlimited. */
  totalSlots: z.number().nullable(),
  /** Live invites — not every invite ever created. */
  usedSlots: z.number(),
  /** Null = unlimited. */
  remainingSlots: z.number().nullable(),
  canCreateInvite: z.boolean(),
})

export type ReferralInviteCapacity = z.infer<typeof referralInviteCapacitySchema>

async function fetchReferralInviteCapacity(userId: string): Promise<ReferralInviteCapacity> {
  const response = await api.get(`/admin/referrals/invite-capacity/${encodeURIComponent(userId)}`)
  return referralInviteCapacitySchema.parse(response.data)
}

/**
 * The keys the OPERATOR TABLE queries under (`referrals-page.tsx`). Listed as
 * a prefix, deliberately: the page holds `['admin','referrals','invites']`,
 * `[...,'rewards']` and `[...,'stats']`, and a revoke issued from the user card
 * changes all three. Invalidating the prefix reaches whichever of them happens
 * to be mounted and costs nothing when none is.
 *
 * A different root from `referralsQueryKeys.all` (`['referrals']`), so the two
 * cannot invalidate each other by accident.
 */
const ADMIN_REFERRALS_PAGE_KEY = ['admin', 'referrals'] as const

/** A query key belonging to some other feature that shows the same change. */
export type ReferralInvalidationKey = readonly unknown[]

export const referralsQueryKeys = {
  all: ['referrals'] as const,
  detail: (userId: string) => [...referralsQueryKeys.all, 'detail', userId] as const,
  invites: (userId: string) => [...referralsQueryKeys.detail(userId), 'invites'] as const,
  rewards: (userId: string) => [...referralsQueryKeys.detail(userId), 'rewards'] as const,
  capacity: (userId: string) => [...referralsQueryKeys.detail(userId), 'invite-capacity'] as const,
}

/**
 * A non-empty user id, or null.
 *
 * `enabled: userId !== null` was the whole guard, and the empty string is not
 * null. `listInvites('')` sends `GET /admin/referrals/invites?inviterId=` —
 * axios DROPS an empty param, so the request degrades into the UNFILTERED
 * list and the tab renders every invite on the platform as though they
 * belonged to the user on screen. The same for `listRewards('')`. That is a
 * false statement about the operator's data, made confidently, and it is what
 * the `userId ?? ''` fallbacks in the old query functions existed to satisfy:
 * they silenced the type error that was pointing at this.
 */
function activeUserId(userId: string | null): string | null {
  return typeof userId === 'string' && userId.length > 0 ? userId : null
}

/**
 * The idle key of a disabled query.
 *
 * Deliberately NOT under `detail(...)`: there is no user to key it by, and
 * parking it beneath some placeholder id would put it in the path of an
 * invalidation aimed at a real one.
 */
function idleKey(kind: string): readonly unknown[] {
  return [...referralsQueryKeys.all, kind, 'idle']
}

/**
 * `skipToken` rather than `enabled: userId !== null`, in all three readers
 * below.
 *
 * They agree on WHEN the request runs; they disagree on what the compiler is
 * told. With `enabled` the query function still has to be written for a null
 * id, which is where `referralsAdminApi.listInvites(userId ?? '')` came from —
 * a fallback that reads as a default and is really a cast, hiding the empty
 * string described on `activeUserId`. `skipToken` narrows `id` to `string` in
 * the branch that builds the fetcher, so the impossible case has no body to
 * put a wrong value in.
 */
export function useReferralInvitesQuery(userId: string | null) {
  const id = activeUserId(userId)
  return useQuery({
    queryKey: id === null ? idleKey('invites') : referralsQueryKeys.invites(id),
    queryFn: id === null ? skipToken : () => referralsAdminApi.listInvites(id),
  })
}

export function useReferralRewardsQuery(userId: string | null) {
  const id = activeUserId(userId)
  return useQuery({
    queryKey: id === null ? idleKey('rewards') : referralsQueryKeys.rewards(id),
    queryFn: id === null ? skipToken : () => referralsAdminApi.listRewards(id),
  })
}

export function useReferralInviteCapacityQuery(userId: string | null) {
  const id = activeUserId(userId)
  return useQuery({
    queryKey: id === null ? idleKey('invite-capacity') : referralsQueryKeys.capacity(id),
    queryFn: id === null ? skipToken : () => fetchReferralInviteCapacity(id),
  })
}

/**
 * Everything one invite write changes.
 *
 * `summary(userId)` used to be in here and nothing ever queried it — the
 * summary hook was the only reader and its route did not exist, so the
 * invalidation was addressed to a key that could never be in the cache.
 * `capacity(userId)` is what actually belonged there: a created invite
 * occupies a slot and a revoked one gives it back, so the remaining count on
 * screen is stale the instant either lands.
 */
async function invalidateInviteWrites(
  queryClient: QueryClient,
  userId: string,
  alsoInvalidate: readonly ReferralInvalidationKey[],
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: referralsQueryKeys.invites(userId) }),
    queryClient.invalidateQueries({ queryKey: referralsQueryKeys.capacity(userId) }),
    queryClient.invalidateQueries({ queryKey: ADMIN_REFERRALS_PAGE_KEY }),
    ...alsoInvalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  ])
}

export function useCreateReferralInviteMutation(
  userId: string | null,
  alsoInvalidate: readonly ReferralInvalidationKey[] = [],
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (): Promise<ReferralInvite> => {
      const id = activeUserId(userId)
      if (id === null) {
        throw new Error('No user selected')
      }
      /**
       * No `expiresInDays`. An ABSENT field takes the server's own default
       * window in `resolveInviteExpiry`; the value this panel would otherwise
       * have to invent is the per-user link TTL, which the server already
       * layers on by itself. `ttlHours`, the parameter this helper used to
       * take, was never a field on `CreateReferralInviteDto` at all and the
       * API runs `forbidNonWhitelisted`, so every call it could make was a 400.
       */
      return referralsAdminApi.createInvite(id)
    },
    onSuccess: async (): Promise<void> => {
      const id = activeUserId(userId)
      if (id === null) {
        return
      }
      await invalidateInviteWrites(queryClient, id, alsoInvalidate)
    },
  })
}

export function useRevokeReferralInviteMutation(
  userId: string | null,
  alsoInvalidate: readonly ReferralInvalidationKey[] = [],
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (inviteId: string): Promise<ReferralInvite> => referralsAdminApi.revokeInvite(inviteId),
    onSuccess: async (): Promise<void> => {
      const id = activeUserId(userId)
      if (id === null) {
        return
      }
      await invalidateInviteWrites(queryClient, id, alsoInvalidate)
    },
  })
}

/**
 * Issuing a reward is the one write here whose effect is visible OUTSIDE the
 * referrals feature: `AdminRewardsService.issue` applies the reward, so a
 * POINTS reward moves `User.points` and an EXTRA_DAYS reward moves a
 * subscription expiry — both of them fields the user card paints from
 * `GET /admin/users/:telegramId`. That query lives under a different root
 * (`['admin','users',telegramId]`) and no referrals key reaches it, which is
 * why the caller passes it in.
 */
export function useIssueReferralRewardMutation(
  userId: string | null,
  alsoInvalidate: readonly ReferralInvalidationKey[] = [],
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (rewardId: string): Promise<ReferralReward> => referralsAdminApi.issueReward(rewardId),
    onSuccess: async (): Promise<void> => {
      const id = activeUserId(userId)
      if (id === null) {
        return
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: referralsQueryKeys.rewards(id) }),
        queryClient.invalidateQueries({ queryKey: ADMIN_REFERRALS_PAGE_KEY }),
        ...alsoInvalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ])
    },
  })
}
