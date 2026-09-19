import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONNECT_HELP_SHOW_MAX_CHECK_AGE_MS,
  UserHintDeliveryService,
} from '../src/modules/user-hints/services/user-hint-delivery.service';

/**
 * The queue that owes hints to people
 * ═══════════════════════════════════
 *
 * A hint is EARNED when something happens and can only be SHOWN when the
 * customer next appears, and nothing lines those two moments up: a card
 * webhook lands before the browser finishes redirecting back, a crypto payment
 * confirms twenty minutes after the tab closed, an operator unbinds a device at
 * three in the morning. Everything below is a consequence of that gap.
 */

const NOW = new Date('2026-08-29T12:00:00.000Z');

interface FakeHint {
  id: string;
  key: string;
  isActive: boolean;
  isRepeatable: boolean;
  groupKey: string | null;
  ttlHours: number;
  surfaces: string[];
  formFactors: string[];
  titleRu: string;
  bodyRu: string;
  titleEn: string | null;
  bodyEn: string | null;
  mode: string;
  tone: string;
  ctaKind: string;
  ctaLabelRu: string | null;
  ctaLabelEn: string | null;
  ctaTarget: string | null;
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

function hint(over: Partial<FakeHint> = {}): FakeHint {
  return {
    id: 'hint-' + (over.key ?? 'a'),
    key: 'a',
    isActive: true,
    isRepeatable: false,
    groupKey: null,
    ttlHours: 24,
    surfaces: [],
    formFactors: [],
    titleRu: 'Заголовок',
    bodyRu: 'Текст',
    titleEn: null,
    bodyEn: null,
    mode: 'MODAL',
    tone: 'INFO',
    ctaKind: 'NONE',
    ctaLabelRu: null,
    ctaLabelEn: null,
    ctaTarget: null,
    ...over,
  };
}

/**
 * What the connect-help guard reads about one person: whether a live
 * subscription of theirs is not known to have connected (`waiting`), whether
 * one of those was READ within the last fifteen minutes and found never
 * connected (`fresh`, default false), and their notification preferences.
 * The query's own meaning is proved on PostgreSQL
 * (`user-hint-delivery-postgres.spec.ts`); here it is an answer.
 */
interface FakePerson {
  readonly waiting: boolean;
  readonly fresh?: boolean;
  readonly prefs?: unknown;
}

/**
 * A group term of the queue read, the way PostgreSQL reads it — NULL
 * included: `group_key = 'x'` and `LIKE` are NULL for a hint with no group,
 * `NOT` of NULL is NULL, and a row passes only on TRUE. A clause this fake
 * does not know fails the case rather than passing it.
 */
function groupTerm(term: Record<string, unknown>, groupKey: string | null): boolean | null {
  if (Array.isArray(term.OR)) {
    const parts = (term.OR as ReadonlyArray<Record<string, unknown>>).map((part) => groupTerm(part, groupKey));
    return parts.includes(true) ? true : parts.includes(null) ? null : false;
  }
  if (term.NOT !== undefined) {
    const inner = groupTerm(term.NOT as Record<string, unknown>, groupKey);
    return inner === null ? null : !inner;
  }
  if ('groupKey' in term) {
    const condition = term.groupKey;
    if (condition === null) return groupKey === null;
    if (groupKey === null) return null;
    if (typeof condition === 'string') return groupKey === condition;
    const prefix = (condition as { startsWith?: string }).startsWith;
    if (typeof prefix === 'string') return groupKey.startsWith(prefix);
  }
  throw new Error(`the fake does not understand this group term: ${JSON.stringify(term)}`);
}

/**
 * The door arm of the delivery filter, read the way PostgreSQL reads it —
 * NULL included: `NOT (NULL LIKE '@%')` is NULL, and an OR of NULLs is not
 * true. A clause this fake does not know fails the case rather than passing it.
 */
function doorTermMatches(term: Record<string, unknown>, h: FakeHint): boolean {
  const clauses = term.OR as ReadonlyArray<Record<string, unknown>>;
  return clauses.some((clause) => {
    if ('ctaKind' in clause) return h.ctaKind !== (clause.ctaKind as { not: string }).not;
    if ('NOT' in clause) {
      const prefix = (clause.NOT as { ctaTarget: { startsWith: string } }).ctaTarget.startsWith;
      return h.ctaTarget !== null && !h.ctaTarget.startsWith(prefix);
    }
    if ('ctaTarget' in clause) {
      if (clause.ctaTarget === null) return h.ctaTarget === null;
      const list = (clause.ctaTarget as { in?: readonly string[] }).in;
      if (list !== undefined) return h.ctaTarget !== null && list.includes(h.ctaTarget);
    }
    throw new Error(`the fake does not understand this door clause: ${JSON.stringify(clause)}`);
  });
}

function isDoorTerm(term: Record<string, unknown>): boolean {
  return (
    Array.isArray(term.OR) &&
    (term.OR as ReadonlyArray<Record<string, unknown>>).some((clause) => 'ctaKind' in clause)
  );
}

function build(
  hints: FakeHint[],
  deliveries: FakeDelivery[] = [],
  language?: string,
  people: Readonly<Record<string, FakePerson>> = {},
) {
  /** Every read the connect-help guard made: the statement and what it bound. */
  const guardReads: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  let seq = 0;
  /**
   * What happened on the way to the queue, in order: `begin`/`commit` for each
   * transaction, `tx.lock` for the advisory lock, `tx.<method>` for every
   * statement made THROUGH the transaction client, and `root.hint` for a hint
   * read that went past it. A statement that went to the root client leaves no
   * `tx.` entry, which is how a case sees it.
   */
  const ops: string[] = [];
  const locks: Array<{ readonly text: string; readonly values: readonly unknown[] }> = [];
  /** Greater than zero while the transaction client is delegating to the root one. */
  let delegating = 0;
  const feedRows: Array<{
    userId: string;
    type: string;
    payload: Record<string, unknown>;
    readAt: Date | null;
  }> = [];
  const prisma = {
    // The connect-help guard: its one statement, answered from `people`.
    $queryRaw: async (query: { readonly sql: string; readonly values: readonly unknown[] }) => {
      if (!/AS "waiting"/.test(query.sql) || !/AS "fresh"/.test(query.sql)) {
        throw new Error(`the fake does not know this statement: ${query.sql.slice(0, 120)}`);
      }
      guardReads.push({ sql: query.sql, values: query.values });
      // The person is the one string bound (every other value is an instant).
      const userId = query.values.find((value): value is string => typeof value === 'string') ?? '';
      const person = people[userId];
      if (person === undefined) return [];
      return [{ prefs: person.prefs ?? null, waiting: person.waiting, fresh: person.fresh ?? false }];
    },
    // The recipient's language, for the feed copy the popup leaves behind.
    user: {
      findUnique: async () => ({ language: language ?? 'RU' }),
    },
    // Where that copy lands. Modelled rather than stubbed away: without it the
    // copy failed inside its own catch and every test here stayed green while
    // the safety net was not being written at all.
    userNotificationEvent: {
      create: async ({
        data,
      }: {
        data: { userId: string; type: string; payload: Record<string, unknown>; readAt?: Date };
      }) => {
        feedRows.push({
          userId: data.userId,
          type: data.type,
          payload: data.payload,
          readAt: data.readAt ?? null,
        });
        return { id: 'feed-' + feedRows.length };
      },
    },
    userHint: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        // Only when the service asked the ROOT client: the transaction client
        // below delegates here, and says so itself.
        if (delegating === 0) ops.push('root.hint');
        return hints.find((h) => h.key === where.key) ?? null;
      },
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
          ...(data as unknown as Omit<FakeDelivery, 'id' | 'shownAt' | 'dismissedAt' | 'actedAt' | 'createdAt'>),
        };
        deliveries.push(row);
        return row;
      },
      /**
       * ONE `updateMany`, serving both callers.
       *
       * There were briefly two keys of this name in this object, and the second
       * silently won — the duplicate-key trap this codebase has hit before. It
       * has to discriminate on the `where` it is handed, not on which caller it
       * guesses is asking.
       */
      // The delivery row plus its hint, as `copyToFeed` reads it after a first
      // show. Modelled from the same fixtures, so the copy describes the hint
      // that was actually shown rather than one the test invented.
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = deliveries.find((d) => d.id === where.id);
        if (!row) return null;
        const h = hints.find((x) => x.id === row.hintId);
        return h === undefined ? null : { hint: h };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const w = where as {
          id?: string;
          userId?: string;
          hintId?: string;
          shownAt?: null;
          dismissedAt?: null;
          actedAt?: null;
          expiresAt?: { gt: Date };
          hint?: { groupKey?: unknown; OR?: ReadonlyArray<{ groupKey: unknown }> };
        };
        const hit = deliveries.filter((d) => {
          if (w.id !== undefined && d.id !== w.id) return false;
          if (w.userId !== undefined && d.userId !== w.userId) return false;
          if (w.hintId !== undefined && d.hintId !== w.hintId) return false;
          // OBEYED, not re-implemented: a stub that applies a constraint the
          // caller did not ask for makes "the service dropped it" look exactly
          // like "the service kept it". Each term on its own for that reason —
          // `dismissedAt` used to imply `actedAt` here, so a statement that
          // forgot `actedAt: null` looked exactly like one that had it.
          if ('shownAt' in w && d.shownAt !== null) return false;
          if ('dismissedAt' in w && d.dismissedAt !== null) return false;
          if ('actedAt' in w && d.actedAt !== null) return false;
          if (w.expiresAt !== undefined && !(d.expiresAt > w.expiresAt.gt)) return false;
          if (w.hint !== undefined) {
            const h = hints.find((x) => x.id === d.hintId);
            const family = w.hint.OR;
            if (family !== undefined) {
              // The connect-help lapse: the group itself, or a key below it.
              const inFamily = family.some(({ groupKey }) =>
                typeof groupKey === 'string'
                  ? h?.groupKey === groupKey
                  : typeof h?.groupKey === 'string' &&
                    h.groupKey.startsWith((groupKey as { startsWith: string }).startsWith),
              );
              if (!inFamily) return false;
            } else if (h?.groupKey !== w.hint.groupKey) return false;
          }
          return true;
        });
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
      /**
       * The pending-hint read. The audience filter now travels in the QUERY, so
       * this stub reads that filter rather than re-running the old in-memory
       * matcher — the point of the change being that the filter and the row
       * bound stopped fighting each other.
       */
      findFirst: async ({
        where,
        orderBy,
      }: {
        where: Record<string, unknown>;
        orderBy?: { createdAt?: 'asc' | 'desc' };
      }) => {
        const w = where as {
          userId: string;
          shownAt: null;
          dismissedAt?: null;
          actedAt?: null;
          expiresAt: { gt: Date };
          hint: {
            isActive: boolean;
            AND?: ReadonlyArray<Record<string, unknown>>;
            /** The held connect-help group, read past (`OUTSIDE_CONNECT_HELP_FAMILY`). */
            OR?: ReadonlyArray<Record<string, unknown>>;
          };
        };
        const termMatches = (
          term: Record<string, unknown>,
          values: readonly string[],
        ): boolean => {
          const clauses = (term.OR as ReadonlyArray<Record<string, unknown>>) ?? [term];
          return clauses.some((clause) => {
            const spec = (clause.surfaces ?? clause.formFactors) as
              | { isEmpty?: boolean; has?: string }
              | undefined;
            if (spec === undefined) return false;
            if (spec.isEmpty === true) return values.length === 0;
            return spec.has !== undefined && values.includes(spec.has);
          });
        };
        const rows = deliveries
          .filter((d) => d.userId === w.userId && d.shownAt === null)
          .filter((d) => !('dismissedAt' in w) || d.dismissedAt === null)
          .filter((d) => !('actedAt' in w) || d.actedAt === null)
          .filter((d) => d.expiresAt > w.expiresAt.gt)
          .map((d) => ({ ...d, hint: hints.find((h) => h.id === d.hintId)! }))
          .filter((d) => d.hint.isActive === w.hint.isActive)
          .filter((d) => w.hint.OR === undefined || groupTerm({ OR: w.hint.OR }, d.hint.groupKey) === true)
          .filter((d) =>
            (w.hint.AND ?? []).every((term) => {
              // The mode term is a plain `in`, not the empty-or-has shape the
              // two audience terms share, so it is matched on its own. An
              // unrecognised term must not silently pass: a filter this fake
              // does not understand is a filter nothing here is testing.
              const mode = term.mode as { in?: readonly string[] } | undefined;
              if (mode !== undefined) return (mode.in ?? []).includes(d.hint.mode);
              if (isDoorTerm(term)) return doorTermMatches(term, d.hint);
              return termMatches(
                term,
                JSON.stringify(term).includes('surfaces')
                  ? d.hint.surfaces
                  : d.hint.formFactors,
              );
            }),
          )
          .sort((a, b) => {
            const delta = a.createdAt.getTime() - b.createdAt.getTime();
            return orderBy?.createdAt === 'desc' ? -delta : delta;
          });
        return rows[0] ?? null;
      },
    },
  };

  const transactionClient = {
    ...prisma,
    userHint: {
      findUnique: async (args: { where: { key: string } }) => {
        ops.push('tx.hint');
        delegating += 1;
        try {
          return await prisma.userHint.findUnique(args);
        } finally {
          delegating -= 1;
        }
      },
    },
    // A proxy rather than a copy, so a case that swaps one of the root
    // methods for a recorder still sees the calls made through the
    // transaction.
    userHintDelivery: new Proxy(prisma.userHintDelivery, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          ops.push(`tx.${String(property)}`);
          return value.apply(target, args);
        };
      },
    }),
    $executeRaw: async (query: { readonly strings: readonly string[]; readonly values: readonly unknown[] }) => {
      ops.push('tx.lock');
      locks.push({ text: query.strings.join('?'), values: query.values });
      return 0;
    },
  };
  /** The options each transaction was opened with, in order. */
  const transactionOptions: unknown[] = [];
  const client = Object.assign(prisma, {
    $transaction: async <T>(work: (tx: typeof transactionClient) => Promise<T>, options?: unknown): Promise<T> => {
      transactionOptions.push(options);
      ops.push('begin');
      const result = await work(transactionClient);
      ops.push('commit');
      return result;
    },
  });
  const service = new UserHintDeliveryService(client as never);
  return { service, deliveries, prisma, feedRows, ops, locks, transactionOptions, guardReads };
}

