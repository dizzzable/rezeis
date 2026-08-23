import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminAuditController } from '../src/modules/audit/controllers/admin-audit.controller';
import { AdminPartnersController } from '../src/modules/partners/controllers/admin-partners.controller';
import { AdminPlansController } from '../src/modules/plans/controllers/admin-plans.controller';
import { AdminRbacController } from '../src/modules/rbac/controllers/admin-rbac.controller';
import { SYSTEM_ROLES, isValidPermission } from '../src/modules/rbac/rbac.resources';
import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';
import { AdminUserWebController } from '../src/modules/users/controllers/admin-user-web.controller';
import { assertEffectiveRoutePermission } from './helpers/controller-routes';

/**
 * Routes whose declared permission did not match what they actually do.
 *
 * Each of these was gated - the guard ran, the decorator was there, a 403 was
 * possible - on the wrong resource. That failure mode is invisible in review
 * (the line looks like every other line) and invisible in testing (the endpoint
 * works), and it only shows up as the wrong ROLE being able to press the
 * button. So the assertions below name the role that could, and why the pairing
 * is wrong, rather than only pinning a string.
 */

function grantsOf(roleName: string): ReadonlySet<string> {
  const role = SYSTEM_ROLES.find((r) => r.name === roleName);
  assert.ok(role, `system role ${roleName} is no longer seeded`);
  return new Set(role.permissions.map((p) => `${p.resource}:${p.action}`));
}

describe('partner-mutating routes on the user card require partners:edit', () => {
  // Five routes under `/admin/users/:telegramId/...` write a `Partner` row -
  // create it, flip `isActive`, move `balance`, rewrite the commission
  // settings, attach a referral into the chain. All five required `users:edit`.
  const proto = AdminUserManagementController.prototype;
  const partnerRoutes: ReadonlyArray<[string, (...args: never[]) => unknown]> = [
    ['POST create-partner', proto.createPartner],
    ['POST partner/toggle', proto.togglePartner],
    ['POST partner/adjust-balance', proto.adjustPartnerBalance],
    ['PATCH partner/settings', proto.updatePartnerSettings],
    ['POST partner/attach-referral', proto.attachPartnerReferral],
  ];

  for (const [label, handler] of partnerRoutes) {
    it(`${label} is gated on partners:edit`, () => {
      assertEffectiveRoutePermission(
        AdminUserManagementController,
        handler,
        { resource: 'partners', action: 'edit' },
        `${label} (writes a Partner row)`,
      );
    });
  }

  it('agrees with the duplicate endpoints on the partners controller', () => {
    // `admin-partners.controller.ts` exposes the same two operations against a
    // partner id and had always required `partners:edit`. Two routes doing the
    // same write behind different permissions is the bug, whichever one moves.
    assertEffectiveRoutePermission(
      AdminPartnersController,
      AdminPartnersController.prototype.toggle,
      { resource: 'partners', action: 'edit' },
      'POST admin/partners/:partnerId/toggle',
    );
    assertEffectiveRoutePermission(
      AdminPartnersController,
      AdminPartnersController.prototype.adjustBalance,
      { resource: 'partners', action: 'edit' },
      'POST admin/partners/:partnerId/adjust-balance',
    );
  });

  it('names the role that could move a partner balance without partners:edit', () => {
    // This is why the mismatch mattered rather than being untidy: the shipped
    // `operator` role holds `users:edit` and only `partners:view`, so it could
    // read partner data by design and adjust a balance by accident.
    const operator = grantsOf('operator');
    assert.ok(operator.has('users:edit'), 'operator is expected to hold users:edit');
    assert.ok(operator.has('partners:view'), 'operator is expected to hold partners:view');
    assert.equal(
      operator.has('partners:edit'),
      false,
      'operator must not hold partners:edit - if it now does, these routes are open to it again '
        + 'and the seed change needs to be a deliberate decision, not a side effect',
    );
  });

  it('gates manual referrer attachment on referrals:edit, like its two siblings', () => {
    for (const [label, handler] of [
      ['POST referral/attach', proto.attachReferrer],
      ['POST referral/sync-stealthnet', proto.syncStealthnetReferrer],
      ['POST referral/qualify', proto.qualifyReferral],
    ] as ReadonlyArray<[string, (...args: never[]) => unknown]>) {
      assertEffectiveRoutePermission(
        AdminUserManagementController,
        handler,
        { resource: 'referrals', action: 'edit' },
        `${label} (rewrites the referral graph)`,
      );
    }
  });
});

