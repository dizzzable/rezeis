import { Injectable, Optional, NotFoundException } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { DeviceIntelligenceService } from '../../device-intelligence/services/device-intelligence.service';
import { parseTelegramId } from '../../../common/utils/postgres-bigint.util';
import { InternalUserService } from '../../internal-user/services/internal-user.service';
import { AdminUserListQueryDto } from '../dto/admin-user-list-query.dto';
import { AdminUserResolveQueryDto } from '../dto/admin-user-resolve-query.dto';
import { AdminUserSearchQueryDto } from '../dto/admin-user-search-query.dto';
import {
  AdminUserListItemInterface,
  AdminUserListResultInterface,
} from '../interfaces/admin-user-list-item.interface';
import { AdminUserResolveResultInterface } from '../interfaces/admin-user-resolve-result.interface';
import { AdminUserSearchResultInterface } from '../interfaces/admin-user-search-result.interface';

/** Matches a CUID-shaped reiwa user id (Prisma default `cuid()`). */
const CUID_PATTERN = /^c[a-z0-9]{20,}$/i;

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_LIST_OFFSET = 0;

/**
 * Aggregates admin user reads — single-user search delegated to the
 * internal-user service, plus a paginated list optimized for the
 * left-rail picker on the admin Users page.
 */
@Injectable()
export class AdminUsersService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly internalUserService: InternalUserService,
    /**
     * Optional so every existing construction of this service keeps working.
     * Absent, the badge column reads zero for everybody — the list still
     * renders, which is the right failure for a decoration on a screen
     * operators need up whatever else is broken.
     */
    @Optional() private readonly deviceIntelligenceService?: DeviceIntelligenceService,
  ) {}

  /**
   * Returns the aggregated search payload for a single resolved user.
   */
  public async searchUser(
    query: AdminUserSearchQueryDto,
  ): Promise<AdminUserSearchResultInterface> {
    return this.internalUserService.getSearchResult(query);
  }

  /**
   * Resolves a free-text identifier — reiwa_id (CUID), Telegram ID, web login,
   * email, or exact subscription CUID (owner of that sub, including DELETED) —
   * to a single canonical reiwa user for the plan "Allowed users" picker.
   * Throws `NotFoundException` when nothing matches so the admin UI can
   * surface a clear "user not found" toast.
   */
  public async resolveUser(
    query: AdminUserResolveQueryDto,
  ): Promise<AdminUserResolveResultInterface> {
    const identifier = query.identifier.trim();
    const user = await this.findUserByIdentifier(identifier);

    if (!user) {
      throw new NotFoundException('User not found for the given identifier');
    }

    return { id: user.id, label: buildUserResolveLabel(user) };
  }

  /**
   * Looks a user up by the most specific identifier shape first (reiwa id →
   * Telegram id → login → email), falling back through the cheaper unique
   * lookups. Returns `null` when no branch matches.
   */
  private async findUserByIdentifier(
    identifier: string,
  ): Promise<ResolvedUserRow | null> {
    const where = buildResolveWhere(identifier);
    if (where === null) {
      return null;
    }

    return this.prismaService.user.findFirst({
      where,
      select: RESOLVE_USER_SELECT,
    });
  }

  /**
   * Returns a paginated, lightweight list of users for the admin list view.
   */
  public async listUsers(
    query: AdminUserListQueryDto,
  ): Promise<AdminUserListResultInterface> {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const offset = query.offset ?? DEFAULT_LIST_OFFSET;
    const where = buildUserListWhere(query);

    const [rows, total] = await this.prismaService.$transaction([
      this.prismaService.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
        select: {
          id: true,
          telegramId: true,
          username: true,
          email: true,
          name: true,
          role: true,
          language: true,
          isBlocked: true,
          createdAt: true,
          updatedAt: true,
          lastSeenAt: true,
          webAccount: { select: { login: true } },
        },
      }),
      this.prismaService.user.count({ where }),
    ]);

    // ONE query for the whole page, after the page is known. A relation
    // count inside the `findMany` above would put a correlated subquery on
    // the busiest admin screen there is, and a per-row lookup would be one
    // round-trip per row. This is a single grouped read over fifty ids.
    const flagCounts =
      (await this.deviceIntelligenceService?.openFlagCounts(rows.map((r) => r.id))) ??
      new Map<string, number>();

    const items: AdminUserListItemInterface[] = rows.map((user) => ({
      id: user.id,
      telegramId: user.telegramId === null ? null : user.telegramId.toString(),
      username: user.username,
      email: user.email,
      name: user.name,
      login: user.webAccount?.login ?? null,
      role: user.role,
      language: user.language,
      isBlocked: user.isBlocked,
      openReviewFlags: flagCounts.get(user.id) ?? 0,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    }));

    return { items, total };
  }
}

