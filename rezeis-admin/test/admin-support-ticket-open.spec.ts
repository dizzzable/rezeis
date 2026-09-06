import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminSupportTicketsController } from '../src/modules/support-tickets/controllers/admin-support-tickets.controller';

/**
 * An operator opening a conversation WITH a client.
 *
 * Until now support could only ever answer: every thread began with the
 * client's own words. `support_tickets:create` sat in the RBAC catalog with
 * no route behind it, which is what these cases are about.
 *
 * Three things are load-bearing and each has a case here:
 *
 *  1. the thread is born OPEN, not WAITING_REPLY — `addMessage` flips
 *     OPEN → WAITING_REPLY on an ADMIN message, which is right for a reply
 *     and would hide a brand-new thread behind the panel's default filter
 *     and label it «Ответ» in an unchanged cabinet;
 *  2. the client is NOTIFIED — `addMessage` has no notification hook of its
 *     own, so a create path that forgets this one call produces a thread
 *     the client will never know exists;
 *  3. an ambiguous `@username` is refused, not guessed.
 */

const TICKET = {
  id: 't-1',
  userId: 'u-1',
  subject: 'Уточнение по оплате',
  status: 'OPEN',
  channel: 'CABINET',
  archivedAt: null,
  closedAt: null,
  closedBy: null,
  createdAt: new Date('2026-09-06T10:00:00.000Z'),
  updatedAt: new Date('2026-09-06T10:00:00.000Z'),
  guest: null,
  user: { id: 'u-1', telegramId: 42n, name: 'Ann', username: 'ann', webAccount: null },
  messages: [
    {
      id: 'm-1',
      authorType: 'ADMIN',
      authorId: 'admin-1',
      content: 'Здравствуйте, уточните пожалуйста…',
      createdAt: new Date('2026-09-06T10:00:00.000Z'),
      metadata: null,
      attachments: [],
    },
  ],
  docRequests: [],
};

interface Recorded {
  created: Array<{ userId: string; subject: string; content: string; adminId: string }>;
  notified: Array<{ ticketId: string; subject: string; user: unknown }>;
  audits: Array<{ action: string; metadata: Record<string, unknown> }>;
  replied: unknown[];
}

function build(opts?: {
  /** Rows `user.findMany` returns for an `@username` lookup. */
  usernameMatches?: Array<{ id: string; language: string }>;
  /** `null` makes `user.findUnique` miss, i.e. an unknown reference. */
  uniqueUser?: { id: string; language: string } | null;
}) {
  const calls: Recorded = { created: [], notified: [], audits: [], replied: [] };
  const supportTicketsService = {
    createByAdmin: async (input: Recorded['created'][number]) => {
      calls.created.push(input);
      return { id: TICKET.id, subject: input.subject };
    },
    getById: async () => TICKET,
    addMessage: async (input: unknown) => {
      // Nothing should reach this from the open route: going through
      // `addMessage` is exactly the mistake that lands the ticket in
      // WAITING_REPLY.
      calls.replied.push(input);
      return { id: 'm-x' };
    },
  };
  const supportNotifications = {
    notifyAdminOpenedTicket: async (input: Recorded['notified'][number]) => {
      calls.notified.push(input);
    },
    notifyAdminReply: async () => {
      throw new Error('the reply notification must not be used for a new thread');
    },
  };
  const prismaService = {
    user: {
      findUnique: async () =>
        opts?.uniqueUser === undefined ? { id: 'u-1', language: 'RU' } : opts.uniqueUser,
      findMany: async () => opts?.usernameMatches ?? [],
    },
    adminAuditLog: {
      create: async ({ data }: { data: { action: string; metadata: Record<string, unknown> } }) => {
        calls.audits.push({ action: data.action, metadata: data.metadata });
        return { id: 'a-1' };
      },
    },
  };
  const controller = new AdminSupportTicketsController(
    supportTicketsService as never,
    {} as never,
    supportNotifications as never,
    {} as never,
    prismaService as never,
    {} as never,
    {} as never,
  );
  return { controller, calls };
}

const ADMIN = { id: 'admin-1' } as never;
const REQ = { headers: {}, socket: {} } as never;

function isBadRequest(err: unknown): boolean {
  return err instanceof Error && err.constructor.name === 'BadRequestException';
}
function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.constructor.name === 'NotFoundException';
}

