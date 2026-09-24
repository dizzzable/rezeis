import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';

import { SupportGuestService } from '../src/modules/support-tickets/services/support-guest.service';
import { SupportNotificationsService } from '../src/modules/support-tickets/services/support-notifications.service';

/**
 * THE GUEST'S NEWEST LETTER IS THE ONE THAT OPENS THE CONVERSATION.
 *
 * Every operator reply to a guest with an email sends a letter whose link is
 * made THE letter link once the letter went out — there is one per guest. Two
 * replies close together send in parallel (the reply handler does not wait,
 * and the SMTP transport is not pooled), and the first reply's session can be
 * the slower one: a TLS handshake, a greylisting relay. Its link was then
 * activated last and took the place of the newer one, so the guest's newest
 * letter opened nothing while the older one worked — and the page's «самое
 * новое письмо» pointed at the dead one.
 *
 * The real `SupportNotificationsService` and `SupportGuestService` here; only
 * the database, SMTP and the cabinet address are stand-ins.
 */

afterEach(() => {
  mock.restoreAll();
});

interface GuestRow {
  id: string;
  secretHash: string;
  emailResumeHash: string | null;
  email: string | null;
  expiresAt: Date;
}

function buildPanel(options: { readonly retryDelaysMs?: readonly number[] } = {}) {
  const guests: GuestRow[] = [];
  const tickets: Array<{ id: string; guestId: string; status: string; subject: string }> = [];
  const matches = (row: GuestRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);
  const withTicket = (guest: GuestRow | undefined) => {
    if (guest === undefined) return null;
    const ticket = tickets.find((t) => t.guestId === guest.id) ?? null;
    return { ...guest, ticket: ticket === null ? null : { id: ticket.id, status: ticket.status } };
  };
  const prisma = {
    supportGuest: {
      create: async ({ data }: { data: Omit<GuestRow, 'id' | 'emailResumeHash'> }) => {
        const row: GuestRow = { id: `guest${guests.length + 1}`, emailResumeHash: null, ...data };
        guests.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<GuestRow> }) => {
        const row = guests.find((g) => g.id === where.id);
        if (row === undefined) throw new Error('not found');
        return Object.assign(row, data);
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<GuestRow> }) => {
        const hit = guests.filter((g) => matches(g, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
      findFirst: async ({ where }: { where: { OR: Array<Record<string, unknown>> } }) =>
        withTicket(guests.find((g) => where.OR.some((condition) => matches(g, condition)))),
      findUnique: async ({ where }: { where: { id: string } }) => withTicket(guests.find((g) => g.id === where.id)),
    },
    supportTicket: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const ticket = tickets.find((t) => t.id === where.id);
        if (ticket === undefined) return null;
        const guest = guests.find((g) => g.id === ticket.guestId);
        return {
          subject: ticket.subject,
          status: ticket.status,
          guestId: ticket.guestId,
          guest: guest === undefined ? null : { id: guest.id, email: guest.email, expiresAt: guest.expiresAt },
        };
      },
    },
  };
  const ticketsService = {
    createGuest: async ({ guestId, subject }: { guestId: string; subject: string }) => {
      const row = { id: `ticket${tickets.length + 1}`, guestId, status: 'OPEN', subject };
      tickets.push(row);
      return { id: row.id };
    },
    addMessage: async () => undefined,
    getById: async (id: string) => ({ id }),
  };
  const guestService = new SupportGuestService(
    prisma as never,
    ticketsService as never,
    {} as never,
    { getSupportLimits: async () => ({ guestTokenTtlHours: 72 }) } as never,
    { cryptKey: 'letter-order-spec-crypt-key-0123456789abcdef' } as never,
  );

  /**
   * Letters as they were handed to SMTP, attempt by attempt, with the `Date`
   * each would carry; `hold(n)` keeps the n-th one's session open, `fail(n)`
   * makes it a transient failure. `delivered` is what reached the inbox, in
   * the order it arrived.
   */
  const letters: string[] = [];
  const dates: Array<Date | undefined> = [];
  const delivered: Array<{ readonly html: string; readonly date: Date | undefined }> = [];
  const held = new Map<number, () => void>();
  const holding = new Set<number>();
  const failing = new Set<number>();
  const notifications = new SupportNotificationsService(
    {} as never,
    prisma as never,
    {
      getSmtpSettings: async () => ({ enabled: true, host: 'smtp.example.com' }),
      sendImmediate: async (payload: { rawHtml?: string; date?: Date }) => {
        letters.push(payload.rawHtml ?? '');
        dates.push(payload.date);
        const n = letters.length;
        if (holding.has(n)) await new Promise<void>((release) => held.set(n, release));
        if (failing.has(n)) return { success: false, error: 'Connection timeout' };
        delivered.push({ html: payload.rawHtml ?? '', date: payload.date });
        return { success: true };
      },
    } as never,
    guestService,
    { getByType: async () => null } as never,
    { resolveCabinetWebBaseUrl: async () => 'https://cab.example.com' } as never,
  );
  (notifications as unknown as { guestLetterRetryDelaysMs: readonly number[] }).guestLetterRetryDelaysMs =
    options.retryDelaysMs ?? [];

  return {
    guests,
    guestService,
    notifications,
    letters,
    dates,
    delivered,
    hold: (n: number) => holding.add(n),
    release: (n: number) => held.get(n)?.(),
    fail: (n: number) => failing.add(n),
  };
}

