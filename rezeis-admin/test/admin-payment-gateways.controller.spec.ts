import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import {
  CUSTOM_ROUTE_ARGS_METADATA,
  GUARDS_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AdminPaymentGatewaysController } from '../src/modules/payments/controllers/admin-payment-gateways.controller';
import { PaymentGatewayMoveDirection } from '../src/modules/payments/dto/move-payment-gateway.dto';
import { PaymentGatewayRegistryService } from '../src/modules/payments/services/payment-gateway-registry.service';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RbacService } from '../src/modules/rbac/services/rbac.service';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
  routeLabel,
} from './helpers/controller-routes';

/** Where the controller answers — stated once, checked below and used in labels. */
const BASE_PATH = 'admin/payments/gateways';

describe('AdminPaymentGatewaysController', () => {
  it('exposes gateway registry admin routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPaymentGatewaysController), BASE_PATH);
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminPaymentGatewaysController),
      [AdminJwtAuthGuard, RbacGuard],
    );
    // The route set is read off the class rather than remembered here. This
    // controller hands out payment credentials, and until this line the spec
    // described the six routes someone typed out: a seventh — a delete, a
    // connectivity probe, anything carrying no `@RequirePermission` at all —
    // was added past a test whose entire purpose is to prove that cannot
    // happen.
    assertRouteHandlers(AdminPaymentGatewaysController, [
      'listGateways',
      'getSupportedCurrencies',
      'getGateway',
      'updateGateway',
      'moveGateway',
      'createDefaults',
    ]);

    const listRoute = `${routeLabel(BASE_PATH, RequestMethod.GET, '/')} (list gateways)`;
    assertRoute(
      AdminPaymentGatewaysController.prototype.listGateways,
      { method: RequestMethod.GET, path: '/' },
      listRoute,
    );
    assertRoutePermission(
      AdminPaymentGatewaysController.prototype.listGateways,
      { resource: 'payment_gateways', action: 'view' },
      listRoute,
    );

    const currenciesRoute = `${routeLabel(BASE_PATH, RequestMethod.GET, 'supported-currencies')} (currency map)`;
    assertRoute(
      AdminPaymentGatewaysController.prototype.getSupportedCurrencies,
      { method: RequestMethod.GET, path: 'supported-currencies' },
      currenciesRoute,
    );
    assertRoutePermission(
      AdminPaymentGatewaysController.prototype.getSupportedCurrencies,
      { resource: 'payment_gateways', action: 'view' },
      currenciesRoute,
    );

    const getRoute = `${routeLabel(BASE_PATH, RequestMethod.GET, ':gatewayId')} (read one gateway)`;
    assertRoute(
      AdminPaymentGatewaysController.prototype.getGateway,
      { method: RequestMethod.GET, path: ':gatewayId' },
      getRoute,
    );
    assertRoutePermission(
      AdminPaymentGatewaysController.prototype.getGateway,
      { resource: 'payment_gateways', action: 'view' },
      getRoute,
    );

    const updateRoute = `${routeLabel(BASE_PATH, RequestMethod.PATCH, ':gatewayId')} (update gateway)`;
    assertRoute(
      AdminPaymentGatewaysController.prototype.updateGateway,
      { method: RequestMethod.PATCH, path: ':gatewayId' },
      updateRoute,
    );
    assertRoutePermission(
      AdminPaymentGatewaysController.prototype.updateGateway,
      { resource: 'payment_gateways', action: 'edit' },
      updateRoute,
    );

    const moveRoute = `${routeLabel(BASE_PATH, RequestMethod.PATCH, ':gatewayId/move')} (reorder gateway)`;
    assertRoute(
      AdminPaymentGatewaysController.prototype.moveGateway,
      { method: RequestMethod.PATCH, path: ':gatewayId/move' },
      moveRoute,
    );
    assertRoutePermission(
      AdminPaymentGatewaysController.prototype.moveGateway,
      { resource: 'payment_gateways', action: 'edit' },
      moveRoute,
    );

    const defaultsRoute = `${routeLabel(BASE_PATH, RequestMethod.POST, 'defaults')} (seed default gateways)`;
    assertRoute(
      AdminPaymentGatewaysController.prototype.createDefaults,
      { method: RequestMethod.POST, path: 'defaults' },
      defaultsRoute,
    );
    assertRoutePermission(
      AdminPaymentGatewaysController.prototype.createDefaults,
      { resource: 'payment_gateways', action: 'edit' },
      defaultsRoute,
    );
    // The rows above say what each LISTED route costs; this says no route
    // escaped having a cost at all. The two are not the same check: the
    // enumeration forces a new route to be noticed, but it is satisfied by
    // adding a name to it — and a route that never gets a row here is one
    // `RbacGuard` waves through (`rbac.guard.ts:41`), open to any signed-in
    // admin rather than refused. On this controller that is the gateway
    // credential store. No route here is exempt, hence no list.
    assertEveryRouteGuarded(AdminPaymentGatewaysController);
  });

  it('takes the admin it checks from the authenticated request', () => {
    // Every test below hands the admin in as an argument, which only stands for
    // a real request while parameter 0 IS the `@CurrentAdmin()` binding. Were it
    // a `@Body()` or a `@Param()`, the caller would be naming the identity whose
    // permissions decide whether they see credentials, and the checks further
    // down would be asserting that against a value the caller controls.
    const authenticatedAdmin = currentAdmin({ id: 'admin-from-request' });
    const context: HttpExecutionContextStub = {
      switchToHttp: () => ({ getRequest: () => ({ user: authenticatedAdmin }) }),
    };

    for (const methodName of ADMIN_ARGUMENT_ROUTES) {
      const binding = readCurrentAdminBinding(methodName);
      assert.equal(binding.index, 0, `${methodName} must take the admin as its first parameter`);
      assert.equal(
        binding.factory(undefined, context),
        authenticatedAdmin,
        `${methodName} does not fill its admin parameter from the authenticated request`,
      );
    }
  });

  it('delegates gateway calls unchanged', async () => {
    const { controller, calls } = createController(false);

    assert.deepStrictEqual(await controller.listGateways(ADMIN), [{ id: 'gateway-1' }]);
    assert.deepStrictEqual(await controller.getGateway(ADMIN, 'gateway-1'), { id: 'gateway-1' });
    assert.deepStrictEqual(
      await controller.updateGateway(ADMIN, 'gateway-1', { isActive: false }),
      { id: 'gateway-1', isActive: false },
    );
    assert.deepStrictEqual(
      await controller.moveGateway(ADMIN, 'gateway-1', { direction: PaymentGatewayMoveDirection.UP }),
      { id: 'gateway-1', direction: 'up' },
    );
    assert.deepStrictEqual(await controller.createDefaults(ADMIN), [{ id: 'gateway-default' }]);
    assert.deepStrictEqual(calls, [
      ['list', false],
      ['get', 'gateway-1', false],
      ['update', 'gateway-1', { isActive: false }, false],
      ['move', 'gateway-1', 'up', false],
      ['defaults', false],
    ]);
  });

  it('asks for secrets only when the admin holds payment_gateways:view_secrets', async () => {
    // The elevated permission is resolved per request and passed down rather
    // than gating the route: an admin with plain `payment_gateways:view` must
    // keep listing and configuring gateways, just with the secrets masked.
    const withoutSecrets = createController(false);
    const withSecrets = createController(true);

    await withoutSecrets.controller.listGateways(ADMIN);
    await withSecrets.controller.listGateways(ADMIN);

    assert.deepStrictEqual(withoutSecrets.calls, [['list', false]]);
    assert.deepStrictEqual(withSecrets.calls, [['list', true]]);
    // The subject is asserted alongside the resource/action pair: a check that
    // only records what was asked cannot tell "may THIS admin see secrets" from
    // "may somebody see secrets", and the second question is always answerable.
    assert.deepStrictEqual(withSecrets.permissionChecks, [viewSecretsCheck(ADMIN)]);
    assert.deepStrictEqual(withoutSecrets.permissionChecks, [viewSecretsCheck(ADMIN)]);
  });

  it('resolves view_secrets against the calling admin id, role and rbacRoleId', async () => {
    // `RbacService.hasPermission` answers from exactly these three fields — it
    // returns `true` for `UserRole.DEV` before reading a role at all, and
    // resolves the granted set from `rbacRoleId` otherwise. A subject assembled
    // from the wrong admin is therefore a wrong ANSWER, not a cosmetic slip.
    const { controller, permissionChecks } = createController(false);

    await controller.listGateways(ELEVATED_ADMIN);

    const [check] = permissionChecks;
    assert.ok(check, 'the controller never asked RbacService about payment_gateways:view_secrets');
    assert.equal(
      check.subject.id,
      ELEVATED_ADMIN.id,
      'RbacService was asked about a different admin id than the one that called',
    );
    assert.equal(
      check.subject.role,
      ELEVATED_ADMIN.role,
      'RbacService was asked with a different role than the calling admin holds',
    );
    assert.equal(
      check.subject.rbacRoleId,
      ELEVATED_ADMIN.rbacRoleId,
      'RbacService was asked with a different rbacRoleId than the calling admin holds',
    );
  });

  it('resolves the permission per caller, not once for the controller', async () => {
    // Two admins interleaved through one instance: pins the subject to the
    // request being served, so a cached or captured admin (or one hardcoded
    // while assembling the subject) shows up as the wrong identity on the
    // calls that belong to the other caller.
    const { controller, permissionChecks } = createController(true);

    await controller.listGateways(ADMIN);
    await controller.getGateway(ELEVATED_ADMIN, 'gateway-1');
    await controller.updateGateway(ELEVATED_ADMIN, 'gateway-1', { isActive: true });
    await controller.moveGateway(ADMIN, 'gateway-1', { direction: PaymentGatewayMoveDirection.DOWN });
    await controller.createDefaults(ELEVATED_ADMIN);

    assert.deepStrictEqual(permissionChecks, [
      viewSecretsCheck(ADMIN),
      viewSecretsCheck(ELEVATED_ADMIN),
      viewSecretsCheck(ELEVATED_ADMIN),
      viewSecretsCheck(ADMIN),
      viewSecretsCheck(ELEVATED_ADMIN),
    ]);
  });

  it('does not let an edit round-trip reveal a secret the caller cannot read', async () => {
    // A save echoes the stored row back. Without the same permission check on
    // the write path, `edit` alone would be a read primitive for credentials.
    const { controller, calls, permissionChecks } = createController(false);

    await controller.updateGateway(ADMIN, 'gateway-1', { isActive: true });
    await controller.moveGateway(ADMIN, 'gateway-1', { direction: PaymentGatewayMoveDirection.UP });
    await controller.createDefaults(ADMIN);

    assert.deepStrictEqual(
      calls.map((call) => call[call.length - 1]),
      [false, false, false],
    );
    // Same subject on the write path: the masking on a save must be decided by
    // the permissions of the admin who saved, not by an anonymous check.
    assert.deepStrictEqual(permissionChecks, [
      viewSecretsCheck(ADMIN),
      viewSecretsCheck(ADMIN),
      viewSecretsCheck(ADMIN),
    ]);
  });
});

