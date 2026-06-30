import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountMergePreviewService } from '../src/modules/account-merge/services/account-merge-preview.service';

interface ResolverFixtures {
  readonly userByTelegramId?: Map<bigint, { id: string }>;
  readonly userById?: Map<string, { id: string }>;
  readonly userByEmail?: Map<string, { id: string }>;
  readonly webByEmail?: Map<string, { userId: string }>;
  readonly webByLogin?: Map<string, { userId: string }>;
}

function createPreviewService(fx: ResolverFixtures): AccountMergePreviewService {
  const prisma = {
    user: {
      findUnique: async (a: { where: { telegramId?: bigint; id?: string; email?: string } }) => {
        if (a.where.telegramId !== undefined) return fx.userByTelegramId?.get(a.where.telegramId) ?? null;
        if (a.where.id !== undefined) return fx.userById?.get(a.where.id) ?? null;
        if (a.where.email !== undefined) return fx.userByEmail?.get(a.where.email) ?? null;
        return null;
      },
    },
    webAccount: {
      findUnique: async (a: { where: { emailNormalized?: string; loginNormalized?: string } }) => {
        if (a.where.emailNormalized !== undefined) return fx.webByEmail?.get(a.where.emailNormalized) ?? null;
        if (a.where.loginNormalized !== undefined) return fx.webByLogin?.get(a.where.loginNormalized) ?? null;
        return null;
      },
    },
  } as unknown as PrismaService;
  return new AccountMergePreviewService(prisma);
}

describe('AccountMergePreviewService.resolveUserId', () => {
  it('resolves a numeric Telegram id', async () => {
    const svc = createPreviewService({ userByTelegramId: new Map([[BigInt(123), { id: 'U-TG' }]]) });
    assert.equal(await svc.resolveUserId('123'), 'U-TG');
  });

  it('resolves an email via User then WebAccount', async () => {
    const viaUser = createPreviewService({ userByEmail: new Map([['a@x.io', { id: 'U-MAIL' }]]) });
    assert.equal(await viaUser.resolveUserId('A@X.io'), 'U-MAIL');
    const viaWeb = createPreviewService({ webByEmail: new Map([['b@x.io', { userId: 'U-WEBMAIL' }]]) });
    assert.equal(await viaWeb.resolveUserId('B@X.io'), 'U-WEBMAIL');
  });

  it('resolves a reiwa_id (CUID)', async () => {
    const id = 'c' + 'a'.repeat(24);
    const svc = createPreviewService({ userById: new Map([[id, { id }]]) });
    assert.equal(await svc.resolveUserId(id), id);
  });

  it('resolves a web login', async () => {
    const svc = createPreviewService({ webByLogin: new Map([['john', { userId: 'U-LOGIN' }]]) });
    assert.equal(await svc.resolveUserId('John'), 'U-LOGIN');
  });

  it('throws on an empty reference', async () => {
    const svc = createPreviewService({});
    await assert.rejects(() => svc.resolveUserId('   '), BadRequestException);
  });

  it('throws when nothing matches', async () => {
    const svc = createPreviewService({});
    await assert.rejects(() => svc.resolveUserId('nobody'), NotFoundException);
    await assert.rejects(() => svc.resolveUserId('999'), NotFoundException);
  });
});
