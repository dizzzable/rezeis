import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AdminQuickSearchController } from '../src/modules/dashboard/controllers/admin-quick-search.controller';
import { QuickSearchQueryDto } from '../src/modules/dashboard/dto/quick-search-query.dto';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { SYSTEM_ROLES, isValidPermission } from '../src/modules/rbac/rbac.resources';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
  routeLabel,
  type RoutePermission,
} from './helpers/controller-routes';

/** Where the controller answers — stated once, checked below and used in labels. */
const BASE_PATH = 'admin/quick-search';

/**
 * The Cmd+K overlay is panel chrome, not a domain screen, so it is gated on the
 * cheapest thing every signed-in operator already holds rather than on the
 * domains it searches. Gating it on `users:view` would have been wrong in a way
 * that is easy to miss: `finance` has `payments:view` and no `users:view`, so a
 * finance admin would lose the ability to look up a transaction id — a surface
 * they are explicitly granted — because of a permission on an unrelated domain.
 *
 * The per-domain filtering happens a layer down: `QuickSearchService.search`
 * asks `RbacService.hasPermission` for each of users / subscriptions / payments
 * / promocodes / partners and searches only the ones the caller holds
 * (`quick-search.service.ts:38`). This gate therefore adds an outer wall, it
 * does not replace that filtering — which is why the weakest sensible
 * permission is the right one here.
 */
const DASHBOARD_VIEW: RoutePermission = { resource: 'dashboard', action: 'view' };

describe('AdminQuickSearchController', () => {
  it('is guarded by admin JWT and RBAC guards', () => {
    // `RbacGuard` has to be in the list, not merely implied by the decorator
    // below. Without it nothing reads `REQUIRE_PERMISSION_KEY` on this route:
    // the metadata is set, the endpoint reads as protected, and every
    // authenticated admin still walks through.
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminQuickSearchController), [
      AdminJwtAuthGuard,
      RbacGuard,
    ]);
  });

  it('gates the cross-domain search route on dashboard:view', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminQuickSearchController), BASE_PATH);
    // Read off the class rather than hand-listed, so a second endpoint added
    // here — a "recent hits" feed, a saved-search write — fails this spec
    // instead of inheriting silence.
    assertRouteHandlers(AdminQuickSearchController, ['search']);

    const label = routeLabel(BASE_PATH, RequestMethod.GET, '/');
    assertRoute(
      AdminQuickSearchController.prototype.search,
      { method: RequestMethod.GET, path: '/' },
      label,
    );
    assertRoutePermission(AdminQuickSearchController.prototype.search, DASHBOARD_VIEW, label);

    // The row above says what the listed route costs; this says no route
    // escaped having a cost at all. `RbacGuard` returns `true` for a route
    // carrying no `@RequirePermission` at any level (`rbac.guard.ts:41`), so a
    // forgotten decorator here is not a 403 — it is a cross-domain search over
    // users, subscriptions, transactions, promocodes and partners open to every
    // signed-in admin. The list is empty because nothing here is deliberately
    // ungated.
    assertEveryRouteGuarded(AdminQuickSearchController, []);
  });

  it('keeps the gate reachable for every default system role', () => {
    assert.equal(isValidPermission(DASHBOARD_VIEW.resource, DASHBOARD_VIEW.action), true);

    // The point of this assertion is the one failure mode a permission change
    // has that a compiler cannot see: adding a gate REMOVES access from roles
    // that had the surface yesterday. `superadmin` seeds from
    // `getAllPermissions()` at runtime and holds an empty literal here, so it is
    // checked by construction rather than by this loop.
    for (const seed of SYSTEM_ROLES) {
      if (seed.name === 'superadmin') {
        assert.deepStrictEqual(seed.permissions, [], 'superadmin seeds from getAllPermissions()');
        continue;
      }
      const holdsGate = seed.permissions.some(
        (p) => p.resource === DASHBOARD_VIEW.resource && p.action === DASHBOARD_VIEW.action,
      );
      assert.equal(
        holdsGate,
        true,
        `system role "${seed.name}" lost quick search: it does not hold ` +
          `${DASHBOARD_VIEW.resource}:${DASHBOARD_VIEW.action}, so the Cmd+K overlay mounted in ` +
          'the admin shell now answers 403 for it. Either grant the seed that permission or gate ' +
          'this route on one the role already holds',
      );
    }
  });

  it('passes the parsed query and the calling admin through to the service', async () => {
    const calls: unknown[] = [];
    const controller = new AdminQuickSearchController({
      search: async (input: unknown) => {
        calls.push(input);
        return [{ type: 'user' as const, id: 'user-1', label: 'Ada', subtitle: 'ada@example.com' }];
      },
    } as never);
    const admin = currentAdmin();

    assert.deepStrictEqual(await controller.search({ q: 'ada', limit: 5 }, admin), [
      { type: 'user', id: 'user-1', label: 'Ada', subtitle: 'ada@example.com' },
    ]);
    // `currentAdmin` must reach the service verbatim: it is what the per-domain
    // permission filtering is resolved against. Dropping it would not fail a
    // type check — `search` would just filter against a different admin.
    assert.deepStrictEqual(calls, [{ rawQuery: 'ada', limit: 5, currentAdmin: admin }]);
  });
});

/**
 * The overlay tells the operator "type at least 2 characters", and three
 * independent places have to agree on that number: the SPA's own gate, this
 * DTO, and `QuickSearchService.search`. An off-by-one in any of them turns an
 * advertised minimum into a lie — either a two-character query 400s while the
 * hint says it should work, or a one-character query reaches the database and
 * every domain runs an unbounded `LIKE` scan.
 */
describe('QuickSearchQueryDto', () => {
  it('accepts the advertised two-character minimum', async () => {
    const dto = plainToInstance(QuickSearchQueryDto, { q: 'vp' });

    assert.deepStrictEqual(await validate(dto), []);
  });

  it('rejects a one-character query with the message the operator was promised', async () => {
    const dto = plainToInstance(QuickSearchQueryDto, { q: 'v' });
    const errors = await validate(dto);

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.constraints?.minLength, 'Query must be at least 2 characters');
  });

  /**
   * Query strings arrive as strings; `@Type(() => Number)` is what makes `@Max`
   * compare a number rather than pass a string through. Without the transform
   * `limit=999` is not "too large", it is not a number at all.
   */
  it('coerces limit from its query-string form and holds the 25 ceiling', async () => {
    const accepted = plainToInstance(QuickSearchQueryDto, { q: 'ada', limit: '25' });
    assert.deepStrictEqual(await validate(accepted), []);
    assert.strictEqual(accepted.limit, 25);

    const rejected = plainToInstance(QuickSearchQueryDto, { q: 'ada', limit: '26' });
    assert.equal((await validate(rejected)).length, 1);
  });

  it('leaves limit optional so the service applies its own default', async () => {
    const dto = plainToInstance(QuickSearchQueryDto, { q: 'ada' });

    assert.deepStrictEqual(await validate(dto), []);
    assert.strictEqual(dto.limit, undefined);
  });
});

function currentAdmin(): CurrentAdminInterface {
  return {
    id: 'admin-1',
    login: 'root',
    email: null,
    name: null,
    role: UserRole.ADMIN,
    isActive: true,
    tokenVersion: 1,
    createdAt: new Date('2026-06-03T00:00:00.000Z'),
    lastLoginAt: null,
    lastLoginIp: null,
    rbacRoleId: null,
    mustChangePassword: false,
  };
}
