import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Inject,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { authConfig } from '../../../common/config/auth.config';
import {
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  verifyInternalSignature,
} from '../../../common/http/internal-signature.util';
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
 *
 * Second factor: reiwa signs every internal call (`x-request-signature`) and this
 * guard verifies it. Until now the signature was sent and never checked, so the
 * documented second factor did not exist and a leaked token was, on its own,
 * enough to write advertising clicks with an arbitrary user id, bind any account
 * to any placement, or accept counter-terms as a partner. Enforcement is staged
 * via `REZEIS_INTERNAL_SIGNATURE_MODE` — see {@link InternalSignatureMode}.
 */
@Injectable()
export class InternalAdminAuthGuard implements CanActivate {
  private readonly logger = new Logger(InternalAdminAuthGuard.name);

  public constructor(
    private readonly jwtService: JwtService,
    private readonly prismaService: PrismaService,
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
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
      this.enforceSignature(request);

      return true;
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      throw new UnauthorizedException('Invalid API token');
    }
  }

  /**
   * Verifies reiwa's request signature according to the configured mode.
   *
   * Throws only in `require` mode. In `log` mode a failure is reported and the
   * request proceeds — the point of that mode is to find out whether every
   * caller in this deployment signs before a mismatch starts returning 401 to
   * the customer cabinet.
   */
  private enforceSignature(request: Request): void {
    const mode = this.config.internalSignatureMode;
    if (mode === 'off') {
      return;
    }
    const secret = this.config.internalSharedSecret;
    if (secret.length === 0) {
      // Nothing to verify against. Loud in `require` mode, because there the
      // operator believes the second factor is on.
      if (mode === 'require') {
        this.logger.error(
          'REZEIS_INTERNAL_SIGNATURE_MODE=require but REZEIS_INTERNAL_SHARED_SECRET is empty — internal requests cannot be verified',
        );
        throw new UnauthorizedException('Internal signature verification unavailable');
      }
      return;
    }

    // The raw bytes as they arrived: reiwa signs `JSON.stringify(body)`, so a
    // re-serialised body would differ in key order or spacing and never match.
    //
    // Caveat before switching to `require`: reiwa signs the path WITHOUT the base
    // URL's path component. Its URL resolver only ever produces `http://host:port`
    // or `https://host`, so today that component is always empty and the signed
    // path equals the one seen here. Put this service behind a path prefix
    // (`https://host/admin`) and every signature would stop matching.
    const rawBody = (request as { rawBody?: Buffer | string }).rawBody;
    const body =
      rawBody === undefined ? '' : typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    // The full target INCLUDING the query string. reiwa signs exactly the path it
    // passed to its transport, and most internal GETs carry the identity in the
    // query (`/api/internal/user/session?telegramId=…`), so stripping it here made
    // the canonical message differ in its second field and the digest never match
    // on those calls — i.e. the second factor verified nothing, while the docs
    // invited the operator to switch on `require` and take the cabinet down.
    const path = request.originalUrl.length > 0 ? request.originalUrl : request.path;
    const result = verifyInternalSignature({
      secret,
      method: request.method,
      path,
      body,
      timestamp: header(request, INTERNAL_TIMESTAMP_HEADER),
      signature: header(request, INTERNAL_SIGNATURE_HEADER),
    });
    if (result.valid) {
      return;
    }
    const detail = `internal signature ${result.reason ?? 'invalid'} for ${request.method} ${path}`;
    if (mode === 'require') {
      this.logger.warn(`${detail} — rejected`);
      throw new UnauthorizedException('Invalid internal request signature');
    }
    this.logger.warn(`${detail} — allowed (mode=log)`);
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

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === 'string') {
    return value;
  }
  return Array.isArray(value) ? value[0] : undefined;
}
