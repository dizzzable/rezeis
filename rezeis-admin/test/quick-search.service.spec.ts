import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  SubscriptionStatus,
  TransactionStatus,
  UserRole,
} from '@prisma/client';

import { QuickSearchService } from '../src/modules/dashboard/services/quick-search.service';

/** Mirrors `PER_DOMAIN_CAP` in the service; stated once so the intent is readable. */
const PER_DOMAIN_CAP = 5;
/** Mirrors `DEFAULT_LIMIT` in the service — the budget the overlay actually asks for. */
const DEFAULT_LIMIT = 12;

describe('QuickSearchService RBAC filtering', () => {
  it('does not query or return payment transactions without payments:view', async () => {
    const calls: string[] = [];
    const service = createService({
      permissions: new Set(['users:view']),
      calls,
    });

    const results = await service.search({
      rawQuery: 'payment-provider-id',
      currentAdmin: createAdmin(),
    });

    assert.equal(calls.includes('transaction.findMany'), false);
    assert.equal(results.some((hit) => hit.type === 'transaction'), false);
  });

  it('returns payment transaction hits only when payments:view is granted', async () => {
    const calls: string[] = [];
    const service = createService({
      permissions: new Set(['payments:view']),
      calls,
    });

    const results = await service.search({
      rawQuery: 'payment-provider-id',
      currentAdmin: createAdmin(),
    });

    assert.equal(calls.includes('transaction.findMany'), true);
    assert.deepStrictEqual(results, [{
      type: 'transaction',
      id: 'payment-1',
      label: 'YOOKASSA · 12.50 USD',
      subtitle: 'COMPLETED · payment-1',
    }]);
  });

  /**
   * The `finance` shape: holds the controller gate (`dashboard:view`) and one
   * domain permission. It must get that domain and silence from the other four
   * — not a 403, not a partial failure. `dashboard:view` is deliberately absent
   * from the set below because the service never reads it; the gate lives on
   * the controller and this asserts the service does not double-check it.
   */
  it('serves the one permitted domain and skips the other four queries', async () => {
    const calls: string[] = [];
    const service = createService({
      permissions: new Set(['payments:view']),
      calls,
      rows: allDomainsMatching(),
    });

    const results = await service.search({
      rawQuery: 'match',
      currentAdmin: createAdmin(),
    });

    assert.deepStrictEqual(calls, ['transaction.findMany']);
    assert.equal(results.length > 0, true);
    assert.deepStrictEqual([...new Set(results.map((hit) => hit.type))], ['transaction']);
  });

  /**
   * An admin who holds the controller gate and no domain permission at all is a
   * real configuration (a custom role built from `dashboard:view` upward). The
   * overlay must render "no results", so the service owes an empty array — an
   * exception here would surface as a red toast on every keystroke.
   */
  it('returns an empty list, not a failure, when no domain permission is held', async () => {
    const calls: string[] = [];
    const service = createService({
      permissions: new Set(['dashboard:view']),
      calls,
      rows: allDomainsMatching(),
    });

    const results = await service.search({
      rawQuery: 'match',
      currentAdmin: createAdmin(),
    });

    assert.deepStrictEqual(results, []);
    assert.deepStrictEqual(calls, []);
  });
});

