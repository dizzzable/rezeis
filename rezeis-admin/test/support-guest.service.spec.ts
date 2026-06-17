import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { SupportGuestService } from '../src/modules/support-tickets/services/support-guest.service';

/**
 * Server-bound guest identity (Phase 2). Verifies the Correctness
 * Properties from the design:
 *  - P2 server-bound authorization (resolve only by token hash),
 *  - P3 uniform negative (unknown/expired/closed → null),
 *  - P4 no raw secret at rest (only sha256 stored),
 *  - P6 closed ⇒ no read/write.
 */

interface GuestRow {
  id: string;
  secretHash: string;
  email: string | null;
  ipHash: string | null;
  expiresAt: Date;
  ticket: { id: string; status: string } | null;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function build() {
  const byHash = new Map<string, GuestRow>();
  const byId = new Map<string, GuestRow>();
  let seq = 0;

  const ticketsCalls = { createGuest: 0, addMessage: [] as unknown[], close: [] as unknown[], getById: [] as string[], ticketUpdates: [] as Array<Record<string, unknown>> };

  const prisma = {
    supportGuest: {
      create: async ({ data }: { data: Omit<GuestRow, 'id' | 'ticket'> }) => {
        const id = `g-${++seq}`;
        const row: GuestRow = { id, ...data, ticket: null };
        byHash.set(data.secretHash, row);
        byId.set(id, row);
        return { id };
      },
      findFirst: async ({ where }: { where: { OR: Array<{ secretHash?: string; emailResumeHash?: string }> } }) => {
        for (const cond of where.OR ?? []) {
          if (cond.secretHash) {
            const row = byHash.get(cond.secretHash);
            if (row) return { id: row.id, expiresAt: row.expiresAt, ticket: row.ticket };
          }
          if (cond.emailResumeHash) {
            for (const row of byHash.values()) {
              if ((row as { emailResumeHash?: string }).emailResumeHash === cond.emailResumeHash) {
                return { id: row.id, expiresAt: row.expiresAt, ticket: row.ticket };
              }
            }
          }
        }
        return null;
      },
      update: async () => ({}),
    },
    user: {
      findUnique: async ({ where }: { where: { id?: string; telegramId?: bigint } }) => {
        // A sentinel reiwa_id models the "unknown user" case.
        if (where.id === 'cmunknownuseridentifierx') return null;
        return { id: where.id ?? 'u-from-tg' };
      },
    },
    supportTicket: {
      update: async (args: { data: Record<string, unknown> }) => {
        ticketsCalls.ticketUpdates.push(args.data);
        return {};
      },
    },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };

  const tickets = {
    createGuest: async ({ guestId, subject }: { guestId: string; subject: string }) => {
      ticketsCalls.createGuest += 1;
      const ticket = { id: `t-${guestId}`, status: 'OPEN', subject };
      const row = byId.get(guestId);
      if (row) row.ticket = { id: ticket.id, status: 'OPEN' };
      return ticket;
    },
    addMessage: async (input: unknown) => {
      ticketsCalls.addMessage.push(input);
      return {};
    },
    getById: async (ticketId: string) => {
      ticketsCalls.getById.push(ticketId);
      return { id: ticketId };
    },
    close: async (input: unknown) => {
      ticketsCalls.close.push(input);
      return {};
    },
  };

  const attachments = {
    storeForMessage: async () => ({ id: 'a-1' }),
    streamForTicket: async () => null,
  };

  const settings = {
    getSupportLimits: async () => ({
      enabled: true,
      guestTokenTtlHours: 72,
      attachmentMaxBytes: 10 * 1024 * 1024,
      attachmentMaxPerMsg: 5,
    }),
  };

  const service = new SupportGuestService(
    prisma as never,
    tickets as never,
    attachments as never,
    settings as never,
  );
  return { service, byHash, byId, ticketsCalls };
}

describe('SupportGuestService', () => {
  it('creates a conversation, stores only the token hash (P4) and seeds the first message', async () => {
    const { service, byHash, ticketsCalls } = build();
    const { token, ticketId } = await service.createConversation({
      subject: 'Payment failed',
      message: 'My payment did not go through',
    });
    assert.ok(token.length >= 40);
    assert.equal(ticketsCalls.createGuest, 1);
    assert.equal(ticketsCalls.addMessage.length, 1);
    assert.equal(ticketId, 't-g-1');
    // Raw token is never stored — only its sha256.
    assert.ok(!byHash.has(token));
    assert.ok(byHash.has(sha256(token)));
  });

  it('resolves the conversation only by the matching token hash (P2)', async () => {
    const { service, ticketsCalls } = build();
    const { token } = await service.createConversation({ subject: 's', message: 'm' });
    const ok = await service.getConversation(token);
    assert.notEqual(ok, null);
    assert.ok(ticketsCalls.getById.length >= 1);
    // A different token never resolves to the conversation.
    const bad = await service.getConversation('not-the-token');
    assert.equal(bad, null);
  });

  it('returns uniform null for empty, unknown, expired and closed (P3, P6)', async () => {
    const { service, byHash } = build();
    const { token } = await service.createConversation({ subject: 's', message: 'm' });

    assert.equal(await service.getConversation(''), null);
    assert.equal(await service.getConversation('garbage'), null);

    // Expire the guest → null.
    const row = byHash.get(sha256(token));
    assert.ok(row);
    const savedExpiry = row.expiresAt;
    row.expiresAt = new Date(Date.now() - 1000);
    assert.equal(await service.getConversation(token), null);
    row.expiresAt = savedExpiry;

    // Close the ticket → null (no read/write after close).
    row.ticket = { id: row.ticket?.id ?? 'x', status: 'CLOSED' };
    assert.equal(await service.getConversation(token), null);
    assert.equal(await service.reply(token, 'still there?'), null);
    assert.equal(await service.close(token), false);
  });

  it('appends a guest reply only while open and closes with a guest marker', async () => {
    const { service, ticketsCalls } = build();
    const { token } = await service.createConversation({ subject: 's', message: 'm' });
    const replied = await service.reply(token, 'any update?');
    assert.notEqual(replied, null);
    const lastMsg = ticketsCalls.addMessage[ticketsCalls.addMessage.length - 1] as {
      authorType: string;
      authorId: string | null;
    };
    assert.equal(lastMsg.authorType, 'USER');
    assert.equal(lastMsg.authorId, null);

    const closed = await service.close(token);
    assert.equal(closed, true);
    const closeArg = ticketsCalls.close[ticketsCalls.close.length - 1] as { closedBy: string };
    assert.match(closeArg.closedBy, /^guest:/);
  });
});

describe('SupportGuestService.attachToUser', () => {
  it('transfers ownership to the account (CABINET, guestId cleared)', async () => {
    const { service, ticketsCalls } = build();
    const { token } = await service.createConversation({ subject: 's', message: 'm' });
    const ok = await service.attachToUser(token, 'cmrealuseridentifier01x');
    assert.equal(ok, true);
    const upd = ticketsCalls.ticketUpdates.find((u) => 'userId' in u);
    assert.ok(upd);
    assert.equal(upd?.channel, 'CABINET');
    assert.equal(upd?.guestId, null);
  });

  it('refuses without a valid guest token (P: cannot link without a token)', async () => {
    const { service } = build();
    assert.equal(await service.attachToUser('not-a-token', 'cmrealuseridentifier01x'), false);
  });

  it('refuses when the target account does not exist', async () => {
    const { service } = build();
    const { token } = await service.createConversation({ subject: 's', message: 'm' });
    assert.equal(await service.attachToUser(token, 'cmunknownuseridentifierx'), false);
  });

  it('refuses a malformed user reference', async () => {
    const { service } = build();
    const { token } = await service.createConversation({ subject: 's', message: 'm' });
    assert.equal(await service.attachToUser(token, '!!!'), false);
  });
});
