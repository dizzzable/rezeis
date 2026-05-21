import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

/**
 * Extracts the authenticated admin from the request object.
 * Populated by JwtStrategy.validate() after successful JWT verification.
 *
 * Usage:
 *   @Get('me')
 *   getMe(@CurrentAdmin() admin: AdminPayload) { ... }
 */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: unknown }>();
    return request.user;
  },
);
