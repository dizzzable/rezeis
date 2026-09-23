import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { InternalGuestSupportController } from '../src/modules/support-tickets/controllers/internal-guest-support.controller';
import { SupportGuestService } from '../src/modules/support-tickets/services/support-guest.service';

/**
 * A REPLY LETTER'S LINK IS A WAY IN, NOT THE DEVICE'S KEY.
 *
 * Every operator reply to a guest issues a fresh email token and overwrites
 * the previous one (`activateEmailResumeToken`), so a letter's token dies at the
 * next reply. The cabinet used to keep whatever token the visitor arrived with
 * as the device cookie — and a device that came in through a letter, including
 * the device that STARTED the conversation, fell out of it at the operator's
 * very next message, into the "new conversation" form.
 *
 * Now the panel exchanges a letter's token for the conversation's durable
 * device credential, which the cabinet stores instead. Link tokens keep
 * rotating; no device that got in is broken by it. An old letter's token is
 * simply out of date. The credential follows the conversation's own life: it
 * stops when the guest expires, the conversation closes, or it is attached to
 * an account.
 */

const CRYPT_KEY = 'device-credential-spec-crypt-key-0123456789abcdef';

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
  status: string;
  subject: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * A panel over `world` — its own database unless one is passed, so two
 * panels with different crypt keys can share the same rows.
 */
function buildPanel(cryptKey = CRYPT_KEY, world: { guests: GuestRow[]; tickets: TicketRow[] } = { guests: [], tickets: [] }) {
  const { guests, tickets } = world;
  const withTicket = (guest: GuestRow | undefined) => {
    if (guest === undefined) return null;
    const ticket = tickets.find((t) => t.guestId === guest.id) ?? null;
    return {
      id: guest.id,
      secretHash: guest.secretHash,
      emailResumeHash: guest.emailResumeHash,
      expiresAt: guest.expiresAt,
      ticket: ticket === null ? null : { id: ticket.id, status: ticket.status },
    };
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
        Object.assign(row, data);
        return row;
      },
      // A conditional write: every field in `where` must equal the row's.
      updateMany: async ({ where, data }: { where: Partial<GuestRow>; data: Partial<GuestRow> }) => {
        const hit = guests.filter((g) =>
          Object.entries(where).every(([k, v]) => (g as unknown as Record<string, unknown>)[k] === v),
        );
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
      findFirst: async ({ where }: { where: { OR: Array<Partial<GuestRow>> } }) =>
        withTicket(
          guests.find((g) =>
            where.OR.some((cond) =>
              Object.entries(cond).every(([k, v]) => (g as unknown as Record<string, unknown>)[k] === v),
            ),
          ),
        ),
      findUnique: async ({ where }: { where: { id: string } }) =>
        withTicket(guests.find((g) => g.id === where.id)),
    },
    supportTicket: {
      update: async ({ where, data }: { where: { id: string }; data: Partial<TicketRow> }) => {
        const row = tickets.find((t) => t.id === where.id);
        if (row === undefined) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
    },
    user: { findUnique: async () => ({ id: 'user-1' }) },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };
  const ticketsService = {
    createGuest: async ({ guestId, subject }: { guestId: string; subject: string }) => {
      const row = { id: `ticket${tickets.length + 1}`, guestId, status: 'OPEN', subject };
      tickets.push(row);
      return { id: row.id };
    },
    addMessage: async () => undefined,
    getById: async (id: string) => {
      const row = tickets.find((t) => t.id === id);
      return {
        id,
        subject: row?.subject ?? '',
        status: row?.status ?? 'OPEN',
        channel: 'GUEST',
        createdAt: new Date('2026-09-23T10:00:00Z'),
        updatedAt: new Date('2026-09-23T10:00:00Z'),
        messages: [],
      };
    },
    close: async ({ ticketId }: { ticketId: string }) => {
      const row = tickets.find((t) => t.id === ticketId);
      if (row !== undefined) row.status = 'CLOSED';
    },
  };
  const settings = { getSupportLimits: async () => ({ guestTokenTtlHours: 72 }) };
  const service = new SupportGuestService(
    prisma as never,
    ticketsService as never,
    {} as never,
    settings as never,
    { cryptKey } as never,
  );
  const controller = new InternalGuestSupportController(
    service,
    { info: () => undefined } as never,
    settings as never,
    {} as never,
  );
  return { service, controller, guests, tickets, world };
}

