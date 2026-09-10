import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  UserHintDeliveryService,
  subGroupPrefix,
} from '../src/modules/user-hints/services/user-hint-delivery.service';

/**
 * Sub-groups: `payment-attempt` lapses `payment-attempt-method`
 * ════════════════════════════════════════════════════════════
 *
 * `payment_failed` and `payment_failed_method` are two ALTERNATIVE pop-ups on
 * one `payment.failed`, and `hint-templates.ts` keeps them in separate groups
 * on purpose: supersession is unconditional and the order is decided nowhere,
 * so a shared group would let whichever `raise()` landed second destroy the
 * other by coin toss.
 *
 * That separation left the other half of a defect standing. A customer whose
 * card is declined and who retries successfully on another one has an unshown
 * `payment_failed_method` modal queued and a `payment_completed` receipt
 * behind it — and exact-string supersession could not connect the two, because
 * `payment-attempt` and `payment-attempt-method` are different strings. The
 * customer paid, and was then told to change their payment method.
 *
 * A group now also lapses its SUB-GROUPS — the keys that extend it across a
 * `-` boundary — and never the reverse. Everything below is about that one
 * rule and the three ways it could go wrong: matching too far (a group that
 * merely shares a prefix), matching in both directions (which would give the
 * alternative pair back the coin toss), and matching a wildcard (`groupKey` is
 * free text an operator types, and Prisma hands it to LIKE unescaped).
 */

const NOW = new Date('2026-09-10T12:00:00.000Z');

interface FakeHint {
  id: string;
  key: string;
  isActive: boolean;
  isRepeatable: boolean;
  groupKey: string | null;
  ttlHours: number;
}

interface FakeDelivery {
  id: string;
  userId: string;
  hintId: string;
  source: string;
  expiresAt: Date;
  shownAt: Date | null;
  dismissedAt: Date | null;
  actedAt: Date | null;
  createdAt: Date;
}

function hint(key: string, groupKey: string | null): FakeHint {
  return {
    id: 'h-' + key,
    key,
    isActive: true,
    // Every template that carries one of the groups under test is repeatable,
    // and so is every fixture here: a non-repeatable hint would stop at the
    // once-only rule before supersession is reached, and would be testing that
    // rule instead of this one.
    isRepeatable: true,
    groupKey,
    ttlHours: 24,
  };
}

/**
 * `"group_key"::text LIKE ($1 || '%')` — the SQL Prisma 7.9 was observed to
 * emit for `{ startsWith }`, matched the way Postgres matches it.
 *
 * Written out rather than approximated with `String.prototype.startsWith`
 * because the difference between the two IS the thing under test. `startsWith`
 * treats `%` and `_` as ordinary characters; LIKE does not, and Prisma binds
 * the value verbatim with no `ESCAPE` clause, which leaves the column's own
 * default — a backslash — as the only way to spell a literal one. A fake that
 * compared strings would pass whether or not the service escaped anything.
 *
 * The trailing `%` the compiler appends is why this returns true once the
 * bound pattern is exhausted: everything after the prefix matches.
 */
function likeStartsWith(bound: string, value: string): boolean {
  let vi = 0;
  for (let pi = 0; pi < bound.length; pi += 1) {
    const char = bound[pi];
    if (char === '\\') {
      pi += 1;
      const literal = bound[pi];
      // Postgres raises `invalid pattern` for a pattern ending in a lone
      // escape. Loud here too rather than quietly matching something.
      if (literal === undefined) throw new Error('malformed LIKE pattern: trailing escape');
      if (value[vi] !== literal) return false;
      vi += 1;
      continue;
    }
    if (char === '%') return true;
    if (char === '_') {
      if (vi >= value.length) return false;
      vi += 1;
      continue;
    }
    if (value[vi] !== char) return false;
    vi += 1;
  }
  return true;
}

