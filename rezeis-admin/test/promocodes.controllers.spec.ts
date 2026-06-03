import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PromocodeAvailability, PromocodeRewardType } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { AdminPromocodesController } from '../src/modules/promocodes/controllers/admin-promocodes.controller';
import { AdminPromocodesStatsController } from '../src/modules/promocodes/controllers/admin-promocodes-stats.controller';
import { InternalPromocodesController } from '../src/modules/promocodes/controllers/internal-promocodes.controller';
import { PromocodeInterface } from '../src/modules/promocodes/interfaces/promocode.interface';

function promo(): PromocodeInterface {
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
    activationsCount: 0,
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
  };
}

function route(controller: object, methodName: string): { path: string; method: RequestMethod } {
  const method = Object.getPrototypeOf(controller)[methodName] as object;
  return {
    path: Reflect.getMetadata(PATH_METADATA, method) as string,
    method: Reflect.getMetadata(METHOD_METADATA, method) as RequestMethod,
  };
}

describe('Promocode controllers', () => {
  it('exposes current admin/internal route contracts and guards', () => {
    const admin = new AdminPromocodesController({} as never);
    const stats = new AdminPromocodesStatsController({} as never);
    const internal = new InternalPromocodesController({} as never, {} as never, {} as never);

    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPromocodesController), 'admin/promocodes');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminPromocodesController), [AdminJwtAuthGuard]);
    assert.deepStrictEqual(route(admin, 'list'), { path: '/', method: RequestMethod.GET });
    assert.deepStrictEqual(route(admin, 'create'), { path: '/', method: RequestMethod.POST });
    assert.deepStrictEqual(route(admin, 'update'), { path: ':promocodeId', method: RequestMethod.PATCH });
    assert.deepStrictEqual(route(admin, 'delete'), { path: ':promocodeId', method: RequestMethod.DELETE });
    assert.deepStrictEqual(route(admin, 'generateCode'), { path: 'generate-code', method: RequestMethod.POST });
    assert.deepStrictEqual(route(admin, 'listUserActivations'), { path: 'activations/by-user', method: RequestMethod.GET });

    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPromocodesStatsController), 'admin/promocodes/stats');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminPromocodesStatsController), [AdminJwtAuthGuard]);
    assert.deepStrictEqual(route(stats, 'getStats'), { path: '/', method: RequestMethod.GET });

    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalPromocodesController), 'internal/promocodes');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, InternalPromocodesController), [InternalAdminAuthGuard]);
    assert.deepStrictEqual(route(internal, 'activate'), { path: 'activate', method: RequestMethod.POST });
    assert.deepStrictEqual(route(internal, 'activateByRef'), { path: 'activate-by-ref', method: RequestMethod.POST });
    assert.deepStrictEqual(route(internal, 'getEligibleSubscriptions'), { path: 'eligible-subscriptions', method: RequestMethod.POST });
    assert.deepStrictEqual(route(internal, 'getUserActivations'), { path: 'user/:userRef/activations', method: RequestMethod.GET });
  });

  it('delegates admin lifecycle calls to PromocodeLifecycleService', async () => {
    const calls: unknown[] = [];
    const controller = new AdminPromocodesController({
      list: async () => [promo()],
      create: async (dto: unknown) => {
        calls.push(['create', dto]);
        return promo();
      },
      update: async (id: string, dto: unknown) => {
        calls.push(['update', id, dto]);
        return promo();
      },
      delete: async (id: string) => {
        calls.push(['delete', id]);
      },
      generateUniqueCode: async () => ({ code: 'PROMO-123' }),
      listUserActivations: async (input: unknown) => {
        calls.push(['listUserActivations', input]);
        return { entries: [], total: 0 };
      },
    } as never);

    assert.equal((await controller.list())[0]?.code, 'PROMO');
    assert.equal((await controller.create({ code: 'promo' } as never)).id, 'promo-1');
    assert.equal((await controller.update('promo-1', { reward: 10 } as never)).id, 'promo-1');
    await controller.delete('promo-1');
    assert.deepStrictEqual(await controller.generateCode(), { code: 'PROMO-123' });
    assert.deepStrictEqual(await controller.listUserActivations({ userId: 'user-1' }), { entries: [], total: 0 });
    assert.deepStrictEqual(calls, [
      ['create', { code: 'promo' }],
      ['update', 'promo-1', { reward: 10 }],
      ['delete', 'promo-1'],
      ['listUserActivations', { userId: 'user-1', limit: 25, offset: 0 }],
    ]);
  });

  it('resolves internal activation-by-reference through admin-owned user lookup', async () => {
    const portalCalls: unknown[] = [];
    const controller = new InternalPromocodesController(
      {
        activate: async (input: unknown) => {
          portalCalls.push(input);
          return { step: 'ACTIVATED', messageKey: 'ok', errorCode: null, promocode: promo(), reward: null, availableSubscriptionIds: [], activation: null };
        },
      } as never,
      { listUserActivations: async () => ({ entries: [], total: 0 }) } as never,
      {
        user: {
          findUnique: async (args: unknown) => {
            assert.deepStrictEqual(args, {
              where: { id: 'cmphfcr6i007v01jg0lcu653h' },
              select: { id: true, telegramId: true },
            });
            return { id: 'cmphfcr6i007v01jg0lcu653h', telegramId: BigInt('123') };
          },
        },
      } as never,
    );

    assert.equal((await controller.activateByRef({ userRef: 'cmphfcr6i007v01jg0lcu653h', code: 'promo' })).step, 'ACTIVATED');
    assert.deepStrictEqual(portalCalls, [{ userId: 'cmphfcr6i007v01jg0lcu653h', userTelegramId: BigInt('123'), dto: { code: 'promo' } }]);
  });
});