/**
 * Exactly the subject the real `RbacService.hasPermission` takes, read off the
 * service itself: a field added to or dropped from that signature breaks this
 * spec instead of quietly widening what the stub will accept.
 */
type RbacPermissionSubject = Parameters<RbacService['hasPermission']>[0];

interface PermissionCheck {
  readonly subject: RbacPermissionSubject;
  readonly resource: string;
  readonly action: string;
}

/**
 * The only part of `ExecutionContext` the `@CurrentAdmin()` factory touches.
 * Declared to that width so the stub below is passed without a cast.
 */
interface HttpExecutionContextStub {
  readonly switchToHttp: () => {
    readonly getRequest: () => { readonly user: CurrentAdminInterface };
  };
}

/**
 * A parameter binding as Nest records it in `ROUTE_ARGS_METADATA`. Custom
 * `createParamDecorator` bindings — `@CurrentAdmin()` among them — carry
 * `CUSTOM_ROUTE_ARGS_METADATA` in the key and their factory in the value.
 */
interface CurrentAdminBinding {
  readonly index: number;
  readonly factory: (data: unknown, context: HttpExecutionContextStub) => unknown;
}

/** Routes that receive the admin and therefore resolve `view_secrets`. */
const ADMIN_ARGUMENT_ROUTES: readonly string[] = [
  'listGateways',
  'getGateway',
  'updateGateway',
  'moveGateway',
  'createDefaults',
];

