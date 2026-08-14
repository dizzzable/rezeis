import { Injectable } from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RbacService } from '../../rbac/services/rbac.service';
import { QuickSearchHitInterface } from '../interfaces/quick-search-result.interface';

const DEFAULT_LIMIT = 12;
/** Per-domain hit cap so a single domain cannot dominate the overlay. */
const PER_DOMAIN_CAP = 5;
/**
 * Rows pulled per domain BEFORE relevance ranking cuts back to
 * `PER_DOMAIN_CAP`.
 *
 * Why over-fetch at all: the database orders by `createdAt: 'desc'`, so with
 * `take: PER_DOMAIN_CAP` the five NEWEST substring matches won the candidate
 * slots and everything else was never loaded. Ranking those five by match
 * quality then reorders a set that the exact match may not even be in — a
 * promocode literally named `SUMMER` loses to five newer codes merely
 * containing it, and the ranking reads as theatre. Fetching a wider window
 * gives the score something to choose from.
 *
 * What it costs, stated plainly: on a broad query Postgres now scans until it
 * has matched 20 rows per domain instead of 5, and 5 domains × 20 tiny rows
 * cross the wire instead of 25 total. On a narrow query it costs nothing — the
 * scan ends when matches run out either way. That is the price of the ranking
 * being real, and it is bounded: no query can pull more than this.
 *
 * What it still does NOT fix: an exact match that is the 21st-newest row
 * containing the query is invisible, because relevance is not expressible in
 * the `orderBy` without raw SQL per domain. Widening this constant trades that
 * blind spot against scan cost linearly; it does not close it.
 */
const CANDIDATES_PER_DOMAIN = PER_DOMAIN_CAP * 4;

/**
 * Match-quality tiers. The whole point of ordering hits is that an operator who
 * types an id or a code gets THAT row first, not the most recently created row
 * that happens to contain the same characters.
 */
const SCORE_EXACT = 3;
const SCORE_PREFIX = 2;
const SCORE_SUBSTRING = 1;
/** A row the WHERE clause returned but no scored field explains. Sorts last. */
const SCORE_UNRANKED = 0;

/**
 * Upper bound of Postgres `int8`, which is what `User.telegramId` is
 * (`@db.BigInt`). A digit string above this cannot be a Telegram id and must
 * not reach the query.
 *
 * This is a live failure, not a theoretical one. Long numeric strings are
 * exactly what an operator pastes into a global search — a 20-digit payment
 * reference, an invoice number. `BigInt(query)` accepts it happily (JS BigInt
 * is arbitrary precision), Prisma binds it, and Postgres rejects the parameter
 * with `22003 numeric field value out of range` — which fails the WHOLE
 * `Promise.all`, so the operator gets a 500 instead of the transaction that
 * `paymentId` would have matched. Quick search breaks worst on the input most
 * likely to have an answer.
 *
 * Note the shape of the check: a range comparison, not `try { BigInt(x) }`.
 * The try/catch idiom appears elsewhere in this codebase labelled "overflow",
 * but `BigInt` only throws on a string that is not a number at all — and
 * `/^\d+$/` has already ruled that out, so that catch block is unreachable and
 * guards nothing.
 */
const MAX_POSTGRES_BIGINT = 9223372036854775807n;

/** Returns the query as a Telegram id, or `null` if it cannot be one. */
function parseTelegramId(query: string): bigint | null {
  if (!/^\d+$/.test(query)) return null;
  const value = BigInt(query);
  return value <= MAX_POSTGRES_BIGINT ? value : null;
}

/**
 * A hit plus the quality of the field it matched on.
 *
 * The score is deliberately NOT part of `QuickSearchHitInterface`: it is a
 * ranking input, not something the overlay renders, and exporting it would
 * invite the frontend to re-sort on it and drift from the order chosen here.
 */
interface ScoredHitInterface {
  readonly hit: QuickSearchHitInterface;
  readonly score: number;
}

/**
 * Aggregates results across users / subscriptions / transactions / promocodes
 * / partners for the admin Cmd+K overlay.
 *
 * The service runs five small, capped queries in parallel and merges them.
 * No raw payload values, provider tokens or webhook payloads ever leak into
 * the response — only the labels needed to render a row.
 */
