import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExternalAuthProvider } from '@prisma/client';

import { ExternalAuthService } from '../src/modules/external-auth/services/external-auth.service';
import type { ExternalUserProfile } from '../src/modules/external-auth/interfaces/external-auth.interface';

interface MockState {
  linkByIdentity?: { userId: string; blocked: boolean } | null;
  accountByEmail?: { userId: string; blocked: boolean } | null;
  shellWebAccount?: { id: string; passwordHash: string | null } | null;
  loginConflict?: { id: string } | null;
}

function createService(state: MockState) {
  const calls = {
    linkCreated: 0,
    linkUpdated: 0,
    userCreated: 0,
    webAccountCreated: 0,
    webAccountUpdated: [] as Array<Record<string, unknown>>,
    events: 0,
  };

  const tx = {
    user: {
      create: async () => {
        calls.userCreated += 1;
        return { id: 'new-user-1' };
      },
    },
    webAccount: {
      create: async () => {
        calls.webAccountCreated += 1;
        return { id: 'web-1' };
      },
      findUnique: async (args: { where: { userId?: string; loginNormalized?: string } }) => {
        if (args.where.loginNormalized !== undefined) return state.loginConflict ?? null;
        return state.shellWebAccount ?? null;
      },
      update: async (args: { data: Record<string, unknown> }) => {
        calls.webAccountUpdated.push(args.data);
        return { id: 'web-1' };
      },
    },
    userOAuthLink: {
      create: async () => {
        calls.linkCreated += 1;
        return { id: 'link-1' };
      },
    },
  };

  const prisma = {
    userOAuthLink: {
      findUnique: async () =>
        state.linkByIdentity
          ? { id: 'link-1', userId: state.linkByIdentity.userId, user: { isBlocked: state.linkByIdentity.blocked } }
          : null,
      update: async () => {
        calls.linkUpdated += 1;
        return { id: 'link-1' };
      },
      create: async () => {
        calls.linkCreated += 1;
        return { id: 'link-1' };
      },
    },
    webAccount: {
      findUnique: async (args: { where: { emailNormalized?: string; userId?: string } }) => {
        if (args.where.emailNormalized !== undefined) {
          return state.accountByEmail
            ? { userId: state.accountByEmail.userId, user: { isBlocked: state.accountByEmail.blocked } }
            : null;
        }
        return state.shellWebAccount ?? null;
      },
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const configService = {
    getPolicy: async () => ({ mode: 'off', customBlocklist: [], allowlist: [], gateProvidersByEmailModule: false }),
    isProviderEnabled: async () => true,
  };
  const disposableEmailService = { check: async () => ({ allowed: true }) };
  const passwordHashService = { hashPassword: async () => 'scrypt:hashed' };
  const systemEventsService = {
    info: () => {
      calls.events += 1;
    },
  };
  const emailDeliveryService = { send: async () => undefined };
  const adapter = {} as never;

  const service = new ExternalAuthService(
    prisma as never,
    configService as never,
    disposableEmailService as never,
    passwordHashService as never,
    systemEventsService as never,
    emailDeliveryService as never,
    adapter,
    adapter,
    adapter,
    adapter,
  );
  return { service, calls };
}

function profile(overrides: Partial<ExternalUserProfile> = {}): ExternalUserProfile {
  return {
    provider: ExternalAuthProvider.GOOGLE,
    providerUserId: 'g-123',
    email: 'user@gmail.com',
    emailVerified: true,
    name: 'Test User',
    avatarUrl: null,
    rawProfile: {},
    ...overrides,
  };
}

describe('ExternalAuthService.resolve', () => {
  it('logs in an existing identity link and touches lastUsedAt', async () => {
    const { service, calls } = createService({ linkByIdentity: { userId: 'user-1', blocked: false } });
    const result = await service.resolve(profile());
    assert.deepStrictEqual(result, { action: 'login', userId: 'user-1' });
    assert.equal(calls.linkUpdated, 1);
  });

  it('denies a blocked user on an existing link', async () => {
    const { service } = createService({ linkByIdentity: { userId: 'user-1', blocked: true } });
    assert.deepStrictEqual(await service.resolve(profile()), { action: 'denied' });
  });

  it('auto-links a verified-email match and logs in', async () => {
    const { service, calls } = createService({
      linkByIdentity: null,
      accountByEmail: { userId: 'user-2', blocked: false },
    });
    const result = await service.resolve(profile());
    assert.deepStrictEqual(result, { action: 'login', userId: 'user-2' });
    assert.equal(calls.linkCreated, 1);
  });

  it('denies a blocked user on a verified-email match', async () => {
    const { service } = createService({
      linkByIdentity: null,
      accountByEmail: { userId: 'user-2', blocked: true },
    });
    assert.deepStrictEqual(await service.resolve(profile()), { action: 'denied' });
  });

  it('does NOT auto-link on an UNVERIFIED email match', async () => {
    const { service, calls } = createService({
      linkByIdentity: null,
      accountByEmail: { userId: 'user-2', blocked: false },
    });
    const result = await service.resolve(profile({ emailVerified: false }));
    // No verified match path → falls through to a new shell + finish_setup.
    assert.equal(result.action, 'finish_setup');
    assert.equal(calls.userCreated, 1);
  });

  it('creates a shell + finish_setup for a brand-new identity', async () => {
    const { service, calls } = createService({ linkByIdentity: null, accountByEmail: null });
    const result = await service.resolve(profile());
    assert.deepStrictEqual(result, { action: 'finish_setup', userId: 'new-user-1' });
    assert.equal(calls.userCreated, 1);
    assert.equal(calls.webAccountCreated, 1);
    assert.equal(calls.linkCreated, 1);
    assert.equal(calls.events, 1);
  });

  it('creates a shell for Telegram (no email) → finish_setup', async () => {
    const { service, calls } = createService({ linkByIdentity: null, accountByEmail: null });
    const result = await service.resolve(
      profile({ provider: ExternalAuthProvider.TELEGRAM, email: null, emailVerified: false, providerUserId: '777' }),
    );
    assert.equal(result.action, 'finish_setup');
    assert.equal(calls.webAccountCreated, 1);
  });
});

describe('ExternalAuthService.finishSetup', () => {
  it('sets login + password on a shell account', async () => {
    const { service, calls } = createService({
      shellWebAccount: { id: 'web-1', passwordHash: null },
      loginConflict: null,
    });
    const result = await service.finishSetup({
      userId: 'cmphfcr6i007v01jg0lcu653h',
      login: 'newlogin',
      passwordHash: 'a'.repeat(64),
    });
    assert.deepStrictEqual(result, { ok: true });
    assert.equal(calls.webAccountUpdated.length, 1);
    assert.equal(calls.webAccountUpdated[0].login, 'newlogin');
    assert.equal(calls.webAccountUpdated[0].passwordHash, 'scrypt:hashed');
  });

  it('is idempotent when credentials are already set', async () => {
    const { service, calls } = createService({
      shellWebAccount: { id: 'web-1', passwordHash: 'scrypt:existing' },
    });
    await service.finishSetup({
      userId: 'cmphfcr6i007v01jg0lcu653h',
      login: 'newlogin',
      passwordHash: 'a'.repeat(64),
    });
    assert.equal(calls.webAccountUpdated.length, 0);
  });

  it('rejects a taken login', async () => {
    const { service } = createService({
      shellWebAccount: { id: 'web-1', passwordHash: null },
      loginConflict: { id: 'other-web' },
    });
    await assert.rejects(
      service.finishSetup({ userId: 'cmphfcr6i007v01jg0lcu653h', login: 'taken', passwordHash: 'a'.repeat(64) }),
    );
  });
});