async function openConversation(panel: ReturnType<typeof buildPanel>, subject = 'Оплата') {
  const { token } = await panel.service.createConversation({
    subject,
    message: 'не прошла',
    email: 'visitor@example.com',
  });
  return { secret: token, guestId: panel.guests[panel.guests.length - 1].id };
}

/**
 * A reply letter's link, as a letter that went out leaves it: minted, then
 * made THE letter link (which retires the previous letter's).
 */
async function letterFor(panel: ReturnType<typeof buildPanel>, guestId: string): Promise<string> {
  const token = panel.service.newEmailResumeToken();
  assert.equal(await panel.service.activateEmailResumeToken(guestId, token), 'activated');
  return token;
}

/** What the cabinet receives for a token: the thread, plus a credential when it was a way in. */
async function follow(panel: ReturnType<typeof buildPanel>, token: string) {
  try {
    return (await panel.controller.get(token)) as { id: string; deviceToken?: string };
  } catch {
    return null;
  }
}

describe('a reply letter’s link', () => {
  it('is exchanged for a credential that outlives the operator’s next reply', async () => {
    const panel = buildPanel();
    const { guestId } = await openConversation(panel);

    const letter1 = await letterFor(panel, guestId);
    assert.ok(letter1);
    const opened = await follow(panel, letter1);
    assert.ok(opened?.deviceToken, 'the link was not exchanged for a device credential');

    await letterFor(panel, guestId); // the operator replies again

    assert.equal(await follow(panel, letter1), null, 'an old letter still opens the thread');
    assert.equal((await follow(panel, opened.deviceToken))?.id, opened.id);
  });

  it('opens nothing, and retires nothing, until its letter went out', async () => {
    // One letter link per guest: minting a new one must not cost the guest the
    // link in the letter they already have, in case the new letter never
    // arrives. Only activation — after the send — switches them.
    const panel = buildPanel();
    const { guestId } = await openConversation(panel);
    const previous = await letterFor(panel, guestId);

    const minted = panel.service.newEmailResumeToken();
    assert.equal(await follow(panel, minted), null, 'a link opened before its letter went out');
    assert.ok((await follow(panel, previous)) !== null, 'minting a link retired the previous letter’s');

    await panel.service.activateEmailResumeToken(guestId, minted);
    assert.ok((await follow(panel, minted)) !== null);
    assert.equal(await follow(panel, previous), null);
  });

  it('is the NEWEST letter’s, whatever order the letters leave in', async () => {
    // Two operator replies close together: reply 1's letter is minted first,
    // but its SMTP session is the slow one and is accepted after reply 2's.
    // Activated last, it used to overwrite the newer link — the guest's
    // newest letter opened nothing, and the older one did.
    const panel = buildPanel();
    const { guestId } = await openConversation(panel);
    const older = panel.service.newEmailResumeToken();
    const newer = panel.service.newEmailResumeToken();

    const newerOutcome = await panel.service.activateEmailResumeToken(guestId, newer);
    const olderOutcome = await panel.service.activateEmailResumeToken(guestId, older);

    assert.ok((await follow(panel, newer)) !== null, 'the newest letter opens nothing');
    assert.equal(await follow(panel, older), null, 'the older letter took the link back');
    // And the loser is told it lost to a newer letter — not a failure to warn about.
    assert.equal(newerOutcome, 'activated');
    assert.equal(olderOutcome, 'superseded');
  });

  it('stays the newest letter’s when two activations race each other', async () => {
    // Both read the live link before either writes. The write replaces only
    // the value its check was made against, so the older one looks again
    // instead of overwriting the newer one it never saw.
    for (const newerFirst of [true, false]) {
      const panel = buildPanel();
      const { guestId } = await openConversation(panel);
      const older = panel.service.newEmailResumeToken();
      const newer = panel.service.newEmailResumeToken();
      const [a, b] = newerFirst ? [newer, older] : [older, newer];

      await Promise.all([
        panel.service.activateEmailResumeToken(guestId, a),
        panel.service.activateEmailResumeToken(guestId, b),
      ]);

      const order = newerFirst ? 'newer first' : 'older first';
      assert.ok((await follow(panel, newer)) !== null, `${order}: the newest letter opens nothing`);
      assert.equal(await follow(panel, older), null, `${order}: the older letter is live`);
    }
  });

  it('still becomes the link when a newer letter never went out', async () => {
    // "Newer" is decided by what was ACTIVATED, not by what was minted: a
    // reply whose letter failed must not keep an older, delivered letter dead.
    const panel = buildPanel();
    const { guestId } = await openConversation(panel);
    const before = await letterFor(panel, guestId);
    const delivered = panel.service.newEmailResumeToken();
    panel.service.newEmailResumeToken(); // a newer letter that never goes out

    assert.equal(await panel.service.activateEmailResumeToken(guestId, delivered), 'activated');
    assert.ok((await follow(panel, delivered)) !== null);
    assert.equal(await follow(panel, before), null);
  });

  it('never breaks the device that started the conversation', async () => {
    const panel = buildPanel();
    const { secret, guestId } = await openConversation(panel);

    await letterFor(panel, guestId);
    await letterFor(panel, guestId);

    const thread = await follow(panel, secret);
    assert.ok(thread !== null);
    // Its key is already durable: nothing to exchange it for.
    assert.equal(thread.deviceToken, undefined);
  });

  it('gives a credential that opens only its own conversation', async () => {
    const panel = buildPanel();
    const first = await openConversation(panel, 'Первое');
    await openConversation(panel, 'Второе');
    const letter = await letterFor(panel, first.guestId);
    const credential = (await follow(panel, letter ?? ''))?.deviceToken ?? '';

    const other = panel.guests[1].id;
    const forged = credential.replace(first.guestId, other);
    assert.equal(await follow(panel, forged), null, 'a credential re-pointed at another guest opened it');
    assert.equal(await follow(panel, `${credential.slice(0, -2)}xx`), null, 'a tampered credential opened a thread');
    // And it is not a way in itself: presented again, it is not re-exchanged.
    assert.equal((await follow(panel, credential))?.deviceToken, undefined);
  });

  it('ends with the conversation: closed, or attached to an account', async () => {
    const closedPanel = buildPanel();
    const closing = await openConversation(closedPanel);
    const closingLink = await letterFor(closedPanel, closing.guestId);
    const closingKey = (await follow(closedPanel, closingLink ?? ''))?.deviceToken ?? '';
    await closedPanel.service.close(closingKey);
    assert.equal(await follow(closedPanel, closingKey), null);

    const attachedPanel = buildPanel();
    const attaching = await openConversation(attachedPanel);
    const attachingLink = await letterFor(attachedPanel, attaching.guestId);
    const attachingKey = (await follow(attachedPanel, attachingLink ?? ''))?.deviceToken ?? '';
    assert.equal(await attachedPanel.service.attachToUser(attachingKey, 'cmrealuseridentifier01x'), true);
    assert.equal(await follow(attachedPanel, attachingKey), null);
  });

  it('is derived from the panel’s key, never stored', async () => {
    const panel = buildPanel();
    const { guestId } = await openConversation(panel);
    const letter = await letterFor(panel, guestId);
    const credential = (await follow(panel, letter ?? ''))?.deviceToken ?? '';

    for (const row of panel.guests) {
      assert.notEqual(row.secretHash, sha256(credential));
      assert.notEqual(row.emailResumeHash, sha256(credential));
    }
  });

  it('is keyed by the panel’s crypt key: minted under one key, it opens nothing under another', async () => {
    // What makes it unforgeable. With a key that did not come from
    // REZEIS_CRYPT_KEY — a constant — anyone who knows a guest id could mint
    // that conversation's credential, and every case above would still pass.
    const panelA = buildPanel('crypt-key-A-0123456789abcdef0123456789abcdef');
    const { guestId } = await openConversation(panelA);
    const letter = await letterFor(panelA, guestId);
    const credential = (await follow(panelA, letter ?? ''))?.deviceToken ?? '';
    assert.ok(credential, 'no credential was minted');

    // The same database, another key: what rotating REZEIS_CRYPT_KEY does.
    const panelB = buildPanel('crypt-key-B-0123456789abcdef0123456789abcdef', panelA.world);

    assert.equal(await follow(panelB, credential), null, 'a credential opened a thread under another key');
    assert.ok((await follow(panelA, credential)) !== null, 'and under its own key it still opens');
  });
});
