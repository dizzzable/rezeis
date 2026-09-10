import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserHintDeliveryService } from '../src/modules/user-hints/services/user-hint-delivery.service';

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

function build(hints: FakeHint[], deliveries: FakeDelivery[] = [], language?: string) {
  let seq = 0;
  const feedRows: Array<{
    userId: string;
    type: string;
    payload: Record<string, unknown>;
    readAt: Date | null;
  }> = [];
  const prisma = {
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
          shownAt?: null;
          dismissedAt?: null;
          actedAt?: null;
          expiresAt?: { gt: Date };
          hint?: { groupKey: string };
        };
        const hit = deliveries.filter((d) => {
          if (w.id !== undefined && d.id !== w.id) return false;
          if (w.userId !== undefined && d.userId !== w.userId) return false;
          // OBEYED, not re-implemented: a stub that applies a constraint the
          // caller did not ask for makes "the service dropped it" look exactly
          // like "the service kept it".
          if ('shownAt' in w && d.shownAt !== null) return false;
          if ('dismissedAt' in w && (d.dismissedAt !== null || d.actedAt !== null)) return false;
          if (w.expiresAt !== undefined && !(d.expiresAt > w.expiresAt.gt)) return false;
          if (w.hint !== undefined) {
            const h = hints.find((x) => x.id === d.hintId);
            if (h?.groupKey !== w.hint.groupKey) return false;
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
          hint: { isActive: boolean; AND?: ReadonlyArray<Record<string, unknown>> };
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
          .filter((d) =>
            (w.hint.AND ?? []).every((term) => {
              // The mode term is a plain `in`, not the empty-or-has shape the
              // two audience terms share, so it is matched on its own. An
              // unrecognised term must not silently pass: a filter this fake
              // does not understand is a filter nothing here is testing.
              const mode = term.mode as { in?: readonly string[] } | undefined;
              if (mode !== undefined) return (mode.in ?? []).includes(d.hint.mode);
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
  const service = new UserHintDeliveryService(prisma as never);
  return { service, deliveries, prisma, feedRows };
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
