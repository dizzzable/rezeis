import { z } from 'zod'
import { api } from '@/lib/api'

import { REFERRAL_INVITE_SOURCES, REFERRAL_PAYOUT_BLOCKERS } from './referrals-icons'

/** `GET /admin/referrals` sends at most this many edges. */
const REFERRALS_LIST_LIMIT = 200

/** `GET /admin/referrals/invites` sends at most this many rows to the tab. */
const INVITES_LIST_LIMIT = 200

/** `GET /admin/referrals/rewards` sends at most this many rows to the tab. */
const REWARDS_LIST_LIMIT = 200

const referralUserSummarySchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  name: z.string().nullable(),
  /**
   * Required, and required is the whole point.
   *
   * `name` and `username` are BOTH null for a web sign-up (`WebAuthService`
   * stores `{ name: '', email }`), which is why the panel printed an em dash
   * for referrers that are perfectly real. The server resolves the full chain
   * - name -> username -> webAccount.login -> email -> webAccount.email -> TG
   * id -> id - and guarantees a non-empty string for a user that exists.
   */
  displayName: z.string(),
  /** Nested here, and only here. There has never been a sibling top-level id. */
  telegramId: z.string().nullable(),
  createdAt: z.string(),
})

/**
 * `GET /admin/referrals` - ONE ROW PER EARNER, not one per database row.
 *
 * A sign-up has at most two people who get paid for it and only the first is a
 * table row: `Referral.referredId` is unique, so a user has exactly one
 * referrer, ever. The second-level earner is derived by walking one step up,
 * and the server derives it here the same way the payout engine does at
 * payout time - which is why this list can carry two rows with the same
 * `referred` and different `level`, and why the page must not count rows when
 * it means sign-ups.
 *
 * The asymmetry between the two, which the fields below encode:
 *
 *   level 1 is a fact about the GRAPH. The row is sent whether or not money
 *   moves, because the relationship is real; when money will not move it says
 *   so through `payoutBlockedBy`.
 *
 *   level 2 is a fact about MONEY. Nothing in the database corresponds to it,
 *   so the server sends one only when the payout will actually happen - and a
 *   level-2 row therefore always carries `payoutBlockedBy: null`.
 *
 * So a MISSING level-2 row is not a claim that no ancestor exists. It is a
 * claim that no level-2 payout happens.
 */
const referralListItemSchema = z.object({
  /** `derived:L2:<level-1 id>` on a derived row; a cuid on a real one. */
  id: z.string(),
  /** The person who EARNS at `level` - the grandparent on a level-2 row. */
  referrer: referralUserSummarySchema,
  referred: referralUserSummarySchema,
  /** The level this row is PAID at. 3 appears only in imported data. */
  level: z.number(),
  inviteSource: z.enum(REFERRAL_INVITE_SOURCES),
  qualifiedAt: z.string().nullable(),
  createdAt: z.string(),
  /**
   * Why the referral programme pays this row nothing, or null when it pays.
   *
   * `.nullable()` and NOT `.optional()`: null is the answer that carries a
   * promise ("the engine will create this reward"), and an absent key would
   * be an older server whose rows cannot make that promise at all. Parsing
   * those as "will be paid" is exactly the false statement about the
   * operator money that this schema exists to refuse.
   */
  payoutBlockedBy: z.enum(REFERRAL_PAYOUT_BLOCKERS).nullable(),
})

/** Both envelopes this endpoint has used: a bare list, and `{ items }`. */
const referralListSchema = z.union([
  z.array(referralListItemSchema),
  z.object({ items: z.array(referralListItemSchema) }),
])

/**
 * `GET /admin/referrals/invites` — `ReferralInviteInterface`, in full.
 *
 * `inviter` is REQUIRED and NESTED, exactly as the server declares it:
 * `ReferralInvite.inviter` is a NOT NULL relation and `mapReferralInvite`
 * maps it on every row. The hand-written row type this replaces made it
 * optional and read a sibling `inviterTelegramId` that has never been sent,
 * so the inviter’s telegram line was blank on every row of the tab.
 *
 * `referralInviteSchema` further down is an ALIAS of this one, not a second
 * shape. `?inviterId=` adds nothing but `where.inviterId` to the same query
 * and the rows still leave through the same `mapReferralInvite`
 * (`referrals.service.ts:89-114` and `:341`), so "the same table seen through
 * `?inviterId=` for a single user" was always exactly this shape. The claim
 * that it was not is what licensed the second, wrong spelling.
 */