describe('QuickSearchService merge budget', () => {
  /**
   * The defect this guards: the merge used to be
   * `[...users, ...subscriptions, ...transactions, ...promocodes, ...partners].slice(0, cap)`.
   * Five domains × `PER_DOMAIN_CAP` is 25 candidates for a 12-seat budget, and
   * the cut ran in DOMAIN DECLARATION ORDER — so 5 users plus 5 subscriptions
   * plus 2 transactions filled it and promocodes and partners were dropped
   * whole. The operator sees "quick search cannot find promocodes", which is
   * indistinguishable from the feature being broken.
   */
  it('starves no domain when all five match at once', async () => {
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: allDomainsMatching(),
    });

    const results = await service.search({
      rawQuery: 'match',
      currentAdmin: createAdmin(),
    });

    assert.equal(results.length, DEFAULT_LIMIT);
    const present = new Set(results.map((hit) => hit.type));
    for (const type of ['user', 'subscription', 'transaction', 'promocode', 'partner']) {
      assert.equal(
        present.has(type as never),
        true,
        `domain "${type}" matched the query but was starved out of the ${DEFAULT_LIMIT}-seat ` +
          `budget; got ${JSON.stringify(results.map((hit) => hit.type))}`,
      );
    }
    // Presence is the guarantee; this is the shape of it. Every hit here scores
    // the same (all substring), so the tie-break puts each domain's best hit
    // first and only then goes deeper — the operator sees a mixed top rather
    // than five users before anything else.
    assert.equal(
      new Set(results.slice(0, 5).map((hit) => hit.type)).size,
      5,
      `the first five seats should be one per domain, got ${JSON.stringify(results.slice(0, 5).map((hit) => hit.type))}`,
    );
  });

  /**
   * `limit=1` is reachable through the DTO (`@Min(1)`), and a single seat
   * cannot be split five ways. When the budget is smaller than the number of
   * matching domains, the seat has to go to the most relevant domain — not to
   * whichever one the `Promise.all` tuple happens to list first.
   */
  it('spends a budget smaller than the domain count on the most relevant domain', async () => {
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: {
        users: [userRow({ id: 'user-substring', name: 'Endless Summer Co' })],
        promocodes: [promocodeRow({ id: 'promo-exact', code: 'SUMMER' })],
      },
    });

    const results = await service.search({
      rawQuery: 'summer',
      limit: 1,
      currentAdmin: createAdmin(),
    });

    assert.deepStrictEqual(results.map((hit) => hit.id), ['promo-exact']);
  });

  /**
   * The strongest form of the guarantee, and the exact case that rules out
   * "just sort everything by score and slice": one domain sweeps the top on
   * relevance. Five prefix-matching promocodes outrank every substring hit, so
   * a pure score sort would seat promocodes, then users, then subscriptions,
   * then transactions — and drop partners at seat 12. The reservation is what
   * makes representation independent of how the scores fall.
   */
  it('starves no domain even when one of them outscores every other', async () => {
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: allDomainsMatchingWithOneFavoured(),
    });

    const results = await service.search({
      rawQuery: 'match',
      currentAdmin: createAdmin(),
    });

    const present = new Set(results.map((hit) => hit.type));
    for (const type of ['user', 'subscription', 'transaction', 'promocode', 'partner']) {
      assert.equal(
        present.has(type as never),
        true,
        `domain "${type}" was starved by a higher-scoring domain; got ` +
          `${JSON.stringify(results.map((hit) => hit.type))}`,
      );
    }
    // …and the favoured domain still leads, so representation did not cost
    // relevance. Both properties hold at once — that is the whole point.
    assert.equal(results[0]?.type, 'promocode');
  });

  /**
   * The other half of the same invariant: guaranteeing a seat per domain must
   * not become "one seat per domain". A query that only one domain answers
   * should still fill the overlay from that domain.
   */
  it('fills the budget from a single domain when only one matches', async () => {
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: { users: userRows(5, 'match') },
    });

    const results = await service.search({
      rawQuery: 'match',
      currentAdmin: createAdmin(),
    });

    assert.equal(results.length, 5);
    assert.deepStrictEqual([...new Set(results.map((hit) => hit.type))], ['user']);
  });

  /**
   * `PER_DOMAIN_CAP` has to hold in memory, not only as the database `take`.
   * The service now over-fetches candidates so relevance can reorder them, so
   * "the database limited it to five" is no longer true — if the in-memory cut
   * were dropped, one broad domain would flood the overlay again and we would
   * be back to the starvation this suite exists to prevent.
   */
  it('caps one domain at PER_DOMAIN_CAP even when the query matches many rows', async () => {
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: { users: userRows(18, 'match') },
    });

    const results = await service.search({
      rawQuery: 'match',
      currentAdmin: createAdmin(),
    });

    assert.equal(results.length, PER_DOMAIN_CAP);
  });

  /**
   * Every domain must fetch MORE candidates than it will show.
   *
   * This is the one decision in the change that mocked delegates cannot catch
   * indirectly — they ignore `take` and hand back whatever the fixture lists,
   * so the ranking passes its tests at any fetch width. In production the width
   * is the whole game: the `orderBy` is `createdAt: 'desc'`, so `take` equal to
   * `PER_DOMAIN_CAP` means the five NEWEST substring matches are the only rows
   * relevance ever sees, and sorting them by match quality reorders a set the
   * exact match may not be in. The ranking would still look correct in every
   * other test here and still fail the operator typing a promocode's exact
   * code. Asserted as an inequality, not a number, so the width stays tunable.
   */
  it('fetches more candidates per domain than it will display', async () => {
    const queryArgs = new Map<string, unknown>();
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: allDomainsMatching(),
      queryArgs,
    });

    await service.search({ rawQuery: 'match', currentAdmin: createAdmin() });

    for (const domain of ['user', 'subscription', 'transaction', 'promocode', 'partner']) {
      const take = (queryArgs.get(domain) as { take?: number } | undefined)?.take;
      assert.equal(
        typeof take === 'number' && take > PER_DOMAIN_CAP,
        true,
        `${domain}.findMany fetched ${String(take)} rows for a ${PER_DOMAIN_CAP}-row cap: ` +
          'relevance can only reorder the newest rows, not find the best ones',
      );
    }
  });

  it('honours a caller-supplied limit below the default', async () => {
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: allDomainsMatching(),
    });

    const results = await service.search({
      rawQuery: 'match',
      limit: 3,
      currentAdmin: createAdmin(),
    });

    assert.equal(results.length, 3);
  });
});

