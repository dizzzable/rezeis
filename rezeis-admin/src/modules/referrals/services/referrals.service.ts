import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CreateReferralInviteDto } from '../dto/create-referral-invite.dto';
import {
  ListReferralInvitesQueryDto,
  ListReferralsQueryDto,
} from '../dto/list-referrals-query.dto';
import {
  CreateReferralInviteResultInterface,
  ReferralInterface,
  ReferralInviteInterface,
  ReferralPayoutBlockerValue,
  ReferralStatsInterface,
  ReferralUserSummaryInterface,
} from '../interfaces/referral.interface';
import { ReferralInviteLimitsService } from './referral-invite-limits.service';
import {
  ReferralSettingsJson,
  normalizeReferralSettings,
} from './referral-qualification.service';
import { buildReferralUserDisplayName } from './referral-user-identity';

/**
 * The columns needed to NAME a user, not merely to identify one.
 *
 * `email` and the `webAccount` join earn their place: a web sign-up row has
 * `name: ''`, no `username` and no `telegramId` (see `WebAuthService`), so the
 * four columns this used to select left such a referrer with nothing printable
 * at all and the panel showed a dash for a valid referral edge. The join is on
 * `WebAccount.userId`, which is unique, so it is one row per user.
 */
const REFERRAL_USER_SUMMARY_SELECT = {
  id: true,
  username: true,
  name: true,
  telegramId: true,
  email: true,
  webAccount: { select: { login: true, email: true } },
  createdAt: true,
} as const;

type UserSummaryRecord = Prisma.UserGetPayload<{
  select: typeof REFERRAL_USER_SUMMARY_SELECT;
}>;

const REFERRAL_INCLUDE = {
  referrer: { select: REFERRAL_USER_SUMMARY_SELECT },
  referred: { select: REFERRAL_USER_SUMMARY_SELECT },
} as const;

type ReferralRecord = Prisma.ReferralGetPayload<{ include: typeof REFERRAL_INCLUDE }>;

const REFERRAL_INVITE_INCLUDE = {
  inviter: { select: REFERRAL_USER_SUMMARY_SELECT },
} as const;

type ReferralInviteRecord = Prisma.ReferralInviteGetPayload<{
  include: typeof REFERRAL_INVITE_INCLUDE;
}>;

const INVITE_TOKEN_BYTES = 18;

/**
 * THE INVITE-QUOTA REFUSAL, AS ONE SPELLING.
 *
 * The operator configures a per-user invite quota and
 * `ReferralInviteLimitsService.getCapacity` is the only thing that computes
 * whether it is spent. Until now only the bot / subscriber path asked it:
 * `InternalReferralsController.createInvite` calls `validateCanCreateInvite`
 * (which is `getCapacity` plus a throw) before minting. The ADMIN route
 * `POST /admin/referrals/invites` asked nothing at all, so an over-quota
 * invite created from the panel - or by anything holding an admin token -
 * succeeded and handed out a slot the operator's own configuration says does
 * not exist.
 *
 * The gate now lives on {@link ReferralsService.createInvite} rather than on
 * the admin controller, because `prismaService.referralInvite.create` has
 * exactly ONE caller and that is it. Guarding the write site makes the quota an
 * invariant of the TABLE; guarding a route makes it an invariant of that route
 * only, and the next route to be added would not inherit it.
 *
 * ── WHY A PRODUCT CODE AND NOT JUST A SENTENCE ───────────────────────────────
 *
 * `AdminSafeExceptionFilter` forwards a `code` only when it is listed in
 * `SAFE_PRODUCT_CODES`, and the panel SPA can do exactly one thing with an
 * untyped 400: print `response.data.message`. That is how a Russian-language
 * panel ends up showing an English sentence - the defect the `PLAN_*` codes
 * were added for earlier today, and the same remedy applies here.
 *
 * The label is the one already embedded in the limits service's own message
 * (`'INVITE_SLOT_LIMIT_REACHED: ...'`), so both throw sites spell the refusal
 * the same way; no other reader existed anywhere in the workspace, so nothing
 * had to be migrated. Restated as a literal in the filter's allowlist rather
 * than imported from here - an allowlist that imports the set it gates admits
 * every future member automatically, which is not an allowlist.
 *
 * ── THE MESSAGE CARRIES NOTHING INTERPOLATED ─────────────────────────────────
 *
 * Deliberately a fixed literal. The filter scrubs any message that trips its
 * sensitive-text patterns, and two of those (`[0-9a-f]{24,}` and the uuid
 * shape) match values this refusal would otherwise be tempted to name - the
 * inviter's cuid above all. An interpolated id would not weaken the message,
 * it would DELETE it and leave 'Request failed' in its place. The exact slot
 * counts are on screen already: the panel holds them from
 * `GET /admin/referrals/invite-capacity/:userId`.
 */