const adminReferralInviteSchema = z.object({
  id: z.string(),
  token: z.string(),
  inviter: referralUserSummarySchema,
  note: z.string().nullable(),
  /** Null means "no expiry" — the tab prints ∞ for it, not a date. */
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  consumedAt: z.string().nullable(),
  createdAt: z.string(),
})

/**
 * A bare list, and ONLY a bare list — deliberately narrower than
 * `referralListSchema` above.
 *
 * That union exists because `GET /admin/referrals` has genuinely answered
 * with both envelopes. This route has not: the controller returns
 * `Promise<readonly ReferralInviteInterface[]>` and nothing wraps it. The
 * `{ items }` half of the page’s old `unwrap()` helper was speculation, not
 * history, and accepting a shape this endpoint never sends is not free — an
 * `{ items: [] }` from some other handler would render as "No invites yet",
 * which is the false statement about the operator’s own data that this
 * validation exists to prevent.
 */
const adminReferralInviteListSchema = z.array(adminReferralInviteSchema)

/**
 * `GET /admin/referrals/rewards` — `AdminReferralRewardInterface`.
 *
 * `userTelegramId` is a REAL top-level field here, and the only one in this
 * feature that is: `mapReward` emits it next to the nested `user`. It is
 * parsed as sent, not "corrected" into a nested read the way
 * `referrerTelegramId` and `inviterTelegramId` — which the server has never
 * sent — had to be.
 *
 * `type` stays a `string` rather than an enum of the two members Prisma has
 * today, because `getRewardTypeMeta` already answers for an unknown type
 * with a neutral badge. Pinning the enum would trade one unfamiliar icon for
 * a rewards tab that refuses to load.
 */
const adminReferralRewardSchema = z.object({
  id: z.string(),
  referralId: z.string(),
  user: referralUserSummarySchema,
  userTelegramId: z.string().nullable(),
  type: z.string(),
  amount: z.number(),
  isIssued: z.boolean(),
  issuedAt: z.string().nullable(),
  issuedBy: z.string().nullable(),
  createdAt: z.string(),
})

/**
 * `{ items, total }`, exactly — and `total` is NOT optional.
 *
 * `AdminRewardsService.list` composes this envelope in one place and takes
 * `total` from an unconditional `prisma.count()`, so every response the
 * handler produces carries it, and nothing reshapes the body on either side
 * (the panel’s axios instance has a single response interceptor and it only
 * handles 401). A bare array, or an `{ items }` with no `total`, therefore
 * did not come from this endpoint — precisely the payload that has to reach
 * the tab as a failure rather than as an empty table.
 *
 * `total` is parsed and then dropped. Nothing in the tab paints a total, and
 * a return shape invented to carry one would be worse than saying so: it is
 * here as the envelope’s witness, not as data.
 */
const adminReferralRewardsListSchema = z.object({
  items: z.array(adminReferralRewardSchema),
  total: z.number(),
})

/**
 * NO SUCH ROUTE. `GET /admin/referrals/summary` does not exist.
 *
 * `AdminReferralsController` declares twenty handlers and this is not one of
 * them (`../src/modules/referrals/controllers/admin-referrals.controller.ts`,
 * lines 79-287). The only `summary` handlers in the whole backend are
 * `admin-dashboard.controller.ts:30` and the reiwa-facing
 * `internal-referrals.controller.ts:36` - a different path, a different guard
 * and a different shape (`{ totalReferrals, qualifiedReferrals, pointsBalance,
 * programAvailable, referralCode, admissionRequiresInvite }`). So this schema
 * validates a 404 body, and every field below is a guess.
 *
 * The guess is left EXACTLY as written rather than replaced with a better
 * guess: there is no wire shape to check it against, and a second invented
 * shape would be indistinguishable from a fact once it shipped. What has to
 * be decided here is the ROUTE, not the schema. `DECLARED_ROUTES` in
 * `referrals-api-wire-contract.test.ts` fails the moment somebody adds this
 * endpoint, which is the moment this schema must be written against it.
 */
const referralSummarySchema = z.object({
  userId: z.string(),
  referralCode: z.string(),
  referralPointsBalance: z.number(),
  activeInvitesCount: z.number(),
  totalReferrals: z.number(),
  qualifiedReferrals: z.number(),
  issuedRewardsCount: z.number(),
  pendingRewardsCount: z.number(),
  totalRewardAmount: z.number(),
})

