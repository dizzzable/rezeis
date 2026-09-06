import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminAdvertisingController } from '../src/modules/advertising/controllers/admin-advertising.controller';

/**
 * Who may see the people behind a campaign's numbers
 * ══════════════════════════════════════════════════
 * `GET placements/:id/users` prints names, `@usernames` and Telegram ids. The
 * route decorator asks for `advertising:view` — permission to look at the
 * CAMPAIGN — and a second, hand-written check asks for `users:view` —
 * permission to look at CUSTOMERS. A media-buyer role is exactly the case the
 * pair exists for: give them the numbers, not the people.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * The controller had no spec at all. `controller-auth-metadata.spec.ts`
 * discovers every route and insists each carries SOME `@RequirePermission`,
 * but it cannot see which one, and it cannot see a runtime check at all — so
 * deleting these six lines turned nothing red while handing the customer list
 * to any role holding `advertising:view`.
 *
 * The clamp is here for the same reason: `limit` arrives from a query string,
 * and an unbounded page is a table scan an operator can trigger by hand.
 */

interface Recorded {
  readonly permissionChecks: Array<{ resource: string; action: string }>;
  readonly listCalls: Array<{ placementId: string; limit: number; offset: number }>;
}

const ADMIN = { id: 'admin-1', role: 'ADMIN', rbacRoleId: 'role-9' } as never;

function build(opts: { readonly maySeeUsers: boolean }) {
  const calls: Recorded = { permissionChecks: [], listCalls: [] };
  const metricsService = {
    listPlacementUsers: async (
      placementId: string,
      page: { limit: number; offset: number },
    ) => {
      calls.listCalls.push({ placementId, ...page });
      return { items: [], total: 0 };
    },
  };
  const rbacService = {
    hasPermission: async (_actor: unknown, resource: string, action: string) => {
      calls.permissionChecks.push({ resource, action });
      return opts.maySeeUsers;
    },
  };
  const controller = new AdminAdvertisingController(
    {} as never,
    metricsService as never,
    {} as never,
    {} as never,
    rbacService as never,
  );
  return { controller, calls };
}

describe('AdminAdvertisingController.listPlacementUsers', () => {
  it('refuses a role that may see the campaign but not the customers', async () => {
    // THE case. `advertising:view` alone reaches this handler — the decorator
    // is satisfied — so this check is the only thing between a media buyer and
    // every acquired customer's name and Telegram id.
    const { controller, calls } = build({ maySeeUsers: false });
    await assert.rejects(
      () => controller.listPlacementUsers('p-1', 50, 0, ADMIN),
      (err: unknown) => (err as { getStatus?: () => number }).getStatus?.() === 403,
    );
    assert.equal(calls.listCalls.length, 0, 'the query must not run at all');
  });

  it('asks for users:view by name', async () => {
    // Not merely "asked something": a check against the wrong resource passes
    // for the wrong people, and the refusal above cannot tell the difference.
    const { controller, calls } = build({ maySeeUsers: true });
    await controller.listPlacementUsers('p-1', 50, 0, ADMIN);
    assert.deepEqual(calls.permissionChecks, [{ resource: 'users', action: 'view' }]);
  });

  it('lists them for a role that holds both', async () => {
    const { controller, calls } = build({ maySeeUsers: true });
    await controller.listPlacementUsers('p-1', 50, 0, ADMIN);
    assert.equal(calls.listCalls.length, 1);
    assert.equal(calls.listCalls[0].placementId, 'p-1');
  });

  it('caps the page an operator can ask for', async () => {
    // `limit` comes off a query string. Unbounded, one hand-written URL walks
    // the whole acquisition table.
    const { controller, calls } = build({ maySeeUsers: true });
    await controller.listPlacementUsers('p-1', 100_000, 0, ADMIN);
    assert.equal(calls.listCalls[0].limit, 200);
  });

  it('refuses to read backwards', async () => {
    const { controller, calls } = build({ maySeeUsers: true });
    await controller.listPlacementUsers('p-1', 0, -5, ADMIN);
    assert.equal(calls.listCalls[0].limit, 1, 'a zero page returns nothing forever');
    assert.equal(calls.listCalls[0].offset, 0);
  });
});