function linkOf(letter: string | undefined): string {
  const encoded = /resume=([^"&]+)/.exec(letter ?? '')?.[1];
  assert.ok(encoded !== undefined, `the letter has no link: ${letter}`);
  return decodeURIComponent(encoded);
}

async function opens(panel: ReturnType<typeof buildPanel>, token: string): Promise<boolean> {
  return (await panel.guestService.getConversation(token)) !== null;
}

/** Lets every pending step of the notifications run to its next wait. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('two guest reply letters in flight together', () => {
  it('leave the NEWEST letter as the one that opens the conversation, when the first is slower', async () => {
    const warnings: string[] = [];
    mock.method(Logger.prototype, 'warn', (message: unknown) => {
      warnings.push(String(message));
    });
    const panel = buildPanel();
    await panel.guestService.createConversation({ subject: 'Оплата', message: 'не прошла', email: 'v@example.com' });
    panel.hold(1); // reply 1's SMTP session is the slow one

    const first = panel.notifications.notifyGuestReply('ticket1');
    await settle();
    const second = panel.notifications.notifyGuestReply('ticket1');
    await second; // reply 2's letter went out, and its link is live
    panel.release(1); // reply 1's letter is accepted only now
    await first;

    const older = linkOf(panel.letters[0]);
    const newest = linkOf(panel.letters[1]);
    assert.equal(await opens(panel, newest), true, 'the newest letter opens nothing');
    assert.equal(await opens(panel, older), false, 'the older letter took the link back');
    // Losing to a newer letter is the ordinary case, not a failure to report.
    assert.deepEqual(warnings, []);
  });

  it('let an older delivered letter be the link when the newer one never went out', async () => {
    const panel = buildPanel();
    await panel.guestService.createConversation({ subject: 'Оплата', message: 'не прошла', email: 'v@example.com' });
    panel.hold(1);
    panel.fail(2); // reply 2's letter is refused, and there are no retries here

    const first = panel.notifications.notifyGuestReply('ticket1');
    await settle();
    await panel.notifications.notifyGuestReply('ticket1');
    panel.release(1);
    await first;

    assert.equal(await opens(panel, linkOf(panel.letters[0])), true, 'the only letter that arrived opens nothing');
  });

  it('in the usual order, one after the other, leave the later one as the link', async () => {
    const panel = buildPanel();
    await panel.guestService.createConversation({ subject: 'Оплата', message: 'не прошла', email: 'v@example.com' });

    await panel.notifications.notifyGuestReply('ticket1');
    await panel.notifications.notifyGuestReply('ticket1');

    assert.equal(await opens(panel, linkOf(panel.letters[1])), true);
    assert.equal(await opens(panel, linkOf(panel.letters[0])), false);
  });
});

/**
 * WHAT THE GUEST SEES AS «САМОЕ НОВОЕ ПИСЬМО» IS THE ONE THAT OPENS.
 *
 * The page's out-of-date notice sends the guest to the newest letter. An inbox
 * orders letters either by their `Date` header (Thunderbird and many phone
 * clients) or by when they arrived (Gmail orders by the time Google accepted
 * the message, Outlook by «Received»), so the letter that is last by BOTH has
 * to be the live one. A retried older reply broke that: its token had been
 * minted before its first attempt, so its retry — the last letter to go out,
 * dated last by nodemailer — lost to the newer reply's link and opened nothing.
 */
describe('the order a guest sees their letters in', () => {
  /** The delivered letter that an inbox sorting by `Date` shows last. */
  function lastByDate(panel: ReturnType<typeof buildPanel>) {
    return [...panel.delivered].reduce((later, letter) =>
      (letter.date?.getTime() ?? -Infinity) >= (later.date?.getTime() ?? -Infinity) ? letter : later,
    );
  }

  it('is the order of the links when an older reply’s letter goes out on a retry, after a newer reply’s', async () => {
    // Reply 1's first attempt is a transient failure; reply 2's
    // letter goes out meanwhile; reply 1's retry goes out after it.
    const panel = buildPanel({ retryDelaysMs: [40] });
    await panel.guestService.createConversation({ subject: 'Оплата', message: 'не прошла', email: 'v@example.com' });
    panel.fail(1);

    const first = panel.notifications.notifyGuestReply('ticket1');
    await settle(); // attempt 1 failed; the retry waits 40 ms
    await panel.notifications.notifyGuestReply('ticket1'); // reply 2's letter goes out
    await first; // reply 1's retry goes out now, last

    assert.equal(panel.delivered.length, 2);
    const arrivedLast = panel.delivered[1];
    assert.equal(await opens(panel, linkOf(arrivedLast.html)), true, 'the letter that arrived last opens nothing');
    assert.equal(await opens(panel, linkOf(lastByDate(panel).html)), true, 'the letter dated last opens nothing');
    assert.equal(await opens(panel, linkOf(panel.delivered[0].html)), false, 'two letters open at once');
  });

  it('is the order of the links when the first reply’s session is the slower one', async () => {
    // By `Date` the newest is reply 2's letter, which the links agree with.
    // (By arrival the slow letter lands last — a Date cannot
    // follow a session that has not ended yet.)
    const panel = buildPanel();
    await panel.guestService.createConversation({ subject: 'Оплата', message: 'не прошла', email: 'v@example.com' });
    panel.hold(1);

    const first = panel.notifications.notifyGuestReply('ticket1');
    await settle();
    // A letter is dated to the millisecond: two replies minted in the same one
    // carry the same `Date`, and no letter is "dated last". It flaked so in the
    // full run, where both replies can fit in one millisecond.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await panel.notifications.notifyGuestReply('ticket1');
    panel.release(1);
    await first;

    assert.equal(await opens(panel, linkOf(lastByDate(panel).html)), true, 'the letter dated last opens nothing');
  });

  it('dates each letter at the moment its link was minted, to the millisecond', async () => {
    // The `Date` header is pinned to the stamp its link carries, so the two
    // orders cannot drift apart by the time the composer takes.
    const panel = buildPanel({ retryDelaysMs: [0] });
    await panel.guestService.createConversation({ subject: 'Оплата', message: 'не прошла', email: 'v@example.com' });
    panel.fail(1);

    await panel.notifications.notifyGuestReply('ticket1');

    assert.equal(panel.letters.length, 2);
    for (const [n, html] of panel.letters.entries()) {
      const stamp = /^(\d{16})\./.exec(linkOf(html))?.[1];
      assert.ok(stamp !== undefined, `attempt ${n + 1} carries no stamped link`);
      assert.equal(panel.dates[n]?.getTime(), Math.floor(Number(stamp) / 1000), `attempt ${n + 1} is not dated at its stamp`);
    }
    assert.notEqual(linkOf(panel.letters[0]), linkOf(panel.letters[1]), 'the retry reused the failed attempt’s link');
  });
});
