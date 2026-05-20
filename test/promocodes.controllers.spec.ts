import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../src/modules/auth/interfaces/request-metadata.interface';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { AdminPromocodesController } from '../src/modules/promocodes/controllers/admin-promocodes.controller';
import { InternalPromocodesController } from '../src/modules/promocodes/controllers/internal-promocodes.controller';

function createAdmin(role: UserRole): CurrentAdminInterface {
  return {
    id: 'admin-1',
    login: 'admin',
    email: 'admin@example.com',
    name: 'Admin',
    role,
    isActive: true,
    tokenVersion: 1,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    lastLoginAt: new Date('2026-04-19T00:00:00.000Z'),
    lastLoginIp: '127.0.0.1',
  };
}

function createMetadata(): RequestMetadataInterface {
  return {
    requestId: 'request-1',
    remoteAddress: '127.0.0.1',
    userAgent: 'promocodes-controller-spec',
  };
}

function createAuthenticatedRequest(role: UserRole) {
  return {
    user: createAdmin(role),
    metadata: createMetadata(),
  };
}

function createAdminPromocodesController(): AdminPromocodesController {
  return new AdminPromocodesController(
    {
      create: async () => ({ ok: true }),
      update: async () => ({ ok: true }),
      delete: async () => undefined,
      toggleActive: async () => ({ ok: true }),
      findAll: async () => ({ data: [], total: 0, page: 1, limit: 20 }),
      findOne: async () => ({ ok: true }),
    } as never,
    {
      getEligibleSubscriptions: async () => [],
    } as never,
    {
      determineNextStep: () => 'NONE',
    } as never,
    {
      validateForActivation: () => null,
    } as never,
    {
      recordActivationFailure: () => undefined,
      recordActivationSuccess: () => undefined,
    } as never,
    {
      promoCode: { findUnique: async () => null },
      user: { findUnique: async () => null },
      subscription: { findMany: async () => [] },
      $transaction: async <T>(callback: (tx: any) => Promise<T>) =>
        callback({
          promoCodeActivation: {
            create: async () => ({ id: 'activation-1' }),
          },
          subscription: {
            update: async () => undefined,
          },
          user: {
            update: async () => undefined,
          },
        }),
      promoCodeActivation: {
        count: async () => 0,
        findUnique: async () => null,
        create: async () => ({ id: 'activation-1' }),
      },
      promoCodeActivation_findMany: async () => [],
    } as never,
    {
      log: async () => undefined,
    } as never,
  );
}