/**
 * A cabinet that can draw both modes — the current one.
 *
 * `modes` is not optional on `HintAudience` on purpose: a caller that forgets
 * it should not silently inherit "everything", because the whole point of the
 * field is that silence means the OLD cabinet, not the new one.
 */
const AUDIENCE = { surface: 'browser', formFactor: 'mobile', modes: ['MODAL', 'TOAST'] };

describe('raising a hint', () => {
  it('queues it with an expiry resolved from the hint TTL', async () => {
    const { service, deliveries } = build([hint({ key: 'connect', ttlHours: 48 })]);

    await service.raise({ userId: 'u1', hintKey: 'connect', source: 'moment:x', now: NOW });

    assert.equal(deliveries.length, 1);
    assert.equal(
      deliveries[0].expiresAt.getTime(),
      NOW.getTime() + 48 * 60 * 60 * 1000,
      'the expiry is stamped at insert, not read live — see the service note',
    );
  });

  it('queues nothing for a hint that is switched off', async () => {
    const { service, deliveries } = build([hint({ key: 'off', isActive: false })]);

    const row = await service.raise({ userId: 'u1', hintKey: 'off', source: 's', now: NOW });

    assert.equal(row, null);
    assert.deepStrictEqual(deliveries, []);
  });

  it('queues nothing for a hint nobody authored', async () => {
    // Always a mistake — a rule naming a hint that does not exist does nothing
    // on every single fire — so the service logs it loudly and answers null.
    const { service } = build([]);

    assert.equal(
      await service.raise({ userId: 'u1', hintKey: 'ghost', source: 's', now: NOW }),
      null,
    );
  });
});

describe('once means once', () => {
  it('refuses a second delivery of a non-repeatable hint', async () => {
    const { service, deliveries } = build([hint({ key: 'welcome' })]);
    await service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });

    await service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });

    assert.equal(deliveries.length, 1);
  });

  it('counts a delivery that is still UNSHOWN', async () => {
    // The subtle half. If "once" only counted shown ones, a customer who buys
    // twice in a week meets the same onboarding modal twice — the first copy is
    // still sitting in the queue unseen.
    const { service, deliveries } = build([hint({ key: 'welcome' })]);
    await service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });
    assert.equal(deliveries[0].shownAt, null, 'precondition: still unshown');

    await service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });

    assert.equal(deliveries.length, 1);
  });

  it('allows repeats when the hint says so', async () => {
    const { service, deliveries } = build([hint({ key: 'renew', isRepeatable: true })]);

    await service.raise({ userId: 'u1', hintKey: 'renew', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'renew', source: 's', now: NOW });

    assert.equal(deliveries.length, 2);
  });
});

describe('one purchase must not become four modals', () => {
  it('supersedes an unshown hint in the same group', async () => {
    // A first purchase through a referral link with a promo code emits four
    // events within seconds. An operator with a hint on each has queued four
    // modals for one act; the shared group is how they say "these are the same
    // thing".
    const hints = [
      hint({ key: 'paid', id: 'h-paid', groupKey: 'purchase' }),
      hint({ key: 'created', id: 'h-created', groupKey: 'purchase' }),
    ];
    const { service, deliveries } = build(hints);

    await service.raise({ userId: 'u1', hintKey: 'paid', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'created', source: 's', now: NOW });

    // BOTH rows survive — the older one LAPSED rather than being deleted.
    // The once-only rule counts prior deliveries, so deleting a superseded row
    // erased the evidence that a non-repeatable hint had already been sent, and
    // the customer's next purchase delivered it a second time.
    assert.equal(deliveries.length, 2);
    const live = deliveries.filter((d) => d.expiresAt > NOW);
    assert.equal(live.length, 1, 'exactly one is still offerable');
    assert.equal(live[0].hintId, 'h-created', 'the newest wins');
  });

  it('leaves an ALREADY SHOWN delivery alone', async () => {
    // History is not tidied to make room. A shown row is evidence of what the
    // customer saw, and rewriting it would make the delivery log useless for
    // the one question it answers.
    const hints = [
      hint({ key: 'paid', id: 'h-paid', groupKey: 'purchase' }),
      hint({ key: 'created', id: 'h-created', groupKey: 'purchase' }),
    ];
    const { service, deliveries } = build(hints);
    await service.raise({ userId: 'u1', hintKey: 'paid', source: 's', now: NOW });
    deliveries[0].shownAt = NOW;

    await service.raise({ userId: 'u1', hintKey: 'created', source: 's', now: NOW });

    assert.equal(deliveries.length, 2);
  });

  it('does not touch another person’s queue', async () => {
    const hints = [
      hint({ key: 'paid', id: 'h-paid', groupKey: 'purchase' }),
      hint({ key: 'created', id: 'h-created', groupKey: 'purchase' }),
    ];
    const { service, deliveries } = build(hints);
    await service.raise({ userId: 'u2', hintKey: 'paid', source: 's', now: NOW });

    await service.raise({ userId: 'u1', hintKey: 'created', source: 's', now: NOW });

    assert.equal(deliveries.filter((d) => d.userId === 'u2').length, 1);
  });
});

