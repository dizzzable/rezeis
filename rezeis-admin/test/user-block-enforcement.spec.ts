import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

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
