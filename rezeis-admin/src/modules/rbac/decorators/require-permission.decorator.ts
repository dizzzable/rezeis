import { SetMetadata } from '@nestjs/common';

import { RbacAction } from '../rbac.resources';

export const REQUIRE_PERMISSION_KEY = 'rbac:require-permission';

export interface RequiredPermission {
  readonly resource: string;
  readonly action: RbacAction;
}

/**
 * Decorator that declares a required (resource, action) for the route.
 *
 * Apply on the handler:
 *
 *   ```ts
 *   @Post('rotate')
 *   @RequirePermission('payment_gateways', 'edit')
 *   public rotate() { … }
 *   ```
 *
 * The `RbacGuard` reads this metadata, asks `RbacService.hasPermission`,
 * and throws `ForbiddenException` on a miss. DEV admins always pass.
 *
 * Multiple decorators on the same handler are AND-combined.
 */
export const RequirePermission = (resource: string, action: RbacAction): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_PERMISSION_KEY, [{ resource, action }] as readonly RequiredPermission[]);

/**
 * Requires ALL of the listed permissions.
 *
 * The guard reads this metadata with `getAllAndOverride`, so a method-level
 * `RequirePermission` REPLACES the controller's rather than adding to it —
 * which makes "this one route needs one more permission than its siblings"
 * impossible to express with the single-permission form. It came up on a route
 * that answers a plans question with a body full of subscription and user ids:
 * gated on `plans:view` alone, a finance role could read identifiers it has no
 * permission to list anywhere else in the panel.
 */
export const RequireAllPermissions = (
  ...permissions: readonly (readonly [string, RbacAction])[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(
    REQUIRE_PERMISSION_KEY,
    permissions.map(([resource, action]) => ({ resource, action })) as readonly RequiredPermission[],
  );