/**
 * Builds the `User.findMany` where clause for the admin list endpoint.
 *
 * The search fragment is matched case-insensitively against the obvious
 * lookup columns and the linked `WebAccount.login`. A numeric fragment adds a
 * `telegramId` branch only when Postgres `int8` could hold it — a longer digit
 * string (an invoice number, a payment reference) is not a Telegram id and,
 * bound anyway, would fail the query with `22003 numeric field value out of
 * range` and take the whole list endpoint down with it. Dropping the branch is
 * not a narrowing: no row's `telegramId` can equal a value the column cannot
 * store, so the clause could never have matched.
 */
function buildUserListWhere(query: AdminUserListQueryDto): Prisma.UserWhereInput {
  // Every filter is an AND term; a multi-value filter is an OR within its own
  // term. Collected in a list rather than merged into one object because two
  // filters can both want `subscriptions.some` and the second would silently
  // replace the first.
  const and: Prisma.UserWhereInput[] = [];

  const searchTerm = buildSearchTerm(query.search);
  if (searchTerm !== null) and.push(searchTerm);

  // ── Subscription filters ────────────────────────────────────────────
  //
  // DELETED rows are excluded from every one of them. A deleted subscription
  // is not a subscription the customer has, and counting it would put people
  // who cancelled months ago in a filter for "customers on Standard".
  const liveSubscription: Prisma.SubscriptionWhereInput = {
    status: { not: SubscriptionStatus.DELETED },
  };

  if (query.planIds !== undefined && query.planIds.length > 0) {
    // The plan lives in the purchase-time snapshot, not in a column: there is
    // no `plan_id` on `subscriptions`. That makes this a JSON path read and
    // therefore unindexed — acceptable on a paged admin screen, and the only
    // way to ask the question at all without a schema change.
    and.push({
      subscriptions: {
        some: {
          ...liveSubscription,
          OR: query.planIds.map((planId) => ({
            planSnapshot: { path: ['id'], equals: planId },
          })),
        },
      },
    });
  }

  // `!== undefined` and NOT `length > 0`, for all three enum-backed filters.
  //
  // The DTO now returns an EMPTY array for "the caller named members, none of
  // which exist" — `?roles=SUPERADMIN` — and `undefined` only for "no filter at
  // all". A `length > 0` guard collapses those back together and returns every
  // user for a filter the page's badge is still counting as applied.
  // `in: []` is the honest answer: no rows.
  if (query.subscriptionStatuses !== undefined) {
    // Not filtered by `liveSubscription`: an operator who explicitly asks for
    // DELETED means it.
    and.push({ subscriptions: { some: { status: { in: query.subscriptionStatuses } } } });
  }

  if (query.isTrial !== undefined) {
    and.push(
      query.isTrial
        ? { subscriptions: { some: { ...liveSubscription, isTrial: true } } }
        : { subscriptions: { none: { ...liveSubscription, isTrial: true } } },
    );
  }

  if (query.hasSubscription !== undefined) {
    and.push(
      query.hasSubscription
        ? { subscriptions: { some: liveSubscription } }
        : { subscriptions: { none: liveSubscription } },
    );
  }

  // ── Account filters ─────────────────────────────────────────────────
  if (query.roles !== undefined) {
    and.push({ role: { in: query.roles } });
  }
  if (query.languages !== undefined) {
    and.push({ language: { in: query.languages } });
  }
  if (query.isBlocked !== undefined) {
    and.push({ isBlocked: query.isBlocked });
  }
  if (query.hasTelegram !== undefined) {
    and.push(query.hasTelegram ? { telegramId: { not: null } } : { telegramId: null });
  }
  if (query.hasWebAccount !== undefined) {
    and.push(query.hasWebAccount ? { webAccount: { isNot: null } } : { webAccount: null });
  }
  if (query.flagged !== undefined) {
    // Open flags only. A judged one is history, and an operator filtering for
    // "needs a look" does not want the ones already looked at.
    and.push(
      query.flagged
        ? { reviewFlags: { some: { clearedAt: null } } }
        : { reviewFlags: { none: { clearedAt: null } } },
    );
  }

  if (query.createdFrom !== undefined || query.createdTo !== undefined) {
    and.push({
      createdAt: {
        ...(query.createdFrom === undefined ? {} : { gte: query.createdFrom }),
        ...(query.createdTo === undefined ? {} : { lte: query.createdTo }),
      },
    });
  }

  if (and.length === 0) return {};
  return and.length === 1 ? and[0] : { AND: and };
}