export const INVITE_SLOT_LIMIT_REACHED_CODE = 'INVITE_SLOT_LIMIT_REACHED';

/** @see INVITE_SLOT_LIMIT_REACHED_CODE */
export const INVITE_SLOT_LIMIT_REACHED_MESSAGE =
  'No invite slots remain for this user. Raise their invite limit on the Invites tab, or revoke a live invite to free one.';

/**
 * The grandparent lookup needs only the ancestor's printable identity and the
 * key it was looked up by - never the whole edge. `referred` on this edge is
 * the level-1 referrer, whose summary the caller already holds.
 */
const GRANDPARENT_EDGE_SELECT = {
  referredId: true,
  referrerId: true,
  referrer: { select: REFERRAL_USER_SUMMARY_SELECT },
} as const;

type GrandparentEdgeRecord = Prisma.ReferralGetPayload<{
  select: typeof GRANDPARENT_EDGE_SELECT;
}>;

/**
 * Marks an id this service COMPUTED rather than read from a table.
 *
 * `:` cannot appear in a cuid (`[a-z0-9]` only), so a derived id can never
 * collide with a `Referral.id` - and any handler that is later pointed at one
 * of these fails on lookup instead of acting on an unrelated row that happened
 * to share the string. It reads as derived at a glance, which is the other
 * half of the job: the next person to add a row action must SEE that this row
 * has nothing to act on.
 *
 * Stability comes from what it is built out of. `Referral.referredId` is
 * `@unique`, so the level-1 referrer has at most one referrer of their own and
 * a registration therefore yields at most ONE level-2 row - which makes the
 * level-1 row's id a complete key for it. Same registration, same string,
 * every request; React keys stay put across refetches.
 */
export const DERIVED_LEVEL_2_ID_PREFIX = 'derived:L2:';

export function deriveLevel2RowId(level1ReferralId: string): string {
  return `${DERIVED_LEVEL_2_ID_PREFIX}${level1ReferralId}`;
}

