import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PromoCodeAvailability, PromoCodeRewardType, UserRole } from '@prisma/client';

import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../src/modules/auth/interfaces/request-metadata.interface';
import { PromocodeCrudService } from '../src/modules/promocodes/services/promocode-crud.service';

const admin: CurrentAdminInterface = {
  id: 'admin-1',
  login: 'admin',
  email: 'admin@example.com',
  name: 'Admin',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-04-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
};

const metadata: RequestMetadataInterface = {
  requestId: 'request-1',
  remoteAddress: '127.0.0.1',
  userAgent: 'promocode-crud-spec',
};

describe('PromocodeCrudService transaction boundaries', () => {
  it('creates promo code and audit log in one transaction', async () => {
    const events: string[] = [];
    const createdPromoCode = createPromoCodeRecord({ id: 'promo-created', code: 'SPRING25' });
    const service = createService({
      promoCode: {
        findUnique: async () => null,
        create: async () => {
          throw new Error('root promo create must not be used');
        },
      },
      $transaction: async (callback: (tx: any) => Promise<any>) => {
        events.push('transaction.begin');
        const result = await callback({
          promoCode: {
            create: async () => {
              events.push('promo.create');
              return createdPromoCode;
            },
          },
          adminAuditLog: {
            create: async (input: { data: { action: string; metadata: unknown } }) => {
              events.push(`audit.create:${input.data.action}`);
              assert.deepStrictEqual(input.data.metadata, { promoCodeId: 'promo-created', code: 'SPRING25' });
            },
          },
        });
        events.push('transaction.commit');
        return result;
      },
    });

    const result = await service.create({ code: 'SPRING25', rewardType: PromoCodeRewardType.DURATION, rewardValue: 7 }, admin, metadata);

    assert.equal(result.id, 'promo-created');
    assert.deepStrictEqual(events, ['transaction.begin', 'promo.create', 'audit.create:PROMOCODE_CREATE', 'transaction.commit']);
  });

  it('updates promo code and audit log in one transaction', async () => {
    const events: string[] = [];
    const existing = createPromoCodeRecord({ id: 'promo-1', code: 'SPRING25', codeNormalized: 'SPRING25' });
    const updated = createPromoCodeRecord({ id: 'promo-1', code: 'SPRING30', codeNormalized: 'SPRING30', rewardValue: 30 });
    const service = createService({
      promoCode: {
        findUnique: async ({ where }: { where: { id?: string; codeNormalized?: string } }) => (where.id === 'promo-1' ? existing : null),
        update: async () => {
          throw new Error('root promo update must not be used');
        },
      },
      promoCodeActivation: { count: async () => 2 },
      $transaction: async (callback: (tx: any) => Promise<any>) => {
        events.push('transaction.begin');
        const result = await callback({
          promoCode: {
            update: async () => {
              events.push('promo.update');
              return updated;
            },
          },
          adminAuditLog: {
            create: async (input: { data: { action: string; metadata: unknown } }) => {
              events.push(`audit.create:${input.data.action}`);
              assert.deepStrictEqual(input.data.metadata, { promoCodeId: 'promo-1', changes: ['code', 'rewardValue'] });
            },
          },
        });
        events.push('transaction.commit');
        return result;
      },
    });

    const result = await service.update('promo-1', { code: 'SPRING30', rewardValue: 30 }, admin, metadata);

    assert.equal(result.code, 'SPRING30');
    assert.equal(result.activationsCount, 2);
    assert.deepStrictEqual(events, ['transaction.begin', 'promo.update', 'audit.create:PROMOCODE_UPDATE', 'transaction.commit']);
  });

  it('deletes promo code and audit log in one transaction', async () => {
    const events: string[] = [];
    const existing = createPromoCodeRecord({ id: 'promo-1', code: 'SPRING25' });
    const service = createService({
      promoCode: {
        findUnique: async () => existing,
        delete: async () => {
          throw new Error('root promo delete must not be used');
        },
      },
      $transaction: async (callback: (tx: any) => Promise<any>) => {
        events.push('transaction.begin');
        await callback({
          promoCode: {
            delete: async () => {
              events.push('promo.delete');
            },
          },
          adminAuditLog: {
            create: async (input: { data: { action: string; metadata: unknown } }) => {
              events.push(`audit.create:${input.data.action}`);
              assert.deepStrictEqual(input.data.metadata, { promoCodeId: 'promo-1', code: 'SPRING25' });
            },
          },
        });
        events.push('transaction.commit');
      },
    });

    await service.delete('promo-1', admin, metadata);

    assert.deepStrictEqual(events, ['transaction.begin', 'promo.delete', 'audit.create:PROMOCODE_DELETE', 'transaction.commit']);
  });

  it('toggles promo code and audit log in one transaction', async () => {
    const events: string[] = [];
    const existing = createPromoCodeRecord({ id: 'promo-1', code: 'SPRING25', isActive: true });
    const toggled = createPromoCodeRecord({ id: 'promo-1', code: 'SPRING25', isActive: false });
    const service = createService({
      promoCode: {
        findUnique: async () => existing,
        update: async () => {
          throw new Error('root promo update must not be used');
        },
      },
      promoCodeActivation: { count: async () => 0 },
      $transaction: async (callback: (tx: any) => Promise<any>) => {
        events.push('transaction.begin');
        const result = await callback({
          promoCode: {
            update: async () => {
              events.push('promo.update');
              return toggled;
            },
          },
          adminAuditLog: {
            create: async (input: { data: { action: string; metadata: unknown } }) => {
              events.push(`audit.create:${input.data.action}`);
              assert.deepStrictEqual(input.data.metadata, { promoCodeId: 'promo-1', code: 'SPRING25', newIsActive: false });
            },
          },
        });
        events.push('transaction.commit');
        return result;
      },
    });

    const result = await service.toggleActive('promo-1', admin, metadata);

    assert.equal(result.isActive, false);
    assert.deepStrictEqual(events, ['transaction.begin', 'promo.update', 'audit.create:PROMOCODE_TOGGLE', 'transaction.commit']);
  });
});

function createService(prismaOverrides: Record<string, unknown>): PromocodeCrudService {
  return new PromocodeCrudService(
    {
      promoCode: {
        findUnique: async () => null,
        create: async () => {
          throw new Error('unexpected root promo create');
        },
        update: async () => {
          throw new Error('unexpected root promo update');
        },
        delete: async () => {
          throw new Error('unexpected root promo delete');
        },
      },
      promoCodeActivation: {
        count: async () => 0,
      },
      adminAuditLog: {
        create: async () => {
          throw new Error('root audit create must not be used');
        },
      },
      $transaction: async () => {
        throw new Error('transaction callback must be provided by test');
      },
      ...prismaOverrides,
    } as never,
    {
      log: async () => {
        throw new Error('AdminAuditLogService.log must not be used for transaction-bound writes');
      },
    } as never,
  );
}

function createPromoCodeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'promo-1',
    code: 'SPRING25',
    codeNormalized: 'SPRING25',
    isActive: true,
    availability: PromoCodeAvailability.ALL,
    rewardType: PromoCodeRewardType.DURATION,
    rewardValue: 7,
    planSnapshot: null,
    maxActivations: null,
    allowedUserIds: [],
    allowedPlanIds: [],
    expiresAt: null,
    createdAt: new Date('2026-04-20T00:00:00.000Z'),
    updatedAt: new Date('2026-04-20T00:00:00.000Z'),
    ...overrides,
  };
}