/**
 * A whole `CurrentAdminInterface`, not a three-field stand-in: the controller
 * is handed what `@CurrentAdmin()` puts on the request, and the fixture has to
 * be the same shape for the compiler to keep checking that.
 */
function currentAdmin(overrides: Partial<CurrentAdminInterface> = {}): CurrentAdminInterface {
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
    rbacRoleId: 'rbac-role-1',
    mustChangePassword: false,
    ...overrides,
  };
}

const ADMIN: CurrentAdminInterface = currentAdmin();

/**
 * Differs from `ADMIN` in every field the RBAC subject carries. `DEV` is not
 * decoration: `RbacService.hasPermission` short-circuits to `true` for that
 * role, so swapping one admin for the other changes the verdict.
 */
const ELEVATED_ADMIN: CurrentAdminInterface = currentAdmin({
  id: 'admin-2',
  login: 'oncall',
  role: UserRole.DEV,
  rbacRoleId: 'rbac-role-2',
});

function permissionSubject(admin: CurrentAdminInterface): RbacPermissionSubject {
  return { id: admin.id, role: admin.role, rbacRoleId: admin.rbacRoleId };
}

function viewSecretsCheck(admin: CurrentAdminInterface): PermissionCheck {
  return {
    subject: permissionSubject(admin),
    resource: 'payment_gateways',
    action: 'view_secrets',
  };
}