describe('promocode controllers security', () => {
  it('keeps AdminPromocodesController behind AdminJwtAuthGuard', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, AdminPromocodesController) as string | undefined;
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminPromocodesController) as readonly unknown[] | undefined;

    assert.equal(controllerPath, 'admin/promocodes');
    assert.deepStrictEqual(guards, [AdminJwtAuthGuard]);
  });

  it('keeps InternalPromocodesController behind InternalAdminAuthGuard', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, InternalPromocodesController) as string | undefined;
    const guards = Reflect.getMetadata(GUARDS_METADATA, InternalPromocodesController) as readonly unknown[] | undefined;

    assert.equal(controllerPath, 'internal/promocodes');
    assert.deepStrictEqual(guards, [InternalAdminAuthGuard]);
  });

  it('exposes internal activations history with the shared admin pagination shape', async () => {
    const controller = new InternalPromocodesController(
      {
        promoCode: {
          findUnique: async () => null,
        },
        subscription: {
          findMany: async () => [],
        },
        user: {
          findUnique: async () => null,
        },
        promoCodeActivation: {
          count: async () => 2,
          findMany: async () => [
            {
              id: 'activation-1',
              activatedAt: new Date('2026-04-20T00:00:00.000Z'),
              user: { id: 'user-1', telegramId: 'tg-1', username: 'alice' },
              promoCode: { id: 'promo-1', code: 'SPRING25' },
            },
          ],
        },
      } as never,
      {
        getEligibleSubscriptions: async () => [],
      } as never,
      {
        determineNextStep: () => 'NONE',
      } as never,
      {
        validateForActivation: () => null,
      } as never,
      {
        recordActivationFailure: () => undefined,
        recordActivationSuccess: () => undefined,
      } as never,
    );

    const result = await controller.getAllActivations({ page: 2, limit: 10 } as never);

    assert.deepStrictEqual(result, {
      data: [
        {
          id: 'activation-1',
          activatedAt: new Date('2026-04-20T00:00:00.000Z'),
          user: { id: 'user-1', telegramId: 'tg-1', username: 'alice' },
          promoCode: { id: 'promo-1', code: 'SPRING25' },
        },
      ],
      total: 2,
      page: 2,
      limit: 10,
    });
  });

  it('rejects USER role for promo write operations', async () => {
    const controller = createAdminPromocodesController();
    const req = createAuthenticatedRequest(UserRole.USER) as never;

    await assert.rejects(async () => {
      await controller.create(
        {
          code: 'SUMMER2024',
          isActive: true,
          availability: 'ALL',
          rewardType: 'DURATION',
          rewardValue: 30,
          planSnapshot: null,
          maxActivations: null,
          allowedUserIds: [],
          allowedPlanIds: [],
          expiresAt: null,
          lifetimeDays: null,
        } as never,
        req,
      );
    }, { name: 'ForbiddenException' });

    await assert.rejects(async () => {
      await controller.activate({ code: 'SUMMER2024', userId: 'user-1' } as never, req);
    }, { name: 'ForbiddenException' });

    await assert.rejects(async () => {
      await controller.toggle('promo-1', req);
    }, { name: 'ForbiddenException' });
  });

  it('returns activate response contract keys on happy path', async () => {
    const controller = new AdminPromocodesController(
      {
        create: async () => ({ ok: true }),
        update: async () => ({ ok: true }),
        delete: async () => undefined,
        toggleActive: async () => ({ ok: true }),
        findAll: async () => ({ data: [], total: 0, page: 1, limit: 20 }),
        findOne: async () => ({ ok: true }),
      } as never,
      {
        getEligibleSubscriptions: async () => [{ id: 'sub-1', planId: 'plan-1', planName: 'Starter' }],
      } as never,
      {
        determineNextStep: () => 'NONE',
      } as never,
      {
        validateForActivation: () => null,
      } as never,
      {
        recordActivationFailure: () => undefined,
        recordActivationSuccess: () => undefined,
      } as never,
      {
        promoCode: {
          findUnique: async () => ({
            id: 'promo-1',
            code: 'SUMMER2024',
            codeNormalized: 'SUMMER2024',
            availability: 'ALL',
            rewardType: 'SUBSCRIPTION',
            rewardValue: 30,
            maxActivations: 10,
            expiresAt: null,
          }),
        },
        user: { findUnique: async () => ({ id: 'user-1' }) },
        subscription: {
          findMany: async () => [
            {
              id: 'sub-1',
              userId: 'user-1',
              status: 'ACTIVE',
              planSnapshot: { id: 'plan-1', name: 'Starter' },
              trafficLimit: null,
              deviceLimit: null,
              expiresAt: null,
            },
          ],
        },
        $transaction: async <T>(callback: (tx: any) => Promise<T>) =>
          callback({
            promoCodeActivation: {
              create: async () => ({ id: 'activation-1' }),
            },
            subscription: {
              update: async () => undefined,
            },
            user: {
              update: async () => undefined,
            },
          }),
        promoCodeActivation: {
          count: async () => 0,
          findUnique: async () => null,
          create: async () => ({ id: 'activation-1' }),
        },
      } as never,
      {
        log: async () => undefined,
      } as never,
    );

    const result = await controller.activate(
      { code: 'summer2024', userId: 'user-1', targetSubscriptionId: 'sub-1' } as never,
      createAuthenticatedRequest(UserRole.ADMIN) as never,
    );

    assert.equal(result.success, true);

    const actualKeys = Object.keys(result).sort();
    const expectedKeys = [
      'availableSubscriptions',
      'code',
      'errorCode',
      'message',
      'nextStep',
      'reward',
      'success',
    ].sort();

    assert.deepStrictEqual(actualKeys, expectedKeys);
  });
});
