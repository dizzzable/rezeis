import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AltshopImporterService } from '../src/modules/imports/services/altshop-importer.service';
import { parseAltshopBackup } from '../src/modules/imports/utils/altshop-backup-parser';

describe('parseAltshopBackup — web_accounts', () => {
  it('extracts web account identities (login/email) and drops the bcrypt hash', async () => {
    const payload = {
      data: {
        users: [{ id: 1, telegram_id: -5, username: 'weblogin', name: 'Web', role: 'USER' }],
        web_accounts: [
          {
            user_telegram_id: -5,
            username: 'weblogin',
            email: 'we@example.com',
            password_hash: '$2b$12$somethingbcrypt',
          },
        ],
      },
    };
    const data = await parseAltshopBackup(gzipNothing(JSON.stringify(payload)));
    const d = data as unknown as { webAccounts: Array<Record<string, unknown>> };
    assert.equal(d.webAccounts.length, 1);
    assert.equal(d.webAccounts[0].username, 'weblogin');
    assert.equal(d.webAccounts[0].email, 'we@example.com');
    assert.equal('password_hash' in d.webAccounts[0], false);
  });
});

describe('AltshopImporterService — claim-pending web account', () => {
  it('creates a claim-pending web account for a migrated web-only user', async () => {
    const created: Array<Record<string, unknown>> = [];
    const prisma = buildPrisma({ created, existingWebAccount: null });
    const service = new AltshopImporterService(prisma as never, { getAllPanelUsers: async () => [] } as never);

    await service.run({
      mode: 'import',
      createdBy: null,
      users: [{ id: 1, telegram_id: -5, username: 'weblogin', name: 'Web', role: 1 } as never],
      subscriptions: [],
      webAccounts: [{ user_telegram_id: -5, username: 'weblogin', email: 'we@example.com' }],
    });

    assert.equal(created.length, 1);
    const wa = created[0];
    assert.equal(wa.login, 'weblogin');
    assert.equal(wa.loginNormalized, 'weblogin');
    assert.equal(wa.passwordHash, null);
    assert.equal(wa.passwordBootstrapPending, true);
    assert.equal(wa.requiresPasswordChange, true);
  });

  it('skips when the user already has a web account', async () => {
    const created: Array<Record<string, unknown>> = [];
    const prisma = buildPrisma({ created, existingWebAccount: { id: 'wa-existing' } });
    const service = new AltshopImporterService(prisma as never, { getAllPanelUsers: async () => [] } as never);

    await service.run({
      mode: 'import',
      createdBy: null,
      users: [{ id: 1, telegram_id: -5, username: 'weblogin', name: 'Web', role: 1 } as never],
      subscriptions: [],
      webAccounts: [{ user_telegram_id: -5, username: 'weblogin', email: null }],
    });

    assert.equal(created.length, 0);
  });

  it('creates no web account in sync mode', async () => {
    const created: Array<Record<string, unknown>> = [];
    const prisma = buildPrisma({ created, existingWebAccount: null, telegramMatch: true });
    const service = new AltshopImporterService(prisma as never, { getAllPanelUsers: async () => [] } as never);

    await service.run({
      mode: 'sync',
      createdBy: null,
      users: [{ id: 1, telegram_id: 777, username: 'tg', name: 'TG', role: 1 } as never],
      subscriptions: [],
      webAccounts: [{ user_telegram_id: 777, username: 'tg', email: null }],
    });

    assert.equal(created.length, 0);
  });

  it('matches a web-only user by its existing cabinet identity on retry', async () => {
    const created: Array<Record<string, unknown>> = [];
    const createdUsers: unknown[] = [];
    const prisma = buildPrisma({
      created,
      createdUsers,
      existingWebAccount: { id: 'wa-existing' },
      webAccountOwnerId: 'existing-web-user',
    });
    const service = new AltshopImporterService(prisma as never, { getAllPanelUsers: async () => [] } as never);
    await service.run({
      mode: 'import', createdBy: null,
      users: [{ id: 1, telegram_id: -5, username: 'weblogin', name: 'Web', role: 1 } as never],
      subscriptions: [],
      webAccounts: [{ user_telegram_id: -5, username: 'weblogin', email: 'we@example.com' }],
    });
    assert.deepEqual(createdUsers, []);
    assert.deepEqual(created, []);
  });

  it('skips a web-only row when login and email belong to different users', async () => {
    const created: Array<Record<string, unknown>> = [];
    const createdUsers: unknown[] = [];
    const prisma = buildPrisma({
      created,
      createdUsers,
      existingWebAccount: null,
      webAccountOwners: { login: 'user-by-login', email: 'user-by-email' },
    });
    const service = new AltshopImporterService(prisma as never, { getAllPanelUsers: async () => [] } as never);
    const result = await service.run({
      mode: 'import', createdBy: null,
      users: [{ id: 1, telegram_id: -5, username: 'weblogin', name: 'Web', role: 1 } as never],
      subscriptions: [],
      webAccounts: [{ user_telegram_id: -5, username: 'weblogin', email: 'we@example.com' }],
    });
    assert.equal(result.skipped, 1);
    assert.deepEqual(createdUsers, []);
    assert.deepEqual(created, []);
  });
});

/** A non-gzip JSON buffer (parseAltshopBackup detects raw JSON). */
function gzipNothing(json: string): Buffer {
  return Buffer.from(json, 'utf-8');
}

function buildPrisma(opts: {
  created: Array<Record<string, unknown>>;
  existingWebAccount: { id: string } | null;
  telegramMatch?: boolean;
  webAccountOwnerId?: string;
  webAccountOwners?: { login?: string; email?: string };
  createdUsers?: unknown[];
}): Record<string, unknown> {
  return {
    user: {
      findUnique: async (args: { where: { telegramId?: bigint; id?: string }; select?: unknown }) => {
        if (args.where.id !== undefined) return { id: args.where.id, createdAt: new Date(), currentSubscriptionId: null };
        if (args.where.telegramId !== undefined) return opts.telegramMatch ? { id: 'user-existing' } : null;
        return null;
      },
      create: async () => {
        opts.createdUsers?.push({ id: 'user-new' });
        return { id: 'user-new' };
      },
      update: async () => ({ id: 'user-new' }),
    },
    webAccount: {
      findUnique: async () => opts.existingWebAccount,
      findFirst: async (args: { where: { loginNormalized?: string; emailNormalized?: string } }) => {
        const ownerId = args.where.loginNormalized
          ? opts.webAccountOwners?.login ?? opts.webAccountOwnerId
          : opts.webAccountOwners?.email ?? opts.webAccountOwnerId;
        return ownerId ? { userId: ownerId } : null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        opts.created.push(args.data);
        return { id: `wa-${opts.created.length}` };
      },
    },
    subscription: { findFirst: async () => null, create: async () => ({ id: 'sub' }), update: async () => ({ id: 'sub' }) },
    transaction: { findUnique: async () => null, create: async () => ({ id: 'tx' }) },
    profileSyncJob: { create: async () => ({ id: 'job' }) },
    importRecord: {
      create: async (args: { data: Record<string, unknown> }) => ({ id: 'import-1', ...args.data }),
      update: async (args: { data: Record<string, unknown> }) => ({ id: 'import-1', ...args.data }),
    },
  };
}