describe('handing one over', () => {
  it('returns the oldest first, because a sequence only reads in order', async () => {
    // "Your card was declined" belongs before "your subscription ended", never
    // after.
    const hints = [hint({ key: 'declined', id: 'h1' }), hint({ key: 'ended', id: 'h2' })];
    const { service } = build(hints);
    await service.raise({ userId: 'u1', hintKey: 'declined', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'ended', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: AUDIENCE,
      now: NOW,
    });

    assert.equal(next?.key, 'declined');
  });

  it('returns one at a time', async () => {
    // Three queued hints must not mean a modal on every screen the customer
    // walks through.
    const hints = [hint({ key: 'a', id: 'h1' }), hint({ key: 'b', id: 'h2' })];
    const { service } = build(hints);
    await service.raise({ userId: 'u1', hintKey: 'a', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'b', source: 's', now: NOW });

    const first = await service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW });

    assert.equal(typeof first?.deliveryId, 'string');
    assert.equal(first?.key, 'a');
  });

  it('skips one that has lapsed', async () => {
    const { service } = build([hint({ key: 'stale', ttlHours: 1 })]);
    await service.raise({ userId: 'u1', hintKey: 'stale', source: 's', now: NOW });

    const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: AUDIENCE,
      now: later,
    });

    assert.equal(next, null);
  });

  it('skips one whose hint was switched off after it was queued', async () => {
    // Read live from the library, which is what makes disabling work without
    // anybody sweeping the queue — and makes re-enabling resume it.
    const hints = [hint({ key: 'paused' })];
    const { service } = build(hints);
    await service.raise({ userId: 'u1', hintKey: 'paused', source: 's', now: NOW });

    hints[0].isActive = false;
    assert.equal(
      await service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW }),
      null,
    );

    hints[0].isActive = true;
    const resumed = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: AUDIENCE,
      now: NOW,
    });
    assert.equal(resumed?.key, 'paused');
  });
});

describe('a hint shown in the wrong place is worse than none', () => {
  it('skips a browser-only hint for somebody inside Telegram', async () => {
    // "Install the app" to somebody running the installed app, "open our bot"
    // to somebody already in Telegram — send those and customers learn to
    // dismiss hints unread, taking the useful ones with them.
    const { service } = build([hint({ key: 'install', surfaces: ['browser'] })]);
    await service.raise({ userId: 'u1', hintKey: 'install', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: { surface: 'tma', formFactor: 'mobile', modes: ['MODAL', 'TOAST'] },
      now: NOW,
    });

    assert.equal(next, null);
  });

  it('shows it on the surface it was meant for', async () => {
    const { service } = build([hint({ key: 'install', surfaces: ['browser'] })]);
    await service.raise({ userId: 'u1', hintKey: 'install', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: { surface: 'browser', formFactor: 'mobile', modes: ['MODAL', 'TOAST'] },
      now: NOW,
    });

    assert.equal(next?.key, 'install');
  });

  it('treats an empty list as “everywhere”, which is the common case', async () => {
    const { service } = build([hint({ key: 'any', surfaces: [], formFactors: [] })]);
    await service.raise({ userId: 'u1', hintKey: 'any', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: { surface: 'tma', formFactor: 'desktop', modes: ['MODAL', 'TOAST'] },
      now: NOW,
    });

    assert.equal(next?.key, 'any');
  });

  it('skips a mobile-only hint on a desktop', async () => {
    const { service } = build([hint({ key: 'phone', formFactors: ['mobile'] })]);
    await service.raise({ userId: 'u1', hintKey: 'phone', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: { surface: 'browser', formFactor: 'desktop', modes: ['MODAL', 'TOAST'] },
      now: NOW,
    });

    assert.equal(next, null);
  });

  it('passes over an unsuitable one and offers the next', async () => {
    // The filter must not stop the queue — it skips, it does not block.
    const hints = [
      hint({ key: 'install', id: 'h1', surfaces: ['browser'] }),
      hint({ key: 'connect', id: 'h2' }),
    ];
    const { service } = build(hints);
    await service.raise({ userId: 'u1', hintKey: 'install', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'connect', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: { surface: 'tma', formFactor: 'mobile', modes: ['MODAL', 'TOAST'] },
      now: NOW,
    });

    assert.equal(next?.key, 'connect');
  });
});

describe('locale', () => {
  it('uses the English copy when there is one', async () => {
    const { service } = build([
      hint({ key: 'x', titleEn: 'Title', bodyEn: 'Body', ctaLabelRu: 'Открыть', ctaLabelEn: 'Open' }),
    ]);
    await service.raise({ userId: 'u1', hintKey: 'x', source: 's', now: NOW });

    const next = await service.nextFor({ userId: 'u1', locale: 'en', audience: AUDIENCE, now: NOW });

    assert.equal(next?.title, 'Title');
    assert.equal(next?.ctaLabel, 'Open');
  });

  it('falls back to Russian when the English copy is missing', async () => {
    // Same rule the notification templates follow: an untranslated hint is
    // delivered in Russian rather than delivered blank.
    const { service } = build([hint({ key: 'x', titleEn: null })]);
    await service.raise({ userId: 'u1', hintKey: 'x', source: 's', now: NOW });

    const next = await service.nextFor({ userId: 'u1', locale: 'en', audience: AUDIENCE, now: NOW });

    assert.equal(next?.title, 'Заголовок');
  });
});

describe('recording what happened to it', () => {
  it('stamps shown once and only once', async () => {
    const { service, deliveries } = build([hint({ key: 'x' })]);
    await service.raise({ userId: 'u1', hintKey: 'x', source: 's', now: NOW });
    const id = deliveries[0].id;

    assert.equal(await service.markShown(id, 'u1'), true);
    const first = deliveries[0].shownAt;
    assert.equal(await service.markShown(id, 'u1'), false, 'a re-render must not re-stamp');
    assert.equal(deliveries[0].shownAt, first);
  });

  it('refuses to stamp another person’s delivery', async () => {
    const { service, deliveries } = build([hint({ key: 'x' })]);
    await service.raise({ userId: 'u1', hintKey: 'x', source: 's', now: NOW });

    assert.equal(await service.markShown(deliveries[0].id, 'u2'), false);
    assert.equal(deliveries[0].shownAt, null);
  });

  it('keeps “followed” and “closed” apart', async () => {
    // Collapsing them makes "this hint helps" indistinguishable from "people
    // close it to be rid of it" — the only question worth asking of a hint.
    const { service, deliveries } = build([hint({ key: 'x' })]);
    await service.raise({ userId: 'u1', hintKey: 'x', source: 's', now: NOW });

    await service.close(deliveries[0].id, 'u1', 'acted');

    assert.notEqual(deliveries[0].actedAt, null);
    assert.equal(deliveries[0].dismissedAt, null);
  });

  it('records only the first outcome', async () => {
    const { service, deliveries } = build([hint({ key: 'x' })]);
    await service.raise({ userId: 'u1', hintKey: 'x', source: 's', now: NOW });
    await service.close(deliveries[0].id, 'u1', 'dismissed');

    assert.equal(await service.close(deliveries[0].id, 'u1', 'acted'), false);
    assert.equal(deliveries[0].actedAt, null);
  });
});

