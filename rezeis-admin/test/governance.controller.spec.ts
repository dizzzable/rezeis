import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GovernanceController } from '../src/modules/governance/governance.controller';
import { GovernanceService } from '../src/modules/governance/governance.service';

describe('GovernanceController', () => {
  it('delegates role-change execution with admin context', async () => {
    const calls: unknown[] = [];
    const controller = new GovernanceController({
      executeRoleChangeRequest: async (requestId: string, adminUserId: string) => {
        calls.push([requestId, adminUserId]);
        return { requestId, targetAdminId: 'admin-2', status: 'EXECUTED', previousRole: 'USER', newRole: 'ADMIN', checkedAt: '2026-04-24T12:00:00.000Z' };
      },
    } as unknown as GovernanceService);

    const result = await controller.executeRoleChangeRequest({ id: 'admin-1' } as Parameters<GovernanceController['executeRoleChangeRequest']>[0], 'request-1');

    assert.deepStrictEqual(calls, [['request-1', 'admin-1']]);
    assert.equal(result.data.status, 'EXECUTED');
  });

  it('delegates active-state execution with admin context', async () => {
    const calls: unknown[] = [];
    const controller = new GovernanceController({
      executeActiveStateRequest: async (requestId: string, adminUserId: string) => {
        calls.push([requestId, adminUserId]);
        return { requestId, targetAdminId: 'admin-2', status: 'EXECUTED', previousActiveState: true, newActiveState: false, checkedAt: '2026-04-24T12:00:00.000Z' };
      },
    } as unknown as GovernanceService);

    const result = await controller.executeActiveStateRequest({ id: 'admin-1' } as Parameters<GovernanceController['executeActiveStateRequest']>[0], 'active-request-1');

    assert.deepStrictEqual(calls, [['active-request-1', 'admin-1']]);
    assert.equal(result.data.status, 'EXECUTED');
  });

  it('delegates token revoke execution with admin context', async () => {
    const calls: unknown[] = [];
    const controller = new GovernanceController({
      executeTokenRevokeRequest: async (adminId: string, requestId: string, adminUserId: string) => {
        calls.push([adminId, requestId, adminUserId]);
        return { requestId, tokenId: 'token-1', status: 'EXECUTED', revokedAt: '2026-04-24T12:00:00.000Z', checkedAt: '2026-04-24T12:00:00.000Z' };
      },
    } as unknown as GovernanceService);

    const result = await controller.executeTokenRevokeRequest({ id: 'admin-1' } as Parameters<GovernanceController['executeTokenRevokeRequest']>[0], 'admin-2', 'token-request-1');

    assert.deepStrictEqual(calls, [['admin-2', 'token-request-1', 'admin-1']]);
    assert.equal(result.data.status, 'EXECUTED');
  });
});