@Injectable()
export class QuickSearchService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly rbacService: RbacService,
  ) {}

  public async search(input: {
    readonly rawQuery: string;
    readonly limit?: number;
    readonly currentAdmin: Pick<CurrentAdminInterface, 'id' | 'role' | 'rbacRoleId'>;
  }): Promise<QuickSearchHitInterface[]> {
    const rawQuery = input.rawQuery;
    // Trim BEFORE the length gate, and search on the trimmed value. The overlay
    // gates on raw `.length`, so two spaces arrive here as a "two-character"
    // query; without this they would become five unbounded `LIKE '%%'` scans
    // over the largest tables in the schema. It also means a pasted id with a
    // trailing space scores as the exact match it is.
    const query = rawQuery.trim();
    if (query.length < 2) return [];
    const cap = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 25));

    const [canSearchUsers, canSearchSubscriptions, canSearchPayments, canSearchPromocodes, canSearchPartners] =
      await Promise.all([
        this.rbacService.hasPermission(input.currentAdmin, 'users', 'view'),
        this.rbacService.hasPermission(input.currentAdmin, 'subscriptions', 'view'),
        this.rbacService.hasPermission(input.currentAdmin, 'payments', 'view'),
        this.rbacService.hasPermission(input.currentAdmin, 'promocodes', 'view'),
        this.rbacService.hasPermission(input.currentAdmin, 'partners', 'view'),
      ]);

    const [users, subscriptions, transactions, promocodes, partners] = await Promise.all([
      canSearchUsers ? this.searchUsers(query) : [],
      canSearchSubscriptions ? this.searchSubscriptions(query) : [],
      canSearchPayments ? this.searchTransactions(query) : [],
      canSearchPromocodes ? this.searchPromocodes(query) : [],
      canSearchPartners ? this.searchPartners(query) : [],
    ]);

    return mergeDomains([users, subscriptions, transactions, promocodes, partners], cap);
  }

  private async searchUsers(query: string): Promise<ScoredHitInterface[]> {
    // Numeric-looking inputs match telegramId in addition to username/email.
    // `BigInt`, never `Number`: the column is 64-bit and `Number` silently
    // loses precision above 2^53, which would match the WRONG account.
    // `parseTelegramId` returns null for anything Postgres `int8` cannot hold.
    const telegramId = parseTelegramId(query);
    const tgIdMatch: Prisma.UserWhereInput | null = telegramId !== null ? { telegramId } : null;
    const where: Prisma.UserWhereInput = {
      OR: [
        { username: { contains: query, mode: 'insensitive' } },
        { email: { contains: query, mode: 'insensitive' } },
        { name: { contains: query, mode: 'insensitive' } },
        { referralCode: { contains: query, mode: 'insensitive' } },
        ...(tgIdMatch ? [tgIdMatch] : []),
      ],
    };
    const rows = await this.prismaService.user.findMany({
      where,
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        telegramId: true,
        // Selected only so the score can see it. `referralCode` is in the OR
        // above, so a row can arrive here explained by nothing else — without
        // it that row scores `SCORE_UNRANKED` and sinks below every fuzzier hit.
        referralCode: true,
      },
      take: CANDIDATES_PER_DOMAIN,
      orderBy: { createdAt: 'desc' },
    });
    const loweredQuery = query.toLowerCase();
    return rankWithinDomain(
      rows.map((u) => ({
        // A row reached here through `telegramId` by EQUALITY, which is the most
        // precise lookup this overlay offers. It is scored explicitly rather
        // than textually because `BigInt('0077').toString()` is `'77'` — the
        // strings differ, so text scoring would rate an exact id hit as no
        // match at all.
        score:
          telegramId !== null && u.telegramId === telegramId
            ? SCORE_EXACT
            : scoreRow([u.username, u.email, u.name, u.referralCode], loweredQuery),
        hit: {
          type: 'user' as const,
          id: u.id,
          label: u.name && u.name.length > 0
            ? u.name
            : u.username ?? u.email ?? (u.telegramId !== null ? `tg:${u.telegramId.toString()}` : u.id),
          subtitle: u.email ?? u.username ?? (u.telegramId !== null ? u.telegramId.toString() : undefined),
        },
      })),
    );
  }

  private async searchSubscriptions(query: string): Promise<ScoredHitInterface[]> {
    const where: Prisma.SubscriptionWhereInput = {
      OR: [
        { id: { contains: query, mode: 'insensitive' } },
        { remnawaveId: { contains: query, mode: 'insensitive' } },
      ],
    };
    const rows = await this.prismaService.subscription.findMany({
      where,
      select: {
        id: true,
        status: true,
        planSnapshot: true,
        userId: true,
        // In the OR, so it has to be scorable — see `searchUsers`.
        remnawaveId: true,
      },
      take: CANDIDATES_PER_DOMAIN,
      orderBy: { createdAt: 'desc' },
    });
    const loweredQuery = query.toLowerCase();
    return rankWithinDomain(
      rows.map((s) => ({
        score: scoreRow([s.id, s.remnawaveId], loweredQuery),
        hit: {
          type: 'subscription' as const,
          id: s.id,
          label: extractPlanName(s.planSnapshot) ?? `Subscription ${s.id.slice(0, 8)}`,
          subtitle: `${s.status} · user ${s.userId.slice(0, 8)}`,
        },
      })),
    );
  }

  private async searchTransactions(query: string): Promise<ScoredHitInterface[]> {
    const where: Prisma.TransactionWhereInput = {
      OR: [
        { id: { contains: query, mode: 'insensitive' } },
        { paymentId: { contains: query, mode: 'insensitive' } },
        { gatewayId: { contains: query, mode: 'insensitive' } },
      ],
    };
    const rows = await this.prismaService.transaction.findMany({
      where,
      select: {
        id: true,
        paymentId: true,
        status: true,
        gatewayType: true,
        amount: true,
        currency: true,
        // In the OR, so it has to be scorable — see `searchUsers`.
        gatewayId: true,
      },
      take: CANDIDATES_PER_DOMAIN,
      orderBy: { createdAt: 'desc' },
    });
    const loweredQuery = query.toLowerCase();
    return rankWithinDomain(
      rows.map((tx) => ({
        score: scoreRow([tx.id, tx.paymentId, tx.gatewayId], loweredQuery),
        hit: {
          type: 'transaction' as const,
          id: tx.paymentId,
          label: `${tx.gatewayType} · ${tx.amount.toString()} ${tx.currency}`,
          subtitle:
            tx.status === TransactionStatus.COMPLETED
              ? `${tx.status} · ${tx.paymentId.slice(0, 12)}`
              : `${tx.status} · pending payment`,
        },
      })),
    );
  }

  private async searchPromocodes(query: string): Promise<ScoredHitInterface[]> {
    // Promocodes are model-less in some schemas; fall back gracefully if
    // the table does not exist in this Prisma client build.
    const promocodeDelegate = (this.prismaService as unknown as Record<string, unknown>)['promocode'] as
      | { findMany: (args: unknown) => Promise<unknown[]> }
      | undefined;
    if (!promocodeDelegate) return [];
    try {
      const rows = (await promocodeDelegate.findMany({
        where: {
          OR: [
            { code: { contains: query, mode: 'insensitive' } },
            { id: { contains: query, mode: 'insensitive' } },
          ],
        },
        select: { id: true, code: true, isActive: true, rewardType: true },
        take: CANDIDATES_PER_DOMAIN,
        orderBy: { createdAt: 'desc' },
      })) as Array<{
        id: string;
        code: string;
        isActive?: boolean;
        rewardType?: string | null;
      }>;
      const loweredQuery = query.toLowerCase();
      return rankWithinDomain(
        rows.map((p) => ({
          score: scoreRow([p.code, p.id], loweredQuery),
          hit: {
            type: 'promocode' as const,
            id: p.id,
            label: p.code,
            subtitle: p.rewardType
              ? `${p.rewardType}${p.isActive === false ? ' · disabled' : ''}`
              : p.isActive === false
                ? 'disabled'
                : undefined,
          },
        })),
      );
    } catch {
      return [];
    }
  }

  private async searchPartners(query: string): Promise<ScoredHitInterface[]> {
    const where: Prisma.PartnerWhereInput = {
      OR: [
        { id: { contains: query, mode: 'insensitive' } },
        { userId: { contains: query, mode: 'insensitive' } },
      ],
    };
    const rows = await this.prismaService.partner.findMany({
      where,
      select: { id: true, userId: true, balance: true, isActive: true },
      take: CANDIDATES_PER_DOMAIN,
      orderBy: { updatedAt: 'desc' },
    });
    const loweredQuery = query.toLowerCase();
    return rankWithinDomain(
      rows.map((p) => ({
        score: scoreRow([p.id, p.userId], loweredQuery),
        hit: {
          type: 'partner' as const,
          id: p.id,
          label: `Partner ${p.userId.slice(0, 8)}`,
          subtitle: `balance ${(p.balance / 100).toFixed(2)}${p.isActive ? '' : ' · disabled'}`,
        },
      })),
    );
  }
}

