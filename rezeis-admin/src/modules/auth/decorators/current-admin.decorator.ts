import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

import { CurrentAdminInterface } from '../interfaces/current-admin.interface';

interface AuthenticatedAdminRequest extends Request {
  readonly user?: CurrentAdminInterface;
}

/**
 * Extracts the authenticated admin from the current request.
 */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentAdminInterface => {
    const request: AuthenticatedAdminRequest = context
      .switchToHttp()
      .getRequest<AuthenticatedAdminRequest>();
    if (!request.user) {
      throw new UnauthorizedException('Admin user is not authenticated');
    }
    return request.user;
  },
);