@Injectable()
export class ReferralsService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly inviteLimitsService: ReferralInviteLimitsService,
  ) {}

  /**
   * The referral table: one row per PERSON WHO GETS PAID for a registration,
   * at the level they get paid at - see {@link ReferralInterface}.
   *
   * `limit` and `offset` page the REGISTRATIONS, not the returned rows, so a
   * page of `limit` registrations can carry up to `2 * limit` rows. Paging the
   * rows instead would make `offset` step over a number of registrations that
   * depends on the data inside the page, and consecutive pages would overlap
   * or drop edges. A caller that needs a row budget should halve `limit`.
   *
   * `referrerId` keeps its exact previous meaning: rows whose EARNER is that
   * user. For a level-1 row that is the `referrer_id` column, which is what
   * the `where` clause below already selects; for a derived level-2 row it is
   * the grandparent, who by construction is not the user the column matched.
   * So the filter returns precisely the set it always returned - the
   * postcondition at the bottom of this method states that as code rather than
   * leaving it to be inferred. What it deliberately does NOT do is enumerate
   * the level-2 rows that user earns: those hang off registrations they do not
   * appear on as a column, and reaching them needs a downward walk this
   * endpoint does not do. A silently-widened filter would be worse.
   *
   * `referredId` needs no such care and gains the interesting case: a derived
   * row describes the SAME registration, so `?referredId=X` answers "everyone
   * who earns from X signing up" - up to two rows. `qualified` likewise: a
   * derived row shares its parent's `qualifiedAt`.
   *
   * QUERY COUNT: four, flat in the number of rows. One page of registrations,
   * one settings read, one batched grandparent lookup keyed by
   * `referredId IN (...)` - the same unique column `createConfiguredRewards`
   * walks, one row at a time - and one batched active-partner lookup covering
   * both levels' earners at once. The lookups are skipped, not repeated, when
   * their input set is empty.
   */
  public async listReferrals(
    query: ListReferralsQueryDto,
  ): Promise<readonly ReferralInterface[]> {
    const where: Prisma.ReferralWhereInput = {
      referrerId: query.referrerId,
      referredId: query.referredId,
    };
    if (query.qualified === 'true') {
      where.qualifiedAt = { not: null };
    }
    if (query.qualified === 'false') {
      where.qualifiedAt = null;
    }
    const referrals = await this.prismaService.referral.findMany({
      where,
      include: REFERRAL_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit ?? 100,
      skip: query.offset ?? 0,
    });

    // Read ONCE, and through the engine's own normaliser. The operator form
    // persists `level2Reward` while older installs hold `reward.config.SECOND`;
    // a second reader of that JSON would eventually disagree with
    // `createConfiguredRewards` about whether level 2 is configured at all.
    const settingsRow = await this.prismaService.settings.findFirst({
      select: { referralSettings: true },
    });
    const settings = normalizeReferralSettings(settingsRow?.referralSettings);
    const level1Pays = levelPays(settings, 'FIRST');
    const level2Pays = levelPays(settings, 'SECOND');

    const referrerIds = [...new Set(referrals.map((referral) => referral.referrerId))];

    // GATE ONE, and the only place it is spelled: level 2 unconfigured means
    // `createConfiguredRewards` returns before the walk, so there is no such
    // payout and no row describing one. Leaving the map empty here is what
    // enforces that below - there is no second condition to keep in step.
    const grandparentEdges =
      level2Pays && referrerIds.length > 0
        ? await this.prismaService.referral.findMany({
            where: { referredId: { in: referrerIds } },
            select: GRANDPARENT_EDGE_SELECT,
          })
        : [];
    const grandparentByReferredId = new Map<string, GrandparentEdgeRecord>(
      grandparentEdges.map((edge) => [edge.referredId, edge]),
    );

    // Both levels' earners in ONE query. `createConfiguredRewards` asks
    // `partner.findUnique(...).isActive === true` per person; asking for the
    // active ones by id set is the same question asked once.
    const partnerCandidateIds = [
      ...new Set([...referrerIds, ...grandparentEdges.map((edge) => edge.referrerId)]),
    ];
    const activePartners =
      partnerCandidateIds.length > 0
        ? await this.prismaService.partner.findMany({
            where: { userId: { in: partnerCandidateIds }, isActive: true },
            select: { userId: true },
          })
        : [];
    const activePartnerIds = new Set(activePartners.map((partner) => partner.userId));

    const rows: ReferralInterface[] = [];
    for (const referral of referrals) {
      const referrerIsActivePartner = activePartnerIds.has(referral.referrerId);
      rows.push(
        mapReferral(
          referral,
          resolveLevel1Blocker({ referrerIsActivePartner, level1Pays }),
        ),
      );

      // An active partner at level 1 stops the engine DEAD: it returns 0
      // before reading `SECOND` at all, so the grandparent is never paid
      // either. Emitting a level-2 row here would invent the one payout this
      // branch most reliably prevents.
      if (referrerIsActivePartner) continue;
      const grandparentEdge = grandparentByReferredId.get(referral.referrerId);
      // No ancestor: the walk finds no edge and stops. Not a defect - most
      // referrers were never referred by anyone.
      if (grandparentEdge === undefined) continue;
      // GATE TWO: the grandparent is an active partner, so the engine skips
      // them and the partner engine pays them instead.
      if (activePartnerIds.has(grandparentEdge.referrerId)) continue;
      rows.push(deriveLevel2Row(referral, grandparentEdge));
    }

    // The postcondition, as code: every row this filter returns is a row that
    // user EARNS. Only a derived row can fail it, and only in a graph that
    // loops back on itself.
    if (query.referrerId !== undefined) {
      return rows.filter((row) => row.referrer.id === query.referrerId);
    }
    return rows;
  }

  public async listInvites(
    query: ListReferralInvitesQueryDto,
  ): Promise<readonly ReferralInviteInterface[]> {
    const where: Prisma.ReferralInviteWhereInput = {
      inviterId: query.inviterId,
    };
    if (query.consumed === 'true') {
      where.consumedAt = { not: null };
    }
    if (query.consumed === 'false') {
      where.consumedAt = null;
    }
    if (query.revoked === 'true') {
      where.revokedAt = { not: null };
    }
    if (query.revoked === 'false') {
      where.revokedAt = null;
    }
    const invites = await this.prismaService.referralInvite.findMany({
      where,
      include: REFERRAL_INVITE_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit ?? 100,
      skip: query.offset ?? 0,
    });
    return invites.map(mapReferralInvite);
  }

  /**
   * The user's current share invite, if they still have a usable one: not
   * revoked, not yet consumed, and not expired. Returned to callers that want a
   * stable share link (the bot's invite hub) instead of minting a new token —
   * and therefore burning a slot — on every view. Newest first, so a user who
   * accumulated several keeps sharing the most recent one.
   */
  public async findReusableInvite(inviterId: string): Promise<ReferralInviteInterface | null> {
    const invite = await this.prismaService.referralInvite.findFirst({
      where: {
        inviterId,
        revokedAt: null,
        consumedAt: null,
        // Skip operator-issued invites: those carry a `note` and are handed out
        // deliberately (targeted / VIP). Reusing one as the user's public share
        // link would leak the operator's note and spend a purpose-made invite.
        note: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      // Tie-break on id: two invites can share a millisecond, and an
      // undetermined winner would make the share link flip between calls —
      // exactly the instability this reuse exists to remove.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: REFERRAL_INVITE_INCLUDE,
    });
    return invite === null ? null : mapReferralInvite(invite);
  }

  public async createInvite(
    input: CreateReferralInviteDto,
  ): Promise<CreateReferralInviteResultInterface> {
    const inviter = await this.prismaService.user.findUnique({
      where: { id: input.inviterId },
      select: { id: true },
    });
    if (inviter === null) {
      throw new NotFoundException('Inviter user not found');
    }
    // The quota gate - see {@link INVITE_SLOT_LIMIT_REACHED_CODE}. Placed after
    // the existence check so a bad id still answers 404 rather than 400, and
    // before BOTH the expiry resolution and the create, so a refusal leaves no
    // `ReferralInvite` row behind.
    //
    // UNLIMITED IS `canCreateInvite`, NEVER A NUMBER. `getCapacity` answers the
    // VIP bypass (and a disabled/absent slot config) with
    // `{ totalSlots: null, remainingSlots: null, canCreateInvite: true }`, where
    // `null` means unlimited. Reading either count as a number - `?? 0`,
    // `Number(...)`, `> 0` - turns "no limit applies" into "no slots left" and
    // locks out exactly the users the bypass exists for. This branch therefore
    // reads the boolean the limits service already decided and nothing else;
    // the two counts are for display.
    const capacity = await this.inviteLimitsService.getCapacity(input.inviterId);
    if (!capacity.canCreateInvite) {
      throw new BadRequestException({
        code: INVITE_SLOT_LIMIT_REACHED_CODE,
        message: INVITE_SLOT_LIMIT_REACHED_MESSAGE,
      });
    }
    // THE INVITE TTL, AS ONE SPELLING - see {@link resolveExplicitInviteExpiry}.
    //
    // The operator configures an invite lifetime (`inviteLimits.linkTtlEnabled`
    // / `linkTtlSeconds`, overridable per user, and waived outright by
    // `bypassInviteGate`), and `ReferralInviteLimitsService.resolveInviteExpiry`
    // is the only thing that turns that configuration into a date. Until now
    // only the bot / cabinet path asked it: `InternalReferralsController`
    // resolved the expiry itself and passed the answer in. The ADMIN route
    // `POST /admin/referrals/invites` arrives here with no expiry field at all -
    // neither panel surface sends one - and fell through to a hardcoded 30-day
    // window. So an operator who switched link expiry OFF still got 30-day links
    // from the panel, and a VIP holding the bypass got a permanent link from the
    // bot and a 30-day one from the panel: same setting, two products.
    //
    // Resolved HERE, at the write site, for the same reason the quota gate above
    // is: `prismaService.referralInvite.create` has exactly one caller and this
    // is it, so the operator's setting becomes an invariant of the TABLE rather
    // than of whichever route remembered to ask. The bot path is untouched and
    // pays no extra query - it arrives with an explicit `expiresAt`, which takes
    // the explicit branch and never reaches the limits service twice.
    //
    // ── WHY THE TTL AND NOT THE OTHER TWO ────────────────────────────────────
    //
    // The admin route deliberately skips `findReusableInvite` and the
    // invited-only gate, and that MUST stay true. Those are eligibility rules
    // about the USER - "this person already holds a live share link", "this
    // person was not themselves invited" - and overruling them is the entire
    // point of an operator route: the panel hands out targeted and VIP invites
    // that no user-facing rule would allow.
    //
    // The TTL is not a rule about the user. It is a SETTING - the operator's own
    // answer to "how long should an invite live" - so a route that ignores it is
    // not overriding a rule, it is ignoring its own configuration, which no
    // operator asked for and no screen shows. An operator who wants a different
    // lifetime for one invite still says so, with `expiresInDays` / `expiresAt`
    // below; what changed is only what happens when they say NOTHING. Do not
    // "converge" the other two onto this site.
    const explicitExpiry = resolveExplicitInviteExpiry(input);
    const expiresAt =
      explicitExpiry === undefined
        ? await this.inviteLimitsService.resolveInviteExpiry(input.inviterId)
        : explicitExpiry;
    const token = createInviteToken();
    const created = await this.prismaService.referralInvite.create({
      data: {
        inviterId: input.inviterId,
        token,
        note: input.note ?? null,
        expiresAt,
      },
      include: REFERRAL_INVITE_INCLUDE,
    });
    return { invite: mapReferralInvite(created) };
  }

  public async revokeInvite(inviteId: string): Promise<ReferralInviteInterface> {
    const existing = await this.prismaService.referralInvite.findUnique({
      where: { id: inviteId },
      select: { id: true, revokedAt: true, consumedAt: true },
    });
    if (existing === null) {
      throw new NotFoundException('Referral invite not found');
    }
    const now = new Date();
    const updated = await this.prismaService.referralInvite.update({
      where: { id: inviteId },
      data: {
        revokedAt: existing.revokedAt ?? now,
      },
      include: REFERRAL_INVITE_INCLUDE,
    });
    return mapReferralInvite(updated);
  }

  public async getStats(): Promise<ReferralStatsInterface> {
    const now = new Date();
    const [
      totalReferrals,
      qualifiedReferrals,
      activeInvites,
      consumedInvites,
      totalInvites,
      totalRewards,
      issuedRewards,
    ] = await Promise.all([
      this.prismaService.referral.count(),
      this.prismaService.referral.count({
        where: { qualifiedAt: { not: null } },
      }),
      this.prismaService.referralInvite.count({
        where: {
          revokedAt: null,
          consumedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      }),
      this.prismaService.referralInvite.count({
        where: { consumedAt: { not: null } },
      }),
      this.prismaService.referralInvite.count(),
      this.prismaService.referralReward.count(),
      this.prismaService.referralReward.count({ where: { isIssued: true } }),
    ]);
    return {
      totalReferrals,
      qualifiedReferrals,
      activeInvites,
      consumedInvites,
      generatedAt: now.toISOString(),
      // SPA-aligned aliases
      referrals: totalReferrals,
      invites: totalInvites,
      rewards: totalRewards,
      issuedRewards,
    };
  }
}

/**
 * The expiry THE REQUEST asked for, or `undefined` when it asked for none.
 *
 * ── WHY THIS IS NO LONGER CALLED `resolveInviteExpiry` ───────────────────────
 *
 * It was, and `ReferralInviteLimitsService` has a method of that name too. Two
 * functions, one name, different rules: the limits service's method reads the
 * operator's configuration (per-user override, the `linkTtlEnabled` switch,
 * `bypassInviteGate` => never expires), while this one knew nothing about any
 * of it and ended in a hardcoded 30-day window. Which of the two answered
 * depended on which ROUTE the request came in through - and that is exactly how
 * the panel and the bot came to mint different invites from one setting.
 *
 * The names now say what each decides, and there is only one of each:
 *   - THIS function - what the request explicitly asked for, and nothing else.
 *     It reads no configuration and has no default.
 *   - `ReferralInviteLimitsService.resolveInviteExpiry` - what the OPERATOR
 *     configured. The only place that answer is computed, for every route.
 * `createInvite` composes them, in that order.
 *
 * ── THE THREE ANSWERS ────────────────────────────────────────────────────────
 *
 *   `null`      - the request said "never expires", explicitly.
 *   a `Date`    - the request named an instant (`expiresAt`) or a window
 *                 (`expiresInDays`).
 *   `undefined` - the request said nothing, so the operator's configuration
 *                 decides. NOT the same as "no expiry": that is `null` above,
 *                 and collapsing the two is the confusion this split exists to
 *                 make impossible.
 *
 * Every branch that does return a date has to return one that MEANS something,
 * because nothing downstream re-checks it: `createInvite` writes the result
 * straight to `ReferralInvite.expiresAt`, and the live-invite filters only ever
 * ask `expiresAt: null OR gt: now`. A bad date does not fail - it produces a
 * silently dead or silently immortal invite.
 *
 * The guards below are deliberately NOT a duplicate of the DTO. The admin HTTP
 * route validates through the global pipe, but
 * `InternalReferralsController.createInvite` builds this input in TypeScript
 * and never meets a pipe at all - so the DTO decorators are simply absent on
 * that path. These checks are what actually holds for both callers.
 */
function resolveExplicitInviteExpiry(
  input: CreateReferralInviteDto,
): Date | null | undefined {
  // Explicit `null` = never expires. Distinct from an absent field, which
  // defers to the operator's configuration instead - the `undefined` at the
  // bottom. This is the ONLY spelling of "permanent" in a REQUEST, and it is
  // load-bearing: the bot route passes it when link-TTL is disabled or the
  // inviter holds the VIP bypass.
  if (input.expiresAt === null) {
    return null;
  }
  if (input.expiresAt !== undefined) {
    const explicitExpiry = new Date(input.expiresAt);
    if (Number.isNaN(explicitExpiry.getTime())) {
      // `new Date('nonsense')` is an Invalid Date, not a throw. Left alone it
      // reaches Prisma as one.
      throw new BadRequestException('expiresAt must be a valid ISO-8601 timestamp');
    }
    // `@IsISO8601()` validates FORMAT, not sanity, so a past timestamp used to
    // arrive here intact and mint an invite that was dead the moment it
    // existed - the same silent product as the `null` TTL below.
    //
    // Refused on the service's own clock, matching how
    // `AntiFraudService.createExemption` guards its own `expiresAt`
    // ('Exemption expiry must be in the future'). Strict `>` for the same
    // reason it uses one: "expires in a second" is a valid if useless invite,
    // whereas "expired already" cannot be anything but a mistake, and a grace
    // window would only be a second policy for the two paths to disagree over.
    //
    // Service-side and not DTO-side because the internal bot route builds its
    // input in TypeScript and never meets the ValidationPipe - a DTO check
    // would guard the admin route only.
    //
    // This guard was held back until it could not fire on a working install.
    // The bot route arrives here with `now + linkTtlSeconds`, and that value
    // is now floored at `MIN_LINK_TTL_SECONDS` in BOTH places it can come
    // from - the per-user DTO and the global JSON reader, which clamps stored
    // values on read - so the margin is a minute against sub-second latency
    // rather than the zero (or negative) it used to be. Nothing else supplies
    // an expiry: the `explicitExpiresAt` parameter on the limits service has
    // no caller that passes it, and `referralInvite.create` has exactly one
    // caller, `createInvite` just below.
    if (explicitExpiry.getTime() <= Date.now()) {
      throw new BadRequestException('expiresAt must be in the future');
    }
    return explicitExpiry;
  }
  if (input.expiresInDays !== undefined) {
    // `null` used to land here: it clears `!== undefined`, and
    // `addDays(new Date(), null)` returns the reference date UNCHANGED - an
    // invite already expired at the instant it was created, with no error
    // raised anywhere. Refused rather than reinterpreted as "no expiry",
    // because that already has a spelling above and quietly minting a
    // permanent invite from a malformed TTL is the worse failure.
    if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1) {
      throw new BadRequestException(
        'expiresInDays must be a positive whole number of days',
      );
    }
    const relativeExpiry = addDays(new Date(), input.expiresInDays);
    if (Number.isNaN(relativeExpiry.getTime())) {
      // A large enough integer walks Date past its representable range and
      // comes back Invalid rather than throwing.
      throw new BadRequestException('expiresInDays is out of range');
    }
    return relativeExpiry;
  }
  // Nothing was asked for, so this function has nothing to say and says so.
  // The operator's configuration decides instead - see the composition in
  // `createInvite`. What stood here was
  // `addDays(new Date(), DEFAULT_INVITE_TTL_DAYS)`: a 30-day window no operator
  // surface could change, which silently overruled a `linkTtlEnabled: false`
  // install and the VIP bypass alike on every route that did not pre-resolve
  // its own expiry - which was the admin one, i.e. both panel surfaces.
  return undefined;
}