/**
 * Grades one field against the query. Case-insensitive because every WHERE
 * clause above is (`mode: 'insensitive'`) — a score that disagreed with the
 * filter would rank rows by a rule that did not select them.
 */
function scoreField(value: string | null | undefined, loweredQuery: string): number {
  if (!value) return SCORE_UNRANKED;
  const lowered = value.toLowerCase();
  if (lowered === loweredQuery) return SCORE_EXACT;
  if (lowered.startsWith(loweredQuery)) return SCORE_PREFIX;
  if (lowered.includes(loweredQuery)) return SCORE_SUBSTRING;
  return SCORE_UNRANKED;
}

/**
 * Best score across the fields the row was SELECTED on.
 *
 * The list passed in must be the same set as that domain's `OR` clause. Scoring
 * the rendered label instead — the obvious shortcut — is wrong in a way that
 * bites the most precise lookups: a user found by e-mail carries their display
 * NAME as the label, so an exact e-mail hit would score `SCORE_UNRANKED` and
 * sink below every fuzzy name match.
 */
function scoreRow(values: ReadonlyArray<string | null | undefined>, loweredQuery: string): number {
  let best = SCORE_UNRANKED;
  for (const value of values) {
    const score = scoreField(value, loweredQuery);
    if (score > best) best = score;
    if (best === SCORE_EXACT) break;
  }
  return best;
}

