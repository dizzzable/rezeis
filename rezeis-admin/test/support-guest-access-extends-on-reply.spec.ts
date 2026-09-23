import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SupportGuestService } from '../src/modules/support-tickets/services/support-guest.service';
import { SupportNotificationsService } from '../src/modules/support-tickets/services/support-notifications.service';

/**
 * EACH OPERATOR REPLY KEEPS THE GUEST'S ACCESS FOR ANOTHER TTL.
 *
 * A guest's access to their conversation (`expiresAt`) was fixed when the
 * conversation opened: `guestTokenTtlHours` (72 h by default) and never
 * extended. The owner's example: opened Monday 10:00, answered Thursday
 * 12:00 — 74 h later. The access had already ended, the letter went out with
 * no button, and the answer could not be read anywhere.
 *
 * The owner's decision (23.09.2026): «каждый ответ оператора продлевает доступ
 * ещё на 72 часа» — the Thursday reply stays readable until Sunday. So an
 * operator reply moves `expiresAt` to the later of its value and now + TTL,
 * BEFORE the reply letter mints its link. The guest's own messages do not
 * extend it; a closed conversation and one attached to an account are not
 * extended; and a conversation nobody answers still expires.
 *
 * The real `SupportGuestService` and `SupportNotificationsService`; only the
 * database, SMTP, the settings and the cabinet address are stand-ins.
 */

const HOUR = 3_600_000;
/**
 * The panel setting (`guestTokenTtlHours`). Not the default 72 on purpose: a
 * renewal that hard-coded 72 h instead of reading the setting must fail here.
 */
const TTL_HOURS = 48;

interface GuestRow {
  id: string;
  secretHash: string;
  emailResumeHash: string | null;
  email: string | null;
  expiresAt: Date;
}

interface TicketRow {
  id: string;
  guestId: string | null;
  userId: string | null;
  status: string;
  subject: string;
}

/** Does `value` satisfy a Prisma field filter: a value, or `{ gt, lt }` on a date? */
function satisfies(value: unknown, filter: unknown): boolean {
  if (filter instanceof Date) return value instanceof Date && value.getTime() === filter.getTime();
  if (filter !== null && typeof filter === 'object') {
    const { gt, lt } = filter as { gt?: Date; lt?: Date };
    const at = (value as Date).getTime();
    return (gt === undefined || at > gt.getTime()) && (lt === undefined || at < lt.getTime());
  }
  return value === filter;
}

function buildPanel() {
  const guests: GuestRow[] = [];
  const tickets: TicketRow[] = [];
  const matches = (row: object, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => satisfies((row as Record<string, unknown>)[k], v));
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
          ...ticket,
          guest: guest === undefined ? null : { id: guest.id, email: guest.email, expiresAt: guest.expiresAt },
        };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<TicketRow> }) => {
        const row = tickets.find((t) => t.id === where.id);
        if (row === undefined) throw new Error('not found');
        return Object.assign(row, data);
      },
    },
    user: { findUnique: async () => ({ id: 'user-1' }) },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };
  const guestMessages: string[] = [];
  const ticketsService = {
    createGuest: async ({ guestId, subject }: { guestId: string; subject: string }) => {
      const row: TicketRow = { id: `ticket${tickets.length + 1}`, guestId, userId: null, status: 'OPEN', subject };
      tickets.push(row);
      return { id: row.id };
    },
    addMessage: async ({ authorType, content }: { authorType: string; content: string }) => {
      if (authorType === 'USER') guestMessages.push(content);
    },
    getById: async (id: string) => ({ id }),
  };
  const guestService = new SupportGuestService(
    prisma as never,
    ticketsService as never,
    {} as never,
    { getSupportLimits: async () => ({ guestTokenTtlHours: TTL_HOURS }) } as never,
    { cryptKey: 'access-extension-spec-crypt-key-0123456789abcdef' } as never,
  );
  const letters: string[] = [];
  const notifications = new SupportNotificationsService(
    {} as never,
    prisma as never,
    {
      getSmtpSettings: async () => ({ enabled: true, host: 'smtp.example.com' }),
      sendImmediate: async (payload: { rawHtml?: string }) => {
        letters.push(payload.rawHtml ?? '');
        return { success: true };
      },
    } as never,
    guestService,
    { getByType: async () => null } as never,
    { resolveCabinetWebBaseUrl: async () => 'https://cab.example.com' } as never,
  );
  (notifications as unknown as { guestLetterRetryDelaysMs: readonly number[] }).guestLetterRetryDelaysMs = [];

  /** Opens a conversation, as the visitor's cabinet does. */
  const open = async () =>
    guestService.createConversation({ subject: 'Оплата', message: 'не прошла', email: 'v@example.com' });
  /** An operator reply lands: what the reply handler runs for a guest ticket. */
  const operatorReplies = (ticketId: string) => notifications.notifyGuestReply(ticketId);

  return { guests, tickets, guestService, notifications, letters, guestMessages, open, operatorReplies };
}