describe('reading back a live customer credential requires users:edit', () => {
  it('gates GET web/temp-password the same as the route that issues it', () => {
    // The route returns the plaintext temporary web password while it is still
    // valid. It inherited the class-level `users:view`, which the shipped
    // `support` role holds - so support could sign in to any customer cabinet
    // whose password an operator had just reset.
    assertEffectiveRoutePermission(
      AdminUserWebController,
      AdminUserWebController.prototype.getTemporaryPassword,
      { resource: 'users', action: 'edit' },
      'GET admin/users/:telegramId/web/temp-password (returns a live credential)',
    );
    assertEffectiveRoutePermission(
      AdminUserWebController,
      AdminUserWebController.prototype.resetWebPassword,
      { resource: 'users', action: 'edit' },
      'POST admin/users/:telegramId/web/reset-password (issues that credential)',
    );
  });

  it('names the role that could read the credential under the old gate', () => {
    const support = grantsOf('support');
    assert.ok(support.has('users:view'), 'support is expected to hold users:view');
    assert.equal(
      support.has('users:edit'),
      false,
      'support must not hold users:edit - it is the read-only role',
    );
  });
});

describe('the plan allow-list routes on the user card require plans:edit', () => {
  // `POST`/`DELETE /admin/users/:telegramId/plan-access/:planId` write
  // `Plan.allowedUserIds` — the column that decides who may buy an `ALLOWED`
  // plan, and the same column the plan editor writes under `plans:edit`. Both
  // required `users:edit`. The subject of the write is a PLAN; that it is
  // addressed through a user id is a property of the screen, not of the data.
  const proto = AdminUserManagementController.prototype;

  for (const [label, handler] of [
    ['POST plan-access/:planId', proto.grantPlanAccess],
    ['DELETE plan-access/:planId', proto.revokePlanAccess],
  ] as ReadonlyArray<[string, (...args: never[]) => unknown]>) {
    it(`${label} is gated on plans:edit`, () => {
      assertEffectiveRoutePermission(
        AdminUserManagementController,
        handler,
        { resource: 'plans', action: 'edit' },
        `${label} (writes Plan.allowedUserIds)`,
      );
    });
  }

  it('agrees with the plan editor, which is the other writer of that column', () => {
    // Two routes writing one column behind different permissions is the bug,
    // whichever one moves. `updatePlan` is where the allow-list is written from
    // the Plans tab, and it has always required `plans:edit`.
    assertEffectiveRoutePermission(
      AdminPlansController,
      AdminPlansController.prototype.updatePlan,
      { resource: 'plans', action: 'edit' },
      'PATCH admin/plans/:planId (writes the whole allow-list)',
    );
  });

  it('names the role that could move a plan allow-list without plans:edit', () => {
    // This is why the mismatch mattered rather than being untidy. The shipped
    // `operator` role holds `users:edit` and only `plans:view`: it may look at
    // the plan catalogue by design and was able to hand out — or take away —
    // access to any restricted tariff by accident. It also holds
    // `subscriptions:edit`, which is what the SPA gated the toggle on, so the
    // control was offered to exactly the role the corrected routes refuse.
    const operator = grantsOf('operator');
    assert.ok(operator.has('users:edit'), 'operator is expected to hold users:edit');
    assert.ok(operator.has('plans:view'), 'operator is expected to hold plans:view');
    assert.ok(
      operator.has('subscriptions:edit'),
      'operator is expected to hold subscriptions:edit',
    );
    assert.equal(
      operator.has('plans:edit'),
      false,
      'operator must not hold plans:edit - if it now does, these routes are open to it again '
        + 'and the seed change needs to be a deliberate decision, not a side effect',
    );
  });

  it('leaves the points adjustment on users:edit, where it belongs', () => {
    // The neighbouring defect fixed in the same change was NOT a permission
    // one: `User.points` is a column of the user, `users:edit` is the right
    // gate, and it stays. Pinned so that "audit the permissions" does not later
    // read as "move them all".
    assertEffectiveRoutePermission(
      AdminUserManagementController,
      proto.adjustPoints,
      { resource: 'users', action: 'edit' },
      'POST admin/users/:telegramId/points (writes User.points)',
    );
  });
});

