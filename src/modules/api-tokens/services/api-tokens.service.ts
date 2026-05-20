import { randomBytes } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { authConfig } from '../../../common/config/auth.config';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface ApiTokenListItemInterface {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdBy: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

export interface ApiTokenCreateResultInterface {
  readonly id: string;
  readonly name: string;
  readonly token: string;
  readonly prefix: string;
  readonly createdAt: string;
}

interface CreateApiTokenInput {
  readonly name: string;
  readonly createdBy: string;
}

/**
 * API Tokens service — manages named bearer tokens for external service
 * integration (reiwa, bots, monitoring, etc.).
 *
 * Architecture (mirrors Remnawave panel):
 *  - Token is a JWT signed with the same secret as admin JWTs
 *  - JWT payload contains `{ sub: tokenId, type: 'api_token' }`
 *  - The token row must exist in DB for the token to be valid (delete = revoke)
 *  - On each authenticated request, the JWT strategy checks if the token
 *    row still exists (cache-friendly: check by id)
 */
@Injectable()
export class ApiTokensService {
  private readonly logger = new Logger(ApiTokensService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly jwtService: JwtService,
    @Inject(authConfig.KEY)
    private readonly authConfiguration: ConfigType<typeof authConfig>,
  ) {}

  /**
   * Creates a new API token. The token is a long-lived JWT (no expiry)
   * that can be revoked by deleting the row.
   */
  public async create(input: CreateApiTokenInput): Promise<ApiTokenCreateResultInterface> {
    try {
      const tokenId = generateTokenId();
      // Long-lived API token. JwtModule defaults to a 24h `expiresIn`
      // for admin sessions, so we override it with a 10-year window
      // (effectively "never expires" — revocation is done by deleting
      // the row from `api_tokens`). We can't pass `expiresIn: undefined`
      // here: newer `jsonwebtoken` versions throw on that value.
      const token = await this.jwtService.signAsync(
        { sub: tokenId, type: 'api_token', name: input.name },
        { secret: this.authConfiguration.jwtSecret, expiresIn: '3650d' },
      );
      const prefix = token.slice(0, 12);

      const record = await this.prismaService.apiToken.create({
        data: {
          id: tokenId,
          name: input.name,
          token,
          prefix,
          createdBy: input.createdBy,
        },
      });

      this.logger.log(`API token "${input.name}" created by ${input.createdBy}`);

      return {
        id: record.id,
        name: record.name,
        token: record.token,
        prefix: record.prefix,
        createdAt: record.createdAt.toISOString(),
      };
    } catch (err) {
      this.logger.error(
        `Failed to create API token "${input.name}": ${(err as Error).name}: ${(err as Error).message}`,
      );
      this.logger.error((err as Error).stack ?? '(no stack)');
      throw err;
    }
  }

  /**
   * Lists all API tokens (without exposing the full token string).
   */
  public async list(): Promise<readonly ApiTokenListItemInterface[]> {
    const records = await this.prismaService.apiToken.findMany({
      orderBy: [{ createdAt: 'desc' }],
    });
    return records.map((record) => ({
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      createdBy: record.createdBy,
      lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
    }));
  }

  /**
   * Deletes (revokes) an API token by id.
   */
  public async delete(tokenId: string): Promise<void> {
    const existing = await this.prismaService.apiToken.findUnique({
      where: { id: tokenId },
      select: { id: true, name: true },
    });
    if (existing === null) {
      throw new NotFoundException('API token not found');
    }
    await this.prismaService.apiToken.delete({ where: { id: tokenId } });
    this.logger.log(`API token "${existing.name}" (${tokenId}) revoked`);
  }

  /**
   * Validates that a token id exists in the database (used by the auth
   * guard to verify API token JWTs are not revoked).
   */
  public async exists(tokenId: string): Promise<boolean> {
    const count = await this.prismaService.apiToken.count({
      where: { id: tokenId },
    });
    return count > 0;
  }

  /**
   * Records last usage timestamp (fire-and-forget, non-blocking).
   */
  public async touchLastUsed(tokenId: string): Promise<void> {
    await this.prismaService.apiToken.update({
      where: { id: tokenId },
      data: { lastUsedAt: new Date() },
    }).catch(() => { /* ignore — non-critical */ });
  }
}

function generateTokenId(): string {
  return randomBytes(16).toString('base64url');
}
