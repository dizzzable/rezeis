import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SupportTicketsService } from '../src/modules/support-tickets/services/support-tickets.service';

/**
 * Two properties of a ticket row that only became visible once an operator
 * could START a conversation.
 *
 * ── The status a thread is born in ───────────────────────────────────────
 *
 * `addMessage` flips OPEN → WAITING_REPLY on an ADMIN message. Correct for a
 * reply, wrong for an opening line: the panel's ticket list defaults to the
 * `open` bucket, so a thread born WAITING_REPLY vanishes from the operator's
 * own screen the instant they create it, and an unchanged cabinet labels it
 * «Ответ» — a reply to a question nobody asked.
 *
 * ── When the row is touched ──────────────────────────────────────────────
 *
 * Both lists sort by `updatedAt` and both print it as the thread's time, but
 * the row used to be written only on a STATUS TRANSITION. Once a thread
 * settled into WAITING_REPLY, every further operator message left the
 * timestamp alone — so the most active conversation sank below dormant ones.
 */

interface Recorded {
  createdTickets: Array<Record<string, unknown>>;
  createdMessages: Array<Record<string, unknown>>;
  updates: Array<{ where: unknown; data: Record<string, unknown> }>;
}

function build(current: { status: string }) {
  const calls: Recorded = { createdTickets: [], createdMessages: [], updates: [] };
  const tx = {
    supportTicket: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.createdTickets.push(data);
        return { id: 't-1', ...data };
      },
    },
    supportTicketMessage: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.createdMessages.push(data);
        return { id: 'm-1', ...data };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    supportTicket: {
      findUnique: async () => ({ id: 't-1', status: current.status }),
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        calls.updates.push(args);
        return { id: 't-1', ...args.data };
      },
      ...tx.supportTicket,
    },
    supportTicketMessage: {
      ...tx.supportTicketMessage,
      findFirst: async () => null,
    },
    supportDocumentRequest: { findFirst: async () => null, update: async () => ({}) },
  };
  const service = new SupportTicketsService(prisma as never);
  return { service, calls };
}

describe('SupportTicketsService.createByAdmin', () => {
  it('opens the thread in OPEN, not WAITING_REPLY', async () => {
    const { service, calls } = build({ status: 'OPEN' });
    await service.createByAdmin({
      userId: 'u-1',
      subject: 'Уточнение',
      content: 'Здравствуйте',
      adminId: 'admin-1',
    });
    assert.equal(calls.createdTickets.length, 1);
    assert.equal(calls.createdTickets[0].status, 'OPEN');
    assert.equal(calls.createdTickets[0].userId, 'u-1');
  });

  it('writes the first message as ADMIN, attributed to the operator', async () => {
    const { service, calls } = build({ status: 'OPEN' });
    await service.createByAdmin({
      userId: 'u-1',
      subject: 'Уточнение',
      content: 'Здравствуйте',
      adminId: 'admin-1',
    });
    assert.equal(calls.createdMessages.length, 1);
    assert.equal(calls.createdMessages[0].authorType, 'ADMIN');
    assert.equal(calls.createdMessages[0].authorId, 'admin-1');
    assert.equal(calls.createdMessages[0].content, 'Здравствуйте');
  });

  it('does not re-write the status after the first message', async () => {
    // Going through `addMessage` would; that is the whole reason this method
    // builds the pair itself.
    const { service, calls } = build({ status: 'OPEN' });
    await service.createByAdmin({
      userId: 'u-1',
      subject: 'Уточнение',
      content: 'Здравствуйте',
      adminId: 'admin-1',
    });
    assert.equal(calls.updates.length, 0);
  });

  it('creates the thread and the message together', async () => {
    // Both inside `$transaction`: a thread with no message renders as an
    // empty row in two lists and a blank preview, and nothing would ever
    // add the missing message.
    const { service, calls } = build({ status: 'OPEN' });
    await service.createByAdmin({
      userId: 'u-1',
      subject: 'Уточнение',
      content: 'Здравствуйте',
      adminId: 'admin-1',
    });
    assert.equal(calls.createdTickets.length, 1);
    assert.equal(calls.createdMessages.length, 1);
    assert.equal(calls.createdMessages[0].ticketId, 't-1');
  });
});

describe('SupportTicketsService.addMessage — status and activity', () => {
  it('still flips OPEN → WAITING_REPLY on an operator reply', async () => {
    const { service, calls } = build({ status: 'OPEN' });
    await service.addMessage({
      ticketId: 't-1',
      authorType: 'ADMIN',
      authorId: 'admin-1',
      content: 'ответ',
    });
    assert.equal(calls.updates.length, 1);
    assert.equal(calls.updates[0].data.status, 'WAITING_REPLY');
  });

  it('still reopens WAITING_REPLY → OPEN when the client answers', async () => {
    const { service, calls } = build({ status: 'WAITING_REPLY' });
    await service.addMessage({
      ticketId: 't-1',
      authorType: 'USER',
      authorId: 'u-1',
      content: 'спасибо',
    });
    assert.equal(calls.updates[0].data.status, 'OPEN');
  });

  it('touches the row on a second operator message, which changes nothing else', async () => {
    // THE case. Before this, the thread stayed at WAITING_REPLY and no write
    // happened at all, so `updatedAt` froze at the first reply and an active
    // conversation sank in both lists.
    const { service, calls } = build({ status: 'WAITING_REPLY' });
    await service.addMessage({
      ticketId: 't-1',
      authorType: 'ADMIN',
      authorId: 'admin-1',
      content: 'ещё одно',
    });
    assert.equal(calls.updates.length, 1, 'the ticket row was not written at all');
    assert.equal(calls.updates[0].data.status, 'WAITING_REPLY');
  });

  it('touches the row when the client writes again to an OPEN thread', async () => {
    const { service, calls } = build({ status: 'OPEN' });
    await service.addMessage({
      ticketId: 't-1',
      authorType: 'USER',
      authorId: 'u-1',
      content: 'ещё вопрос',
    });
    assert.equal(calls.updates.length, 1);
    assert.equal(calls.updates[0].data.status, 'OPEN');
  });

  it('never reopens a CLOSED thread by writing to it', async () => {
    // Reopening is an explicit operator action with its own route; a message
    // must not do it silently, in either direction.
    for (const authorType of ['ADMIN', 'USER', 'SYSTEM'] as const) {
      const { service, calls } = build({ status: 'CLOSED' });
      await service.addMessage({ ticketId: 't-1', authorType, authorId: 'x', content: 'ping' });
      assert.equal(calls.updates[0].data.status, 'CLOSED', authorType);
    }
  });

  it('touches the row for a SYSTEM message too', async () => {
    const { service, calls } = build({ status: 'OPEN' });
    await service.addMessage({
      ticketId: 't-1',
      authorType: 'SYSTEM',
      authorId: 'admin-1',
      content: 'запрошен документ',
    });
    assert.equal(calls.updates.length, 1);
    assert.equal(calls.updates[0].data.status, 'OPEN');
  });
});