describe('the defects a review found, pinned', () => {
  it('never offers a delivery the customer already closed', async () => {
    // The cabinet stamps "shown" fire-and-forget and swallows a failure, so a
    // hint somebody read and dismissed can carry a null `shownAt` for ever.
    // Gating on `shownAt` alone brought it back on every page load until it
    // expired, with no way for them to be rid of it.
    const { service, deliveries } = build([hint({ key: 'x' })]);
    await service.raise({ userId: 'u1', hintKey: 'x', source: 's', now: NOW });
    deliveries[0].dismissedAt = NOW;

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: AUDIENCE,
      now: NOW,
    });

    assert.equal(next, null);
  });

  it('never offers a delivery the customer ACTED on', async () => {
    // The other arm of the same filter, and it had no test at all — delete
    // `actedAt: null` from the query and every hint test stayed green.
    //
    // `close(…, 'acted')` stamps `actedAt` and leaves `dismissedAt` null, so
    // this is the customer who did the very thing the hint asked for: they
    // pressed the button and were sent where it pointed. Offering it again on
    // the next page load is the worst version of this feature — the people it
    // nags hardest are the ones it worked on.
    const { service, deliveries } = build([hint({ key: 'x' })]);
    await service.raise({ userId: 'u1', hintKey: 'x', source: 's', now: NOW });
    deliveries[0].actedAt = NOW;

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: AUDIENCE,
      now: NOW,
    });

    assert.equal(next, null);
  });

  it('does not deliver a once-only hint twice after a supersession', async () => {
    // THE bug. Purchase one supersedes `welcome`; purchase two must not resend
    // it, and it did, because the superseded row had been deleted.
    const hints = [
      hint({ key: 'welcome', id: 'h-w', groupKey: 'purchase' }),
      hint({ key: 'paid', id: 'h-p', groupKey: 'purchase' }),
    ];
    const { service, deliveries } = build(hints);

    await service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'paid', source: 's', now: NOW });
    const again = await service.raise({
      userId: 'u1',
      hintKey: 'welcome',
      source: 's',
      now: NOW,
    });

    assert.equal(again, null, 'the second purchase must not resend it');
    assert.equal(deliveries.filter((d) => d.hintId === 'h-w').length, 1);
  });

  it('skips a surface-restricted hint when the surface is UNKNOWN', async () => {
    // "We cannot tell where this person is" must not be turned into a match.
    // Defaulting an absent surface to `browser` showed "install the app"
    // inside Telegram — the exact thing the restriction exists to prevent.
    const { service } = build([hint({ key: 'install', surfaces: ['browser'] })]);
    await service.raise({ userId: 'u1', hintKey: 'install', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: { surface: null, formFactor: null, modes: ['MODAL', 'TOAST'] },
      now: NOW,
    });

    assert.equal(next, null);
  });

  it('still offers an unrestricted hint when the surface is unknown', async () => {
    // The positive control: unknown narrows, it does not blank the queue.
    const { service } = build([hint({ key: 'any' })]);
    await service.raise({ userId: 'u1', hintKey: 'any', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: { surface: null, formFactor: null, modes: ['MODAL', 'TOAST'] },
      now: NOW,
    });

    assert.equal(next?.key, 'any');
  });

  it('is not starved by unsuitable deliveries sitting in front', async () => {
    // A delivery failing the audience filter is never shown, never closed and
    // never removed, so under a bounded page it sat at the head for its whole
    // TTL. Twenty of them made every later hint — a failed payment among
    // them — unreachable for up to ninety days.
    const hints = [
      hint({ key: 'tma-only', id: 'h-tma', surfaces: ['tma'], isRepeatable: true }),
      hint({ key: 'wanted', id: 'h-want' }),
    ];
    const { service } = build(hints);
    for (let i = 0; i < 25; i += 1) {
      await service.raise({ userId: 'u1', hintKey: 'tma-only', source: 's', now: NOW });
    }
    await service.raise({ userId: 'u1', hintKey: 'wanted', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: { surface: 'browser', formFactor: 'mobile', modes: ['MODAL', 'TOAST'] },
      now: NOW,
    });

    assert.equal(next?.key, 'wanted');
  });
});

describe('the words survive the popup being closed', () => {
  /** Queue a hint and put it on screen, which is when the copy is written. */
  async function raiseAndShow(h: ReturnType<typeof build>, key: string) {
    const delivery = await h.service.raise({ userId: 'u1', hintKey: key, source: 's' });
    if (delivery !== null) await h.service.markShown(delivery.id, 'u1');
    return delivery;
  }

  it('leaves a copy in the notification feed once the hint is shown', async () => {
    // The whole point. A modal is read once and dismissed, and a mis-tap
    // dismisses it exactly as thoroughly as reading does — after which the
    // text existed only in a delivery table nothing in the cabinet reads.
    const h = build([hint({ key: 'welcome', titleRu: 'Добро пожаловать', bodyRu: 'Загляните в Помощь' })]);

    await raiseAndShow(h, 'welcome');

    assert.equal(h.feedRows.length, 1);
    assert.equal(h.feedRows[0]?.userId, 'u1');
    assert.equal(h.feedRows[0]?.payload['title'], 'Добро пожаловать');
    assert.equal(h.feedRows[0]?.payload['text'], 'Загляните в Помощь');
  });

  it('writes nothing until it actually reaches a screen', async () => {
    // Queue time is not show time, and the difference is the whole reason this
    // moved: a hint can be queued and never shown for half a dozen reasons.
    const h = build([hint({ key: 'welcome' })]);

    await h.service.raise({ userId: 'u1', hintKey: 'welcome', source: 's' });

    assert.deepEqual(h.feedRows, []);
  });

  it('does not turn one purchase into four rows', async () => {
    // THE regression this move fixes. Four hints in one group are ONE modal by
    // design — the newest supersedes the rest — and writing at queue time made
    // them four feed rows anyway, which is the very thing the group exists to
    // prevent, moved one surface over.
    const h = build([
      hint({ key: 'a', groupKey: 'purchase' }),
      hint({ key: 'b', groupKey: 'purchase' }),
      hint({ key: 'c', groupKey: 'purchase' }),
      hint({ key: 'd', groupKey: 'purchase' }),
    ]);

    for (const key of ['a', 'b', 'c', 'd']) {
      // Same clock as `nextFor` below: supersession stamps `expiresAt = now`,
      // and a lapsed row is excluded by `expiresAt > now`. Two different
      // `now`s would leave the lapsed rows a hair in the future and offerable.
      await h.service.raise({ userId: 'u1', hintKey: key, source: 's', now: NOW });
    }
    const next = await h.service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW });
    if (next !== null) await h.service.markShown(next.deliveryId, 'u1');

    assert.equal(h.feedRows.length, 1, JSON.stringify(h.feedRows.map((r) => r.payload['hintKey'])));
    assert.equal(h.feedRows[0]?.payload['hintKey'], 'd', 'the newest of the group is the one kept');
  });

  it('writes one row however many times the same show is reported', async () => {
    // `markShown` is idempotent, and the copy has to be too: a re-render must
    // not add a second row.
    const h = build([hint({ key: 'welcome' })]);
    const delivery = await h.service.raise({ userId: 'u1', hintKey: 'welcome', source: 's' });

    await h.service.markShown(delivery!.id, 'u1');
    await h.service.markShown(delivery!.id, 'u1');
    await h.service.markShown(delivery!.id, 'u1');

    assert.equal(h.feedRows.length, 1);
  });

  it('names the fields the cabinet feed actually reads', async () => {
    // `title` and `text`, not `titleRu`/`bodyRu`: the presenter reads those two
    // keys and nothing else, and a row without them renders as
    // "Уведомление / Текст недоступен" — the failure this copy exists to avoid.
    const h = build([hint({ key: 'welcome' })]);

    await raiseAndShow(h, 'welcome');

    const payload = h.feedRows[0]?.payload ?? {};
    assert.ok('title' in payload && 'text' in payload, JSON.stringify(payload));
    assert.equal(payload['hintKey'], 'welcome');
  });

  it('marks the copy read, because the words were just on the screen', async () => {
    // Left unread it would light the bell — and now the home-screen icon — for
    // text the customer had just been shown. The row is where to find the
    // words again, not news.
    const h = build([hint({ key: 'welcome' })]);

    await raiseAndShow(h, 'welcome');

    assert.notEqual(h.feedRows[0]?.readAt ?? null, null);
  });

  it('writes the copy in the recipient language', async () => {
    const h = build(
      [hint({ key: 'welcome', titleEn: 'Welcome', bodyEn: 'Take a look at Help' })],
      [],
      'EN',
    );

    await raiseAndShow(h, 'welcome');

    assert.equal(h.feedRows[0]?.payload['title'], 'Welcome');
    assert.equal(h.feedRows[0]?.payload['text'], 'Take a look at Help');
  });

  it('falls back per field, so a half-translated hint is not half English', async () => {
    // The operator translated the title and not the body. An English title over
    // a Russian body is one message in two languages; the body falls back.
    const h = build([hint({ key: 'welcome', titleEn: 'Welcome', bodyEn: null })], [], 'EN');

    await raiseAndShow(h, 'welcome');

    assert.equal(h.feedRows[0]?.payload['title'], 'Welcome');
    assert.equal(h.feedRows[0]?.payload['text'], 'Текст');
  });
});

