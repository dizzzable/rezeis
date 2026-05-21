import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import {
  REQUIRE_PERMISSION_KEY,
  RequiredPermission,
} from '../decorators/require-permission.decorator';
import { RbacService } from '../services/rbac.service';

/**
 * Runs after `AdminJwtAuthGuard` and enforces `@RequirePermission`. Routes
 * without the decorator are passed through unchanged so the guard can be
 * applied globally without breaking unmarked endpoints.
 *
 * Wiring guidance
 * ─────────────────
 *   - For new code: combine with `@UseGuards(AdminJwtAuthGuard, RbacGuard)`.
 *   - For existing controllers: add `RbacGuard` after `AdminJwtAuthGuard`
 *     in the `@UseGuards()` list. The current admin populated by passport
 *     is read from `request.user`.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  public constructor(
    private readonly reflector: Reflector,
    private readonly rbacService: RbacService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<readonly RequiredPermission[] | undefined>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: CurrentAdminInterface & { rbacRoleId?: string | null } }>();
    const admin = request.user;
    if (!admin) {
      // Auth guard hasn't populated `request.user` — likely the route is
      // missing `@UseGuards(AdminJwtAuthGuard)`. Fail closed.
      throw new ForbiddenException('Authenticated admin required');
    }

    for (const { resource, action } of required) {
      const ok = await this.rbacService.hasPermission(
        {
          id: admin.id,
          role: admin.role,
          rbacRoleId: admin.rbacRoleId ?? null,
        },
        resource,
        action,
      );
      if (!ok) {
        throw new ForbiddenException(
          `Missing permission: ${resource}:${action}`,
        );
      }
    }
    return true;
  }
}
