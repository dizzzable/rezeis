import { randomBytes } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { authConfig } from '../../../common/config/auth.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  API_TOKEN_JWT_AUDIENCE,
  API_TOKEN_JWT_EXPIRES_IN,
  API_TOKEN_JWT_TYPE,
  API_TOKEN_TTL_MS,
} from '../../auth/constants/api-token-auth.constants';
import { hashApiToken } from '../../auth/utils/api-token-hash.util';

export interface ApiTokenListItemInterface {
  readonly id: string;
  readonly name: string;
  readonly audience: string;
  readonly prefix: string;
  readonly createdBy: string | null;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface ApiTokenCreateResultInterface {
  readonly id: string;
  readonly name: string;
  readonly token: string;
  readonly prefix: string;
  readonly expiresAt: string;
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
 *  - JWT payload contains `{ sub: tokenId, type: 'api_token', aud: ... }`
 *  - Only `sha256(token)` is stored at rest; the raw token is returned once
 *  - The token row, fingerprint, audience, and expiration must match for the token to be valid
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
   * Creates a new API token. The raw JWT is returned once and expires on the
   * same policy window persisted in the database for rotation visibility.
   */
  public async create(input: CreateApiTokenInput): Promise<ApiTokenCreateResultInterface> {
    try {
      const tokenId = generateTokenId();
      const expiresAt = new Date(Date.now() + API_TOKEN_TTL_MS);
      const token = await this.jwtService.signAsync(
        { sub: tokenId, type: API_TOKEN_JWT_TYPE, name: input.name },
        {
          secret: this.authConfiguration.jwtSecret,
          expiresIn: API_TOKEN_JWT_EXPIRES_IN,
          audience: API_TOKEN_JWT_AUDIENCE,
        },
      );
      const tokenHash = hashApiToken(token);
      const prefix = tokenHash.slice(0, 12);

      const record = await this.prismaService.apiToken.create({
        data: {
          id: tokenId,
          name: input.name,
          tokenHash,
          audience: API_TOKEN_JWT_AUDIENCE,
          prefix,
          createdBy: input.createdBy,
          expiresAt,
        },
      });

      this.logger.log(`API token "${input.name}" created by ${input.createdBy}`);

      return {
        id: record.id,
        name: record.name,
        token,
        prefix: record.prefix,
        expiresAt: record.expiresAt.toISOString(),
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
      audience: record.audience,
      prefix: record.prefix,
      createdBy: record.createdBy,
      lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
      expiresAt: record.expiresAt.toISOString(),
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

}

function generateTokenId(): string {
  return randomBytes(16).toString('base64url');
}
