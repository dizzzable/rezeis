import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  API_TOKEN_JWT_AUDIENCE,
  API_TOKEN_JWT_EXPIRES_IN,
  API_TOKEN_JWT_TYPE,
  API_TOKEN_TTL_MS,
} from '../src/modules/auth/constants/api-token-auth.constants';
import { hashApiToken } from '../src/modules/auth/utils/api-token-hash.util';
import { ApiTokensService } from '../src/modules/api-tokens/services/api-tokens.service';

describe('ApiTokensService', () => {
  it('creates audience-bound API tokens without storing the raw bearer token', async () => {
    const createCalls: unknown[] = [];
    const signCalls: Array<{ readonly payload: Record<string, unknown>; readonly options: Record<string, unknown> }> = [];
    const signedToken = 'signed-api-token';
    const prismaService = {
      apiToken: {
        create: async (args: { readonly data: ApiTokenCreateData }): Promise<ApiTokenRecord> => {
          createCalls.push(args);
          return {
            id: args.data.id,
            name: args.data.name,
            tokenHash: args.data.tokenHash,
            audience: args.data.audience,
            prefix: args.data.prefix,
            createdBy: args.data.createdBy,
            lastUsedAt: null,
            expiresAt: args.data.expiresAt,
            createdAt: new Date('2026-06-03T19:00:00.000Z'),
          };
        },
      },
    };
    const jwtService = {
      signAsync: async (payload: Record<string, unknown>, options: Record<string, unknown>): Promise<string> => {
        signCalls.push({ payload, options });
        return signedToken;
      },
    };
    const service = new ApiTokensService(
      prismaService as unknown as PrismaService,
      jwtService as unknown as JwtService,
      { jwtSecret: 'jwt-secret' } as never,
    );

    const beforeCreate = Date.now();
    const result = await service.create({ name: 'Reiwa', createdBy: 'admin-1' });
    const afterCreate = Date.now();

    assert.equal(result.token, signedToken);
    assert.equal(result.prefix, hashApiToken(signedToken).slice(0, 12));
    assert.equal(signCalls.length, 1);
    assert.equal(signCalls[0]!.payload.type, API_TOKEN_JWT_TYPE);
    assert.equal(signCalls[0]!.payload.name, 'Reiwa');
    assert.equal(typeof signCalls[0]!.payload.sub, 'string');
    assert.equal(signCalls[0]!.options.secret, 'jwt-secret');
    assert.equal(signCalls[0]!.options.audience, API_TOKEN_JWT_AUDIENCE);
    assert.equal(signCalls[0]!.options.expiresIn, API_TOKEN_JWT_EXPIRES_IN);

    const createData = (createCalls[0] as { readonly data: Record<string, unknown> }).data;
    assert.ok(createData.expiresAt instanceof Date);
    assert.ok(createData.expiresAt.getTime() >= beforeCreate + API_TOKEN_TTL_MS);
    assert.ok(createData.expiresAt.getTime() <= afterCreate + API_TOKEN_TTL_MS);
    assert.equal(createData.id, signCalls[0]!.payload.sub);
    assert.equal(createData.name, 'Reiwa');
    assert.equal(createData.tokenHash, hashApiToken(signedToken));
    assert.equal(createData.audience, API_TOKEN_JWT_AUDIENCE);
    assert.equal(createData.prefix, hashApiToken(signedToken).slice(0, 12));
    assert.equal(createData.createdBy, 'admin-1');
    assert.equal(hasOwn(createData, 'token'), false);
    assert.equal(result.expiresAt, createData.expiresAt.toISOString());
  });

  it('lists token metadata without exposing token hashes or bearer tokens', async () => {
    const prismaService = {
      apiToken: {
        findMany: async (): Promise<readonly ApiTokenRecord[]> => [
          {
            id: 'token-1',
            name: 'Reiwa',
            tokenHash: hashApiToken('signed-api-token'),
            audience: API_TOKEN_JWT_AUDIENCE,
            prefix: 'abcdef123456',
            createdBy: 'admin-1',
            lastUsedAt: null,
            expiresAt: new Date('2026-12-01T19:00:00.000Z'),
            createdAt: new Date('2026-06-03T19:00:00.000Z'),
          },
        ],
      },
    };
    const service = new ApiTokensService(
      prismaService as unknown as PrismaService,
      {} as JwtService,
      { jwtSecret: 'jwt-secret' } as never,
    );

    const result = await service.list();

    assert.deepStrictEqual(result, [
      {
        id: 'token-1',
        name: 'Reiwa',
        audience: API_TOKEN_JWT_AUDIENCE,
        prefix: 'abcdef123456',
        createdBy: 'admin-1',
        lastUsedAt: null,
        expiresAt: '2026-12-01T19:00:00.000Z',
        createdAt: '2026-06-03T19:00:00.000Z',
      },
    ]);
    assert.equal(hasOwn(result[0] as Record<string, unknown>, 'token'), false);
    assert.equal(hasOwn(result[0] as Record<string, unknown>, 'tokenHash'), false);
  });
});

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

interface ApiTokenCreateData {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly audience: string;
  readonly prefix: string;
  readonly createdBy: string;
  readonly expiresAt: Date;
}

interface ApiTokenRecord extends ApiTokenCreateData {
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
}
