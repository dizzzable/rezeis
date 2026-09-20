import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { describe, it } from 'node:test';

import {
  AdminNotificationInboxService,
  NOTIFICATIONS_PER_ADMIN,
  NOTIFICATION_RETENTION_DAYS,
} from '../src/modules/admin-notifications/services/admin-notification-inbox.service';
import type { SystemEventPayload } from '../src/common/services/system-events.service';

/**
 * The panel's notification centre, on the two questions it can get wrong:
 * WHO is given a copy of an alert (a permission and an opt-in, decided once,
 * when the event is raised) and WHOSE copy a request may touch (the admin on
 * the token, and nobody else's).
 *
 * Prisma is a recording fake: these assertions are about the arguments the
 * service builds — the scoping `where`, the keyset order, the retention
 * cutoff — because that is where the defects live. Nothing here re-implements
 * a database.
 */

interface CreateManyCall {
  readonly data: readonly Record<string, unknown>[];
}

function createState() {
  return {
    createMany: [] as CreateManyCall[],
    findMany: [] as Record<string, unknown>[],
    updateMany: [] as Record<string, unknown>[],
    deleteMany: [] as Record<string, unknown>[],
    countCalls: [] as Record<string, unknown>[],
    /** Rows the notification `findMany` answers with, in order. */
    rows: [] as Record<string, unknown>[],
    unread: 0,
    /** `{ adminId, count }` groups the overflow query answers with. */
    overflowing: [] as { adminId: string; _count: { _all: number } }[],
    admins: [
      { id: 'admin-1', role: 'ADMIN', rbacRoleId: null },
      { id: 'admin-2', role: 'ADMIN', rbacRoleId: null },
    ] as { id: string; role: string; rbacRoleId: string | null }[],
    adminFindMany: [] as Record<string, unknown>[],
    permitted: new Set<string>(['admin-1', 'admin-2']),
    enabled: new Set<string>(['admin-1', 'admin-2']),
  };
}

type State = ReturnType<typeof createState>;