describe('a mode the asking cabinet cannot draw', () => {
  /**
   * THE PAIRING DEFECT THIS FIELD EXISTS FOR.
   *
   * The panel and the cabinet ship as separate images on separate upgrade
   * schedules, so a panel that has learned a mode meets cabinets that have not.
   * The shipped cabinet does not defer a mode it cannot draw — it CLOSES it, as
   * dismissed, deliberately, because leaving it queued starves every hint
   * behind it. So a `TOAST` sent to an older cabinet is a delivery destroyed
   * unshown, and for a `repeatable: false` hint such as "your trial has
   * started" it is destroyed permanently: `raise` counts the closed row and
   * never queues another.
   *
   * Nothing anywhere told the operator, and nothing could: the panel has no
   * delivery-outcome view, and the customer sees no error because there is no
   * error — every write succeeded.
   */
  const OLD_CABINET = { surface: 'browser', formFactor: 'mobile', modes: null };
  const SILENT = { surface: null, formFactor: null, modes: null };

  it('is not handed to a cabinet that did not claim it', async () => {
    const { service } = build([hint({ key: 'trial', mode: 'TOAST' })]);
    await service.raise({ userId: 'u1', hintKey: 'trial', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: OLD_CABINET,
      now: NOW,
    });

    assert.equal(next, null, 'a toast was handed to a cabinet that would destroy it');
  });

  it('is handed to one that did', async () => {
    // The other half, and the one that makes the case above mean something: a
    // filter that answered null for everybody would also pass it.
    const { service } = build([hint({ key: 'trial', mode: 'TOAST' })]);
    await service.raise({ userId: 'u1', hintKey: 'trial', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: AUDIENCE,
      now: NOW,
    });

    assert.equal(next?.key, 'trial');
  });

  it('waits rather than dies, so the upgrade still delivers it', async () => {
    // THE WHOLE POINT OF SKIPPING RATHER THAN CLOSING. The delivery is left
    // alone by the older cabinet's ask, so the same row is still there when a
    // cabinet that can draw it comes along.
    const { service, deliveries } = build([hint({ key: 'trial', mode: 'TOAST' })]);
    await service.raise({ userId: 'u1', hintKey: 'trial', source: 's', now: NOW });

    await service.nextFor({ userId: 'u1', locale: 'ru', audience: OLD_CABINET, now: NOW });
    const afterUpgrade = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: AUDIENCE,
      now: NOW,
    });

    assert.equal(afterUpgrade?.key, 'trial');
    // The SAME row, still unexpired. The two assertions this replaces —
    // `dismissedAt === null` and `shownAt === null` — could not fail: `nextFor`
    // is a pure read, only `markShown` and `close` write those columns, and the
    // fake starts both at null. They described something the panel cannot do at
    // all (closing is the CABINET's action, against a different endpoint) and
    // stayed green under two mutations that broke the mode filter outright.
    assert.equal(deliveries.length, 1, 'the older ask queued or dropped a row');
    assert.equal(afterUpgrade?.deliveryId, deliveries[0]?.id);
    assert.ok(deliveries[0].expiresAt > NOW, 'the older ask lapsed the delivery');
  });

  it('does not block the modal queued behind it', async () => {
    // The starvation the cabinet's own close was written to avoid, which this
    // filter must not reintroduce on the server: an undrawable row sits at the
    // head of a `createdAt`-ascending queue, and everything after it — a failed
    // payment among them — has to keep flowing past.
    const { service } = build([
      hint({ key: 'trial', id: 'h1', mode: 'TOAST' }),
      hint({ key: 'declined', id: 'h2', mode: 'MODAL' }),
    ]);
    await service.raise({ userId: 'u1', hintKey: 'trial', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'declined', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: OLD_CABINET,
      now: NOW,
    });

    assert.equal(next?.key, 'declined');
  });

  it('still hands over a modal when the cabinet says nothing at all', async () => {
    // Silence must not mean "nothing you can draw". Every cabinet ever shipped
    // draws a modal, and a filter that read an absent list as an empty one
    // would stop hints reaching every cabinet older than this field — a much
    // larger outage than the one it was written to prevent.
    const { service } = build([hint({ key: 'declined', mode: 'MODAL' })]);
    await service.raise({ userId: 'u1', hintKey: 'declined', source: 's', now: NOW });

    const next = await service.nextFor({ userId: 'u1', locale: 'ru', audience: SILENT, now: NOW });

    assert.equal(next?.key, 'declined');
  });

  it('ignores a mode name it has never heard of', async () => {
    // A newer cabinet claiming `BANNER` must not make this panel throw or
    // answer nothing — the unknown name simply matches no row.
    const { service } = build([hint({ key: 'declined', mode: 'MODAL' })]);
    await service.raise({ userId: 'u1', hintKey: 'declined', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: { surface: null, formFactor: null, modes: ['MODAL', 'BANNER'] },
      now: NOW,
    });

    assert.equal(next?.key, 'declined');
  });
});

