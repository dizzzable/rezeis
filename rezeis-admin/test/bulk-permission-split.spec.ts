import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BulkUserOperationsService } from '../src/modules/users/services/bulk-user-operations.service';

/**
 * The toolbar was a way around the permission model, not a use of it
 * ═════════════════════════════════════════════════════════════════
 *
 * One permission — `users:bulk_operations` — gated everything the multi-select
 * toolbar can do, from setting a language to DELETING accounts. The
 * single-user route for that same deletion requires `users:delete`, which an
 * operator trusted with bulk edits may well not hold.
 *
 * The split is ADDITIVE. `users:bulk_operations` is still required for every
 * action; the destructive ones now also require the permission their
 * single-user twin requires. Nobody gains anything, and an admin with full
 * rights is unaffected — which is why it ships without a role migration.
 */

const ADMIN = { id: 'admin-1', role: 'ADMIN', rbacRoleId: 'role-1' } as never;
const REQUEST_METADATA = { ip: '203.0.113.1', userAgent: 'test' } as never;

function buildService(granted: ReadonlySet<string>) {
  const asked: Array<{ resource: string; action: string }> = [];
  const deletions: string[] = [];
  const service = new BulkUserOperationsService(
    {
      user: {
        findFirst: async () => ({ id: 'user-1', telegramId: 42n, isBlocked: false }),
      },
      adminAuditLog: { create: async () => ({}) },
    } as never,
    { warn: () => undefined, info: () => undefined } as never,
    {
      deleteUser: async (id: string) => {
        deletions.push(id);
      },
    } as never,
    { block: async () => ({}), unblock: async () => ({}) } as never,
    {
      hasPermission: async (_admin: unknown, resource: string, action: string) => {
        asked.push({ resource, action });
        return granted.has(`${resource}:${action}`);
      },
    } as never,
  );
  return { service, asked, deletions };
}

function run(service: BulkUserOperationsService, action: string) {
  return service.execute({
    userIds: ['user-1'],
    action: action as never,
    currentAdmin: ADMIN,
    requestMetadata: REQUEST_METADATA,
  });
}

describe('destructive bulk actions need more than the bulk permission', () => {
  it('refuses a bulk delete from an operator who cannot delete one user', async () => {
    const { service, deletions } = buildService(new Set());

    await assert.rejects(() => run(service, 'delete'));
    // THE assertion: nothing was deleted. A refusal that still ran the first
    // row would be worse than no check.
    assert.deepStrictEqual(deletions, []);
  });

  it('names the missing permission, so nobody asks for a wider role than they need', async () => {
    const { service } = buildService(new Set());

    await assert.rejects(
      () => run(service, 'delete'),
      (err: unknown) =>
        String((err as { getResponse(): { message?: string } }).getResponse().message).includes(
          'users:delete',
        ),
    );
  });

  it('allows it once the operator holds the single-user permission', async () => {
    const { service, deletions } = buildService(new Set(['users:delete']));

    const result = await run(service, 'delete');

    assert.equal(result.succeeded, 1);
    assert.deepStrictEqual(deletions, ['user-1']);
  });

  it('asks about the users resource, matching the single-user route', async () => {
    // The two surfaces must not disagree about who may perform the same act.
    const { service, asked } = buildService(new Set(['users:delete']));

    await run(service, 'delete');

    assert.deepStrictEqual(asked, [{ resource: 'users', action: 'delete' }]);
  });

  it('leaves an ordinary edit behind the bulk permission alone', async () => {
    // Languages, notes and tags are ordinary edits. Requiring a second
    // permission for them would break roles that were correctly scoped.
    const { service, asked } = buildService(new Set());

    await run(service, 'set_language');

    assert.deepStrictEqual(asked, [], 'no extra permission is consulted');
  });
});
