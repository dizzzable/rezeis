import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminSupportTicketsController } from '../src/modules/support-tickets/controllers/admin-support-tickets.controller';
import { SupportTicketsService } from '../src/modules/support-tickets/services/support-tickets.service';

/**
 * Archive RBAC (Phase 3 / Correctness Property 5). Reading CLOSED
 * (archived) conversations requires `support_tickets.archive`; reopen
 * clears `archivedAt`.
 */

const ADMIN = {
  id: 'admin-1',
  role: 'ADMIN',
  rbacRoleId: 'role-1',
} as never;

function controller(opts: { hasArchive: boolean }) {
  const tickets = {
    list: async () => ({ items: [], total: 0 }),
    isArchived: async () => true,
    getById: async (id: string) => ({
      id,
      userId: null,
      subject: 's',
      status: 'CLOSED',
      channel: 'GUEST',
      archivedAt: new Date(),
      closedAt: new Date(),
      closedBy: 'admin-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
      docRequests: [],
      user: null,
      guest: null,
    }),
  };
  const rbac = {
    hasPermission: async (_a: unknown, _r: string, action: string) =>
      action === 'archive' ? opts.hasArchive : true,
  };
  const ctrl = new AdminSupportTicketsController(
    tickets as never,
    {} as never,
    {} as never,
    {} as never,
    rbac as never,
    {} as never,
  );
  return ctrl;
}

describe('AdminSupportTicketsController archive gating', () => {
  it('denies archive listing without support_tickets.archive', async () => {
    const ctrl = controller({ hasArchive: false });
    await assert.rejects(
      ctrl.list(undefined, undefined, 'true', undefined, 50, 0, ADMIN),
      /archive/i,
    );
  });

  it('allows archive listing with the permission', async () => {
    const ctrl = controller({ hasArchive: true });
    const res = await ctrl.list(undefined, undefined, 'true', undefined, 50, 0, ADMIN);
    assert.deepEqual(res, { items: [], total: 0 });
  });

  it('denies reading an archived ticket without the permission', async () => {
    const ctrl = controller({ hasArchive: false });
    await assert.rejects(ctrl.getById('tkt1', ADMIN), /archive/i);
  });

  it('allows reading an archived ticket with the permission', async () => {
    const ctrl = controller({ hasArchive: true });
    const res = (await ctrl.getById('tkt1', ADMIN)) as { id: string };
    assert.equal(res.id, 'tkt1');
  });
});

describe('SupportTicketsService archive lifecycle', () => {
  function build() {
    const updates: Array<Record<string, unknown>> = [];
    const prisma = {
      supportTicket: {
        findUnique: async ({ select }: { select?: Record<string, unknown> }) => {
          if (select && 'archivedAt' in select) {
            return { archivedAt: new Date(), status: 'CLOSED' };
          }
          return { id: 'tkt1', status: 'CLOSED' };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return { id: 'tkt1', ...data };
        },
      },
    };
    return { service: new SupportTicketsService(prisma as never), updates };
  }

  it('isArchived is true for a CLOSED/archived ticket', async () => {
    const { service } = build();
    assert.equal(await service.isArchived('tkt1'), true);
  });

  it('reopen clears archivedAt (and closedAt/closedBy)', async () => {
    const { service, updates } = build();
    await service.reopen('tkt1');
    const data = updates[updates.length - 1];
    assert.equal(data.archivedAt, null);
    assert.equal(data.closedAt, null);
    assert.equal(data.closedBy, null);
    assert.equal(data.status, 'OPEN');
  });
});