/**
 * Orders one domain's hits by match quality and applies `PER_DOMAIN_CAP`.
 *
 * The cap is enforced HERE and not only by the database `take`: since the
 * queries over-fetch candidates (`CANDIDATES_PER_DOMAIN`), "the database
 * limited it to five" stopped being true, and without this cut one broad
 * domain would hand `mergeDomains` twenty hits and flood the overlay.
 *
 * `Array.prototype.sort` is stable, so hits of equal quality keep the order the
 * database returned them in — `createdAt: 'desc'`. Recency stays the tie-break
 * it always was; it is no longer the ranking.
 */
function rankWithinDomain(scored: ReadonlyArray<ScoredHitInterface>): ScoredHitInterface[] {
  return [...scored].sort((a, b) => b.score - a.score).slice(0, PER_DOMAIN_CAP);
}

/**
 * Merges the five per-domain lists into one `cap`-sized list.
 *
 * The bug this replaces: the merge was `[...users, ...subscriptions, ...].slice(0, cap)`.
 * Five domains × `PER_DOMAIN_CAP` is 25 candidates for a 12-seat budget and the
 * cut ran in DOMAIN DECLARATION ORDER, so 5 users + 5 subscriptions + 2
 * transactions consumed it and promocodes and partners were dropped whole. The
 * operator's report — "quick search does not find promocodes" — was literally
 * true, and nothing in the response said a domain had been discarded.
 *
 * Strategy: reserve one seat per non-empty domain, then fill the remaining
 * seats by score, then display everything ordered by score.
 *
 * Why this and not the two obvious single-rule alternatives:
 *
 *   Round-robin interleaving guarantees representation but cannot rank. It
 *   places each domain's best hit by DOMAIN POSITION, so a promocode whose code
 *   IS the query lands fourth, behind three substring matches from domains that
 *   are merely declared earlier. That is the ordering half of the same
 *   complaint, unfixed.
 *
 *   Sorting everything by score and slicing ranks correctly but re-opens the
 *   starvation: 5 exactly-matching users + 5 exactly-matching subscriptions +
 *   5 exactly-matching transactions is 15 hits above any substring match, so a
 *   promocode that matched only loosely is cut before it is ever considered —
 *   the same whole-domain disappearance, now triggered by a better query.
 *
 * The reservation is what makes the guarantee unconditional (it holds no matter
 * how the scores fall), and the final sort is what makes exact-beats-partial
 * hold across domains. Neither rule alone gives both.
 *
 * Display order is `score desc`, then per-domain rank ascending, then domain
 * order. The rank tie-break means equally-scored hits come out round-robin —
 * every domain's best, then every domain's second — so the top of the list
 * stays mixed instead of showing five users before anything else.
 */
function mergeDomains(
  domains: ReadonlyArray<ReadonlyArray<ScoredHitInterface>>,
  cap: number,
): QuickSearchHitInterface[] {
  interface CandidateInterface {
    readonly scored: ScoredHitInterface;
    /** Index of the producing domain — the last, purely deterministic tie-break. */
    readonly domain: number;
    /** Position within its own domain after `rankWithinDomain`; 0 is its best hit. */
    readonly rank: number;
  }

  const reservedSeats: CandidateInterface[] = [];
  const remainder: CandidateInterface[] = [];
  domains.forEach((domain, domainIndex) => {
    domain.forEach((scored, rank) => {
      const candidate: CandidateInterface = { scored, domain: domainIndex, rank };
      // Rank 0 is the domain's single reserved seat. Every other hit competes.
      (rank === 0 ? reservedSeats : remainder).push(candidate);
    });
  });

  const byRelevance = (a: CandidateInterface, b: CandidateInterface): number =>
    b.scored.score - a.scored.score || a.domain - b.domain || a.rank - b.rank;
  // Sorted so that a `cap` smaller than the number of domains (the DTO allows
  // `limit=1`) still spends its seats on the most relevant domains rather than
  // on whichever happens to be declared first.
  reservedSeats.sort(byRelevance);
  remainder.sort(byRelevance);

  const seated = reservedSeats.slice(0, cap);
  const filled = remainder.slice(0, Math.max(0, cap - seated.length));

  return [...seated, ...filled]
    .sort((a, b) => b.scored.score - a.scored.score || a.rank - b.rank || a.domain - b.domain)
    .map((candidate) => candidate.scored.hit);
}

function extractPlanName(snapshot: Prisma.JsonValue): string | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const v = (snapshot as Record<string, unknown>)['name'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