describe('audit export requires the audit:export action that was declared for it', () => {
  it('uses audit:export on the download route and audit:view on the read routes', () => {
    assertEffectiveRoutePermission(
      AdminAuditController,
      AdminAuditController.prototype.export,
      { resource: 'audit', action: 'export' },
      'GET admin/audit/export (downloads the whole log as a file)',
    );
    for (const [label, handler] of [
      ['GET admin/audit', AdminAuditController.prototype.list],
      ['GET admin/audit/events', AdminAuditController.prototype.listLegacy],
      ['GET admin/audit/facets', AdminAuditController.prototype.facets],
    ] as ReadonlyArray<[string, (...args: never[]) => unknown]>) {
      assertEffectiveRoutePermission(
        AdminAuditController,
        handler,
        { resource: 'audit', action: 'view' },
        label,
      );
    }
  });

  it('keeps audit:export a real catalog action that some route enforces', () => {
    // It was in the catalog and in no decorator anywhere: an action an operator
    // could tick or untick in the role editor with no effect either way, while
    // `operator` and `finance` - both holding `audit:view` - downloaded the log
    // regardless.
    assert.equal(isValidPermission('audit', 'export'), true);
    for (const roleName of ['operator', 'finance']) {
      const grants = grantsOf(roleName);
      assert.ok(grants.has('audit:view'), `${roleName} is expected to hold audit:view`);
      assert.equal(
        grants.has('audit:export'),
        false,
        `${roleName} must not be seeded with audit:export - the whole point of separating the `
          + 'action is that reading the log and exporting it are different grants',
      );
    }
  });
});

describe('the role editor cannot be used to grant more than the actor holds', () => {
  it('passes the acting admin resolved grants into every role write', async () => {
    // `RbacService.createRole` / `updateRole` enforce the subset rule, but only
    // over the set they are handed. A controller that resolved the wrong admin
    // - or helpfully passed the full catalog - would leave the service check
    // enforcing nothing while still looking enforced.
    const seen: Array<{ call: string; actorPermissions: ReadonlySet<string> }> = [];
    const resolvedFor: unknown[] = [];
    const rbacService = {
      getEffectivePermissionTokens: async (admin: unknown) => {
        resolvedFor.push(admin);
        return new Set(['rbac_roles:edit']);
      },
      createRole: async (input: { actorPermissions: ReadonlySet<string> }) => {
        seen.push({ call: 'createRole', actorPermissions: input.actorPermissions });
        return null;
      },
      updateRole: async (_id: string, input: { actorPermissions: ReadonlySet<string> }) => {
        seen.push({ call: 'updateRole', actorPermissions: input.actorPermissions });
        return null;
      },
    };
    const controller = new AdminRbacController(rbacService as never);
    const admin = {
      id: 'admin-7',
      role: 'ADMIN',
      rbacRoleId: 'role-9',
    } as never;

    await controller.createRole(
      { name: 'ops', displayName: 'Ops', permissions: [] } as never,
      admin,
    );
    await controller.updateRole(
      'role-1',
      { displayName: 'Ops', permissions: [] } as never,
      admin,
    );

    assert.deepStrictEqual(
      seen.map((s) => s.call),
      ['createRole', 'updateRole'],
    );
    for (const entry of seen) {
      assert.deepStrictEqual(
        [...entry.actorPermissions],
        ['rbac_roles:edit'],
        `${entry.call} must receive the ACTOR's resolved grants, not a wider set`,
      );
    }
    assert.deepStrictEqual(resolvedFor, [
      { id: 'admin-7', role: 'ADMIN', rbacRoleId: 'role-9' },
      { id: 'admin-7', role: 'ADMIN', rbacRoleId: 'role-9' },
    ]);
  });
});