/**
 * AN ALIAS of `adminReferralInviteSchema`, deliberately - not a fourth
 * spelling of the same eight fields.
 *
 * WHAT WAS WRONG. It required a top-level `inviterId: string` and a
 * NON-NULLABLE `expiresAt: string`, and declared neither `inviter`, `note`
 * nor `consumedAt`. `mapReferralInvite`
 * (`../src/modules/referrals/services/referrals.service.ts:341`) sends no
 * `inviterId` at all - the inviter arrives NESTED, as `inviter` - and sends
 * `expiresAt` as `record.expiresAt?.toISOString() ?? null`, null being the
 * permanent invite `resolveInviteExpiry` mints from an explicit
 * `expiresAt: null` (`referrals.service.ts:245-252`).
 * `ReferralInviteInterface`
 * (`../src/modules/referrals/interfaces/referral.interface.ts:49-58`) is the
 * declaration of record and says the same.
 *
 * A missing REQUIRED key is a ZodError, so this never degraded - it threw on
 * the first row of every response, for every operator, on every call, and had
 * done so since it was written. Nothing noticed because nothing calls it; see
 * the reachability inventory in `referrals-api-wire-contract.test.ts`.
 *
 * One route, one mapper, therefore one schema: `?inviterId=` narrows `where`
 * and changes nothing else.
 */
const referralInviteSchema = adminReferralInviteSchema

/**
 * `POST /admin/referrals/invites` answers `{ invite }`, not a bare invite.
 *
 * `CreateReferralInviteResultInterface`
 * (`../src/modules/referrals/interfaces/referral.interface.ts:78-80`) has
 * exactly one member and `ReferralsService.createInvite` returns
 * `{ invite: mapReferralInvite(created) }` (`referrals.service.ts:166`), so
 * parsing the body AS the invite failed on required `id` no matter how right
 * the invite schema was. Unwrapped here rather than handed back whole, the
 * same way `listAdminRewards` unwraps `{ items, total }`: the caller asked
 * for an invite.
 */
const createReferralInviteResultSchema = z.object({ invite: referralInviteSchema })

/**
 * AN ALIAS of `adminReferralRewardSchema` - see `referralInviteSchema` above
 * for why an alias rather than a fifth spelling.
 *
 * WHAT WAS WRONG. A required top-level `userId` that `mapReward`
 * (`../src/modules/referrals/services/admin-rewards.service.ts:299-312`) has
 * never emitted: the user arrives NESTED as `user`, with a top-level
 * `userTelegramId` beside it. `issuedAt` and `issuedBy` were missing too.
 * The one required key was enough to make every parse throw.
 *
 * `?userId=` is a genuine filter (`ListRewardsQueryDto.userId`,
 * `../src/modules/referrals/dto/list-rewards-query.dto.ts:16`) applied as
 * `where.userId` in `AdminRewardsService.list` (`admin-rewards.service.ts:73`).
 * It narrows the rows. It does not reshape them, and - the second half of this
 * defect - it does not unwrap the envelope either; see `listRewards`.
 */
const referralRewardSchema = adminReferralRewardSchema

/**
 * `POST /admin/referrals/rewards/:rewardId/issue` answers with the REWARD.
 *
 * `AdminRewardsService.issue` ends in `return mapReward(updated)`
 * (`../src/modules/referrals/services/admin-rewards.service.ts:191`) and the
 * handler is typed `Promise<AdminReferralRewardInterface>`
 * (`admin-referrals.controller.ts:160-165`). There is no `status` and no
 * `reason` anywhere on that path.
 *
 * The `z.enum(['ISSUED', 'BLOCKED'])` this replaces was not a drifted field,
 * it was an invented protocol. The two outcomes it imagined are, on the real
 * endpoint, a 200 carrying the reward and a THROWN 4xx carrying a Nest error
 * body: an already-issued reward comes back unchanged and still 200
 * (`admin-rewards.service.ts:153-155`), a revoked one raises
 * `'Cannot issue a revoked reward'` (`:150-152`), and an EXTRA_DAYS reward for
 * a user with no finite subscription raises from `applyRewardEffect`
 * (`:433-438`). None of those bodies ever reaches this schema. `reason` exists
 * nowhere in the module but `revoke`'s `revokeReason` column, which
 * `mapReward` does not map.
 *
 * The name survives only because it is exported; the shape is the reward's.
 */
const referralRewardIssueSchema = referralRewardSchema

/**
 * NO SUCH ROUTE. `GET /admin/referrals/qualification-audit` does not exist -
 * the string appears nowhere in the backend, in any spelling. See the note on
 * `referralSummarySchema`: the fields below are a guess, kept as written and
 * labelled as a guess, and what has to be decided is the route.
 */