function build(hints: FakeHint[]) {
  const deliveries: FakeDelivery[] = [];
  let seq = 0;
  const prisma = {
    userHint: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        hints.find((h) => h.key === where.key) ?? null,
    },
    userHintDelivery: {
      count: async ({ where }: { where: { userId: string; hintId: string } }) =>
        deliveries.filter((d) => d.userId === where.userId && d.hintId === where.hintId).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const row: FakeDelivery = {
          id: 'del-' + seq,
          shownAt: null,
          dismissedAt: null,
          actedAt: null,
          createdAt: new Date(NOW.getTime() + seq),
          ...(data as unknown as Pick<FakeDelivery, 'userId' | 'hintId' | 'source' | 'expiresAt'>),
        };
        deliveries.push(row);
        return row;
      },
      /**
       * Both supersession statements land here — the exact one and the
       * sub-group one — and it discriminates on the `where` it is handed
       * rather than guessing which caller is asking.
       *
       * Every term is OBEYED, never re-implemented: a stub that applies a
       * constraint the caller did not ask for makes "the service dropped it"
       * indistinguishable from "the service kept it", and a stub that ignores
       * one makes a missing term invisible.
       */
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const w = where as {
          userId?: string;
          shownAt?: null;
          dismissedAt?: null;
          actedAt?: null;
          expiresAt?: { gt: Date };
          hint?: { groupKey: string | { startsWith: string } };
        };
        const hit = deliveries.filter((d) => {
          if (w.userId !== undefined && d.userId !== w.userId) return false;
          if ('shownAt' in w && d.shownAt !== null) return false;
          if ('dismissedAt' in w && d.dismissedAt !== null) return false;
          if ('actedAt' in w && d.actedAt !== null) return false;
          if (w.expiresAt !== undefined && !(d.expiresAt > w.expiresAt.gt)) return false;
          if (w.hint !== undefined) {
            const group = hints.find((x) => x.id === d.hintId)?.groupKey ?? null;
            const term = w.hint.groupKey;
            if (typeof term === 'string') return group === term;
            // NULL LIKE anything is NULL, which is not true — a hint with no
            // group is below nothing.
            if (group === null) return false;
            return likeStartsWith(term.startsWith, group);
          }
          return true;
        });
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
  };
  const service = new UserHintDeliveryService(prisma as never);
  return { service, deliveries };
}

/** Is this delivery still offerable? `nextFor` asks exactly this. */
function live(deliveries: readonly FakeDelivery[], hintId: string): boolean {
  const row = deliveries.find((d) => d.hintId === hintId);
  assert.ok(row !== undefined, `no delivery was queued for ${hintId}`);
  return row.expiresAt > NOW;
}

describe('a group lapses what is below it', () => {
  it('lapses an unshown delivery in a sub-group', async () => {
    // THE DEFECT, in its own words: the card was declined, the customer
    // retried on another one, and the payment went through. The receipt is in
    // `payment-attempt`; the unshown "change your payment method" modal is in
    // `payment-attempt-method`, one level below it.
    const { service, deliveries } = build([
      hint('tpl-payment-failed-method', 'payment-attempt-method'),
      hint('tpl-payment-completed', 'payment-attempt'),
    ]);

    await service.raise({
      userId: 'u1',
      hintKey: 'tpl-payment-failed-method',
      source: 'rule:1',
      now: NOW,
    });
    await service.raise({
      userId: 'u1',
      hintKey: 'tpl-payment-completed',
      source: 'rule:2',
      now: NOW,
    });

    assert.equal(deliveries.length, 2, 'lapsed, not deleted — the once-only rule counts rows');
    assert.equal(
      live(deliveries, 'h-tpl-payment-failed-method'),
      false,
      'a customer who has paid must not be told to change their payment method',
    );
    assert.equal(live(deliveries, 'h-tpl-payment-completed'), true);
  });

  it('reaches a sub-group of a sub-group', async () => {
    // The rule is about the boundary, not about one level of it.
    const { service, deliveries } = build([
      hint('deep', 'payment-attempt-method-card'),
      hint('top', 'payment-attempt'),
    ]);

    await service.raise({ userId: 'u1', hintKey: 'deep', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'top', source: 's', now: NOW });

    assert.equal(live(deliveries, 'h-deep'), false);
  });

  it('carries the fix to the quiet half of the expiry pair', async () => {
    // `EXPIRY` in `hint-templates.ts` is `subscription-expiry`, which makes
    // `subscription-expiry-quiet` a sub-group of it — a relation the const
    // hides from anyone grepping the file for the literal. It is the same
    // defect as the payment one and the same direction of fix: an operator
    // running the quiet warning and the loud expiry notice had a "your
    // subscription ends soon" toast still queued after it already had.
    const { service, deliveries } = build([
      hint('tpl-expire-soon-quiet', 'subscription-expiry-quiet'),
      hint('tpl-subscription-expired', 'subscription-expiry'),
    ]);

    await service.raise({ userId: 'u1', hintKey: 'tpl-expire-soon-quiet', source: 's', now: NOW });
    await service.raise({
      userId: 'u1',
      hintKey: 'tpl-subscription-expired',
      source: 's',
      now: NOW,
    });

    assert.equal(live(deliveries, 'h-tpl-expire-soon-quiet'), false);
  });

  it('still lapses an unshown delivery in the SAME group', async () => {
    // The behaviour the sub-group statement was added beside, not instead of.
    const { service, deliveries } = build([
      hint('tpl-payment-failed', 'payment-attempt'),
      hint('tpl-payment-completed', 'payment-attempt'),
    ]);

    await service.raise({ userId: 'u1', hintKey: 'tpl-payment-failed', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'tpl-payment-completed', source: 's', now: NOW });

    assert.equal(live(deliveries, 'h-tpl-payment-failed'), false);
    assert.equal(live(deliveries, 'h-tpl-payment-completed'), true);
  });
});

