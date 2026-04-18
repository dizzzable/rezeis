import { Inject, Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';

import { authConfig } from '../../../common/config/auth.config';

function normalizeHeaderValue(headerValue: string | string[] | undefined): string | null {
  if (typeof headerValue === 'string') {
    return headerValue;
  }
  if (Array.isArray(headerValue) && headerValue.length > 0) {
    return headerValue[0] ?? null;
  }
  return null;
}

function compareSecrets(actualValue: string | null, expectedValue: string): boolean {
  if (!actualValue) {
    return false;
  }
  const actualBuffer: Buffer = Buffer.from(actualValue);
  const expectedBuffer: Buffer = Buffer.from(expectedValue);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

/**
 * Protects internal admin routes with a static API key.
 */
@Injectable()
export class InternalAdminAuthGuard implements CanActivate {
  public constructor(
    @Inject(authConfig.KEY)
    private readonly authConfiguration: ConfigType<typeof authConfig>,
  ) {}

  /**
   * Validates the internal API key header.
   */
  public canActivate(context: ExecutionContext): boolean {
    const request: Request = context.switchToHttp().getRequest<Request>();
    const internalApiKey: string | null = normalizeHeaderValue(request.headers['x-internal-api-key']);
    const isAuthorized: boolean = compareSecrets(
      internalApiKey,
      this.authConfiguration.internalApiKey,
    );
    if (!isAuthorized) {
      throw new UnauthorizedException('Invalid internal API key');
    }
    return true;
  }
}