function linkOf(letter: string | undefined): string | null {
  const encoded = /resume=([^"&]+)/.exec(letter ?? '')?.[1];
  return encoded === undefined ? null : decodeURIComponent(encoded);
}

/** Hours from now to `at`, rounded to the minute's worth. */
function hoursFromNow(at: Date): number {
  return Math.round(((at.getTime() - Date.now()) / HOUR) * 60) / 60;
}

describe('an operator reply to a guest', () => {
  it('on day 4 — after the access ended — extends it, and its letter has a working button', async () => {
    // The owner's example: opened Monday 10:00, answered Thursday 12:00.
    const panel = buildPanel();
    const { token: secret, ticketId } = await panel.open();
    panel.guests[0].expiresAt = new Date(Date.now() - 2 * HOUR); // Thursday 12:00: ended at 10:00
    assert.equal(await panel.guestService.getConversation(secret), null, 'the access had not ended');

    await panel.operatorReplies(ticketId);

    assert.equal(hoursFromNow(panel.guests[0].expiresAt), TTL_HOURS, 'the access was not extended by the TTL');
    const link = linkOf(panel.letters[0]);
    assert.ok(link !== null, `the letter has no button: ${panel.letters[0]}`);
    assert.ok((await panel.guestService.getConversation(link)) !== null, 'the button opens nothing');
    assert.ok((await panel.guestService.getConversation(secret)) !== null, 'the guest’s own code opens nothing');
  });

  it('extends a guest without an email too — no letter, but the conversation opens again', async () => {
    const panel = buildPanel();
    const { token: secret, ticketId } = await panel.open();
    panel.guests[0].email = null;
    panel.guests[0].expiresAt = new Date(Date.now() - 2 * HOUR);

    await panel.operatorReplies(ticketId);

    assert.equal(panel.letters.length, 0);
    assert.ok((await panel.guestService.getConversation(secret)) !== null);
  });

  it('never shortens it: a later end the guest already has stays', async () => {
    // E.g. the TTL was lowered in the settings after this conversation opened.
    const panel = buildPanel();
    const { ticketId } = await panel.open();
    const later = new Date(Date.now() + 200 * HOUR);
    panel.guests[0].expiresAt = later;

    await panel.operatorReplies(ticketId);

    assert.equal(panel.guests[0].expiresAt.getTime(), later.getTime());
  });

  it('does not extend a closed conversation', async () => {
    const panel = buildPanel();
    const { ticketId } = await panel.open();
    const ended = new Date(Date.now() - 2 * HOUR);
    panel.guests[0].expiresAt = ended;
    panel.tickets[0].status = 'CLOSED';

    await panel.operatorReplies(ticketId);

    assert.equal(panel.guests[0].expiresAt.getTime(), ended.getTime());
    assert.equal(linkOf(panel.letters[0]), null, 'a closed conversation got a button');
  });

  it('does not revive a guest identity whose conversation was attached to an account', async () => {
    const panel = buildPanel();
    const { token: secret, ticketId } = await panel.open();
    assert.equal(await panel.guestService.attachToUser(secret, 'cmrealuseridentifier01x'), true);
    assert.equal(panel.guests[0].expiresAt.getTime(), 0);

    // Even called for that ticket directly, and even with the guest still
    // named on it: an attached identity is expired for good.
    assert.equal(await panel.guestService.extendAccessOnOperatorReply(ticketId), false);
    panel.tickets[0].guestId = panel.guests[0].id;
    assert.equal(await panel.guestService.extendAccessOnOperatorReply(ticketId), false);

    assert.equal(panel.guests[0].expiresAt.getTime(), 0);
    assert.equal(await panel.guestService.getConversation(secret), null);
  });
});

describe('a conversation nobody answers', () => {
  it('still expires TTL after it opened, and the guest’s own messages do not extend it', async () => {
    const panel = buildPanel();
    const { token: secret } = await panel.open();
    assert.equal(hoursFromNow(panel.guests[0].expiresAt), TTL_HOURS, 'access does not start at the TTL');

    // Ten hours later the guest writes again: access is where it was.
    const ends = new Date(Date.now() + (TTL_HOURS - 10) * HOUR);
    panel.guests[0].expiresAt = ends;
    assert.ok((await panel.guestService.reply(secret, 'ещё вопрос')) !== null);
    assert.deepEqual(panel.guestMessages, ['не прошла', 'ещё вопрос']);
    assert.equal(panel.guests[0].expiresAt.getTime(), ends.getTime(), 'a guest message extended the access');

    // No operator reply before the TTL ran out: the conversation is closed to the guest.
    panel.guests[0].expiresAt = new Date(Date.now() - 1_000);
    assert.equal(await panel.guestService.getConversation(secret), null);
    assert.equal(await panel.guestService.reply(secret, 'алло?'), null, 'an expired guest could still write');
  });
});
