import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  API_TOKEN_JWT_AUDIENCE,
  API_TOKEN_JWT_TYPE,
  API_TOKEN_LAST_USED_TOUCH_INTERVAL_MS,
} from '../src/modules/auth/constants/api-token-auth.constants';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { hashApiToken } from '../src/modules/auth/utils/api-token-hash.util';

describe('InternalAdminAuthGuard', () => {
  it('accepts a signed API token only when the stored fingerprint and audience match', async () => {
    const token = 'signed-api-token';
    const { guard, findUniqueCalls, updateManyCalls } = createGuard({
      token,
      payload: { sub: 'token-1', type: API_TOKEN_JWT_TYPE, aud: API_TOKEN_JWT_AUDIENCE },
      record: {
        id: 'token-1',
        tokenHash: hashApiToken(token),
        audience: API_TOKEN_JWT_AUDIENCE,
        lastUsedAt: null,
        expiresAt: futureDate(),
      },
    });

    assert.equal(await guard.canActivate(createContext({ authorization: `Bearer ${token}` })), true);
    assert.deepStrictEqual(findUniqueCalls, [
      {
        where: { id: 'token-1' },
        select: { id: true, tokenHash: true, audience: true, lastUsedAt: true, expiresAt: true },
      },
    ]);
    assert.equal(updateManyCalls.length, 1);
    assert.equal(updateManyCalls[0]!.where.id, 'token-1');
  });

  it('rejects a signed API token when the database fingerprint does not match the presented bearer token', async () => {
    const token = 'signed-api-token';
    const { guard, updateManyCalls } = createGuard({
      token,
      payload: { sub: 'token-1', type: API_TOKEN_JWT_TYPE, aud: API_TOKEN_JWT_AUDIENCE },
      record: {
        id: 'token-1',
        tokenHash: hashApiToken('different-token'),
        audience: API_TOKEN_JWT_AUDIENCE,
        lastUsedAt: null,
        expiresAt: futureDate(),
      },
    });

    await assert.rejects(
      () => guard.canActivate(createContext({ authorization: `Bearer ${token}` })),
      (error: unknown) => error instanceof UnauthorizedException && error.message === 'Invalid API token',
    );
    assert.equal(updateManyCalls.length, 0);
  });

  it('rejects API tokens issued for a different audience before touching the database', async () => {
    const { guard, findUniqueCalls, updateManyCalls } = createGuard({
      token: 'signed-api-token',
      payload: { sub: 'token-1', type: API_TOKEN_JWT_TYPE, aud: 'other-service' },
      record: null,
    });

    await assert.rejects(
      () => guard.canActivate(createContext({ authorization: 'Bearer signed-api-token' })),
      (error: unknown) => error instanceof UnauthorizedException && error.message === 'Invalid token audience',
    );
    assert.equal(findUniqueCalls.length, 0);
    assert.equal(updateManyCalls.length, 0);
  });

  it('rejects an otherwise valid API token after the database expiration time', async () => {
    const token = 'signed-api-token';
    const { guard, updateManyCalls } = createGuard({
      token,
      payload: { sub: 'token-1', type: API_TOKEN_JWT_TYPE, aud: API_TOKEN_JWT_AUDIENCE },
      record: {
        id: 'token-1',
        tokenHash: hashApiToken(token),
        audience: API_TOKEN_JWT_AUDIENCE,
        lastUsedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    await assert.rejects(
      () => guard.canActivate(createContext({ authorization: `Bearer ${token}` })),
      (error: unknown) => error instanceof UnauthorizedException && error.message === 'API token has expired',
    );
    assert.equal(updateManyCalls.length, 0);
  });

  it('does not write lastUsedAt on every authenticated request', async () => {
    const token = 'signed-api-token';
    const { guard, updateManyCalls } = createGuard({
      token,
      payload: { sub: 'token-1', type: API_TOKEN_JWT_TYPE, aud: API_TOKEN_JWT_AUDIENCE },
      record: {
        id: 'token-1',
        tokenHash: hashApiToken(token),
        audience: API_TOKEN_JWT_AUDIENCE,
        lastUsedAt: new Date(Date.now() - API_TOKEN_LAST_USED_TOUCH_INTERVAL_MS + 60_000),
        expiresAt: futureDate(),
      },
    });

    assert.equal(await guard.canActivate(createContext({ authorization: `Bearer ${token}` })), true);
    assert.equal(updateManyCalls.length, 0);
  });
});

function createGuard(input: {
  readonly token: string;
  readonly payload: Record<string, unknown>;
  readonly record: ApiTokenGuardRecord | null;
}): {
  readonly guard: InternalAdminAuthGuard;
  readonly findUniqueCalls: unknown[];
  readonly updateManyCalls: ApiTokenUpdateManyArgs[];
} {
  const findUniqueCalls: unknown[] = [];
  const updateManyCalls: ApiTokenUpdateManyArgs[] = [];
  const jwtService = {
    verify: (token: string): Record<string, unknown> => {
      assert.equal(token, input.token);
      return input.payload;
    },
  };
  const prismaService = {
    apiToken: {
      findUnique: async (args: unknown): Promise<ApiTokenGuardRecord | null> => {
        findUniqueCalls.push(args);
        return input.record;
      },
      updateMany: async (args: ApiTokenUpdateManyArgs): Promise<{ readonly count: number }> => {
        updateManyCalls.push(args);
        return { count: 1 };
      },
    },
  };
  return {
    guard: new InternalAdminAuthGuard(
      jwtService as unknown as JwtService,
      prismaService as unknown as PrismaService,
    ),
    findUniqueCalls,
    updateManyCalls,
  };
}

function createContext(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

interface ApiTokenGuardRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly audience: string;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date;
}

interface ApiTokenUpdateManyArgs {
  readonly where: {
    readonly id: string;
    readonly OR: readonly unknown[];
  };
  readonly data: {
    readonly lastUsedAt: Date;
  };
}

function futureDate(): Date {
  return new Date(Date.now() + 60_000);
}
