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

function createService(
  prismaService: object,
  events: object = { info: () => undefined, error: () => undefined },
): PromocodeLifecycleService {
  return new PromocodeLifecycleService(
    prismaService as never,
    {} as never,
    {} as never,
    events as never,
    { enqueue: async () => undefined } as never,
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
        expiresAt: null,
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
    const service = createService({
      promocode: { create: async () => assert.fail('must not create') },
    });

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

  it('archives promocodes instead of deleting their activation history', async () => {
    let updateArgs: unknown;
    const eventCalls: unknown[][] = [];
    const service = createService(
      {
        promocode: {
          update: async (args: unknown) => {
            updateArgs = args;
            return { id: 'promo-1', code: 'GIFT-ABC', _count: { activations: 1 } };
          },
        },
      },
      { info: (...args: unknown[]) => eventCalls.push(args), error: () => undefined },
    );

    await service.delete('promo-1');

    const archivedAt = (updateArgs as { data: { archivedAt: unknown } }).data.archivedAt;
    assert.ok(archivedAt instanceof Date);
    assert.deepStrictEqual(updateArgs, {
      where: { id: 'promo-1', archivedAt: null },
      data: { isActive: false, archivedAt },
      select: { id: true, code: true, _count: { select: { activations: true } } },
    });
    assert.deepStrictEqual(eventCalls, [
      [
        'promocode.archived',
        'PROMOCODE',
        'Promocode GIFT-ABC archived',
        { promocodeId: 'promo-1', code: 'GIFT-ABC', activationsCount: 1 },
      ],
    ]);
  });

  it('treats an already archived promocode as an idempotent delete success', async () => {
    const service = createService({
      promocode: {
        update: async () => {
          throw new Prisma.PrismaClientKnownRequestError('Record not found', {
            code: 'P2025',
            clientVersion: 'test',
          });
        },
        findUnique: async () => ({ archivedAt: new Date('2026-07-11T00:00:00.000Z') }),
      },
    });

    await service.delete('promo-1');
  });

  it('lists only non-archived promocodes', async () => {
    let findManyArgs: unknown;
    const service = createService({
      promocode: {
        findMany: async (args: unknown) => {
          findManyArgs = args;
          return [createRecord({ id: 'promo-a' })];
        },
      },
    });

    assert.equal((await service.list())[0]?.id, 'promo-a');
    assert.deepStrictEqual(findManyArgs, {
      where: { archivedAt: null },
      include: { _count: { select: { activations: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('does not resolve archived promocodes by code', async () => {
    let findFirstArgs: unknown;
    const service = createService({
      promocode: {
        findFirst: async (args: unknown) => {
          findFirstArgs = args;
          return null;
        },
      },
    });

    assert.equal(await service.getByCode(' promo '), null);
    assert.deepStrictEqual(findFirstArgs, {
      where: { code: 'PROMO', archivedAt: null },
      include: { _count: { select: { activations: true } } },
    });
  });

  it('rejects updates to archived promocodes', async () => {
    const service = createService({
      promocode: { findFirst: async () => null },
    });

    await assert.rejects(service.update('archived-promo', { isActive: true }), NotFoundException);
  });

  it('reads non-archived promocodes and rejects missing ids', async () => {
    let findFirstArgs: unknown;
    const service = createService({
      promocode: {
        findFirst: async (args: unknown) => {
          findFirstArgs = args;
          return null;
        },
      },
    });

    await assert.rejects(service.getById('missing-promo'), NotFoundException);
    assert.deepStrictEqual(findFirstArgs, {
      where: { id: 'missing-promo', archivedAt: null },
      include: { _count: { select: { activations: true } } },
    });
  });
});