const referralQualificationAuditSchema = z.object({
  action: z.string(),
  referredUserId: z.string().nullable(),
  transactionId: z.string().nullable(),
  purchaseChannel: z.string().nullable(),
  qualifiedReferralCount: z.number().nullable(),
  rewardsIssuedCount: z.number().nullable(),
  totalRewardAmount: z.number().nullable(),
  createdAt: z.string(),
})

/**
 * NO SUCH ROUTE, twice over: neither `GET` nor
 * `POST /admin/referrals/exchange-policy` exists. Points exchange lives on the
 * reiwa-facing internal controller (`internal-referrals.controller.ts:191-225`,
 * `exchange/options` and `exchange`) behind a different guard, under a
 * different path prefix, with a different shape (`ExchangeOptionsResponse`),
 * and nothing admin-side reads or writes a policy at all. See the note on
 * `referralSummarySchema`.
 */
const referralExchangePolicySchema = z.object({ exchangeEnabled: z.boolean(), giftPromocodeEnabled: z.boolean(), allowedPlanIds: z.array(z.string()), allowedDurationDays: z.array(z.number()), codePrefix: z.string(), costPerDay: z.number() })

export type ReferralUserSummary = z.infer<typeof referralUserSummarySchema>
export type ReferralListItem = z.infer<typeof referralListItemSchema>
export type AdminReferralInvite = z.infer<typeof adminReferralInviteSchema>
export type AdminReferralReward = z.infer<typeof adminReferralRewardSchema>
export type ReferralSummary = z.infer<typeof referralSummarySchema>
export type ReferralInvite = z.infer<typeof referralInviteSchema>
export type ReferralReward = z.infer<typeof referralRewardSchema>
export type ReferralRewardIssue = z.infer<typeof referralRewardIssueSchema>
export type ReferralQualificationAudit = z.infer<typeof referralQualificationAuditSchema>
export type ReferralExchangePolicy = z.infer<typeof referralExchangePolicySchema>

