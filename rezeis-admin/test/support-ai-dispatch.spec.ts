import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SupportAiDispatchService } from '../src/modules/support-tickets/services/support-ai-dispatch.service';
import { SUPPORT_AI_JOBS } from '../src/modules/support-tickets/support-ai.constants';

/**
 * Who answers a client's message once the AI assistant lives in tickets
 * (owner's rules, 16.10.2026):
 *  - a cabinet ticket opened while the assistant is on goes to the assistant;
 *  - the operators are not alerted while it leads the thread;
 *  - they are told exactly once, when it hands the thread over.
 */

interface TicketRow {
  aiActive: boolean;
  aiActiveSince?: Date | null;
  status: string;
  userId: string | null;
  subject: string;
  messages: Array<{ id: string; authorType: string }>;
}

function build(opts: {
  readonly ready?: boolean;
  readonly queueFails?: boolean;
  readonly ticket?: Partial<TicketRow>;
} = {}) {
  const ticket: TicketRow = {
    aiActive: false,
    status: 'OPEN',
    userId: 'u-1',
    subject: 'Не подключается',
    messages: [{ id: 'm-1', authorType: 'USER' }],
    ...opts.ticket,
  };
  const jobs: Array<{ name: string; data: unknown; options: Record<string, unknown> }> = [];
  const events: Array<{ type: string; message: string; metadata: Record<string, unknown> }> = [];
  const prisma = {
    supportTicket: {
      findUnique: async () => ({ id: 't-1', ...ticket }),
      update: async ({ data }: { data: Partial<TicketRow> }) => {
        Object.assign(ticket, data);
        return { id: 't-1', ...ticket };
      },
      // Compare-and-swap on `aiActive` and `status`, as the service relies on.
      updateMany: async ({ where, data }: { where: { aiActive?: boolean; status?: string }; data: Partial<TicketRow> }) => {
        if (where.aiActive !== undefined && ticket.aiActive !== where.aiActive) return { count: 0 };
        if (where.status !== undefined && ticket.status !== where.status) return { count: 0 };
        Object.assign(ticket, data);
        return { count: 1 };
      },
    },
  };
  const aiConfig = {
    getSettings: async () => ({
      enabled: opts.ready !== false,
      apiKey: opts.ready === false ? '' : 'sk-test',
      baseUrl: '',
      model: '',
      modelsEndpoint: '',
      systemPrompt: '',
    }),
  };
  const systemEvents = {
    info: (type: string, _category: string, message: string, metadata: Record<string, unknown>) =>
      events.push({ type, message, metadata }),
  };
  const queue = {
    add: async (name: string, data: unknown, options: Record<string, unknown>) => {
      if (opts.queueFails === true) throw new Error('Redis is down');
      // BullMQ refuses a custom id with ":" unless it has exactly three parts;
      // a fake that accepts anything once hid a month of lost cards.
      const jobId = String(options['jobId']);
      if (jobId.includes(':') && jobId.split(':').length !== 3) throw new Error('Custom Id cannot contain :');
      jobs.push({ name, data, options });
      return { id: jobId };
    },
  };
  const service = new SupportAiDispatchService(prisma as never, aiConfig as never, systemEvents as never, queue as never);
  return { service, ticket, jobs, events };
}

describe('a new cabinet ticket', () => {
  it('goes to the assistant when it is on, and its first answer is queued', async () => {
    const { service, ticket, jobs } = build();
    assert.equal(await service.takeNewTicket('t-1', 'm-1'), 'assistant');
    assert.equal(ticket.aiActive, true);
    assert.ok(ticket.aiActiveSince instanceof Date, 'its reply limit counts from here');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].name, SUPPORT_AI_JOBS.REPLY);
    assert.deepEqual(jobs[0].data, { ticketId: 't-1', messageId: 'm-1' });
    assert.ok(!String(jobs[0].options['jobId']).includes(':'), 'a job id BullMQ accepts');
    assert.ok(Number(jobs[0].options['delay']) > 0, 'a short wait, so three quick lines get one answer');
  });

  it('stays an ordinary ticket while the assistant is off or has no key', async () => {
    const { service, ticket, jobs } = build({ ready: false });
    assert.equal(await service.takeNewTicket('t-1', 'm-1'), 'operator');
    assert.equal(ticket.aiActive, false);
    assert.equal(jobs.length, 0);
  });

  it('falls back to the operators when the answer cannot be queued — nobody waits on silence', async () => {
    const { service, ticket } = build({ queueFails: true });
    assert.equal(await service.takeNewTicket('t-1', 'm-1'), 'operator');
    assert.equal(ticket.aiActive, false);
  });
});