describe('AdminSupportTicketsController.openForUser', () => {
  it('creates the thread and its first message through the admin path', async () => {
    const { controller, calls } = build();
    await controller.openForUser(
      { userRef: '42', subject: 'Уточнение по оплате', message: 'Здравствуйте' },
      ADMIN,
      REQ,
    );
    assert.equal(calls.created.length, 1);
    assert.deepEqual(calls.created[0], {
      userId: 'u-1',
      subject: 'Уточнение по оплате',
      content: 'Здравствуйте',
      adminId: 'admin-1',
    });
    // Never through `addMessage` — see the header comment.
    assert.equal(calls.replied.length, 0);
  });

  it('notifies the client that a conversation was opened', async () => {
    // THE case. Without this call the client has a thread they cannot know
    // about: `addMessage` carries no notification hook, and the cabinet only
    // polls its ticket list every ten seconds while that page is open.
    const { controller, calls } = build();
    await controller.openForUser(
      { userRef: '42', subject: 'Тема', message: 'Текст' },
      ADMIN,
      REQ,
    );
    assert.equal(calls.notified.length, 1);
    assert.equal(calls.notified[0].ticketId, 't-1');
    assert.deepEqual(calls.notified[0].user, { id: 'u-1', language: 'RU' });
  });

  it('records the operator action in the audit log', async () => {
    const { controller, calls } = build();
    await controller.openForUser({ userRef: '42', subject: 'Тема', message: 'Текст' }, ADMIN, REQ);
    assert.equal(calls.audits.length, 1);
    assert.equal(calls.audits[0].action, 'support_ticket.open');
    assert.equal(calls.audits[0].metadata.ticketId, 't-1');
    assert.equal(calls.audits[0].metadata.userId, 'u-1');
  });

  it('trims the subject and the message before storing them', async () => {
    const { controller, calls } = build();
    await controller.openForUser(
      { userRef: '  42  ', subject: '  Тема  ', message: '  Текст  ' },
      ADMIN,
      REQ,
    );
    assert.equal(calls.created[0].subject, 'Тема');
    assert.equal(calls.created[0].content, 'Текст');
  });

  it('refuses an empty subject', async () => {
    const { controller, calls } = build();
    await assert.rejects(
      () => controller.openForUser({ userRef: '42', subject: '   ', message: 'Текст' }, ADMIN, REQ),
      isBadRequest,
    );
    assert.equal(calls.created.length, 0);
  });

  it('refuses an empty message', async () => {
    const { controller } = build();
    await assert.rejects(
      () => controller.openForUser({ userRef: '42', subject: 'Тема', message: '' }, ADMIN, REQ),
      isBadRequest,
    );
  });

  it('refuses a missing recipient', async () => {
    const { controller } = build();
    await assert.rejects(
      () => controller.openForUser({ subject: 'Тема', message: 'Текст' }, ADMIN, REQ),
      isBadRequest,
    );
  });

  it('refuses a subject longer than the cap', async () => {
    const { controller } = build();
    await assert.rejects(
      () =>
        controller.openForUser(
          { userRef: '42', subject: 'я'.repeat(201), message: 'Текст' },
          ADMIN,
          REQ,
        ),
      isBadRequest,
    );
  });

  it('refuses a message longer than the reply cap', async () => {
    const { controller } = build();
    await assert.rejects(
      () =>
        controller.openForUser(
          { userRef: '42', subject: 'Тема', message: 'я'.repeat(10_001) },
          ADMIN,
          REQ,
        ),
      isBadRequest,
    );
  });

  it('reports an unknown recipient as not found, and writes nothing', async () => {
    const { controller, calls } = build({ uniqueUser: null });
    await assert.rejects(
      () => controller.openForUser({ userRef: '999', subject: 'Т', message: 'Т' }, ADMIN, REQ),
      isNotFound,
    );
    assert.equal(calls.created.length, 0);
    assert.equal(calls.notified.length, 0);
  });

  it('resolves an @username', async () => {
    const { controller, calls } = build({ usernameMatches: [{ id: 'u-7', language: 'EN' }] });
    await controller.openForUser({ userRef: '@ann', subject: 'Т', message: 'Т' }, ADMIN, REQ);
    assert.equal(calls.created[0].userId, 'u-7');
    assert.deepEqual(calls.notified[0].user, { id: 'u-7', language: 'EN' });
  });

  it('refuses an @username that matches two accounts instead of guessing', async () => {
    // `User.username` is nullable and NOT unique. Picking the first row would
    // open a private conversation with the wrong person, and the operator
    // would have no way to tell from the screen that it happened.
    const { controller, calls } = build({
      usernameMatches: [
        { id: 'u-7', language: 'EN' },
        { id: 'u-8', language: 'RU' },
      ],
    });
    await assert.rejects(
      () => controller.openForUser({ userRef: '@ann', subject: 'Т', message: 'Т' }, ADMIN, REQ),
      isBadRequest,
    );
    assert.equal(calls.created.length, 0);
  });

  it('reports an @username nobody holds as not found', async () => {
    const { controller } = build({ usernameMatches: [] });
    await assert.rejects(
      () => controller.openForUser({ userRef: '@nobody', subject: 'Т', message: 'Т' }, ADMIN, REQ),
      isNotFound,
    );
  });

  it('refuses a bare @', async () => {
    const { controller } = build();
    await assert.rejects(
      () => controller.openForUser({ userRef: '@', subject: 'Т', message: 'Т' }, ADMIN, REQ),
      isBadRequest,
    );
  });

  it('refuses a reference that is neither a telegramId nor a reiwa_id', async () => {
    const { controller } = build();
    await assert.rejects(
      () => controller.openForUser({ userRef: 'not a ref!', subject: 'Т', message: 'Т' }, ADMIN, REQ),
      isBadRequest,
    );
  });
});
