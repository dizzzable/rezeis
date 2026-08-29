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

function build(hints: FakeHint[], deliveries: FakeDelivery[] = []) {
  let seq = 0;
  const prisma = {
    userHint: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        hints.find((h) => h.key === where.key) ?? null,
    },
    userHintDelivery: {
      count: async ({ where }: { where: { userId: string; hintId: string } }) =>
        deliveries.filter((d) => d.userId === where.userId && d.hintId === where.hintId).length,
      create: async ({ data }: { data: Omit<FakeDelivery, 'id' | 'shownAt' | 'dismissedAt' | 'actedAt' | 'createdAt'> }) => {
        seq += 1;
        const row: FakeDelivery = {
          id: 'del-' + seq,
          shownAt: null,
          dismissedAt: null,
          actedAt: null,
          createdAt: new Date(NOW.getTime() + seq),
          ...data,
        };
        deliveries.push(row);
        return row;
      },
      deleteMany: async ({
        where,
      }: {
        where: { userId: string; shownAt?: null; hint: { groupKey: string } };
      }) => {
        const doomed = deliveries.filter((d) => {
          if (d.userId !== where.userId) return false;
          // OBEYED, not re-implemented. An earlier version of this stub applied
          // the unshown filter itself whether or not the caller asked for it,
          // so dropping `shownAt: null` from the service left every test green
          // while the service happily deleted history.
          if ('shownAt' in where && d.shownAt !== null) return false;
          const h = hints.find((x) => x.id === d.hintId);
          return h?.groupKey === where.hint.groupKey;
        });
        for (const row of doomed) deliveries.splice(deliveries.indexOf(row), 1);
        return { count: doomed.length };
      },
      findMany: async ({
        where,
        orderBy,
      }: {
        where: Record<string, unknown>;
        orderBy?: { createdAt?: 'asc' | 'desc' };
      }) => {
        const w = where as {
          userId: string;
          shownAt: null;
          expiresAt: { gt: Date };
          hint: { isActive: boolean };
        };
        return deliveries
          .filter((d) => d.userId === w.userId && d.shownAt === null && d.expiresAt > w.expiresAt.gt)
          .map((d) => ({ ...d, hint: hints.find((h) => h.id === d.hintId)! }))
          .filter((d) => d.hint.isActive === w.hint.isActive)
          .sort((a, b) => {
            const delta = a.createdAt.getTime() - b.createdAt.getTime();
            return orderBy?.createdAt === 'desc' ? -delta : delta;
          });
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const w = where as Record<string, unknown>;
        const hit = deliveries.filter((d) => {
          if (d.id !== w['id'] || d.userId !== w['userId']) return false;
          if ('shownAt' in w && d.shownAt !== null) return false;
          if ('dismissedAt' in w && (d.dismissedAt !== null || d.actedAt !== null)) return false;
          return true;
        });
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
  };
  const service = new UserHintDeliveryService(prisma as never);
  return { service, deliveries, prisma };
}

const AUDIENCE = { surface: 'browser', formFactor: 'mobile' };

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

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].hintId, 'h-created', 'the newest wins');
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
      audience: { surface: 'tma', formFactor: 'mobile' },
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
      audience: { surface: 'browser', formFactor: 'mobile' },
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
      audience: { surface: 'tma', formFactor: 'desktop' },
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
      audience: { surface: 'browser', formFactor: 'desktop' },
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
      audience: { surface: 'tma', formFactor: 'mobile' },
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