describe('raising with an outcome, for a caller that has to say which', () => {
  /**
   * `raise()` folds three different refusals into one `null`, and a rule's run
   * log graded all of them — and a queued hint — the same green. The pop-up
   * action now reports which it was, so each outcome is pinned here against
   * the same fake queue the rest of this file uses.
   */

  /** Records the `where` of every once-only count the service asks for. */
  function recordCounts(h: ReturnType<typeof build>): Array<Record<string, unknown>> {
    const asked: Array<Record<string, unknown>> = [];
    const count = h.prisma.userHintDelivery.count;
    h.prisma.userHintDelivery.count = async (args) => {
      asked.push(args.where);
      return count(args);
    };
    return asked;
  }

  /** A delivery row put in place directly, in whatever state a case needs. */
  function delivery(over: Partial<FakeDelivery> & Pick<FakeDelivery, 'id' | 'hintId'>): FakeDelivery {
    return {
      userId: 'u1',
      source: 's',
      expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      shownAt: null,
      dismissedAt: null,
      actedAt: null,
      createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      ...over,
    };
  }

  it('answers queued, with the row it wrote', async () => {
    const h = build([hint({ key: 'connect' })]);

    const outcome = await h.service.raiseWithOutcome({
      userId: 'u1',
      hintKey: 'connect',
      source: 'rule:rule-1',
      now: NOW,
    });

    assert.ok(outcome.kind === 'queued', `answered ${outcome.kind}`);
    assert.equal(h.deliveries.length, 1);
    assert.equal(outcome.delivery, h.deliveries[0], 'answered a row it did not write');
    assert.equal(h.deliveries[0].source, 'rule:rule-1');
  });

  it('answers hint_missing for a key nobody authored, and writes nothing', async () => {
    const h = build([hint({ key: 'connect' })]);

    const outcome = await h.service.raiseWithOutcome({
      userId: 'u1',
      hintKey: 'ghost',
      source: 's',
      now: NOW,
    });

    assert.deepStrictEqual(outcome, { kind: 'hint_missing' });
    assert.deepStrictEqual(h.deliveries, []);
  });

  it('answers hint_inactive for a hint that is switched off, and writes nothing', async () => {
    const h = build([hint({ key: 'paused', isActive: false })]);

    const outcome = await h.service.raiseWithOutcome({
      userId: 'u1',
      hintKey: 'paused',
      source: 's',
      now: NOW,
    });

    assert.deepStrictEqual(outcome, { kind: 'hint_inactive' });
    assert.deepStrictEqual(h.deliveries, []);
  });

  it('answers already_delivered when this customer has ANY delivery of a once-only hint', async () => {
    // Dismissed AND lapsed — the prior delivery least likely to be counted,
    // and it still counts. "Once" is about what was queued, not about what is
    // still waiting.
    const old = delivery({
      id: 'd-old',
      hintId: 'h-welcome',
      shownAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
      dismissedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      expiresAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    const h = build([hint({ key: 'welcome', id: 'h-welcome' })], [old]);
    const asked = recordCounts(h);

    const outcome = await h.service.raiseWithOutcome({
      userId: 'u1',
      hintKey: 'welcome',
      source: 's',
      now: NOW,
    });

    assert.deepStrictEqual(outcome, { kind: 'already_delivered' });
    assert.deepStrictEqual(h.deliveries, [old]);
    // EXACTLY this question. The fake count ignores any term it is not told
    // about, so the only way to see a shown, dismissed or expiry term slipped
    // into it — which would stop a closed delivery counting — is to read the
    // question itself.
    assert.deepStrictEqual(asked, [{ userId: 'u1', hintId: 'h-welcome' }]);
  });

  it('treats showAgain: false as no showAgain', async () => {
    // The pop-up action passes `false` on every automatic run, so a check that
    // asked "was it given" instead of "is it true" would skip "once" on all of
    // them.
    const h = build([hint({ key: 'welcome', id: 'h-welcome' })]);
    await h.service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });

    const outcome = await h.service.raiseWithOutcome({
      userId: 'u1',
      hintKey: 'welcome',
      source: 's',
      now: NOW,
      showAgain: false,
    });

    assert.deepStrictEqual(outcome, { kind: 'already_delivered' });
    assert.equal(h.deliveries.length, 1);
  });

  it('with showAgain, queues a once-only hint this customer already has', async () => {
    const h = build([hint({ key: 'welcome', id: 'h-welcome' })]);
    await h.service.raise({ userId: 'u1', hintKey: 'welcome', source: 'rule:rule-1', now: NOW });

    const outcome = await h.service.raiseWithOutcome({
      userId: 'u1',
      hintKey: 'welcome',
      source: 'rule:rule-1:manual',
      now: NOW,
      showAgain: true,
    });

    assert.ok(outcome.kind === 'queued', `answered ${outcome.kind}`);
    assert.equal(h.deliveries.length, 2);
    assert.equal(outcome.delivery, h.deliveries[1]);
    assert.equal(h.deliveries[1].source, 'rule:rule-1:manual');
  });

  it('with showAgain, still lapses the older unshown deliveries of its group', async () => {
    // showAgain skips "once" and nothing else. Its own earlier copy is in the
    // group too, so it is lapsed with the rest — the customer gets the hint
    // again, not the hint twice.
    const hints = [
      hint({ key: 'welcome', id: 'h-welcome', groupKey: 'purchase' }),
      hint({ key: 'paid', id: 'h-paid', groupKey: 'purchase' }),
    ];
    const earlierWelcome = delivery({ id: 'd-welcome', hintId: 'h-welcome' });
    const pendingPaid = delivery({ id: 'd-paid', hintId: 'h-paid' });
    const h = build(hints, [earlierWelcome, pendingPaid]);

    const outcome = await h.service.raiseWithOutcome({
      userId: 'u1',
      hintKey: 'welcome',
      source: 'rule:rule-1:manual',
      now: NOW,
      showAgain: true,
    });

    assert.ok(outcome.kind === 'queued', `answered ${outcome.kind}`);
    assert.equal(h.deliveries.length, 3, 'lapsed, not deleted');
    assert.deepStrictEqual(
      h.deliveries.filter((d) => d.expiresAt > NOW).map((d) => d.id),
      [outcome.delivery.id],
      'only the new delivery may still be offerable',
    );
  });

  it('with showAgain, still queues nothing for a hint that is switched off', async () => {
    const h = build([hint({ key: 'paused', isActive: false })]);

    const outcome = await h.service.raiseWithOutcome({
      userId: 'u1',
      hintKey: 'paused',
      source: 's',
      now: NOW,
      showAgain: true,
    });

    assert.deepStrictEqual(outcome, { kind: 'hint_inactive' });
    assert.deepStrictEqual(h.deliveries, []);
  });

  it('keeps raise() answering the row, or null', async () => {
    const h = build([hint({ key: 'welcome' })]);

    const first = await h.service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });
    const second = await h.service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });

    assert.equal(first, h.deliveries[0]);
    assert.equal(second, null, 'a refusal is still null, not an outcome object');
  });

  it('does not let an untyped caller talk raise() into showAgain', async () => {
    // `raise()` is what the cabinet's moment endpoint and the audience loop
    // call, and neither may skip "once". Forwarding its input wholesale would
    // carry a stray `showAgain` straight through.
    const h = build([hint({ key: 'welcome' })]);
    await h.service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });

    const again = await h.service.raise({
      userId: 'u1',
      hintKey: 'welcome',
      source: 's',
      now: NOW,
      showAgain: true,
    } as never);

    assert.equal(again, null);
    assert.equal(h.deliveries.length, 1);
  });

  describe('showAgain replaces a waiting copy instead of stacking another', () => {
    const HOUR = 60 * 60 * 1000;

    /** Records the `where` of every `updateMany` the service asks for. */
    function recordUpdates(h: ReturnType<typeof build>): Array<Record<string, unknown>> {
      const asked: Array<Record<string, unknown>> = [];
      const updateMany = h.prisma.userHintDelivery.updateMany;
      h.prisma.userHintDelivery.updateMany = async (args) => {
        asked.push(args.where);
        return updateMany(args);
      };
      return asked;
    }

    it('leaves one waiting copy, with a fresh expiry, after a second test run', async () => {
      // THE DEFECT: each press queued one more copy behind the last, and the
      // customer met the same pop-up once per press.
      const h = build([hint({ key: 'welcome', id: 'h-welcome', ttlHours: 48 })]);
      const later = new Date(NOW.getTime() + 3 * HOUR);

      const first = await h.service.raiseWithOutcome({
        userId: 'u1',
        hintKey: 'welcome',
        source: 'rule:rule-1:manual',
        now: NOW,
        showAgain: true,
      });
      const second = await h.service.raiseWithOutcome({
        userId: 'u1',
        hintKey: 'welcome',
        source: 'rule:rule-1:manual',
        now: later,
        showAgain: true,
      });

      assert.ok(first.kind === 'queued' && second.kind === 'queued', 'a run was not queued');
      const waiting = h.deliveries.filter(
        (d) => d.shownAt === null && d.dismissedAt === null && d.actedAt === null && d.expiresAt > later,
      );
      assert.deepStrictEqual(waiting.map((d) => d.id), [second.delivery.id]);
      assert.equal(
        second.delivery.expiresAt.getTime(),
        later.getTime() + 48 * HOUR,
        'the copy left waiting does not carry the fresh expiry',
      );
      assert.equal(first.delivery.expiresAt.getTime(), later.getTime(), 'the earlier copy was not lapsed');
      // And what the customer is actually offered is the fresh one.
      const next = await h.service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: later });
      assert.equal(next?.deliveryId, second.delivery.id);
    });

    it('lapses only a WAITING copy — shown, dismissed, acted and lapsed ones are history', async () => {
      const future = new Date(NOW.getTime() + 24 * HOUR);
      const past = new Date(NOW.getTime() - HOUR);
      const waiting = delivery({ id: 'd-waiting', hintId: 'h-welcome', expiresAt: future });
      const history = [
        delivery({ id: 'd-shown', hintId: 'h-welcome', expiresAt: future, shownAt: past }),
        delivery({ id: 'd-dismissed', hintId: 'h-welcome', expiresAt: future, dismissedAt: past }),
        delivery({ id: 'd-acted', hintId: 'h-welcome', expiresAt: future, actedAt: past }),
        delivery({ id: 'd-lapsed', hintId: 'h-welcome', expiresAt: past }),
      ];
      const h = build([hint({ key: 'welcome', id: 'h-welcome' })], [waiting, ...history]);
      const expiryBefore = new Map(history.map((row) => [row.id, row.expiresAt.getTime()]));

      const outcome = await h.service.raiseWithOutcome({
        userId: 'u1',
        hintKey: 'welcome',
        source: 's',
        now: NOW,
        showAgain: true,
      });

      assert.equal(outcome.kind, 'queued');
      assert.equal(waiting.expiresAt.getTime(), NOW.getTime(), 'the waiting copy was not lapsed');
      for (const row of history) {
        assert.equal(row.expiresAt.getTime(), expiryBefore.get(row.id), `${row.id} was rewritten`);
      }
    });

    it('leaves other customers and other hints alone', async () => {
      const future = new Date(NOW.getTime() + 24 * HOUR);
      const theirs = delivery({ id: 'd-theirs', hintId: 'h-welcome', userId: 'u2', expiresAt: future });
      const otherHint = delivery({ id: 'd-other-hint', hintId: 'h-other', expiresAt: future });
      const h = build(
        [hint({ key: 'welcome', id: 'h-welcome' }), hint({ key: 'other', id: 'h-other' })],
        [theirs, otherHint],
      );

      await h.service.raiseWithOutcome({
        userId: 'u1',
        hintKey: 'welcome',
        source: 's',
        now: NOW,
        showAgain: true,
      });

      assert.equal(theirs.expiresAt.getTime(), future.getTime(), 'another customer’s copy was lapsed');
      assert.equal(otherHint.expiresAt.getTime(), future.getTime(), 'another hint’s copy was lapsed');
    });

    it('does nothing extra without showAgain', async () => {
      // Every automatic run passes `showAgain: false`. A repeatable hint stacks
      // there exactly as it always has, and an ungrouped one rewrites no row.
      const future = new Date(NOW.getTime() + 24 * HOUR);
      const earlier = delivery({ id: 'd-earlier', hintId: 'h-renew', expiresAt: future });
      const h = build([hint({ key: 'renew', id: 'h-renew', isRepeatable: true })], [earlier]);
      const updates = recordUpdates(h);

      const outcome = await h.service.raiseWithOutcome({
        userId: 'u1',
        hintKey: 'renew',
        source: 'rule:rule-1',
        now: NOW,
        showAgain: false,
      });

      assert.equal(outcome.kind, 'queued');
      assert.equal(earlier.expiresAt.getTime(), future.getTime(), 'lapsed a copy without showAgain');
      assert.deepStrictEqual(updates, [], 'rewrote rows for an ungrouped hint without showAgain');
    });
  });
});

describe('asking whether a hint could be queued, without queuing it', () => {
  it('answers missing, inactive or active for the key it was asked about', async () => {
    const h = build([
      hint({ key: 'on', id: 'h-on' }),
      hint({ key: 'off', id: 'h-off', isActive: false }),
    ]);
    const asked: Array<{ where: { key: string } }> = [];
    const findUnique = h.prisma.userHint.findUnique;
    h.prisma.userHint.findUnique = async (args) => {
      asked.push(args);
      return findUnique(args);
    };

    assert.equal(await h.service.hintStatus('on'), 'active');
    assert.equal(await h.service.hintStatus('off'), 'inactive');
    assert.equal(await h.service.hintStatus('ghost'), 'missing');

    assert.deepStrictEqual(
      asked.map((args) => args.where),
      [{ key: 'on' }, { key: 'off' }, { key: 'ghost' }],
    );
    assert.deepStrictEqual(h.deliveries, [], 'asking wrote a delivery');
  });
});

