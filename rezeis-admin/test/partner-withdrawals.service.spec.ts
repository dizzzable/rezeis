import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';

import { PartnerWithdrawalsService } from '../src/modules/partners/services/partner-withdrawals.service';

describe('PartnerWithdrawalsService', () => {
  it('creates a pending partner withdrawal request', async () => {
    const createCalls: unknown[] = [];
    const service = new PartnerWithdrawalsService({
      partner: {
        findUnique: async () => ({ id: 'partner-1', balance: 1000, isActive: true }),
        updateMany: async (args: unknown) => args && { count: 1 },
      },
      settings: {
        findFirst: async () => ({ partnerSettings: { withdrawals: { enabled: true, minimumAmount: 100, supportedMethods: ['USDT'] } } }),
      },
      partnerWithdrawal: {
        create: async (args: { data: Record<string, unknown> }) => {
          createCalls.push(args.data);
          return {
            id: 'withdrawal-1',
            partnerId: 'partner-1',
            amount: 300,
            requestedAmount: { toString: () => '300' },
            requestedCurrency: 'USDT',
            quoteRate: { toString: () => '1' },
            quoteSource: 'MANUAL_BASELINE',
            status: 'PENDING',
            method: 'USDT',
            requisites: 'wallet',
            adminComment: null,
            processedBy: null,
            createdAt: new Date('2026-04-20T00:00:00.000Z'),
            updatedAt: new Date('2026-04-20T00:00:00.000Z'),
          };
        },
      },
      $transaction: async (callback: (tx: unknown) => unknown) => callback({
        partner: { updateMany: async () => ({ count: 1 }) },
        partnerWithdrawal: {
          create: async (args: { data: Record<string, unknown> }) => {
            createCalls.push(args.data);
            return {
              id: 'withdrawal-1', partnerId: 'partner-1', amount: 300, requestedAmount: { toString: () => '300' }, requestedCurrency: 'USDT', quoteRate: { toString: () => '1' }, quoteSource: 'MANUAL_BASELINE', status: 'PENDING', method: 'USDT', requisites: 'wallet', adminComment: null, processedBy: null, createdAt: new Date('2026-04-20T00:00:00.000Z'), updatedAt: new Date('2026-04-20T00:00:00.000Z'),
            };
          },
        },
        adminAuditLog: { create: async () => undefined },
      }),
    } as never);

    const result = await service.createWithdrawal({
      userId: 'user-1',
      requestedAmount: 300,
      requestedCurrency: 'USDT',
      method: 'USDT',
      requisites: 'wallet',
    });

    assert.equal(result.status, 'PENDING');
    assert.equal(createCalls.length, 1);
  });

  it('updates withdrawal status during approval', async () => {
    const updateCalls: unknown[] = [];
    const service = new PartnerWithdrawalsService({
      partnerWithdrawal: {
        findUnique: async () => ({ id: 'withdrawal-1', status: 'PENDING' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateCalls.push(args.data);
          return {
            id: 'withdrawal-1',
            partnerId: 'partner-1',
            amount: 300,
            requestedAmount: { toString: () => '300' },
            requestedCurrency: 'USDT',
            quoteRate: { toString: () => '1' },
            quoteSource: 'MANUAL_BASELINE',
            status: 'PROCESSING',
            method: 'USDT',
            requisites: 'wallet',
            adminComment: 'ok',
            processedBy: 'admin-1',
            createdAt: new Date('2026-04-20T00:00:00.000Z'),
            updatedAt: new Date('2026-04-20T00:00:00.000Z'),
          };
        },
      },
      partner: { update: async () => undefined },
      $transaction: async (callback: (tx: unknown) => unknown) => callback({
        partnerWithdrawal: {
          update: async (args: { data: Record<string, unknown> }) => {
            updateCalls.push(args.data);
            return { id: 'withdrawal-1', partnerId: 'partner-1', amount: 300, requestedAmount: { toString: () => '300' }, requestedCurrency: 'USDT', quoteRate: { toString: () => '1' }, quoteSource: 'MANUAL_BASELINE', status: 'PROCESSING', method: 'USDT', requisites: 'wallet', adminComment: 'ok', processedBy: 'admin-1', createdAt: new Date('2026-04-20T00:00:00.000Z'), updatedAt: new Date('2026-04-20T00:00:00.000Z') };
          },
        },
        partner: { update: async () => undefined },
        adminAuditLog: { create: async () => undefined },
      }),
    } as never);

    const result = await service.approveWithdrawal({
      withdrawalId: 'withdrawal-1',
      processedBy: 'admin-1',
      adminComment: 'ok',
    });

    assert.equal(result.status, 'PROCESSING');
    assert.equal(updateCalls.length, 1);
  });

  it('allows rejecting a pending withdrawal', async () => {
    const updateCalls: unknown[] = [];
    const service = new PartnerWithdrawalsService({
      partnerWithdrawal: {
        findUnique: async () => ({ id: 'withdrawal-1', status: 'PENDING' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateCalls.push(args.data);
          return {
            id: 'withdrawal-1',
            partnerId: 'partner-1',
            amount: 300,
            requestedAmount: { toString: () => '300' },
            requestedCurrency: 'USDT',
            quoteRate: { toString: () => '1' },
            quoteSource: 'MANUAL_BASELINE',
            status: 'REJECTED',
            method: 'USDT',
            requisites: 'wallet',
            adminComment: 'nope',
            processedBy: 'admin-1',
            createdAt: new Date('2026-04-20T00:00:00.000Z'),
            updatedAt: new Date('2026-04-20T00:00:00.000Z'),
          };
        },
      },
      partner: { update: async () => undefined },
      $transaction: async (callback: (tx: unknown) => unknown) => callback({
        partnerWithdrawal: { update: async (args: { data: Record<string, unknown> }) => { updateCalls.push(args.data); return { id: 'withdrawal-1', partnerId: 'partner-1', amount: 300, requestedAmount: { toString: () => '300' }, requestedCurrency: 'USDT', quoteRate: { toString: () => '1' }, quoteSource: 'MANUAL_BASELINE', status: 'REJECTED', method: 'USDT', requisites: 'wallet', adminComment: 'nope', processedBy: 'admin-1', createdAt: new Date('2026-04-20T00:00:00.000Z'), updatedAt: new Date('2026-04-20T00:00:00.000Z') }; } },
        partner: { update: async () => undefined },
        adminAuditLog: { create: async () => undefined },
      }),
    } as never);

    const result = await service.rejectWithdrawal({
      withdrawalId: 'withdrawal-1',
      processedBy: 'admin-1',
      adminComment: 'nope',
    });

    assert.equal(result.status, 'REJECTED');
    assert.equal(updateCalls.length, 1);
  });

  it('allows completing a processing withdrawal', async () => {
    const updateCalls: unknown[] = [];
    const service = new PartnerWithdrawalsService({
      partnerWithdrawal: {
        findUnique: async () => ({ id: 'withdrawal-1', status: 'PROCESSING' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateCalls.push(args.data);
          return {
            id: 'withdrawal-1',
            partnerId: 'partner-1',
            amount: 300,
            requestedAmount: { toString: () => '300' },
            requestedCurrency: 'USDT',
            quoteRate: { toString: () => '1' },
            quoteSource: 'MANUAL_BASELINE',
            status: 'COMPLETED',
            method: 'USDT',
            requisites: 'wallet',
            adminComment: 'paid',
            processedBy: 'admin-1',
            createdAt: new Date('2026-04-20T00:00:00.000Z'),
            updatedAt: new Date('2026-04-20T00:00:00.000Z'),
          };
        },
      },
      partner: { update: async () => undefined },
      $transaction: async (callback: (tx: unknown) => unknown) => callback({
        partnerWithdrawal: { update: async (args: { data: Record<string, unknown> }) => { updateCalls.push(args.data); return { id: 'withdrawal-1', partnerId: 'partner-1', amount: 300, requestedAmount: { toString: () => '300' }, requestedCurrency: 'USDT', quoteRate: { toString: () => '1' }, quoteSource: 'MANUAL_BASELINE', status: 'COMPLETED', method: 'USDT', requisites: 'wallet', adminComment: 'paid', processedBy: 'admin-1', createdAt: new Date('2026-04-20T00:00:00.000Z'), updatedAt: new Date('2026-04-20T00:00:00.000Z') }; } },
        partner: { update: async () => undefined },
        adminAuditLog: { create: async () => undefined },
      }),
    } as never);

    const result = await service.completeWithdrawal({
      withdrawalId: 'withdrawal-1',
      processedBy: 'admin-1',
      adminComment: 'paid',
    });

    assert.equal(result.status, 'COMPLETED');
    assert.equal(updateCalls.length, 1);
  });

  it('rejects invalid withdrawal status transitions with a bad request', async () => {
    const service = new PartnerWithdrawalsService({
      partnerWithdrawal: {
        findUnique: async () => ({ id: 'withdrawal-1', status: 'COMPLETED' }),
        update: async () => {
          throw new Error('update should not be called');
        },
      },
    } as never);

    await assert.rejects(
      () =>
        service.rejectWithdrawal({
          withdrawalId: 'withdrawal-1',
          processedBy: 'admin-1',
          adminComment: 'too late',
        }),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        assert.equal(error.message, 'Partner withdrawal status transition is not allowed');
        return true;
      },
    );
  });

  it('projects bounded withdrawal audit events without raw metadata', async () => {
    const service = new PartnerWithdrawalsService({
      partner: { findUnique: async () => ({ id: 'partner-1' }) },
      adminAuditLog: {
        findMany: async () => [
          {
            action: 'CREATE_PARTNER_WITHDRAWAL_REQUEST',
            metadata: { partnerId: 'partner-1', withdrawalId: 'withdrawal-1', balanceReserved: true, rawSecret: 'hidden' },
            createdAt: new Date('2026-04-20T00:00:00.000Z'),
          },
          {
            action: 'UPDATE_PARTNER_WITHDRAWAL_STATUS',
            metadata: { partnerId: 'partner-1', withdrawalId: 'withdrawal-1', balanceRefunded: true, adminComment: 'do not expose' },
            createdAt: new Date('2026-04-21T00:00:00.000Z'),
          },
        ],
      },
    } as never);

    const result = await service.listWithdrawalAuditEvents('user-1');

    assert.equal(result.length, 2);
    assert.deepStrictEqual(result[0], { action: 'CREATE_PARTNER_WITHDRAWAL_REQUEST', withdrawalId: 'withdrawal-1', partnerId: 'partner-1', balanceReserved: true, balanceRefunded: null, createdAt: '2026-04-20T00:00:00.000Z' });
    assert.equal(JSON.stringify(result).includes('hidden'), false);
    assert.equal(JSON.stringify(result).includes('do not expose'), false);
  });
});