/**
 * The free-text half, unchanged in behaviour and now one term among many.
 *
 * Returns `null` for an empty fragment so the caller adds nothing, rather
 * than an empty object that would read as a filter.
 */
function buildSearchTerm(search: string | undefined): Prisma.UserWhereInput | null {
  const trimmed = search?.trim();
  if (!trimmed) {
    return null;
  }

  const conditions: Prisma.UserWhereInput[] = [
    { id: { contains: trimmed, mode: 'insensitive' } },
    { username: { contains: trimmed, mode: 'insensitive' } },
    { email: { contains: trimmed, mode: 'insensitive' } },
    { name: { contains: trimmed, mode: 'insensitive' } },
    { referralCode: { contains: trimmed, mode: 'insensitive' } },
    {
      // Web-first users keep their email + login on the WebAccount (User.email
      // is often null for them), so search both there too — otherwise looking
      // a web/external-auth user up by email or login finds nothing.
      webAccount: {
        is: {
          OR: [
            { login: { contains: trimmed, mode: 'insensitive' } },
            { email: { contains: trimmed, mode: 'insensitive' } },
          ],
        },
      },
    },
    // Subscription CUID (or partial) — operators paste ids from the
    // Subscriptions log to open the owning user (including DELETED rows).
    {
      subscriptions: {
        some: {
          id: { contains: trimmed, mode: 'insensitive' },
        },
      },
    },
  ];

  const telegramId = parseTelegramId(trimmed);
  if (telegramId !== null) {
    conditions.push({ telegramId });
  }

  return { OR: conditions };
}

/** Column projection used when resolving a single user for the picker. */
const RESOLVE_USER_SELECT = {
  id: true,
  telegramId: true,
  username: true,
  name: true,
  email: true,
  webAccount: { select: { login: true, email: true } },
} satisfies Prisma.UserSelect;

type ResolvedUserRow = Prisma.UserGetPayload<{ select: typeof RESOLVE_USER_SELECT }>;

/**
 * Builds the `User.findFirst` where clause for a single free-text identifier.
 *
 * Branches are combined with OR so an exact match on any of reiwa id,
 * Telegram id, login (raw/normalized) or email (raw/normalized on both the
 * `User` and its `WebAccount`) resolves the user. Returns `null` when the
 * identifier is empty (nothing to look up).
 *
 * A numeric identifier only contributes a `telegramId` branch when `int8` can
 * hold it; see `parseTelegramId`. The remaining branches still run, so an
 * over-long digit string is looked up everywhere it could legitimately match.
 */
function buildResolveWhere(identifier: string): Prisma.UserWhereInput | null {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return null;
  }

  const conditions: Prisma.UserWhereInput[] = [];

  if (CUID_PATTERN.test(trimmed)) {
    conditions.push({ id: trimmed });
    // Exact subscription id → resolve the owner (works for deleted subs too).
    conditions.push({
      subscriptions: {
        some: { id: trimmed },
      },
    });
  }

  const telegramId = parseTelegramId(trimmed);
  if (telegramId !== null) {
    conditions.push({ telegramId });
  }

  const normalized = trimmed.toLowerCase();
  conditions.push(
    { email: { equals: trimmed, mode: 'insensitive' } },
    {
      webAccount: {
        is: {
          OR: [
            { login: { equals: trimmed, mode: 'insensitive' } },
            { loginNormalized: normalized },
            { email: { equals: trimmed, mode: 'insensitive' } },
            { emailNormalized: normalized },
          ],
        },
      },
    },
  );

  return { OR: conditions };
}

/**
 * Builds a human-friendly label for a resolved user, preferring the most
 * recognizable field and always falling back to the reiwa id.
 */
function buildUserResolveLabel(user: ResolvedUserRow): string {
  const parts: string[] = [];
  const primary =
    user.name?.trim() ||
    user.username?.trim() ||
    user.webAccount?.login?.trim() ||
    user.email?.trim() ||
    user.webAccount?.email?.trim() ||
    null;

  if (primary) {
    parts.push(primary);
  }
  if (user.telegramId !== null) {
    parts.push(`TG ${user.telegramId.toString()}`);
  }

  return parts.length > 0 ? parts.join(' · ') : user.id;
}

