import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { ExternalAuthService } from '../src/modules/external-auth/services/external-auth.service';
import { InternalUserService } from '../src/modules/internal-user/services/internal-user.service';
import { WebAuthService } from '../src/modules/web-auth/services/web-auth.service';

/**
 * Blocking a user has to be met by the person, not just recorded about them.
 *
 * Before these checks existed, `users.is_blocked` stopped broadcasts, quests,
 * referral earnings and NEW magic links — and nothing else. A blocked person
 * kept their cabinet session (the cookie lives in Redis and its TTL slides on
 * every request, so an active one never expires), could sign back in with their
 * password, and could re-enter through the bot.
 *
 * The three doors below are the ones that were open. Each is asserted
 * separately because each was reachable on its own: clearing a cookie leads to
 * the login door, and a fresh Telegram account leads to the bootstrap door.
 */

describe('password login', () => {
  function buildService(isBlocked: boolean) {
    const verifyPassword = async () => true;
    const service = new WebAuthService(
      {
        webAccount: {
          findUnique: async () => ({
            id: 'wa-1',
            userId: 'user-1',
            passwordHash: 'stored-hash',
            passwordBootstrapPending: false,
            requiresPasswordChange: false,
            emailVerifiedAt: null,
            user: { telegramId: null, isBlocked },
          }),
        },
      } as never,
      { verifyPassword, needsRehash: () => false } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return service;
  }

  it('refuses a blocked user holding the right password', async () => {
    // This door verified the password and let them in. Its sibling,
    // `signInLinkedWebAccount`, always refused — the two check the SAME hash
    // and disagreed about who may enter, and the cabinet uses this one.
    const service = buildService(true);
    await assert.rejects(
      () => service.login({ login: 'abuser', password: 'correct-horse' } as never),
      (err: unknown) => err instanceof UnauthorizedException,
    );
  });

  it('still lets an unblocked user in', async () => {
    // The positive control. A refusal that fires for everybody would satisfy
    // the assertion above perfectly.
    const service = buildService(false);
    const result = await service.login({
      login: 'regular',
      password: 'correct-horse',
    } as never);
    assert.equal(result.userId, 'user-1');
  });

  it('says exactly what it says for an unknown login', async () => {
    // Same message, so the refusal is not a probe for "is this account
    // blocked" that an attacker can run against arbitrary logins.
    const service = buildService(true);
    await assert.rejects(
      () => service.login({ login: 'abuser', password: 'x' } as never),
      (err: unknown) =>
        err instanceof UnauthorizedException &&
        (err.getResponse() as { message?: string }).message === 'Invalid login or password',
    );
  });
});

describe('session read', () => {
  function buildService(isBlocked: boolean) {
    const USER = {
      id: 'user-1',
      telegramId: null,
      isBlocked,
      subscriptions: [],
      webAccount: null,
    };
    return new InternalUserService(
      {
        user: {
          // Both are stubbed: `getRequiredUser` picks its lookup from which
          // identifier was supplied, and pinning only one would make this test
          // depend on that choice.
          findUnique: async () => USER,
          findFirst: async () => USER,

        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it('refuses to hand a blocked user their session', async () => {
    // This is what actually ends a LIVE session. Blocking touches no session
    // store — the cabinet cookie is in Redis, its TTL slides on every request,
    // and the panel has no way to revoke it. Refusing the read the cabinet
    // performs on load is the one place that needs no session index.
    const service = buildService(true);
    await assert.rejects(
      () => service.getSession({ userId: 'user-1' } as never),
      (err: unknown) => err instanceof ForbiddenException,
    );
  });

  it('lets an unblocked user past the gate', async () => {
    // The positive control. It asserts the GATE, not the session payload:
    // building a fixture complete enough for the full projection would couple
    // this file to every field the mapper touches, and the subject here is who
    // is refused. Reaching the mapper at all is the proof the gate opened.
    const service = buildService(false);
    await assert.rejects(
      () => service.getSession({ userId: 'user-1' } as never),
      (err: unknown) => !(err instanceof ForbiddenException),
    );
  });
});

describe('registration doors', () => {
  /**
   * `users.is_blocked` can only refuse a row that EXISTS. Somebody who signs
   * up again has none — which is the whole point of a ban being evaded — so
   * every path that can mint a new account has to consult the identity
   * blocklist instead. There are three such paths and each is asserted
   * separately, because each is reachable on its own.
   */
  function buildWebAuth(overrides: {
    readonly listed?: boolean;
    readonly ipBlocked?: boolean;
  } = {}) {
    const writes: string[] = [];
    const service = new WebAuthService(
      {
        // Any write reaching here is the defect: a refusal must cost nothing,
        // with no account to delete and no referral edge to unwind.
        $transaction: async () => {
          writes.push('transaction');
          return { userId: 'user-1', webAccountId: 'wa-1' };
        },
      } as never,
      { hashPassword: async () => 'scrypt:x' } as never,
      {} as never,
      { getInternalPlatformPolicy: async () => ({ accessMode: 'OPEN' }) } as never,
      { evaluate: () => null } as never,
      {} as never,
      { info: () => undefined } as never,
      {} as never,
      { captureBestEffort: async () => undefined } as never,
      { listRequiredKeys: async () => [], recordConsents: async () => undefined } as never,
      {
        findFirstMatch: async () => (overrides.listed === true ? { id: 'entry-1' } : null),
      } as never,
      {
        isBlocked: async () => ({ blocked: overrides.ipBlocked === true }),
      } as never,
    );
    return { service, writes };
  }

  const REGISTRATION = {
    login: 'abuser2',
    password: 'correct-horse',
    email: 'abuser@example.com',
    registrationSnapshot: { channel: 'web', ip: '192.0.2.55' },
  };

  it('refuses a web sign-up whose identity is on the blocklist', async () => {
    const { service, writes } = buildWebAuth({ listed: true });
    await assert.rejects(
      () => service.register(REGISTRATION as never),
      (err: unknown) => err instanceof ForbiddenException,
    );
    assert.deepStrictEqual(writes, [], 'nothing may be written before the refusal');
  });

  it('refuses a web sign-up from a blocked address', async () => {
    // The address comes from the PAYLOAD, not from the request. The global IP
    // guard in front of the panel sees the cabinet, not the customer, so on a
    // split deployment it would see one address for every sign-up on earth.
    const { service, writes } = buildWebAuth({ ipBlocked: true });
    await assert.rejects(
      () => service.register(REGISTRATION as never),
      (err: unknown) => err instanceof ForbiddenException,
    );
    assert.deepStrictEqual(writes, []);
  });

  it('says the same thing either way, so the form is not an oracle', async () => {
    // A distinguishable refusal turns the sign-up form into a lookup for
    // "is this e-mail banned", runnable against any address an attacker likes.
    const listedMessage = await refusalCode(buildWebAuth({ listed: true }).service);
    const addressMessage = await refusalCode(buildWebAuth({ ipBlocked: true }).service);
    assert.equal(listedMessage, addressMessage);
    assert.equal(listedMessage, 'REGISTRATION_DISABLED');
  });

  async function refusalCode(service: WebAuthService): Promise<string | undefined> {
    try {
      await service.register(REGISTRATION as never);
      return undefined;
    } catch (err) {
      return ((err as ForbiddenException).getResponse() as { code?: string }).code;
    }
  }

  it('still lets an ordinary sign-up through — the control', async () => {
    // A refusal that fired for everybody would satisfy all three assertions
    // above and would close registration entirely.
    const { service, writes } = buildWebAuth();
    const result = await service.register(REGISTRATION as never);
    assert.equal(result.userId, 'user-1');
    assert.deepStrictEqual(writes, ['transaction']);
  });
});

describe('the social sign-up door', () => {
  /**
   * OAuth was the ONE path that could create a user while consulting neither
   * the platform access mode nor the blocklist. `REG_BLOCKED` closed the web
   * form and the bot, and left the Google button working.
   *
   * Every returning-user branch above it already refused a blocked account, so
   * what is asserted here is specifically the NEW-account branch.
   */
  function buildExternalAuth(overrides: {
    readonly rejection?: { code: string; status: 403 | 503; message: string } | null;
    readonly listed?: boolean;
  } = {}) {
    const created: string[] = [];
    const service = new ExternalAuthService(
      {
        userOAuthLink: { findUnique: async () => null },
        webAccount: { findUnique: async () => null },
        user: { findUnique: async () => null },
        $transaction: async () => {
          created.push('shell');
          return 'user-new';
        },
      } as never,
      { getPolicy: async () => ({ mode: 'off' }) } as never,
      { check: async () => ({ allowed: true }) } as never,
      {} as never,
      { info: () => undefined } as never,
      {} as never,
      { captureBestEffort: async () => undefined } as never,
      { getInternalPlatformPolicy: async () => ({ accessMode: 'OPEN' }) } as never,
      { evaluate: () => overrides.rejection ?? null } as never,
      {
        findFirstMatch: async () => (overrides.listed === true ? { id: 'entry-1' } : null),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, created };
  }

  const PROFILE = {
    provider: 'GOOGLE',
    providerUserId: 'google-999',
    email: 'abuser@example.com',
    emailVerified: false,
    name: 'Ab User',
    rawProfile: {},
  };

  it('refuses a social sign-up while registration is closed', async () => {
    const { service, created } = buildExternalAuth({
      rejection: { code: 'REGISTRATION_DISABLED', status: 403, message: 'closed' },
    });
    await assert.rejects(
      () => service.resolve(PROFILE as never),
      (err: unknown) => err instanceof ForbiddenException,
    );
    assert.deepStrictEqual(created, [], 'no shell account may be minted');
  });

  it('refuses a social sign-up whose identity is on the blocklist', async () => {
    const { service, created } = buildExternalAuth({ listed: true });
    await assert.rejects(
      () => service.resolve(PROFILE as never),
      (err: unknown) => err instanceof ForbiddenException,
    );
    assert.deepStrictEqual(created, []);
  });

  it('still mints a shell for an ordinary new visitor — the control', async () => {
    const { service, created } = buildExternalAuth();
    const outcome = await service.resolve(PROFILE as never);
    assert.equal(outcome.action, 'finish_setup');
    assert.deepStrictEqual(created, ['shell']);
  });
});

describe('claiming a Telegram id onto a different account', () => {
  /**
   * THE MOVE THE CASCADE'S `TELEGRAM_ID` ROW EXISTS TO STOP, and the one it
   * could not stop.
   *
   * Blocking lists the customer's Telegram id, e-mail and login. They then
   * register a fresh web account under a NEW e-mail and a NEW login — which
   * passes, since none of those values is listed — and attach their OLD
   * Telegram id to it. Neither of the two paths that can do that consulted the
   * blocklist.
   *
   * From that moment the ban is gone: the bot only checks the blocklist when NO
   * row owns the id, so a row that now owns it makes the account indisputably
   * theirs and indisputably unblocked. Full bot session, full cabinet,
   * payments allowed.
   */
  function buildClaim(listed: boolean) {
    const writes: string[] = [];
    const service = new WebAuthService(
      {
        $transaction: async () => {
          writes.push('transaction');
          return { status: 'linked' };
        },
      } as never,
      { verifyPassword: async () => true } as never,
      {} as never,
      { getInternalPlatformPolicy: async () => ({ accessMode: 'OPEN' }) } as never,
      { evaluate: () => null } as never,
      {} as never,
      { info: () => undefined } as never,
      {} as never,
      { captureBestEffort: async () => undefined } as never,
      { listRequiredKeys: async () => [], recordConsents: async () => undefined } as never,
      { find: async () => (listed ? { id: 'entry-1' } : null) } as never,
      { isBlocked: async () => ({ blocked: false }) } as never,
    );
    return { service, writes };
  }

  const CLAIM = { login: 'freshlogin', password: 'correct-horse', telegramId: '111' };

  it('refuses when the Telegram id is on the blocklist', async () => {
    const { service, writes } = buildClaim(true);

    await assert.rejects(() => service.telegramClaim(CLAIM as never));
    assert.deepStrictEqual(writes, [], 'nothing may be written before the refusal');
  });

  it('refuses with the same message a wrong password gets, so it is not an oracle', async () => {
    // A distinct refusal would tell an evader WHICH of their identities is
    // listed — the one thing they need in order to route around it.
    const { service } = buildClaim(true);

    await assert.rejects(
      () => service.telegramClaim(CLAIM as never),
      (err: unknown) => (err as Error).message === 'Invalid login or password',
    );
  });

  it('still links an id nobody has blocked — the control', async () => {
    const { service, writes } = buildClaim(false);

    await service.telegramClaim(CLAIM as never);
    assert.deepStrictEqual(writes, ['transaction']);
  });
});