describe('QuickSearchService relevance ordering', () => {
  /**
   * The ordering defect: every domain ordered by `createdAt: 'desc'` and
   * nothing scored match quality, so a promocode whose code IS the query lost
   * to five users whose names merely contain it and who happen to be newer.
   * Exact beats prefix beats substring, across domains.
   */
  it('ranks an exact match above prefix and substring matches from other domains', async () => {
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: {
        users: [
          userRow({ id: 'user-prefix', name: 'Summerfield Ltd' }),
          userRow({ id: 'user-substring', name: 'Endless Summer Co' }),
        ],
        promocodes: [promocodeRow({ id: 'promo-exact', code: 'SUMMER' })],
      },
    });

    const results = await service.search({
      rawQuery: 'summer',
      currentAdmin: createAdmin(),
    });

    assert.deepStrictEqual(
      results.map((hit) => hit.id),
      ['promo-exact', 'user-prefix', 'user-substring'],
      'expected exact > prefix > substring regardless of which domain produced the hit',
    );
  });

  /**
   * Match quality has to be read off the field the WHERE clause matched on, not
   * off the rendered label. A user found by e-mail carries their display name
   * as the label, so scoring the label would read "no match" and sink an exact
   * hit to the bottom.
   */
  it('scores the matched field, not the rendered label', async () => {
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: {
        users: [
          userRow({ id: 'user-substring', name: 'ada@example.com holder', email: null }),
          userRow({ id: 'user-exact-email', name: 'Ada Lovelace', email: 'ada@example.com' }),
        ],
      },
    });

    const results = await service.search({
      rawQuery: 'ada@example.com',
      currentAdmin: createAdmin(),
    });

    assert.equal(results[0]?.id, 'user-exact-email');
  });

  /**
   * `referralCode` is in the user WHERE clause, so a row can arrive explained by
   * nothing else on the row. If it is not SELECTED it cannot be scored, and an
   * operator pasting a referral code verbatim gets their exact hit ranked below
   * every unrelated name that merely contains the string.
   */
  it('scores a user matched only by referral code', async () => {
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: {
        users: [
          userRow({ id: 'user-substring', name: 'promo REF7788 winner' }),
          userRow({ id: 'user-referral', name: 'Ada Lovelace', referralCode: 'REF7788' }),
        ],
      },
    });

    const results = await service.search({
      rawQuery: 'ref7788',
      currentAdmin: createAdmin(),
    });

    assert.equal(results[0]?.id, 'user-referral');
  });

  /** Exactness is case-insensitive — the WHERE clause is, so the score must be. */
  it('treats a case-different whole-field match as exact', async () => {
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: {
        promocodes: [
          promocodeRow({ id: 'promo-prefix', code: 'SUMMERSALE' }),
          promocodeRow({ id: 'promo-exact', code: 'SUMMER' }),
        ],
      },
    });

    const results = await service.search({
      rawQuery: 'sUmMeR',
      currentAdmin: createAdmin(),
    });

    assert.deepStrictEqual(results.map((hit) => hit.id), ['promo-exact', 'promo-prefix']);
  });

  /**
   * Recency is the tie-break, not the ranking. Two substring hits inside one
   * domain keep the order the database returned them in (`createdAt: 'desc'`),
   * so the ranking is a reordering by quality and nothing else.
   */
  it('keeps database order between hits of equal match quality', async () => {
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: {
        promocodes: [
          promocodeRow({ id: 'promo-newer', code: 'A-SUMMER-1' }),
          promocodeRow({ id: 'promo-older', code: 'B-SUMMER-2' }),
        ],
      },
    });

    const results = await service.search({
      rawQuery: 'summer',
      currentAdmin: createAdmin(),
    });

    assert.deepStrictEqual(results.map((hit) => hit.id), ['promo-newer', 'promo-older']);
  });

  /**
   * A numeric query hits `telegramId` by BigInt equality, which is exact by
   * construction. Scoring it as "no textual match" would rank an operator's
   * most precise possible lookup below every fuzzy substring hit.
   */
  it('treats a telegramId equality hit as an exact match', async () => {
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: {
        users: [
          userRow({ id: 'user-substring', name: 'order 123456789 refund', telegramId: null }),
          userRow({ id: 'user-telegram', name: 'Ada Lovelace', telegramId: 123456789n }),
        ],
      },
    });

    const results = await service.search({
      rawQuery: '123456789',
      currentAdmin: createAdmin(),
    });

    assert.equal(results[0]?.id, 'user-telegram');
  });
});