describe('a client message on a ticket', () => {
  it('is the operators\' when the assistant does not lead the thread', async () => {
    const { service, jobs } = build({ ticket: { aiActive: false } });
    assert.equal(await service.onClientMessage('t-1', 'm-2'), 'operator');
    assert.equal(jobs.length, 0);
  });

  it('queues the assistant\'s answer when it leads the thread', async () => {
    const { service, jobs, events } = build({ ticket: { aiActive: true } });
    assert.equal(await service.onClientMessage('t-1', 'm-2'), 'assistant');
    assert.equal(jobs.length, 1);
    assert.equal(events.length, 0, 'no alert while the assistant answers');
  });

  it('hands the thread over at once when the assistant was switched off under it', async () => {
    const { service, ticket, events } = build({ ready: false, ticket: { aiActive: true } });
    assert.equal(await service.onClientMessage('t-1', 'm-2'), 'assistant', 'the hand-over card is the alert');
    assert.equal(ticket.aiActive, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'support.ticket_handed_off');
    assert.equal(events[0].metadata['reason'], 'ai_off');
  });

  it('hands the thread over when the answer cannot be queued', async () => {
    const { service, events } = build({ queueFails: true, ticket: { aiActive: true } });
    assert.equal(await service.onClientMessage('t-1', 'm-2'), 'assistant');
    assert.equal(events[0]?.metadata['reason'], 'ai_error');
  });
});

describe('the hand-over', () => {
  it('tells the operators once, however many paths reach it', async () => {
    const { service, ticket, events } = build({ ticket: { aiActive: true } });
    assert.equal(await service.handOff('t-1', 'клиент просит оператора'), true);
    assert.equal(await service.handOff('t-1', 'ai_error'), false);
    assert.equal(events.length, 1);
    assert.equal(ticket.aiActive, false);
    assert.match(events[0].message, /ИИ передал обращение «Не подключается» оператору: клиент просит оператора/);
  });

  it('puts the thread back in the operators\' queue — not «ждёт ответа клиента»', async () => {
    // The assistant's last reply moved it to WAITING_REPLY; it now waits on a person.
    const { service, ticket } = build({ ticket: { aiActive: true, status: 'WAITING_REPLY' } });
    assert.equal(await service.handOff('t-1', 'нужен возврат'), true);
    assert.equal(ticket.status, 'OPEN');
    const closed = build({ ticket: { aiActive: true, status: 'CLOSED' } });
    await closed.service.handOff('t-1', 'ai_off');
    assert.equal(closed.ticket.status, 'CLOSED');
  });

  it('prints the panel\'s own reasons in words', async () => {
    const { service, events } = build({ ticket: { aiActive: true } });
    await service.handOff('t-1', 'ai_limit');
    assert.match(events[0].message, /ответил 12 раз и вопрос не закрыт/);
  });
});

describe('the operator\'s switch on a ticket', () => {
  it('gives the thread back and answers the client\'s last word at once', async () => {
    const { service, ticket, jobs } = build({ ticket: { aiActive: false } });
    assert.deepEqual(await service.setActive('t-1', true), { aiActive: true });
    assert.equal(ticket.aiActive, true);
    assert.equal(jobs.length, 1);
  });

  it('starts a fresh reply count — a thread given back after the limit is not handed over again at once', async () => {
    const earlier = new Date('2026-10-16T10:00:00.000Z');
    const { service, ticket } = build({ ticket: { aiActive: false, aiActiveSince: earlier } });
    await service.setActive('t-1', true);
    assert.ok(ticket.aiActiveSince instanceof Date && ticket.aiActiveSince > earlier);
  });

  it('does not queue an answer when support had the last word', async () => {
    const { service, jobs } = build({ ticket: { messages: [{ id: 'm-9', authorType: 'ADMIN' }] } });
    await service.setActive('t-1', true);
    assert.equal(jobs.length, 0);
  });

  it('refuses to switch on a silence: assistant off, closed thread, guest thread', async () => {
    await assert.rejects(() => build({ ready: false }).service.setActive('t-1', true), /switched off/);
    await assert.rejects(() => build({ ticket: { status: 'CLOSED' } }).service.setActive('t-1', true), /closed/);
    await assert.rejects(() => build({ ticket: { userId: null } }).service.setActive('t-1', true), /account/);
  });

  it('switches off without a card — the operator is already on the thread', async () => {
    const { service, ticket, events } = build({ ticket: { aiActive: true } });
    await service.setActive('t-1', false);
    assert.equal(ticket.aiActive, false);
    assert.equal(events.length, 0);
  });
});