function readCurrentAdminBinding(methodName: string): CurrentAdminBinding {
  const routeArgs: Record<string, CurrentAdminBinding> | undefined = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    AdminPaymentGatewaysController,
    methodName,
  );
  const bindings = Object.entries(routeArgs ?? {})
    .filter(([key]) => key.includes(CUSTOM_ROUTE_ARGS_METADATA))
    .map(([, binding]) => binding);
  assert.equal(bindings.length, 1, `${methodName} should carry exactly one custom param decorator`);
  return bindings[0];
}

function createController(canRevealSecrets: boolean): {
  readonly controller: AdminPaymentGatewaysController;
  readonly calls: readonly unknown[][];
  readonly permissionChecks: readonly PermissionCheck[];
} {
  const calls: unknown[][] = [];
  const permissionChecks: PermissionCheck[] = [];
  // Typed off `RbacService` itself, so `subject`, `resource` and `action` are
  // the real parameters rather than an `unknown` the stub is free to drop.
  const rbacService: Pick<RbacService, 'hasPermission'> = {
    hasPermission: async (subject, resource, action) => {
      permissionChecks.push({ subject, resource, action });
      return canRevealSecrets;
    },
  };
  const controller = new AdminPaymentGatewaysController(
    {
      listGateways: async (revealSecrets: boolean) => {
        calls.push(['list', revealSecrets]);
        return [{ id: 'gateway-1' }];
      },
      getGateway: async (gatewayId: string, revealSecrets: boolean) => {
        calls.push(['get', gatewayId, revealSecrets]);
        return { id: gatewayId };
      },
      updateGateway: async (gatewayId: string, input: unknown, revealSecrets: boolean) => {
        calls.push(['update', gatewayId, input, revealSecrets]);
        return { id: gatewayId, ...((input as Record<string, unknown>) ?? {}) };
      },
      moveGateway: async (gatewayId: string, direction: string, revealSecrets: boolean) => {
        calls.push(['move', gatewayId, direction, revealSecrets]);
        return { id: gatewayId, direction };
      },
      createDefaults: async (revealSecrets: boolean) => {
        calls.push(['defaults', revealSecrets]);
        return [{ id: 'gateway-default' }];
      },
    } as never as PaymentGatewayRegistryService,
    // Narrowing back to the declaring class: `RbacService` carries private
    // state a literal cannot satisfy, and the controller asks for the class.
    // The assertion is checked in one direction — `RbacService` is assignable
    // to the `Pick`, so a renamed or re-signatured `hasPermission` stops it.
    rbacService as RbacService,
  );
  return { controller, calls, permissionChecks };
}
