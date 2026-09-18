import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';

import { RawCacheService } from '../src/common/cache/raw-cache.service';
import { PasskeyService } from '../src/modules/oauth/services/passkey.service';

/**
 * A passkey challenge is issued only if it was stored.
 * ════════════════════════════════════════════════════
 * Both WebAuthn ceremonies park a challenge in Redis for their verify half, and
 * the verify half accepts nothing else. `RawCacheService.set` is a silent no-op
 * while Redis is not ready, so with Redis down the options endpoints still
 * answered 200 with a challenge nobody would ever find: the operator went
 * through the authenticator prompt for a guaranteed "challenge expired", and a
 * sign-in charged that to the fail2ban counter as a failed login.
 *
 * The sign-in TOKEN was never the problem, and the last case here shows it: the
 * verify half reads the challenge with `take`, which answers null while Redis
 * is down, so no JWT is signed. What was not closed was the half before it.
 *
 * "Redis down" is the real `RawCacheService` with no live connection — the same
 * `isReady() === false` branch a dropped connection puts it in — not a double.
 */

const RP_ID = 'panel.example.com';
const ORIGIN = `https://${RP_ID}`;
const PASSWORD = 'correct horse battery staple';
const METADATA = { requestId: 'req-7', remoteAddress: '203.0.113.9', userAgent: 'Mozilla/5.0 (test)' };

interface Attempt {
  readonly loginNormalized: string;
  readonly success: boolean;
  readonly reason: string | null;
}

/** Redis unreachable: the production cache, never connected. */
function redisDown(): RawCacheService {
  return new RawCacheService();
}

/** A cache that keeps what it is given, JSON round-tripped as Redis would. */
function workingCache(): { cache: RawCacheService; store: Map<string, string> } {
  const store = new Map<string, string>();
  const cache = {
    get: async <T>(key: string): Promise<T | null> => {
      const raw = store.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    set: async (key: string, value: unknown): Promise<void> => {
      store.set(key, JSON.stringify(value));
    },
    take: async <T>(key: string): Promise<T | null> => {
      const raw = store.get(key);
      store.delete(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    del: async (key: string): Promise<void> => {
      store.delete(key);
    },
  };
  return { cache: cache as unknown as RawCacheService, store };
}

function createService(cache: RawCacheService) {
  const attempts: Attempt[] = [];
  const signed: unknown[] = [];
  const prisma = {
    adminUser: {
      findUnique: async () => ({
        id: 'admin-1',
        login: 'Operator',
        loginNormalized: 'operator',
        name: 'The Operator',
        totpEnabled: false,
        passwordHash: 'stored-hash',
      }),
    },
    adminPasskey: {
      findMany: async () => [],
      findUnique: async ({ where }: { where: { credentialId: string } }) => ({
        id: 'pk-1',
        adminUserId: 'admin-1',
        name: 'Key',
        credentialId: where.credentialId,
        publicKey: 'AAAA',
        counter: BigInt(0),
        transports: ['internal'],
      }),
    },
    adminAuditLog: { create: async ({ data }: { data: unknown }) => data },
  };
  const providers: Record<string, unknown> = {
    PasswordHashService: {
      verifyPassword: async ({ plainTextPassword }: { plainTextPassword: string }) => plainTextPassword === PASSWORD,
    },
    TwoFactorService: { verifyForLogin: async () => false },
    LoginGuardService: {
      isRateLimited: async () => false,
      recordAttempt: async (attempt: Attempt) => {
        attempts.push(attempt);
        return { autoBlocked: false };
      },
    },
  };
  const moduleRef = {
    get: (token: unknown): unknown => {
      const name = (token as { name?: string } | undefined)?.name ?? '<anonymous>';
      if (!(name in providers)) throw new Error(`provider ${name} is not registered`);
      return providers[name];
    },
  } as unknown as ModuleRef;
  const jwtService = {
    signAsync: async (payload: unknown): Promise<string> => {
      signed.push(payload);
      return 'jwt';
    },
  };
  const service = new PasskeyService(
    prisma as never,
    cache,
    jwtService as never,
    { jwtExpiresIn: '24h' } as never,
    moduleRef,
  );
  return { service, attempts, signed };
}

function isUnavailable(error: unknown): boolean {
  return error instanceof ServiceUnavailableException && error.getStatus() === 503;
}

describe('a passkey challenge is issued only if it was stored', () => {
  it('refuses to issue a sign-in challenge while Redis is down', async () => {
    const { service } = createService(redisDown());

    await assert.rejects(service.generateAuthenticationOptions(RP_ID), isUnavailable);
  });

  it('refuses to issue an enrolment challenge while Redis is down, even after a correct factor', async () => {
    const { service, attempts } = createService(redisDown());

    await assert.rejects(
      service.generateRegistrationOptions('admin-1', RP_ID, { password: PASSWORD }, METADATA),
      isUnavailable,
    );
    // Control: it got past the factor, so the refusal is the store's, not the password's.
    assert.deepEqual(
      attempts.map((attempt) => [attempt.success, attempt.reason]),
      [[true, 'passkey_enrolment']],
    );
  });

  it('still issues both, and stores what it issued, when the store keeps them', async () => {
    const { cache, store } = workingCache();
    const { service } = createService(cache);

    const signIn = await service.generateAuthenticationOptions(RP_ID);
    const signInChallenge = signIn['challenge'];
    assert.equal(typeof signInChallenge, 'string');
    assert.deepEqual(JSON.parse(store.get(`passkey:auth:${String(signInChallenge)}`) ?? 'null'), {
      challenge: signInChallenge,
      adminId: null,
    });

    const enrol = await service.generateRegistrationOptions('admin-1', RP_ID, { password: PASSWORD }, METADATA);
    const parked = JSON.parse(store.get('passkey:reg:admin-1') ?? 'null') as { challenge?: unknown; reauthAt?: unknown };
    assert.equal(parked.challenge, enrol['challenge']);
    assert.equal(typeof parked.reauthAt, 'number');
  });

  it('never signed a sign-in token while Redis was down: the verify half reads nothing and refuses', async () => {
    const { service, attempts, signed } = createService(redisDown());
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: 'a-challenge-parked-before-the-outage', origin: ORIGIN }),
      'utf8',
    ).toString('base64url');

    await assert.rejects(
      service.verifyAuthentication(
        RP_ID,
        ORIGIN,
        {
          id: 'credential-1',
          rawId: 'credential-1',
          type: 'public-key',
          clientExtensionResults: {},
          response: { clientDataJSON, authenticatorData: '', signature: '' },
        } as never,
        METADATA,
      ),
      (error: unknown) =>
        error instanceof UnauthorizedException && /challenge expired or invalid/i.test(error.message),
    );
    assert.deepEqual(signed, [], 'a JWT was signed with no challenge to check it against');
    assert.deepEqual(
      attempts.map((attempt) => [attempt.success, attempt.reason]),
      [[false, 'challenge_expired']],
    );
  });
});