export const referralsAdminApi = {
  /**
   * GET /admin/referrals - the operator table's own list.
   *
   * There was no fetcher for it at all: `referrals-page.tsx` called `api.get`
   * inline and cast the result, so its row type could declare `level: number`
   * and `referrerTelegramId` - fields this endpoint has NEVER sent - and
   * nothing objected. The panel rendered a bare `L`, an em dash for the source
   * and an empty telegram id on every row for as long as that shipped. Parsed
   * here so the next drift of that kind is a failing test, not a blank column.
   */
  async listReferrals(limit: number = REFERRALS_LIST_LIMIT): Promise<readonly ReferralListItem[]> {
    const response = await api.get('/admin/referrals', { params: { limit } })
    const parsed = referralListSchema.parse(response.data)
    return Array.isArray(parsed) ? parsed : parsed.items
  },

  /**
   * GET /admin/referrals/invites - the operator table’s invite list.
   *
   * Named `listAdminInvites` and not `listInvites` because that name is
   * already taken on this object by the per-user `?inviterId=` fetcher,
   * which answers a different question with a different row shape - the
   * same reason `listAdminRewards` below is not `listRewards`.
   *
   * The tab used to call `api.get` inline and cast the result to a
   * hand-written row type through a local `unwrap()` helper that proved the
   * value was an array and, in its own words, nothing about what was inside
   * it. That is how it came to read a top-level `inviterTelegramId`.
   */
  async listAdminInvites(limit: number = INVITES_LIST_LIMIT): Promise<readonly AdminReferralInvite[]> {
    const response = await api.get('/admin/referrals/invites', { params: { limit } })
    return adminReferralInviteListSchema.parse(response.data)
  },

  /**
   * GET /admin/referrals/rewards - the operator table’s reward list.
   *
   * Returns the rows. See `adminReferralRewardsListSchema` for why the
   * envelope must be `{ items, total }` and why `total` is checked but not
   * handed back.
   */
  async listAdminRewards(limit: number = REWARDS_LIST_LIMIT): Promise<readonly AdminReferralReward[]> {
    const response = await api.get('/admin/referrals/rewards', { params: { limit } })
    return adminReferralRewardsListSchema.parse(response.data).items
  },

  /** NO SUCH ROUTE - 404 before any schema matters. See `referralSummarySchema`. */
  async getSummary(userId: string): Promise<ReferralSummary> {
    const response = await api.get('/admin/referrals/summary', { params: { userId } })
    return referralSummarySchema.parse(response.data)
  },

  /**
   * GET /admin/referrals/invites?inviterId= - the same route and the same
   * rows as `listAdminInvites`, narrowed to one inviter.
   *
   * `ReferralsService.listInvites` puts `query.inviterId` straight into
   * `where` and maps the result with `mapReferralInvite`
   * (`referrals.service.ts:89-114`), so this reuses that route's list schema
   * instead of keeping a private one - which is how the two drifted apart.
   */
  async listInvites(inviterId: string): Promise<readonly ReferralInvite[]> {
    const response = await api.get('/admin/referrals/invites', { params: { inviterId } })
    return adminReferralInviteListSchema.parse(response.data)
  },

  /**
   * POST /admin/referrals/invites.
   *
   * `expiresInDays`, not `ttlHours`. The server DTO
   * (`CreateReferralInviteDto`) has no `ttlHours` field and never had one, and
   * the API runs with `forbidNonWhitelisted: true`, so every call this helper
   * could make was rejected 400 `["property ttlHours should not exist"]`.
   *
   * Renamed rather than converted: the server stores day granularity
   * (`@IsInt() @Min(1) @Max(365)`, applied via `addDays`), so an hours
   * parameter cannot round-trip — anything under 24h has no representation at
   * all, and rounding e.g. 6h up to one day silently quadruples how long the
   * invite lives. The parameter states the unit the server can actually
   * honour instead of hiding a lossy conversion inside the client.
   *
   * Omitted when undefined, never sent as `null`: an ABSENT field falls back
   * to the server's default TTL, but `null` passes `@IsOptional()` and then
   * reaches `addDays(new Date(), null)` in `resolveInviteExpiry`, which
   * returns the reference date unchanged — an invite already expired at the
   * moment it was created.
   */
  async createInvite(inviterId: string, expiresInDays?: number): Promise<ReferralInvite> {
    const response = await api.post('/admin/referrals/invites', {
      inviterId,
      ...(expiresInDays === undefined ? {} : { expiresInDays }),
    })
    return createReferralInviteResultSchema.parse(response.data).invite
  },

  /**
   * POST /admin/referrals/invites/:id/revoke - the controller's own explicit
   * alias of `DELETE /invites/:inviteId` (`admin-referrals.controller.ts:126`),
   * so the POST is deliberate rather than a mistake. Both forms return a bare
   * `ReferralInviteInterface` from `ReferralsService.revokeInvite`
   * (`referrals.service.ts:185`) - no envelope, unlike `createInvite`.
   */
  async revokeInvite(inviteId: string): Promise<ReferralInvite> {
    const response = await api.post(`/admin/referrals/invites/${inviteId}/revoke`)
    return referralInviteSchema.parse(response.data)
  },

  /**
   * GET /admin/referrals/rewards?userId= - the same route, the same envelope
   * and the same rows as `listAdminRewards`, narrowed to one user.
   *
   * `AdminRewardsService.list` composes `{ items, total }` in ONE place
   * (`admin-rewards.service.ts:93-96`) for every query it accepts; a filter
   * does not unwrap it. Parsing this body as a bare array therefore failed on
   * every call, before the row schema was ever consulted.
   */
  async listRewards(userId: string): Promise<readonly ReferralReward[]> {
    const response = await api.get('/admin/referrals/rewards', { params: { userId } })
    return adminReferralRewardsListSchema.parse(response.data).items
  },

  /** Answers with the reward itself - see `referralRewardIssueSchema`. */
  async issueReward(rewardId: string): Promise<ReferralRewardIssue> {
    const response = await api.post(`/admin/referrals/rewards/${rewardId}/issue`)
    return referralRewardIssueSchema.parse(response.data)
  },

  /** NO SUCH ROUTE - 404. See `referralQualificationAuditSchema`. */
  async listQualificationAudit(userId: string): Promise<ReferralQualificationAudit[]> {
    const response = await api.get('/admin/referrals/qualification-audit', { params: { userId } })
    return z.array(referralQualificationAuditSchema).parse(response.data)
  },

  /** NO SUCH ROUTE - 404. See `referralExchangePolicySchema`. */
  async getExchangePolicy(): Promise<ReferralExchangePolicy> {
    const response = await api.get('/admin/referrals/exchange-policy')
    return referralExchangePolicySchema.parse(response.data)
  },

  /** NO SUCH ROUTE - 404. See `referralExchangePolicySchema`. */
  async updateExchangePolicy(input: Partial<ReferralExchangePolicy>): Promise<ReferralExchangePolicy> {
    const response = await api.post('/admin/referrals/exchange-policy', input)
    return referralExchangePolicySchema.parse(response.data)
  },
}
