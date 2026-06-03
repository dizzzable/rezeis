import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PromocodeAvailability, PromocodeRewardType } from '@prisma/client';

import { PromocodeLifecycleService } from '../src/modules/promocodes/services/promocode-lifecycle.service';

function createRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'promo-1',
    code: 'PROMO',
    isActive: true,
    availability: PromocodeAvailability.ALL,
    rewardType: PromocodeRewardType.DURATION,
    reward: 7,
    plan: null,
    lifetime: null,
    maxActivations: null,
    allowedTelegramIds: [],
    allowedPlanIds: [],
    createdAt: new Date('2026-04-20T10:00:00.000Z'),
    updatedAt: new Date('2026-04-20T10:00:00.000Z'),
    _count: { activations: 0 },
    ...overrides,
  };
}

function createService(prismaService: object): PromocodeLifecycleService {
  return new PromocodeLifecycleService(
    prismaService as never,
    {} as never,
    {} as never,
    { info: () => undefined } as never,
  );
}

describe('PromocodeLifecycleService', () => {
  it('creates promocodes with normalized codes and wire-safe BigInt allow lists', async () => {
    let createArgs: unknown;
    const service = createService({
      promocode: {
        create: async (args: unknown) => {
          createArgs = args;
          return createRecord({ code: 'PROMO-1', allowedTelegramIds: [BigInt('123456789')] });
        },
      },
    });

    const result = await service.create({
      code: ' promo-1 ',
      availability: PromocodeAvailability.ALLOWED,
      rewardType: PromocodeRewardType.DURATION,
      reward: 14,
      allowedTelegramIds: ['123456789'],
      allowedPlanIds: ['plan-1'],
    });

    const actualCreateArgs = createArgs as { data: { plan: unknown } };
    assert.equal(actualCreateArgs.data.plan, Prisma.JsonNull);
    assert.deepStrictEqual(createArgs, {
      data: {
        code: 'PROMO-1',
        isActive: true,
        availability: PromocodeAvailability.ALLOWED,
        rewardType: PromocodeRewardType.DURATION,
        reward: 14,
        plan: Prisma.JsonNull,
        lifetime: null,
        maxActivations: null,
        allowedTelegramIds: [BigInt('123456789')],
        allowedPlanIds: ['plan-1'],
      },
      include: { _count: { select: { activations: true } } },
    });
    assert.equal(result.code, 'PROMO-1');
    assert.deepStrictEqual(result.allowedTelegramIds, ['123456789']);
  });

  it('requires a plan snapshot for subscription promocodes', async () => {
    const service = createService({ promocode: { create: async () => assert.fail('must not create') } });

    await assert.rejects(
      service.create({
        code: 'SUBSCRIPTION-PROMO',
        availability: PromocodeAvailability.ALL,
        rewardType: PromocodeRewardType.SUBSCRIPTION,
      }),
      BadRequestException,
    );
  });

  it('maps duplicate-code persistence errors to a bounded conflict', async () => {
    const service = createService({
      promocode: {
        create: async () => {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        },
      },
    });

    await assert.rejects(
      service.create({
        code: 'promo',
        availability: PromocodeAvailability.ALL,
        rewardType: PromocodeRewardType.DURATION,
      }),
      ConflictException,
    );
  });

  it('lists and reads promocodes using the current Prisma model name', async () => {
    const calls: unknown[] = [];
    const service = createService({
      promocode: {
        findMany: async (args: unknown) => {
          calls.push(args);
          return [createRecord({ id: 'promo-a' })];
        },
        findUnique: async (args: unknown) => {
          calls.push(args);
          return null;
        },
      },
    });

    assert.equal((await service.list())[0]?.id, 'promo-a');
    await assert.rejects(service.getById('missing-promo'), NotFoundException);
    assert.deepStrictEqual(calls, [
      { include: { _count: { select: { activations: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
      { where: { id: 'missing-promo' }, include: { _count: { select: { activations: true } } } },
    ]);
  });
});