describe('QuickSearchService short and blank queries', () => {
  /**
   * A long numeric paste — a payment reference, an invoice number — is a
   * realistic global-search input. It used to build `telegramId: BigInt(query)`
   * from any digit string; `User.telegramId` is Postgres `int8`, so the
   * parameter was rejected at bind time, the rejection failed the whole
   * `Promise.all`, and the operator got a 500 for a query the TRANSACTIONS
   * domain would have answered. The clause has to be dropped, not the search.
   */
  it('drops the telegramId clause for a number too large to be one', async () => {
    const queryArgs = new Map<string, unknown>();
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: {
        transactions: [transactionRow({ id: 'tx-1', paymentId: '99999999999999999999999999' })],
      },
      queryArgs,
    });

    const results = await service.search({
      rawQuery: '99999999999999999999999999',
      currentAdmin: createAdmin(),
    });

    const userWhere = (queryArgs.get('user') as { where?: { OR?: unknown[] } } | undefined)?.where;
    assert.equal(
      userWhere?.OR?.some((clause) => Object.prototype.hasOwnProperty.call(clause, 'telegramId')),
      false,
      'an out-of-int8-range number reached the telegramId clause and would be rejected at bind time',
    );
    // …and the search still answers, from the domain that can match it.
    assert.deepStrictEqual(results.map((hit) => hit.type), ['transaction']);
  });

  /** The boundary itself is a valid id and must still be matched. */
  it('keeps the telegramId clause at the exact int8 maximum', async () => {
    const queryArgs = new Map<string, unknown>();
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: {},
      queryArgs,
    });

    await service.search({ rawQuery: '9223372036854775807', currentAdmin: createAdmin() });

    const userWhere = (queryArgs.get('user') as { where?: { OR?: unknown[] } } | undefined)?.where;
    assert.deepStrictEqual(
      userWhere?.OR?.find((clause) => Object.prototype.hasOwnProperty.call(clause, 'telegramId')),
      { telegramId: 9223372036854775807n },
    );
  });

  it('answers a two-character query instead of treating it as too short', async () => {
    const calls: string[] = [];
    const service = createService({
      permissions: allDomainPermissions(),
      calls,
      rows: { promocodes: [promocodeRow({ id: 'promo-vp', code: 'VP' })] },
    });

    const results = await service.search({
      rawQuery: 'vp',
      currentAdmin: createAdmin(),
    });

    assert.equal(calls.includes('promocode.findMany'), true);
    assert.deepStrictEqual(results.map((hit) => hit.id), ['promo-vp']);
  });

  /**
   * The overlay gates on raw `.length`, so two spaces reach the service as a
   * two-character query. Trimming first is what keeps that from becoming five
   * unbounded `LIKE '%%'` scans across the biggest tables in the schema.
   */
  it('issues no query at all for whitespace-only input', async () => {
    const calls: string[] = [];
    const service = createService({
      permissions: allDomainPermissions(),
      calls,
      rows: allDomainsMatching(),
    });

    assert.deepStrictEqual(
      await service.search({ rawQuery: '   ', currentAdmin: createAdmin() }),
      [],
    );
    assert.deepStrictEqual(
      await service.search({ rawQuery: ' a ', currentAdmin: createAdmin() }),
      [],
    );
    assert.deepStrictEqual(calls, []);
  });

  /**
   * Padding must not change what the operator gets: a pasted id usually arrives
   * with a trailing space, and the trimmed value is what both the WHERE clause
   * and the exactness score have to see — otherwise a pasted exact id scores as
   * "no match" and sinks.
   */
  it('scores a padded query against its trimmed form', async () => {
    const service = createService({
      permissions: allDomainPermissions(),
      calls: [],
      rows: {
        promocodes: [
          promocodeRow({ id: 'promo-prefix', code: 'SUMMERSALE' }),
          promocodeRow({ id: 'promo-exact', code: 'SUMMER' }),
        ],
      },
    });

    const results = await service.search({
      rawQuery: '  summer  ',
      currentAdmin: createAdmin(),
    });

    assert.deepStrictEqual(results.map((hit) => hit.id), ['promo-exact', 'promo-prefix']);
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────

interface DomainRowsInterface {
  readonly users?: unknown[];
  readonly subscriptions?: unknown[];
  readonly transactions?: unknown[];
  readonly promocodes?: unknown[];
  readonly partners?: unknown[];
}

function allDomainPermissions(): ReadonlySet<string> {
  return new Set([
    'users:view',
    'subscriptions:view',
    'payments:view',
    'promocodes:view',
    'partners:view',
  ]);
}

/**
 * `PER_DOMAIN_CAP` hits in every domain — the starvation scenario.
 *
 * Every value is deliberately a MID-STRING match ("…-match-…", never
 * "match-…"), so all five domains score the same substring tier. That keeps
 * relevance out of the picture and leaves the budget as the only thing under
 * test. `allDomainsMatchingWithOneFavoured` is the variant that puts scores in
 * play on purpose.
 */
function allDomainsMatching(): DomainRowsInterface {
  return {
    users: userRows(PER_DOMAIN_CAP, 'match'),
    subscriptions: Array.from({ length: PER_DOMAIN_CAP }, (_unused, i) =>
      subscriptionRow({ id: `sub-match-${i}` }),
    ),
    transactions: Array.from({ length: PER_DOMAIN_CAP }, (_unused, i) =>
      transactionRow({ id: `tx-${i}`, paymentId: `pay-match-${i}` }),
    ),
    promocodes: Array.from({ length: PER_DOMAIN_CAP }, (_unused, i) =>
      promocodeRow({ id: `promo-${i}`, code: `CODE-MATCH-${i}` }),
    ),
    partners: Array.from({ length: PER_DOMAIN_CAP }, (_unused, i) =>
      partnerRow({ id: `partner-match-${i}` }),
    ),
  };
}

/** As above, but every promocode is a PREFIX match and outscores all others. */
function allDomainsMatchingWithOneFavoured(): DomainRowsInterface {
  return {
    ...allDomainsMatching(),
    promocodes: Array.from({ length: PER_DOMAIN_CAP }, (_unused, i) =>
      promocodeRow({ id: `promo-${i}`, code: `MATCH-CODE-${i}` }),
    ),
  };
}

function userRows(count: number, token: string): unknown[] {
  return Array.from({ length: count }, (_unused, i) =>
    userRow({ id: `user-${i}`, name: `Nina ${token} ${i}` }),
  );
}

function userRow(overrides: {
  id: string;
  name?: string | null;
  username?: string | null;
  email?: string | null;
  telegramId?: bigint | null;
  referralCode?: string | null;
}) {
  return {
    id: overrides.id,
    username: overrides.username ?? null,
    email: overrides.email === undefined ? null : overrides.email,
    name: overrides.name ?? null,
    telegramId: overrides.telegramId ?? null,
    referralCode: overrides.referralCode ?? null,
  };
}

function subscriptionRow(overrides: { id: string; remnawaveId?: string | null }) {
  return {
    id: overrides.id,
    status: SubscriptionStatus.ACTIVE,
    planSnapshot: { name: 'Pro' },
    userId: 'user-owner-1',
    remnawaveId: overrides.remnawaveId ?? null,
  };
}

function transactionRow(overrides: { id: string; paymentId: string; gatewayId?: string | null }) {
  return {
    id: overrides.id,
    paymentId: overrides.paymentId,
    status: TransactionStatus.COMPLETED,
    gatewayType: PaymentGatewayType.YOOKASSA,
    amount: { toString: () => '12.50' },
    currency: Currency.USD,
    gatewayId: overrides.gatewayId ?? null,
  };
}

function promocodeRow(overrides: { id: string; code: string }) {
  return {
    id: overrides.id,
    code: overrides.code,
    isActive: true,
    rewardType: null,
  };
}

function partnerRow(overrides: { id: string; userId?: string }) {
  return {
    id: overrides.id,
    userId: overrides.userId ?? 'user-owner-1',
    balance: 1000,
    isActive: true,
  };
}

function createService(input: {
  readonly permissions: ReadonlySet<string>;
  readonly calls: string[];
  readonly rows?: DomainRowsInterface;
  /** When supplied, records the args each delegate was called with. */
  readonly queryArgs?: Map<string, unknown>;
}): QuickSearchService {
  // The two original RBAC specs assert one transaction row verbatim and pass no
  // `rows` at all. Passing ANY `rows` therefore switches every domain to
  // "exactly what the test listed" — otherwise this row leaks into ordering
  // specs as a phantom sixth hit and makes their expectations unreadable.
  const defaultTransactions = input.rows
    ? []
    : [
        {
          id: 'transaction-1',
          paymentId: 'payment-1',
          status: TransactionStatus.COMPLETED,
          gatewayType: PaymentGatewayType.YOOKASSA,
          amount: { toString: () => '12.50' },
          currency: Currency.USD,
          gatewayId: null,
        },
      ];
  const delegate = (name: string, rows: unknown[]) => ({
    findMany: async (args: unknown) => {
      input.calls.push(`${name}.findMany`);
      input.queryArgs?.set(name, args);
      return rows;
    },
  });
  const prismaService = {
    user: delegate('user', input.rows?.users ?? []),
    subscription: delegate('subscription', input.rows?.subscriptions ?? []),
    transaction: delegate('transaction', input.rows?.transactions ?? defaultTransactions),
    promocode: delegate('promocode', input.rows?.promocodes ?? []),
    partner: delegate('partner', input.rows?.partners ?? []),
  };
  const rbacService = {
    hasPermission: async (_admin: unknown, resource: string, action: string) =>
      input.permissions.has(`${resource}:${action}`),
  };

  return new QuickSearchService(prismaService as never, rbacService as never);
}

function createAdmin() {
  return {
    id: 'admin-1',
    role: UserRole.ADMIN,
    rbacRoleId: 'role-1',
  };
}