describe('and nothing else', () => {
  it('does NOT let a sub-group lapse its parent', async () => {
    // The asymmetry the alternative pair is built on. `payment_failed` and
    // `payment_failed_method` fire on one `payment.failed`, on separate
    // `setImmediate`s, in an order nothing decides — so a rule that worked
    // both ways would pick the survivor at random, which is the defect their
    // separate groups exist to prevent. One way, it cannot.
    const { service, deliveries } = build([
      hint('tpl-payment-failed', 'payment-attempt'),
      hint('tpl-payment-failed-method', 'payment-attempt-method'),
    ]);

    await service.raise({ userId: 'u1', hintKey: 'tpl-payment-failed', source: 's', now: NOW });
    await service.raise({
      userId: 'u1',
      hintKey: 'tpl-payment-failed-method',
      source: 's',
      now: NOW,
    });

    assert.equal(
      live(deliveries, 'h-tpl-payment-failed'),
      true,
      'the half that raised first must survive the half that raised second',
    );
    assert.equal(live(deliveries, 'h-tpl-payment-failed-method'), true);
  });

  it('does not touch a group that shares a prefix without the boundary', async () => {
    // `payment-attempts` is a different group that happens to begin with the
    // same letters. Without the `-` the rule would be "any key starting with
    // this one", which is not a hierarchy — it is a collision.
    const { service, deliveries } = build([
      hint('plural', 'payment-attempts'),
      hint('tpl-payment-completed', 'payment-attempt'),
    ]);

    await service.raise({ userId: 'u1', hintKey: 'plural', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'tpl-payment-completed', source: 's', now: NOW });

    assert.equal(live(deliveries, 'h-plural'), true);
  });

  it('does not read a wildcard in a hand-typed group key', async () => {
    // `groupKey` is a free-text field with a 64-character cap and no character
    // set, and Prisma binds it into `LIKE ($1 || '%')` verbatim. Unescaped,
    // a group named `pay%` would compile to `LIKE 'pay%-%'` and lapse every
    // pending hint whose group starts with `pay` and contains a hyphen — here,
    // a payment warning that has nothing to do with it.
    const { service, deliveries } = build([
      hint('unrelated', 'payment-attempt'),
      hint('wild', 'pay%'),
    ]);

    await service.raise({ userId: 'u1', hintKey: 'unrelated', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'wild', source: 's', now: NOW });

    assert.equal(live(deliveries, 'h-unrelated'), true);
  });

  it('does not read a single-character wildcard either', async () => {
    // `_` is the other one, and the likelier accident: an operator who names
    // groups `payment_attempt` in snake case would otherwise have that key
    // match `paymentXattempt-…` as well as its own children.
    const { service, deliveries } = build([
      hint('unrelated', 'paymentXattempt-method'),
      hint('snake', 'payment_attempt'),
    ]);

    await service.raise({ userId: 'u1', hintKey: 'unrelated', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'snake', source: 's', now: NOW });

    assert.equal(live(deliveries, 'h-unrelated'), true);
  });

  it('still finds the real sub-groups of a key that contains a wildcard', async () => {
    // Escaping must make those characters literal, not make the key inert.
    const { service, deliveries } = build([hint('child', 'pay%-method'), hint('wild', 'pay%')]);

    await service.raise({ userId: 'u1', hintKey: 'child', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'wild', source: 's', now: NOW });

    assert.equal(live(deliveries, 'h-child'), false);
  });

  it('lapses nothing for a hint with no group', async () => {
    const { service, deliveries } = build([
      hint('grouped', 'payment-attempt-method'),
      hint('ungrouped', null),
    ]);

    await service.raise({ userId: 'u1', hintKey: 'grouped', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'ungrouped', source: 's', now: NOW });

    assert.equal(live(deliveries, 'h-grouped'), true);
  });

  it('treats a BLANK group key as no group at all', async () => {
    // Unreachable through the DTO — `groupKey` is trimmed and an empty string
    // is stored as NULL — so this is about a row some other hand wrote. Read
    // as a group, an empty key does two things nobody chose: its sub-group
    // pattern is `-`, which lapses every pending hint whose group begins with
    // a hyphen, and its exact match gathers every other blank-group hint into
    // one group of unrelated things. Read as no group, it does neither.
    const { service, deliveries } = build([
      hint('hyphen-first', '-orphan'),
      hint('other-blank', ''),
      hint('blank', ''),
    ]);

    await service.raise({ userId: 'u1', hintKey: 'hyphen-first', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'other-blank', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'blank', source: 's', now: NOW });

    assert.equal(live(deliveries, 'h-hyphen-first'), true, 'a blank group is below nothing');
    assert.equal(live(deliveries, 'h-other-blank'), true, 'and is not a group of its own');
  });

  it('leaves an ALREADY SHOWN delivery in a sub-group alone', async () => {
    // The new statement carries the same three pending terms as the old one.
    // A shown row is evidence of what the customer saw, and rewriting it to
    // tidy a queue is how a delivery log stops being evidence.
    const { service, deliveries } = build([
      hint('tpl-payment-failed-method', 'payment-attempt-method'),
      hint('tpl-payment-completed', 'payment-attempt'),
    ]);
    await service.raise({
      userId: 'u1',
      hintKey: 'tpl-payment-failed-method',
      source: 's',
      now: NOW,
    });
    deliveries[0].shownAt = NOW;

    await service.raise({ userId: 'u1', hintKey: 'tpl-payment-completed', source: 's', now: NOW });

    assert.equal(live(deliveries, 'h-tpl-payment-failed-method'), true);
  });

  it('leaves a CLOSED delivery in a sub-group alone', async () => {
    // The cabinet stamps "shown" fire-and-forget and swallows the failure, so
    // a delivery the customer read and dismissed can carry a null `shownAt`
    // for ever. `dismissedAt`/`actedAt` are what actually say "closed".
    const { service, deliveries } = build([
      hint('tpl-payment-failed-method', 'payment-attempt-method'),
      hint('tpl-payment-completed', 'payment-attempt'),
    ]);
    await service.raise({
      userId: 'u1',
      hintKey: 'tpl-payment-failed-method',
      source: 's',
      now: NOW,
    });
    deliveries[0].dismissedAt = NOW;

    await service.raise({ userId: 'u1', hintKey: 'tpl-payment-completed', source: 's', now: NOW });

    assert.equal(
      deliveries[0].expiresAt > NOW,
      true,
      'a closed row is history; supersession must not rewrite it',
    );
  });

  it('does not reach into another person’s queue', async () => {
    const { service, deliveries } = build([
      hint('tpl-payment-failed-method', 'payment-attempt-method'),
      hint('tpl-payment-completed', 'payment-attempt'),
    ]);

    await service.raise({
      userId: 'u2',
      hintKey: 'tpl-payment-failed-method',
      source: 's',
      now: NOW,
    });
    await service.raise({ userId: 'u1', hintKey: 'tpl-payment-completed', source: 's', now: NOW });

    const theirs = deliveries.find((d) => d.userId === 'u2');
    assert.ok(theirs !== undefined);
    assert.equal(theirs.expiresAt > NOW, true);
  });
});

describe('the pattern itself', () => {
  it('adds the boundary', () => {
    assert.equal(subGroupPrefix('payment-attempt'), 'payment-attempt-');
  });

  it('leaves an ordinary key untouched', () => {
    // The escape is a no-op for every template key and any sane hand-typed
    // one, which is what keeps the emitted pattern readable in a query log.
    assert.equal(subGroupPrefix('subscription-expiry'), 'subscription-expiry-');
  });

  it('escapes the three characters LIKE reads', () => {
    assert.equal(subGroupPrefix('a%b_c\\d'), 'a\\%b\\_c\\\\d-');
  });

  it('answers null for a key that is blank or only spaces', () => {
    assert.equal(subGroupPrefix(''), null);
    assert.equal(subGroupPrefix('   '), null);
  });
});
