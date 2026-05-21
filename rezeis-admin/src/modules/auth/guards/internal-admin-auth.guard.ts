import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Protects internal API routes with API Token verification.
 *
 * Accepts a Bearer token in the Authorization header. The token must be a
 * valid JWT (signed with the derived secret) AND the token id must exist in
 * the `api_tokens` table (not revoked).
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
      const payload = this.jwtService.verify(token);

      // Must be an api_token type JWT
      if (payload.type !== 'api_token' || typeof payload.sub !== 'string') {
        throw new UnauthorizedException('Invalid token type');
      }

      // Verify token is not revoked (exists in DB)
      const exists = await this.prismaService.apiToken.count({
        where: { id: payload.sub },
      });

      if (exists === 0) {
        throw new UnauthorizedException('API token has been revoked');
      }

      // Fire-and-forget: update lastUsedAt
      this.prismaService.apiToken.update({
        where: { id: payload.sub },
        data: { lastUsedAt: new Date() },
      }).catch(() => { /* non-critical */ });

      return true;
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      throw new UnauthorizedException('Invalid API token');
    }
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
