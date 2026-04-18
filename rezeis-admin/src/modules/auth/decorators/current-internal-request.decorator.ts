import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

import { InternalAdminRequest } from '../interfaces/internal-admin-request.interface';
import { extractRequestMetadata } from '../utils/request-metadata.util';

/**
 * Extracts normalized request metadata for internal endpoints.
 */
export const CurrentInternalRequest = createParamDecorator(
  (_data: unknown, context: ExecutionContext): InternalAdminRequest => {
    const request: Request = context.switchToHttp().getRequest<Request>();
    return extractRequestMetadata(request);
  },
);