function addDays(reference: Date, days: number): Date {
  const result = new Date(reference);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function createInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
}

/**
 * Would `createConfiguredRewards` create a reward at this level, ignoring who
 * the earner is?
 *
 * The three ways it can answer no, in the order that method meets them: the
 * operator kill-switch (`qualifyReferralAfterPurchase` returns before calling
 * it at all when `enabled === false`), no `reward` block (`if (!input.reward)
 * return 0`), and a zero amount (`if (firstAmount > 0)` / `if (secondAmount
 * <= 0) return created`). `enabled` is checked for an explicit `false` only -
 * an absent flag leaves an existing install enabled, exactly as the engine
 * treats it.
 */
function levelPays(settings: ReferralSettingsJson, level: 'FIRST' | 'SECOND'): boolean {
  if (settings.enabled === false) return false;
  if (settings.reward === undefined) return false;
  return (settings.reward.config[level] ?? 0) > 0;
}

/**
 * The level-1 row is kept whatever the answer - it is a database row and a
 * real relationship - so the reason it will not pay has to travel WITH it.
 *
 * Partner status is reported ahead of a missing reward because it is the more
 * specific fact and the one that survives a configuration change: switch the
 * level-1 amount back on and this referrer is still skipped.
 */
function resolveLevel1Blocker(input: {
  readonly referrerIsActivePartner: boolean;
  readonly level1Pays: boolean;
}): ReferralPayoutBlockerValue | null {
  if (input.referrerIsActivePartner) return 'PARTNER_PROGRAMME';
  if (!input.level1Pays) return 'REWARD_NOT_CONFIGURED';
  return null;
}

