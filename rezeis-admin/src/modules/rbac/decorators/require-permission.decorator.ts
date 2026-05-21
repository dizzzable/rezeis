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
export const RequirePermission = (resource: string, action: RbacAction): MethodDecorator =>
  SetMetadata(REQUIRE_PERMISSION_KEY, [{ resource, action }] as readonly RequiredPermission[]);
