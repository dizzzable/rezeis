import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { buildInternalSignature } from '../src/common/http/internal-signature.util';
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

  // reiwa has been signing every internal call from the start and this guard never
  // checked, so the documented second factor did not exist: a leaked token alone
  // could write advertising clicks with any user id or accept counter-terms as a
  // partner. Enforcement is staged, hence three behaviours.
  describe('reiwa request signature', () => {
    const SECRET = 'shared-with-reiwa';
    const BODY = '{"code":"ABC123"}';
    const PATH = '/api/internal/advertising/click';

    function signedHeaders(overrides: { body?: string; path?: string; method?: string } = {}) {
      const timestamp = String(Date.now());
      const signature = buildInternalSignature({
        secret: SECRET,
        method: overrides.method ?? 'POST',
        path: overrides.path ?? PATH,
        body: overrides.body ?? BODY,
        timestamp,
      });
      return { 'x-request-timestamp': timestamp, 'x-request-signature': signature };
    }

    function guardFor(mode: 'off' | 'log' | 'require') {
      const token = 'signed-api-token';
      return {
        token,
        ...createGuard({
          token,
          payload: { sub: 'token-1', type: API_TOKEN_JWT_TYPE, aud: API_TOKEN_JWT_AUDIENCE },
          record: {
            id: 'token-1',
            tokenHash: hashApiToken(token),
            audience: API_TOKEN_JWT_AUDIENCE,
            lastUsedAt: new Date(),
            expiresAt: futureDate(),
          },
          signatureMode: mode,
          sharedSecret: SECRET,
        }),
      };
    }

    it('accepts a correctly signed request in require mode', async () => {
      const { guard, token } = guardFor('require');
      const context = createContext(
        { authorization: `Bearer ${token}`, ...signedHeaders() },
        { method: 'POST', originalUrl: PATH, rawBody: Buffer.from(BODY, 'utf8') },
      );
      assert.equal(await guard.canActivate(context), true);
    });

    it('rejects a tampered body in require mode', async () => {
      const { guard, token } = guardFor('require');
      const context = createContext(
        { authorization: `Bearer ${token}`, ...signedHeaders() },
        {
          method: 'POST',
          originalUrl: PATH,
          rawBody: Buffer.from('{"code":"HACKED"}', 'utf8'),
        },
      );
      await assert.rejects(() => guard.canActivate(context), UnauthorizedException);
    });

    it('rejects an unsigned request in require mode', async () => {
      const { guard, token } = guardFor('require');
      const context = createContext(
        { authorization: `Bearer ${token}` },
        { method: 'POST', originalUrl: PATH, rawBody: Buffer.from(BODY, 'utf8') },
      );
      await assert.rejects(() => guard.canActivate(context), UnauthorizedException);
    });

    it('lets an unsigned request through in log mode', async () => {
      // The point of this mode: find out whether every caller in a deployment
      // signs, without 401-ing the customer cabinet to find out.
      const { guard, token } = guardFor('log');
      const context = createContext(
        { authorization: `Bearer ${token}` },
        { method: 'POST', originalUrl: PATH, rawBody: Buffer.from(BODY, 'utf8') },
      );
      assert.equal(await guard.canActivate(context), true);
    });

    it('ignores the signature entirely when the secret is not configured', async () => {
      const token = 'signed-api-token';
      const { guard } = createGuard({
        token,
        payload: { sub: 'token-1', type: API_TOKEN_JWT_TYPE, aud: API_TOKEN_JWT_AUDIENCE },
        record: {
          id: 'token-1',
          tokenHash: hashApiToken(token),
          audience: API_TOKEN_JWT_AUDIENCE,
          lastUsedAt: new Date(),
          expiresAt: futureDate(),
        },
        signatureMode: 'log',
        sharedSecret: '',
      });
      assert.equal(
        await guard.canActivate(createContext({ authorization: `Bearer ${token}` })),
        true,
      );
    });

    it('refuses to serve require mode without a secret', async () => {
      // Failing closed here is the point: the operator believes the second factor
      // is on, and silently verifying nothing would be worse than a hard stop.
      const token = 'signed-api-token';
      const { guard } = createGuard({
        token,
        payload: { sub: 'token-1', type: API_TOKEN_JWT_TYPE, aud: API_TOKEN_JWT_AUDIENCE },
        record: {
          id: 'token-1',
          tokenHash: hashApiToken(token),
          audience: API_TOKEN_JWT_AUDIENCE,
          lastUsedAt: new Date(),
          expiresAt: futureDate(),
        },
        signatureMode: 'require',
        sharedSecret: '',
      });
      await assert.rejects(
        () => guard.canActivate(createContext({ authorization: `Bearer ${token}` })),
        UnauthorizedException,
      );
    });

    it('accepts a signed GET whose identity lives in the query string', async () => {
      // The shape of nearly every internal GET the cabinet makes. Verification
      // stripped the query, so the digest never matched and `require` would have
      // returned 401 for session, subscription and unread-count on every page load.
      const { guard, token } = guardFor('require');
      const path = '/api/internal/user/session?telegramId=42';
      const context = createContext(
        {
          authorization: `Bearer ${token}`,
          ...signedHeaders({ method: 'GET', path, body: '' }),
        },
        { method: 'GET', originalUrl: path, path: '/api/internal/user/session' },
      );
      assert.equal(await guard.canActivate(context), true);
    });

    it('signs GET requests with an empty body', async () => {
      const { guard, token } = guardFor('require');
      const path = '/api/internal/user/123/advertising/stats';
      const context = createContext(
        {
          authorization: `Bearer ${token}`,
          ...signedHeaders({ method: 'GET', path, body: '' }),
        },
        { method: 'GET', originalUrl: path },
      );
      assert.equal(await guard.canActivate(context), true);
    });
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
  /** Defaults to `off` so the pre-existing token tests are unaffected. */
  readonly signatureMode?: 'off' | 'log' | 'require';
  readonly sharedSecret?: string;
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
      {
        jwtSecret: 'x',
        jwtExpiresIn: '24h',
        cryptKey: 'x',
        internalSharedSecret: input.sharedSecret ?? '',
        internalSignatureMode: input.signatureMode ?? 'off',
      } as never,
    ),
    findUniqueCalls,
    updateManyCalls,
  };
}

function createContext(
  headers: Record<string, string>,
  request: { method?: string; originalUrl?: string; path?: string; rawBody?: Buffer } = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers,
        method: request.method ?? 'GET',
        originalUrl: request.originalUrl ?? '/api/internal/ping',
        path: request.path ?? request.originalUrl ?? '/api/internal/ping',
        rawBody: request.rawBody,
      }),
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
