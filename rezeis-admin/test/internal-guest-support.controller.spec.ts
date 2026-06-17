import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InternalGuestSupportController } from '../src/modules/support-tickets/controllers/internal-guest-support.controller';
import { CreateGuestTicketDto, GuestReplyDto } from '../src/modules/support-tickets/dto/guest-support.dto';

/**
 * reiwa-facing guest controller (Phase 2). Verifies that authorization is
 * derived ONLY from the X-Support-Guest-Token header (no path/body id), that
 * unresolved tokens yield a uniform 404, and that SUPPORT events fire.
 */

const TICKET_ENTITY = {
  id: 't-1',
  subject: 'Payment failed',
  status: 'OPEN',
  channel: 'GUEST',
  createdAt: new Date('2026-06-17T10:00:00.000Z'),
  updatedAt: new Date('2026-06-17T10:05:00.000Z'),
  messages: [
    { id: 'm-1', authorType: 'USER', content: 'help', createdAt: new Date('2026-06-17T10:00:00.000Z') },
    { id: 'm-2', authorType: 'ADMIN', content: 'on it', createdAt: new Date('2026-06-17T10:05:00.000Z') },
  ],
};

function build() {
  const calls = {
    createConversation: [] as unknown[],
    getConversation: [] as string[],
    reply: [] as Array<{ token: string; content: string }>,
    close: [] as string[],
    events: [] as Array<{ type: string; metadata: Record<string, unknown> }>,
  };
  const guestService = {
    createConversation: async (input: unknown) => {
      calls.createConversation.push(input);
      return { token: 'tok-abc', ticketId: 't-1' };
    },
    getConversation: async (token: string) => {
      calls.getConversation.push(token);
      return token === 'tok-abc' ? TICKET_ENTITY : null;
    },
    reply: async (token: string, content: string) => {
      calls.reply.push({ token, content });
      return token === 'tok-abc' ? TICKET_ENTITY : null;
    },
    close: async (token: string) => {
      calls.close.push(token);
      return token === 'tok-abc';
    },
  };
  const systemEvents = {
    info: (type: string, _category: string, _message: string, metadata: Record<string, unknown>) => {
      calls.events.push({ type, metadata });
    },
  };
  const settings = {
    getSupportRuntimeConfig: async () => ({ enabled: true, turnstileSiteKey: '', turnstileSecret: null }),
  };
  const controller = new InternalGuestSupportController(
    guestService as never,
    systemEvents as never,
    settings as never,
  );
  return { controller, calls };
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.constructor.name === 'NotFoundException';
}

describe('InternalGuestSupportController', () => {
  it('creates a conversation, returns the token + serialized ticket, fires SUPPORT_TICKET_CREATED', async () => {
    const { controller, calls } = build();
    const body: CreateGuestTicketDto = { subject: ' Payment failed ', message: ' help ', email: 'a@b.co' };
    const res = await controller.create(body, '203.0.113.9');
    assert.equal(res.token, 'tok-abc');
    assert.equal(res.resumeCode, 'tok-abc');
    assert.equal(res.ticket?.status, 'open');
    assert.equal(res.ticket?.channel, 'guest');
    assert.equal(res.ticket?.messages.length, 2);
    assert.equal(res.ticket?.messages[1].authorType, 'admin');
    // event fired with guest marker
    assert.equal(calls.events.length, 1);
    assert.equal(calls.events[0].metadata.guest, true);
    // subject/message trimmed and forwarded; ip forwarded for hashing
    const created = calls.createConversation[0] as { subject: string; message: string; email: string | null; ipHash: string | null };
    assert.equal(created.subject, 'Payment failed');
    assert.equal(created.message, 'help');
    assert.equal(created.email, 'a@b.co');
    assert.ok(created.ipHash && created.ipHash.length === 64); // sha256 hex
  });

  it('get resolves ONLY by the header token', async () => {
    const { controller, calls } = build();
    const ticket = await controller.get('tok-abc');
    assert.equal(ticket.id, 't-1');
    assert.deepEqual(calls.getConversation, ['tok-abc']);
  });

  it('get returns a uniform 404 for missing/unknown token', async () => {
    const { controller } = build();
    await assert.rejects(() => controller.get(undefined), isNotFound);
    await assert.rejects(() => controller.get('wrong'), isNotFound);
  });

  it('reply appends only with a valid token and fires the user-reply event', async () => {
    const { controller, calls } = build();
    const body: GuestReplyDto = { content: ' any update? ' };
    const ticket = await controller.reply('tok-abc', body);
    assert.equal(ticket.id, 't-1');
    assert.deepEqual(calls.reply[0], { token: 'tok-abc', content: 'any update?' });
    assert.equal(calls.events[0].type, 'support.ticket_user_reply');
    await assert.rejects(() => controller.reply('wrong', body), isNotFound);
  });

  it('close returns ok for a valid token and 404 otherwise', async () => {
    const { controller } = build();
    assert.deepEqual(await controller.close('tok-abc'), { ok: true });
    await assert.rejects(() => controller.close('wrong'), isNotFound);
  });
});
