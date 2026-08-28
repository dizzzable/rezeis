import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Locale, SubscriptionStatus, UserRole } from '@prisma/client';
import { plainToInstance } from 'class-transformer';

import { AdminUserListQueryDto } from '../src/modules/users/dto/admin-user-list-query.dto';
import { AdminUsersService } from '../src/modules/users/services/admin-users.service';

/**
 * The filters behind the Users list.
 *
 * ── What is actually worth pinning ───────────────────────────────────────
 *
 * Not that a filter produces some clause — that it produces the RIGHT one, in
 * the two places where a plausible-looking mistake changes who is listed:
 *
 *   • filters must AND with each other. Merged into one object, two filters
 *     that both reach for `subscriptions.some` would silently replace one
 *     another, and the operator would get the result of whichever won.
 *   • a deleted subscription is not one the customer has. Counting it puts
 *     people who cancelled months ago into "customers on Standard".
 *   • `?flag=false` is the string "false", which is truthy. A filter for "not
 *     blocked" that returns the blocked ones is the classic version of this,
 *     and this codebase has had it before.
 */

function whereFor(raw: Record<string, unknown>): Record<string, unknown> {
  const captured: Array<Record<string, unknown>> = [];
  const service = new AdminUsersService(
    {
      $transaction: async (queries: readonly unknown[]) => [[], 0].slice(0, queries.length),
      user: {
        findMany: (args: { where: Record<string, unknown> }) => {
          captured.push(args.where);
          return { query: 'findMany' };
        },
        count: () => ({ query: 'count' }),
      },
    } as never,
    {} as never,
  );
  const query = plainToInstance(AdminUserListQueryDto, raw);
  void service.listUsers(query);
  assert.equal(captured.length, 1, 'expected exactly one list query');
  return captured[0];
}

function andTerms(where: Record<string, unknown>): Array<Record<string, unknown>> {
  const and = where['AND'];
  if (Array.isArray(and)) return and as Array<Record<string, unknown>>;
  return Object.keys(where).length === 0 ? [] : [where];
}

describe('no filters', () => {
  it('asks for everybody', async () => {
    assert.deepStrictEqual(whereFor({}), {});
  });

  it('treats an empty multi-value filter as absent, not as "match nothing"', async () => {
    // `?roles=` reaching the query as `role: { in: [] }` would return an empty
    // list, which reads as a broken page rather than as a filter nobody set.
    assert.deepStrictEqual(whereFor({ roles: '' }), {});
  });
});

describe('combining filters', () => {
  it('ANDs them instead of letting one overwrite another', async () => {
    // Both of these want `subscriptions.some`. Merged into a single object the
    // second would replace the first, and the operator would get the result of
    // whichever key was written last.
    const where = whereFor({ planIds: 'plan-1', hasSubscription: 'true' });
    const terms = andTerms(where);
    assert.equal(terms.length, 2);
    assert.ok(terms.every((term) => 'subscriptions' in term));
  });

  it('does not wrap a single filter in a pointless AND', async () => {
    const where = whereFor({ isBlocked: 'true' });
    assert.deepStrictEqual(where, { isBlocked: true });
  });

  it('keeps the free-text search as one more term', async () => {
    const terms = andTerms(whereFor({ search: 'dizzable', isBlocked: 'true' }));
    assert.equal(terms.length, 2);
    assert.ok(terms.some((term) => Array.isArray(term['OR'])));
    assert.ok(terms.some((term) => term['isBlocked'] === true));
  });
});

describe('subscription filters', () => {
  it('matches the plan inside the purchase-time snapshot', async () => {
    // There is no `plan_id` column on `subscriptions`; the plan is in the JSON
    // snapshot taken when it was bought.
    const term = andTerms(whereFor({ planIds: 'plan-1,plan-2' }))[0];
    const some = (term['subscriptions'] as { some: Record<string, unknown> }).some;
    assert.deepStrictEqual(some['OR'], [
      { planSnapshot: { path: ['id'], equals: 'plan-1' } },
      { planSnapshot: { path: ['id'], equals: 'plan-2' } },
    ]);
  });

  it('excludes deleted subscriptions from a plan filter', async () => {
    // Otherwise "customers on Standard" includes everybody who ever cancelled
    // one.
    const term = andTerms(whereFor({ planIds: 'plan-1' }))[0];
    const some = (term['subscriptions'] as { some: Record<string, unknown> }).some;
    assert.deepStrictEqual(some['status'], { not: SubscriptionStatus.DELETED });
  });

  it('honours an explicit request for deleted ones', async () => {
    // Asking for DELETED by name is not the same question, and answering it
    // with "not DELETED" would be answering a different one.
    const term = andTerms(whereFor({ subscriptionStatuses: 'DELETED' }))[0];
    const some = (term['subscriptions'] as { some: Record<string, unknown> }).some;
    assert.deepStrictEqual(some['status'], { in: [SubscriptionStatus.DELETED] });
  });

  it('uses none() for the negative arms, not some() with a negation', async () => {
    // `some: { isTrial: false }` means "has a non-trial subscription", which is
    // true of somebody who also has a trial. The question was whether they have
    // a trial at all.
    const trial = andTerms(whereFor({ isTrial: 'false' }))[0];
    assert.ok('none' in (trial['subscriptions'] as Record<string, unknown>));

    const has = andTerms(whereFor({ hasSubscription: 'false' }))[0];
    assert.ok('none' in (has['subscriptions'] as Record<string, unknown>));
  });

  it('drops a status nobody defines instead of refusing the request', async () => {
    // A shared link outliving a rename should return the rest of the filter,
    // not a validation error the operator cannot act on.
    assert.deepStrictEqual(whereFor({ subscriptionStatuses: 'NOT_A_STATUS' }), {});
  });
});

describe('account filters', () => {
  it('reads an explicit false as false', async () => {
    // The trap: `?isBlocked=false` arrives as the STRING "false", which is
    // truthy. A filter for "not blocked" that returns the blocked ones is the
    // shape this has taken here before.
    assert.deepStrictEqual(whereFor({ isBlocked: 'false' }), { isBlocked: false });
  });

  it('filters by role and language as sets', async () => {
    const terms = andTerms(whereFor({ roles: 'USER,ADMIN', languages: 'RU' }));
    assert.ok(
      terms.some((term) =>
        Array.isArray((term['role'] as { in?: unknown[] })?.in) &&
        (term['role'] as { in: UserRole[] }).in.includes(UserRole.ADMIN),
      ),
    );
    assert.ok(
      terms.some((term) => (term['language'] as { in?: Locale[] })?.in?.[0] === Locale.RU),
    );
  });

  it('distinguishes having a Telegram id from having a web account', async () => {
    assert.deepStrictEqual(whereFor({ hasTelegram: 'true' }), { telegramId: { not: null } });
    assert.deepStrictEqual(whereFor({ hasTelegram: 'false' }), { telegramId: null });
    assert.deepStrictEqual(whereFor({ hasWebAccount: 'true' }), { webAccount: { isNot: null } });
  });

  it('counts only unresolved review flags', async () => {
    // A judged flag is history. An operator filtering for "needs a look" does
    // not want the ones already looked at.
    assert.deepStrictEqual(whereFor({ flagged: 'true' }), {
      reviewFlags: { some: { clearedAt: null } },
    });
  });

  it('bounds a registration window on both sides when both are given', async () => {
    const where = whereFor({
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-02-01T00:00:00.000Z',
    });
    const range = where['createdAt'] as { gte?: Date; lte?: Date };
    assert.ok(range.gte instanceof Date);
    assert.ok(range.lte instanceof Date);
  });
});