function createService(state: State): {
  service: AdminNotificationInboxService;
  fire: (event: SystemEventPayload) => Promise<void>;
} {
  let hook: ((event: SystemEventPayload) => void) | null = null;

  const prisma = {
    adminUser: {
      findMany: async (args: Record<string, unknown>) => {
        state.adminFindMany.push(args);
        return state.admins;
      },
    },
    adminNotification: {
      createMany: async (args: CreateManyCall) => {
        state.createMany.push(args);
        return { count: args.data.length };
      },
      findMany: async (args: Record<string, unknown>) => {
        state.findMany.push(args);
        return state.rows;
      },
      count: async (args: Record<string, unknown>) => {
        state.countCalls.push(args);
        return state.unread;
      },
      updateMany: async (args: Record<string, unknown>) => {
        state.updateMany.push(args);
        return { count: 1 };
      },
      deleteMany: async (args: Record<string, unknown>) => {
        state.deleteMany.push(args);
        return { count: 1 };
      },
      groupBy: async () => state.overflowing,
    },
  };

  const rbac = {
    hasPermission: async (admin: { id: string }) => state.permitted.has(admin.id),
  };
  const preferences = {
    isEnabled: async (adminId: string) => state.enabled.has(adminId),
  };
  const systemEvents = {
    registerHook: (fn: (event: SystemEventPayload) => void) => {
      hook = fn;
      return () => undefined;
    },
  };

  const service = new AdminNotificationInboxService(
    prisma as never,
    rbac as never,
    systemEvents as never,
    preferences as never,
  );
  service.onModuleInit();

  return {
    service,
    fire: async (event: SystemEventPayload) => {
      assert.ok(hook, 'the service subscribed to system events');
      (hook as (e: SystemEventPayload) => void)(event);
      // Filing is deliberately not awaited by the raising action.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const ticketCreated: SystemEventPayload = {
  type: 'support.ticket_created',
  category: 'SUPPORT',
  severity: 'WARNING',
  message: 'Новое обращение #42',
  metadata: { ticketId: 'ticket-42' },
};

describe('AdminNotificationInboxService — who is given a copy', () => {
  it('files one copy per entitled admin, with the route’s own words and link', async () => {
    const state = createState();
    const { fire } = createService(state);

    await fire(ticketCreated);

    assert.equal(state.createMany.length, 1);
    assert.deepStrictEqual(state.createMany[0]?.data, [
      {
        adminId: 'admin-1',
        category: 'support',
        severity: 'WARNING',
        type: 'support.ticket_created',
        title: 'Поддержка',
        message: 'Новое обращение #42',
        url: '/support-tickets?ticket=ticket-42',
      },
      {
        adminId: 'admin-2',
        category: 'support',
        severity: 'WARNING',
        type: 'support.ticket_created',
        title: 'Поддержка',
        message: 'Новое обращение #42',
        url: '/support-tickets?ticket=ticket-42',
      },
    ]);
    // Only admins who can still sign in are considered at all.
    assert.deepStrictEqual(state.adminFindMany[0]?.where, { isActive: true });
  });

  it('skips an admin the category’s permission does not cover', async () => {
    const state = createState();
    state.permitted = new Set(['admin-2']);
    const { fire } = createService(state);

    await fire(ticketCreated);

    assert.deepStrictEqual(
      state.createMany[0]?.data.map((row) => row['adminId']),
      ['admin-2'],
    );
  });

  it('skips an admin who switched the category off', async () => {
    const state = createState();
    state.enabled = new Set(['admin-1']);
    const { fire } = createService(state);

    await fire(ticketCreated);

    assert.deepStrictEqual(
      state.createMany[0]?.data.map((row) => row['adminId']),
      ['admin-1'],
    );
  });

  it('writes nothing for an event that is not an alert', async () => {
    const state = createState();
    const { fire } = createService(state);

    // INFO on a category nobody is alerted about: the panel's stream is full of these.
    await fire({
      type: 'user.registered',
      category: 'USER',
      severity: 'INFO',
      message: 'Новый пользователь',
    });

    assert.equal(state.createMany.length, 0);
    assert.equal(state.adminFindMany.length, 0);
  });

  it('never lets a filing failure escape into the raising action', async () => {
    const state = createState();
    const { fire } = createService(state);
    state.admins = null as never;

    await fire(ticketCreated);

    assert.equal(state.createMany.length, 0);
  });
});

describe('AdminNotificationInboxService — whose copy a request may touch', () => {
  it('reads one page newest first, and offers a cursor only when there is more', async () => {
    const state = createState();
    const { service } = createService(state);
    const row = {
      id: 'n-1',
      category: 'support',
      severity: 'WARNING',
      type: 'support.ticket_created',
      title: 'Поддержка',
      message: 'Новое обращение #42',
      url: '/support-tickets?ticket=ticket-42',
      readAt: null,
      createdAt: new Date('2026-09-20T10:00:00.000Z'),
    };
    state.rows = [row];
    state.unread = 3;

    const page = await service.list('admin-1', { limit: 20 });

    assert.deepStrictEqual(state.findMany[0]?.where, { adminId: 'admin-1' });
    assert.deepStrictEqual(state.findMany[0]?.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
    // One more than the page, which is how "is there another page" is answered.
    assert.equal(state.findMany[0]?.take, 21);
    assert.equal(page.nextCursor, null);
    assert.equal(page.unread, 3);
    assert.deepStrictEqual(page.items, [{ ...row, createdAt: '2026-09-20T10:00:00.000Z' }]);
  });

  it('asks only for unread when the bell asks only for unread', async () => {
    const state = createState();
    const { service } = createService(state);

    await service.list('admin-1', { limit: 5, unreadOnly: true, cursor: 'n-9' });

    assert.deepStrictEqual(state.findMany[0]?.where, { adminId: 'admin-1', readAt: null });
    assert.deepStrictEqual(state.findMany[0]?.cursor, { id: 'n-9' });
    assert.equal(state.findMany[0]?.skip, 1);
  });

  it('marks and deletes by admin AND id, so another operator’s copy matches nothing', async () => {
    const state = createState();
    const { service } = createService(state);

    await service.markRead('admin-1', 'n-7');
    await service.remove('admin-1', 'n-7');
    await service.markAllRead('admin-1');
    await service.clear('admin-1', { readOnly: true });

    assert.deepStrictEqual(state.updateMany[0]?.where, { id: 'n-7', adminId: 'admin-1', readAt: null });
    assert.deepStrictEqual(state.deleteMany[0]?.where, { id: 'n-7', adminId: 'admin-1' });
    assert.deepStrictEqual(state.updateMany[1]?.where, { adminId: 'admin-1', readAt: null });
    assert.deepStrictEqual(state.deleteMany[1]?.where, { adminId: 'admin-1', readAt: { not: null } });
  });
});

describe('AdminNotificationInboxService — what it keeps', () => {
  it('drops what is older than the retention window, and trims an inbox over the cap', async () => {
    const state = createState();
    const { service } = createService(state);
    state.overflowing = [{ adminId: 'admin-1', _count: { _all: NOTIFICATIONS_PER_ADMIN + 40 } }];
    const oldestKept = { id: 'n-500', createdAt: new Date('2026-09-01T00:00:00.000Z') };
    state.rows = [oldestKept];
    const before = Date.now();

    await service.prune();

    const expiry = state.deleteMany[0]?.where as { createdAt: { lt: Date } };
    const window = before - expiry.createdAt.lt.getTime();
    assert.ok(
      Math.abs(window - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000) < 5_000,
      'the cutoff is the retention window back from now',
    );
    // The 500th newest row is found by the same keyset the list is ordered by…
    assert.equal(state.findMany[0]?.skip, NOTIFICATIONS_PER_ADMIN - 1);
    // …and everything strictly before it goes, ties on the timestamp included.
    assert.deepStrictEqual(state.deleteMany[1]?.where, {
      adminId: 'admin-1',
      OR: [
        { createdAt: { lt: oldestKept.createdAt } },
        { createdAt: oldestKept.createdAt, id: { lt: oldestKept.id } },
      ],
    });
  });
});