/**
 * The level-2 payout row for one registration.
 *
 * `referred`, `inviteSource`, `qualifiedAt` and `createdAt` come from the
 * registration because that is what this row is ABOUT - the same event, seen
 * by the person one step further up. Only `referrer` and `level` differ from
 * the level-1 row beside it.
 *
 * `payoutBlockedBy` is `null` and not a parameter: every branch that would
 * block this payout is a branch on which the row is not created at all.
 */
function deriveLevel2Row(
  registration: ReferralRecord,
  grandparentEdge: GrandparentEdgeRecord,
): ReferralInterface {
  return {
    id: deriveLevel2RowId(registration.id),
    referrer: mapUserSummary(grandparentEdge.referrer),
    referred: mapUserSummary(registration.referred),
    level: 2,
    inviteSource: registration.inviteSource,
    qualifiedAt: registration.qualifiedAt?.toISOString() ?? null,
    createdAt: registration.createdAt.toISOString(),
    payoutBlockedBy: null,
  };
}

function mapReferral(
  record: ReferralRecord,
  payoutBlockedBy: ReferralPayoutBlockerValue | null,
): ReferralInterface {
  return {
    id: record.id,
    referrer: mapUserSummary(record.referrer),
    referred: mapUserSummary(record.referred),
    // Both of these were already FETCHED by `REFERRAL_INCLUDE` and then
    // dropped on the floor here, which is why the panel rendered the level
    // badge as a bare "L" and the source cell as a dash on every row.
    level: record.level,
    // Narrowed to `ReferralInviteSourceValue` at this boundary on purpose: the
    // column's Prisma type is the whole enum, so a fourth member added to
    // `ReferralInviteSource` makes THIS LINE stop compiling instead of quietly
    // shipping a token the SPA cannot render.
    inviteSource: record.inviteSource,
    qualifiedAt: record.qualifiedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    // Passed in rather than read here: it depends on the partner lookup and
    // the settings read, both of which are batched once per REQUEST. Deriving
    // it inside the mapper is exactly the shape that would turn into an N+1.
    payoutBlockedBy,
  };
}

function mapReferralInvite(record: ReferralInviteRecord): ReferralInviteInterface {
  return {
    id: record.id,
    token: record.token,
    inviter: mapUserSummary(record.inviter),
    note: record.note,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    consumedAt: record.consumedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

function mapUserSummary(record: UserSummaryRecord): ReferralUserSummaryInterface {
  return {
    id: record.id,
    username: record.username,
    name: record.name === '' ? null : record.name,
    // `name` and `username` stay exactly as they were - narrow, honest,
    // nullable. `displayName` is the field the panel prints, and it is the
    // only one guaranteed to be non-empty for a user that exists.
    displayName: buildReferralUserDisplayName(record),
    telegramId: record.telegramId?.toString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}
