import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';

import { ReferralsService } from '../src/modules/referrals/services/referrals.service';

function user(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    username: `${id}-username`,
    name: `${id}-name`,
    telegramId: BigInt('123456789'),
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ReferralsService', () => {
  it('lists referrals with current filters and maps user summaries safely', async () => {
    let findManyArgs: unknown;
    const service = new ReferralsService({
      referral: {
        findMany: async (args: unknown) => {
          findManyArgs = args;
          return [{
            id: 'referral-1',
            referrer: user('referrer'),
            referred: user('referred', { name: '' }),
            qualifiedAt: new Date('2026-04-05T00:00:00.000Z'),
            createdAt: new Date('2026-04-02T00:00:00.000Z'),
          }];
        },
      },
    } as never);

    const result = await service.listReferrals({ referrerId: 'referrer', qualified: 'true', limit: 10, offset: 5 });

    assert.deepStrictEqual(findManyArgs, {
      where: { referrerId: 'referrer', referredId: undefined, qualifiedAt: { not: null } },
      include: {
        referrer: { select: { id: true, username: true, name: true, telegramId: true, createdAt: true } },
        referred: { select: { id: true, username: true, name: true, telegramId: true, createdAt: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
      skip: 5,
    });
    assert.deepStrictEqual(result, [{
      id: 'referral-1',
      referrer: {
        id: 'referrer',
        username: 'referrer-username',
        name: 'referrer-name',
        telegramId: '123456789',
        createdAt: '2026-04-01T00:00:00.000Z',
      },
      referred: {
        id: 'referred',
        username: 'referred-username',
        name: null,
        telegramId: '123456789',
        createdAt: '2026-04-01T00:00:00.000Z',
      },
      qualifiedAt: '2026-04-05T00:00:00.000Z',
      createdAt: '2026-04-02T00:00:00.000Z',
    }]);
  });

  it('creates invite tokens only for existing inviters and maps the created row', async () => {
    let createArgs: unknown;
    const service = new ReferralsService({
      user: { findUnique: async () => ({ id: 'inviter-1' }) },
      referralInvite: {
        create: async (args: unknown) => {
          createArgs = args;
          return {
            id: 'invite-1',
            token: 'generated-token',
            inviter: user('inviter-1'),
            note: 'hello',
            expiresAt: new Date('2026-05-01T00:00:00.000Z'),
            revokedAt: null,
            consumedAt: null,
            createdAt: new Date('2026-04-01T00:00:00.000Z'),
          };
        },
      },
    } as never);

    const result = await service.createInvite({
      inviterId: 'inviter-1',
      note: 'hello',
      expiresAt: '2026-05-01T00:00:00.000Z',
    });

    assert.equal((createArgs as { data: { inviterId: string; note: string } }).data.inviterId, 'inviter-1');
    assert.equal(typeof (createArgs as { data: { token: string } }).data.token, 'string');
    assert.equal((createArgs as { data: { note: string } }).data.note, 'hello');
    assert.deepStrictEqual(result.invite.expiresAt, '2026-05-01T00:00:00.000Z');
  });

  it('rejects invite creation for missing inviters', async () => {
    const service = new ReferralsService({
      user: { findUnique: async () => null },
    } as never);

    await assert.rejects(service.createInvite({ inviterId: 'missing' }), NotFoundException);
  });
});