describe('one writer per customer’s queue', () => {
  /**
   * Two raises for one customer that overlap both read the queue before either
   * writes it: "once" counted zero twice, `showAgain` lapsed the same old copy
   * twice and left two new ones. The cure is a transaction that takes a lock
   * on the customer before it reads anything. Whether the lock actually makes
   * two connections wait is a question for PostgreSQL, and
   * `user-hint-delivery-postgres.spec.ts` asks it with truly concurrent calls;
   * these cases pin what can be seen without one — that the lock is taken,
   * first, on the right key, and that every statement goes through it.
   */
  it('takes the customer’s lock before anything else, and writes only through the transaction', async () => {
    const h = build([hint({ key: 'welcome', id: 'h-welcome', groupKey: 'purchase' })]);

    await h.service.raiseWithOutcome({
      userId: 'u1',
      hintKey: 'welcome',
      source: 'rule:rule-1:manual',
      now: NOW,
      showAgain: true,
    });

    // The showAgain lapse, both supersession statements, the insert.
    assert.deepStrictEqual(h.ops, [
      'begin',
      'tx.hint',
      'tx.lock',
      'tx.updateMany',
      'tx.updateMany',
      'tx.updateMany',
      'tx.create',
      'commit',
    ]);
    assert.equal(h.locks.length, 1);
    assert.match(h.locks[0].text, /pg_advisory_xact_lock\(hashtext\(\?\)::bigint\)/);
    assert.deepStrictEqual(h.locks[0].values, ['user-hint:u1']);
  });

  it('counts "once" under the same lock, and answers the second raise from inside it', async () => {
    const h = build([hint({ key: 'welcome', id: 'h-welcome' })]);

    const first = await h.service.raiseWithOutcome({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });
    const second = await h.service.raiseWithOutcome({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });

    assert.equal(first.kind, 'queued');
    assert.equal(second.kind, 'already_delivered');
    assert.deepStrictEqual(h.ops, [
      'begin', 'tx.hint', 'tx.lock', 'tx.count', 'tx.create', 'commit',
      'begin', 'tx.hint', 'tx.lock', 'tx.count', 'commit',
    ]);
  });

  it('locks the CUSTOMER, not the hint — supersession reaches across the hints of a group', async () => {
    const h = build([
      hint({ key: 'paid', id: 'h-paid', groupKey: 'purchase' }),
      hint({ key: 'created', id: 'h-created', groupKey: 'purchase' }),
    ]);

    await h.service.raiseWithOutcome({ userId: 'u1', hintKey: 'paid', source: 's', now: NOW });
    await h.service.raiseWithOutcome({ userId: 'u1', hintKey: 'created', source: 's', now: NOW });
    await h.service.raiseWithOutcome({ userId: 'u2', hintKey: 'paid', source: 's', now: NOW });

    assert.deepStrictEqual(
      h.locks.map((lock) => lock.values),
      [['user-hint:u1'], ['user-hint:u1'], ['user-hint:u2']],
    );
  });

  it('keeps raise() answering exactly as before', async () => {
    const h = build([hint({ key: 'welcome' }), hint({ key: 'paused', isActive: false })]);

    const queued = await h.service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });
    assert.equal(queued, h.deliveries[0]);
    assert.equal(await h.service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW }), null);
    assert.equal(await h.service.raise({ userId: 'u1', hintKey: 'paused', source: 's', now: NOW }), null);
    assert.equal(await h.service.raise({ userId: 'u1', hintKey: 'ghost', source: 's', now: NOW }), null);
  });

  it('sends raise() through the same customer lock', async () => {
    // `raise()` is what the audience loop and the cabinet's moment endpoint
    // call. Its answers alone cannot show whether it took the lock — a raise
    // that skipped it answers the same, and races the same way it used to.
    const h = build([hint({ key: 'welcome', id: 'h-welcome' })]);

    await h.service.raise({ userId: 'u7', hintKey: 'welcome', source: 'moment:subscription-ready', now: NOW });

    assert.deepStrictEqual(h.ops, ['begin', 'tx.hint', 'tx.lock', 'tx.count', 'tx.create', 'commit']);
    assert.deepStrictEqual(h.locks.map((lock) => lock.values), [['user-hint:u7']]);
  });

  it('reads the hint inside the transaction, so waiting for a connection is bounded too', async () => {
    // Outside it, that read's wait for a pooled connection is bounded only by
    // the pool's 15 s (`DB_CONNECTION_TIMEOUT_MS`), and before that was set it
    // had NO timer at all, so a raise could hang instead of failing — and a
    // raise that hangs never reaches the audience loop's failure count, which
    // is what stops a run against a database that is not answering. Inside,
    // `maxWait` (10 s) binds first.
    const h = build([hint({ key: 'welcome', id: 'h-welcome' })]);

    await h.service.raiseWithOutcome({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });

    assert.deepStrictEqual(h.ops, ['begin', 'tx.hint', 'tx.lock', 'tx.count', 'tx.create', 'commit']);
    assert.equal(h.ops.includes('root.hint'), false, 'the hint was read outside the transaction');
  });

  it('reads the hint inside the transaction even when it does not exist or is switched off', async () => {
    // The refusals answer before the lock is taken, but the READ that produced
    // them is still inside, because it is the read that can hang.
    const h = build([hint({ key: 'paused', isActive: false })]);

    const missing = await h.service.raiseWithOutcome({ userId: 'u1', hintKey: 'ghost', source: 's', now: NOW });
    const inactive = await h.service.raiseWithOutcome({ userId: 'u1', hintKey: 'paused', source: 's', now: NOW });

    assert.deepStrictEqual(missing, { kind: 'hint_missing' });
    assert.deepStrictEqual(inactive, { kind: 'hint_inactive' });
    assert.deepStrictEqual(h.ops, ['begin', 'tx.hint', 'commit', 'begin', 'tx.hint', 'commit']);
    assert.deepStrictEqual(h.transactionOptions, [
      { maxWait: 10_000, timeout: 20_000 },
      { maxWait: 10_000, timeout: 20_000 },
    ]);
  });

  it('asks whether a hint could be queued under the same bounded wait', async () => {
    // `hintStatus` runs inside the audience action, before its loop: an
    // unbounded wait there hangs the whole run where nothing can stop it.
    const h = build([hint({ key: 'on', id: 'h-on' })]);

    assert.equal(await h.service.hintStatus('on'), 'active');

    assert.deepStrictEqual(h.ops, ['begin', 'tx.hint', 'commit']);
    assert.equal(h.ops.includes('root.hint'), false, 'the status read went past the transaction');
    assert.deepStrictEqual(h.transactionOptions, [{ maxWait: 10_000, timeout: 20_000 }]);
  });

  it('opens the raise transaction with room to wait for a busy pool', async () => {
    // Prisma's defaults — 2 s to get a connection, 5 s to finish — turn a pool
    // busy for two seconds into a P2028 on a raise that used to simply wait.
    // The numbers are the service's reasoned budget, repeated here as literals
    // so that a change to them is a change to this line.
    const h = build([hint({ key: 'welcome' })]);

    await h.service.raiseWithOutcome({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });
    await h.service.raise({ userId: 'u2', hintKey: 'welcome', source: 's', now: NOW });

    assert.deepStrictEqual(h.transactionOptions, [
      { maxWait: 10_000, timeout: 20_000 },
      { maxWait: 10_000, timeout: 20_000 },
    ]);
  });
});

describe('a button aimed at a door', () => {
  /**
   * `@connect` is not a path: the cabinet opens whatever its Connect button
   * opens. A cabinet older than the door navigates to a hint's target as it
   * stands, so it must never be handed one — it is HELD for a cabinet that
   * declared the door in `x-reiwa-hint-doors`, as a mode is.
   */
  const DOOR_HINT = { key: 'connect-door', ctaKind: 'ROUTE', ctaLabelRu: 'Подключить', ctaTarget: '@connect' };
  const DOORLESS = AUDIENCE;
  const CONNECTING = { ...AUDIENCE, doors: ['@connect'] };

  it('is held from a cabinet that declared no door, and handed to one that did', async () => {
    const { service } = build([hint(DOOR_HINT)]);
    await service.raise({ userId: 'u1', hintKey: 'connect-door', source: 's', now: NOW });

    assert.equal(
      await service.nextFor({ userId: 'u1', locale: 'ru', audience: DOORLESS, now: NOW }),
      null,
      'a door was handed to a cabinet that would navigate to "@connect" as a path',
    );
    const next = await service.nextFor({ userId: 'u1', locale: 'ru', audience: CONNECTING, now: NOW });
    assert.equal(next?.key, 'connect-door');
    assert.equal(next?.ctaTarget, '@connect');
  });

  it('waits for that cabinet rather than dying', async () => {
    const { service, deliveries } = build([hint(DOOR_HINT)]);
    await service.raise({ userId: 'u1', hintKey: 'connect-door', source: 's', now: NOW });
    const before = { ...deliveries[0]! };

    await service.nextFor({ userId: 'u1', locale: 'ru', audience: DOORLESS, now: NOW });

    assert.deepStrictEqual(deliveries[0], before, 'holding the hint rewrote its delivery');
  });

  it('opens a door only by its exact name', async () => {
    // Doors are case-sensitive and never upper-cased the way modes are.
    const { service } = build([hint(DOOR_HINT)]);
    await service.raise({ userId: 'u1', hintKey: 'connect-door', source: 's', now: NOW });

    const next = await service.nextFor({
      userId: 'u1',
      locale: 'ru',
      audience: { ...AUDIENCE, doors: ['@CONNECT', '@other'] },
      now: NOW,
    });

    assert.equal(next, null);
  });

  it('passes every other button to a doorless cabinet exactly as before', async () => {
    // Each arm of the filter has a row here that only it lets through: no
    // button, an external link, an ordinary path — and a ROUTE with no target
    // at all, which only another hand can write, and which `NOT LIKE` alone
    // would hold because it is NULL for a NULL target.
    const cases = [
      hint({ key: 'none', id: 'h-none' }),
      hint({ key: 'external', id: 'h-ext', ctaKind: 'EXTERNAL', ctaLabelRu: 'Канал', ctaTarget: 'https://t.me/x' }),
      hint({ key: 'path', id: 'h-path', ctaKind: 'ROUTE', ctaLabelRu: 'Тарифы', ctaTarget: '/plans' }),
      hint({ key: 'route-null', id: 'h-null', ctaKind: 'ROUTE', ctaLabelRu: 'Куда-то', ctaTarget: null }),
    ];
    for (const one of cases) {
      const { service } = build([one]);
      await service.raise({ userId: 'u1', hintKey: one.key, source: 's', now: NOW });

      const next = await service.nextFor({ userId: 'u1', locale: 'ru', audience: DOORLESS, now: NOW });

      assert.equal(next?.key, one.key, `${one.key} was held from a cabinet with no doors`);
    }
  });
});

