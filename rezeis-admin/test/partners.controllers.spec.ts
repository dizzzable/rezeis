import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { AdminPartnersController } from '../src/modules/partners/controllers/admin-partners.controller';
import { InternalPartnersController } from '../src/modules/partners/controllers/internal-partners.controller';

describe('partners controllers', () => {
  it('exposes admin and internal partner summary routes behind existing guards', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPartnersController), 'admin/partners');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminPartnersController), [AdminJwtAuthGuard]);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPartnersController.prototype.getSummary), 'summary');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminPartnersController.prototype.getSummary), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPartnersController.prototype.listEarnings), 'earnings');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminPartnersController.prototype.listEarnings), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPartnersController.prototype.listWithdrawals), 'withdrawals');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminPartnersController.prototype.listWithdrawals), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPartnersController.prototype.createWithdrawal), 'withdrawals');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminPartnersController.prototype.createWithdrawal), RequestMethod.POST);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPartnersController.prototype.approveWithdrawal), 'withdrawals/:withdrawalId/approve');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminPartnersController.prototype.approveWithdrawal), RequestMethod.POST);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPartnersController.prototype.rejectWithdrawal), 'withdrawals/:withdrawalId/reject');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminPartnersController.prototype.rejectWithdrawal), RequestMethod.POST);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPartnersController.prototype.completeWithdrawal), 'withdrawals/:withdrawalId/complete');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminPartnersController.prototype.completeWithdrawal), RequestMethod.POST);

    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalPartnersController), 'internal/partners');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, InternalPartnersController), [InternalAdminAuthGuard]);
  });

  it('delegates partner summary and earnings calls unchanged', async () => {
    const calls: unknown[] = [];
    const service = {
      getSummary: async (userId: string) => {
        calls.push(['summary', userId]);
        return { userId, partnerId: 'partner-1' };
      },
      listEarnings: async (userId: string) => {
        calls.push(['earnings', userId]);
        return [{ id: 'earning-1', userId }];
      },
    };
    const withdrawalsService = {
      listWithdrawals: async (userId: string) => {
        calls.push(['withdrawals', userId]);
        return [{ id: 'withdrawal-1', userId }];
      },
      createWithdrawal: async (input: unknown) => {
        calls.push(['createWithdrawal', input]);
        return { id: 'withdrawal-2', status: 'PENDING' };
      },
      approveWithdrawal: async (input: unknown) => {
        calls.push(['approveWithdrawal', input]);
        return { id: 'withdrawal-1', status: 'PROCESSING' };
      },
      rejectWithdrawal: async (input: unknown) => {
        calls.push(['rejectWithdrawal', input]);
        return { id: 'withdrawal-1', status: 'REJECTED' };
      },
      completeWithdrawal: async (input: unknown) => {
        calls.push(['completeWithdrawal', input]);
        return { id: 'withdrawal-1', status: 'COMPLETED' };
      },
    };

    const adminController = new AdminPartnersController(service as never, withdrawalsService as never);
    assert.deepStrictEqual(await adminController.getSummary({ userId: 'user-1' } as never), { userId: 'user-1', partnerId: 'partner-1' });
    assert.deepStrictEqual(await adminController.listEarnings({ userId: 'user-1' } as never), [{ id: 'earning-1', userId: 'user-1' }]);
    assert.deepStrictEqual(await adminController.listWithdrawals({ userId: 'user-1' } as never), [{ id: 'withdrawal-1', userId: 'user-1' }]);
    assert.deepStrictEqual(await adminController.createWithdrawal({ userId: 'user-1' } as never, { id: 'admin-1' } as never), { id: 'withdrawal-2', status: 'PENDING' });
    assert.deepStrictEqual(
      await adminController.approveWithdrawal('withdrawal-1', { adminComment: 'ok' } as never, { id: 'admin-1' } as never),
      { id: 'withdrawal-1', status: 'PROCESSING' },
    );
    assert.deepStrictEqual(
      await adminController.rejectWithdrawal('withdrawal-2', { adminComment: 'declined' } as never, { id: 'admin-2' } as never),
      { id: 'withdrawal-1', status: 'REJECTED' },
    );
    assert.deepStrictEqual(
      await adminController.completeWithdrawal('withdrawal-3', { adminComment: 'paid' } as never, { id: 'admin-3' } as never),
      { id: 'withdrawal-1', status: 'COMPLETED' },
    );

    const internalController = new InternalPartnersController(service as never, withdrawalsService as never);
    assert.deepStrictEqual(await internalController.getSummary({ userId: 'user-2' } as never), { userId: 'user-2', partnerId: 'partner-1' });

    assert.deepStrictEqual(calls, [
      ['summary', 'user-1'],
      ['earnings', 'user-1'],
      ['withdrawals', 'user-1'],
      ['createWithdrawal', { userId: 'user-1', createdByAdminId: 'admin-1' }],
      ['approveWithdrawal', { withdrawalId: 'withdrawal-1', processedBy: 'admin-1', adminComment: 'ok' }],
      ['rejectWithdrawal', { withdrawalId: 'withdrawal-2', processedBy: 'admin-2', adminComment: 'declined' }],
      ['completeWithdrawal', { withdrawalId: 'withdrawal-3', processedBy: 'admin-3', adminComment: 'paid' }],
      ['summary', 'user-2'],
    ]);
  });
});
