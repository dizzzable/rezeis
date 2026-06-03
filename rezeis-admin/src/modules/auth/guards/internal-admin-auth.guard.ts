import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  API_TOKEN_JWT_AUDIENCE,
  API_TOKEN_JWT_TYPE,
  API_TOKEN_LAST_USED_TOUCH_INTERVAL_MS,
} from '../constants/api-token-auth.constants';
import { isApiTokenHashMatch } from '../utils/api-token-hash.util';

interface InternalApiTokenJwtPayload {
  readonly sub?: unknown;
  readonly type?: unknown;
  readonly aud?: unknown;
}

/**
 * Protects internal API routes with API Token verification.
 *
 * Accepts a Bearer token in the Authorization header. The token must be a
 * valid JWT (signed with the derived secret), the token fingerprint must match
 * the `api_tokens` row, and the row must not have been revoked or expired.
 *
 * This replaces the old static `x-internal-api-key` header approach.
 */
@Injectable()
export class InternalAdminAuthGuard implements CanActivate {
  public constructor(
    private readonly jwtService: JwtService,
    private readonly prismaService: PrismaService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing API token');
    }

    try {
      const payload = this.jwtService.verify<InternalApiTokenJwtPayload>(token);

      // Must be an api_token type JWT
      if (payload.type !== API_TOKEN_JWT_TYPE || typeof payload.sub !== 'string') {
        throw new UnauthorizedException('Invalid token type');
      }

      if (payload.aud !== undefined && payload.aud !== API_TOKEN_JWT_AUDIENCE) {
        throw new UnauthorizedException('Invalid token audience');
      }

      const record = await this.prismaService.apiToken.findUnique({
        where: { id: payload.sub },
        select: { id: true, tokenHash: true, audience: true, lastUsedAt: true, expiresAt: true },
      });

      if (record === null) {
        throw new UnauthorizedException('API token has been revoked');
      }

      if (record.audience !== API_TOKEN_JWT_AUDIENCE || !isApiTokenHashMatch(token, record.tokenHash)) {
        throw new UnauthorizedException('Invalid API token');
      }

      if (record.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException('API token has expired');
      }

      this.touchLastUsed(record.id, record.lastUsedAt);

      return true;
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      throw new UnauthorizedException('Invalid API token');
    }
  }

  private touchLastUsed(tokenId: string, lastUsedAt: Date | null): void {
    const now = new Date();
    if (lastUsedAt !== null && now.getTime() - lastUsedAt.getTime() < API_TOKEN_LAST_USED_TOUCH_INTERVAL_MS) {
      return;
    }

    void this.prismaService.apiToken.updateMany({
      where: {
        id: tokenId,
        OR: [
          { lastUsedAt: null },
          { lastUsedAt: { lt: new Date(now.getTime() - API_TOKEN_LAST_USED_TOUCH_INTERVAL_MS) } },
        ],
      },
      data: { lastUsedAt: now },
    }).catch(() => { /* non-critical */ });
  }

  private extractToken(request: Request): string | null {
    const authHeader = request.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
    // Backward compat: also check x-api-token header
    const apiTokenHeader = request.headers['x-api-token'];
    if (typeof apiTokenHeader === 'string' && apiTokenHeader.length > 0) {
      return apiTokenHeader;
    }
    return null;
  }
}