describe('«Не получилось подключиться?» after the customer connected', () => {
  /**
   * The pop-up is raised when `subscription.not_connected` fires and shown when
   * the customer next opens the cabinet — they may have connected in between.
   * So `nextFor` decides, for a candidate of the `connect-help` group only and
   * once per person: SHOW on a read at most fifteen minutes old that found the
   * VPN never connected; LAPSE — every waiting delivery of the group closed —
   * once nothing live is left that is not known to have connected, or the help
   * was switched off; otherwise HOLD: skipped, not closed, and the next hint
   * offered.
   *
   * Whether the QUERY means that is proved on PostgreSQL; here the person's
   * answer is given, and what `nextFor` does with it is checked.
   */
  const CONNECT_HELP = { key: 'tpl-connect-help', id: 'h-connect', groupKey: 'connect-help', isRepeatable: true };
  const OTHER = { key: 'welcome', id: 'h-welcome' };

  it('hands it over on a fresh read that the VPN is still not connected', async () => {
    const { service, guardReads } = build([hint(CONNECT_HELP)], [], undefined, { u1: { waiting: true, fresh: true } });
    await service.raise({ userId: 'u1', hintKey: 'tpl-connect-help', source: 's', now: NOW });

    const next = await service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW });

    assert.equal(next?.key, 'tpl-connect-help');
    assert.equal(guardReads.length, 1);
  });

  it('HOLDS it on an old read: not shown, not closed — and offers the next hint', async () => {
    // The customer may have connected since that read, with the webhook lost:
    // the cabinet's own subscriptions read, on this very page load, is what
    // writes the truth, and the cabinet asks again seconds later.
    const { service, deliveries, guardReads } = build([hint(CONNECT_HELP), hint(OTHER)], [], undefined, {
      u1: { waiting: true, fresh: false },
    });
    await service.raise({ userId: 'u1', hintKey: 'tpl-connect-help', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });
    const popup = deliveries.find((d) => d.hintId === 'h-connect');
    const expiresBefore = popup?.expiresAt.getTime();

    const next = await service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW });

    assert.equal(next?.key, 'welcome', 'the held pop-up was handed over, or blocked the hint behind it');
    assert.equal(popup?.expiresAt.getTime(), expiresBefore, 'held is not lapsed');
    assert.equal(popup?.shownAt, null);
    assert.equal(popup?.dismissedAt, null);
    assert.equal(guardReads.length, 1, 'the person is asked about once');
  });

  it('HOLDS with nothing behind it: no hint, and the pop-up still waiting for the next ask', async () => {
    const { service, deliveries } = build([hint(CONNECT_HELP)], [], undefined, { u1: { waiting: true, fresh: false } });
    await service.raise({ userId: 'u1', hintKey: 'tpl-connect-help', source: 's', now: NOW });

    assert.equal(await service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW }), null);
    assert.ok((deliveries[0]?.expiresAt.getTime() ?? 0) > NOW.getTime(), 'the held pop-up was closed');

    // The cabinet's read then finds it still not connected: the next ask shows it.
    const later = build([hint(CONNECT_HELP)], deliveries, undefined, { u1: { waiting: true, fresh: true } });
    const next = await later.service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW });
    assert.equal(next?.key, 'tpl-connect-help');
  });

  it('holds a sub-group with it, and a hint with no group is never held along', async () => {
    const { service } = build(
      [
        hint({ ...CONNECT_HELP, key: 'own', id: 'h-own', groupKey: 'connect-help-own' }),
        hint(CONNECT_HELP),
        hint({ key: 'plain', id: 'h-plain' }),
      ],
      [],
      undefined,
      { u1: { waiting: true, fresh: false } },
    );
    await service.raise({ userId: 'u1', hintKey: 'own', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'tpl-connect-help', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'plain', source: 's', now: NOW });

    const next = await service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW });

    assert.equal(next?.key, 'plain', 'a held sub-group was handed over, or the group-less hint was held too');
  });

  it('closes it as lapsed once nothing of theirs is waiting, and offers the next hint', async () => {
    const { service, deliveries } = build([hint(CONNECT_HELP), hint(OTHER)], [], undefined, {
      u1: { waiting: false },
    });
    await service.raise({ userId: 'u1', hintKey: 'tpl-connect-help', source: 's', now: NOW });
    await service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });

    const next = await service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW });

    assert.equal(next?.key, 'welcome', 'the stale pop-up was handed over, or blocked the one behind it');
    const lapsed = deliveries.find((d) => d.hintId === 'h-connect');
    assert.equal(lapsed?.expiresAt.getTime(), NOW.getTime(), 'the stale pop-up was not closed as lapsed');
    // Lapsed, not dismissed: nothing is put in the customer's mouth.
    assert.equal(lapsed?.dismissedAt, null);
    assert.equal(lapsed?.shownAt, null);
    assert.equal(deliveries.find((d) => d.hintId === 'h-welcome')?.expiresAt.getTime() !== NOW.getTime(), true);
  });

  it('closes it for somebody who switched the help off in the cabinet, however fresh the read', async () => {
    const { service, deliveries } = build([hint(CONNECT_HELP)], [], undefined, {
      u1: { waiting: true, fresh: true, prefs: { connect_help: false } },
    });
    await service.raise({ userId: 'u1', hintKey: 'tpl-connect-help', source: 's', now: NOW });

    assert.equal(await service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW }), null);
    assert.equal(deliveries[0]?.expiresAt.getTime(), NOW.getTime());
  });

  it('keeps it for somebody whose other notification switches are off', async () => {
    // Only `connect_help === false` is the opt-out.
    const { service } = build([hint(CONNECT_HELP)], [], undefined, {
      u1: { waiting: true, fresh: true, prefs: { payment_failed: false, connect_help: true } },
    });
    await service.raise({ userId: 'u1', hintKey: 'tpl-connect-help', source: 's', now: NOW });

    const next = await service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW });

    assert.equal(next?.key, 'tpl-connect-help');
  });

  it('guards the sub-groups too, and not a group that merely begins with the same letters', async () => {
    const sub = build([hint({ ...CONNECT_HELP, key: 'own', groupKey: 'connect-help-own' })], [], undefined, {
      u1: { waiting: false },
    });
    await sub.service.raise({ userId: 'u1', hintKey: 'own', source: 's', now: NOW });
    assert.equal(await sub.service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW }), null);
    assert.equal(sub.guardReads.length, 1);

    const lookalike = build([hint({ ...CONNECT_HELP, key: 'near', groupKey: 'connect-helpful' })], [], undefined, {
      u1: { waiting: false },
    });
    await lookalike.service.raise({ userId: 'u1', hintKey: 'near', source: 's', now: NOW });
    const next = await lookalike.service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW });
    assert.equal(next?.key, 'near');
    assert.equal(lookalike.guardReads.length, 0, '"connect-helpful" is not a sub-group of "connect-help"');
  });

  it('costs a hint outside the group nothing', async () => {
    const { service, guardReads } = build([hint(OTHER)], [], undefined, { u1: { waiting: false } });
    await service.raise({ userId: 'u1', hintKey: 'welcome', source: 's', now: NOW });

    const next = await service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW });

    assert.equal(next?.key, 'welcome');
    assert.equal(guardReads.length, 0, 'a hint outside the group paid for the guard');
  });

  it('asks one bound statement: "not known to have connected" to lapse, a read at most 15 min old to show', async () => {
    // Pending help leaves out `skipped_template_off` — the operator switched
    // the message off and relies on this very pop-up — so a guard on pending
    // would close it in exactly the case it exists for. The live-row proof is
    // `user-hint-delivery-postgres.spec.ts`; this pins what is asked.
    const { service, guardReads } = build([hint(CONNECT_HELP)], [], undefined, { u1: { waiting: true, fresh: true } });
    await service.raise({ userId: 'u1', hintKey: 'tpl-connect-help', source: 's', now: NOW });

    await service.nextFor({ userId: 'u1', locale: 'ru', audience: AUDIENCE, now: NOW });

    assert.equal(CONNECT_HELP_SHOW_MAX_CHECK_AGE_MS, 15 * 60 * 1000);
    const read = guardReads[0];
    assert.ok(read !== undefined);
    assert.match(read.sql, /LEFT JOIN "subscription_connect_states" "c"[\s\S]*"c"\."first_connected_at" IS NULL\s*\) AS "waiting"/);
    assert.match(read.sql, /"s"\."status" IN \('ACTIVE', 'LIMITED'\)/);
    assert.match(read.sql, /"c"\."profile_missing_at" < "c"\."checked_at"/, 'no missing profile after that read');
    assert.doesNotMatch(read.sql, /\bnow\(\)|current_timestamp/i, 'the clock is bound, never SQL now()');
    assert.ok(read.values.includes('u1'));
    const instants = read.values.filter((value): value is Date => value instanceof Date).map((date) => date.getTime());
    assert.ok(instants.includes(NOW.getTime() - 15 * 60 * 1000), 'the read may be at most 15 minutes older than now');
  });
});
