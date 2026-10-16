import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveNotificationRoute } from '../src/modules/push/admin-notification-routes';
import { SupportTicketsService } from '../src/modules/support-tickets/services/support-tickets.service';

/**
 * Two edges of the AI assistant in tickets that live outside its own module:
 *  - an operator's own message takes the thread from the assistant;
 *  - a client's message on a thread the assistant leads alerts nobody, and
 *    the hand-over does.
 */

function build() {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    supportTicket: {
      findUnique: async () => ({ id: 't-1', status: 'OPEN' }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      },
    },
    supportTicketMessage: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'm-1', ...data }) },
    supportDocumentRequest: {
      findFirst: async () => null,
      update: async () => ({}),
      create: async () => ({ id: 'd-1' }),
    },
  };
  return { service: new SupportTicketsService(prisma as never), updates };
}

describe('an operator\'s message takes the thread from the assistant', () => {
  it('in the same write that moves the status', async () => {
    const { service, updates } = build();
    await service.addMessage({ ticketId: 't-1', authorType: 'ADMIN', authorId: 'admin-1', content: 'Я помогу' });
    assert.equal(updates.length, 1);
    assert.equal(updates[0]['aiActive'], false);
  });

  it('and so does the operator asking for a document', async () => {
    const { service, updates } = build();
    await service.createDocumentRequest({ ticketId: 't-1', requestedBy: 'admin-1', kind: 'PAYMENT_PROOF', label: 'Чек' });
    assert.equal(updates[0]['aiActive'], false);
  });

  it('but the assistant\'s own reply leaves it leading', async () => {
    const { service, updates } = build();
    await service.addMessage({
      ticketId: 't-1',
      authorType: 'ADMIN',
      authorId: null,
      content: 'Попробуйте переустановить профиль',
      metadata: { ai: true },
    });
    assert.equal('aiActive' in updates[0], false);
  });

  it('and so does the client\'s message', async () => {
    const { service, updates } = build();
    await service.addMessage({ ticketId: 't-1', authorType: 'USER', authorId: 'u-1', content: 'не помогло' });
    assert.equal('aiActive' in updates[0], false);
  });
});

describe('who is alerted', () => {
  const event = (type: string, metadata: Record<string, unknown>) =>
    ({ type, category: 'SUPPORT', severity: 'INFO', message: 'm', metadata }) as never;

  it('nobody, for a client\'s message on a thread the assistant leads', () => {
    assert.equal(resolveNotificationRoute(event('support.ticket_user_reply', { ticketId: 't-1', aiHandling: true })), null);
    assert.equal(resolveNotificationRoute(event('support.ticket_created', { ticketId: 't-1', aiHandling: true })), null);
  });

  it('the support category as before, for an ordinary ticket', () => {
    assert.equal(resolveNotificationRoute(event('support.ticket_user_reply', { ticketId: 't-1' }))?.category, 'support');
  });

  it('the support category, with a title of its own, for the hand-over', () => {
    const route = resolveNotificationRoute(event('support.ticket_handed_off', { ticketId: 't-1' }));
    assert.equal(route?.category, 'support');
    assert.equal(route?.title, 'Поддержка: нужен оператор');
    assert.equal(route?.url(event('support.ticket_handed_off', { ticketId: 't-1' })), '/support-tickets?ticket=t-1');
  });
});
