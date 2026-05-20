import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GovernanceService } from '../src/modules/governance/governance.service';
import { UserRole } from '@prisma/client';

describe('GovernanceService', () => {
  it('returns a read-only mutation governance catalog', () => {
    const result = new GovernanceService({} as never).getMutationPolicy();
    assert.equal(result.items.some((item) => item.code === 'USER_BLOCK_UNBLOCK' && item.status === 'SHIPPED'), true);
    assert.equal(result.items.some((item) => item.code === 'BROADCAST_SEND' && item.status === 'SHIPPED'), true);
    assert.equal(result.items.every((item) => item.requiresAuditLog), true);
    assert.equal(result.totals.highRisk > 0, true);
  });

  it('returns a read-only RBAC capability matrix', () => {
    const result = new GovernanceService({} as never).getRbacCapabilityMatrix();
    assert.equal(result.mutationEnabled, false);
    assert.equal(result.roles.some((role) => role.role === 'DEV' && role.capabilities.every((capability) => capability.allowed)), true);
    assert.equal(result.roles.some((role) => role.role === 'USER' && role.capabilities.some((capability) => capability.code === 'PAYMENT_REFUND_EXECUTE' && !capability.allowed)), true);
  });

  it('executes safe role-change requests and writes audit', async () => {
    const calls: unknown[] = [];
    const service = new GovernanceService({
      $transaction: async (callback: (transactionClient: unknown) => Promise<unknown>) => {
        calls.push(['transaction.begin']);
        const result = await callback({
          adminRoleChangeRequest: { update: async (input: unknown) => calls.push(['tx.request.update', input]) },
          adminUser: {
            update: async (input: unknown) => {
              calls.push(['tx.admin.update', input]);
              return { id: 'admin-2', role: UserRole.ADMIN };
            },
          },
          adminAuditLog: { create: async (input: unknown) => calls.push(['tx.audit.create', input]) },
        });
        calls.push(['transaction.commit']);
        return result;
      },
      adminRoleChangeRequest: {
        findUnique: async () => ({ id: 'request-1', targetAdminId: 'admin-2', fromRole: UserRole.USER, toRole: UserRole.ADMIN, reason: 'promotion', idempotencyKey: null, status: 'PLANNED', executionEnabled: false, createdAt: new Date('2026-04-24T12:00:00.000Z') }),
        update: async () => { throw new Error('root role request update must not be used for execution writes'); },
      },
      adminUser: {
        findUnique: async () => ({ id: 'admin-2', role: UserRole.USER }),
        count: async () => 2,
        update: async () => { throw new Error('root admin update must not be used for role execution writes'); },
      },
      adminAuditLog: { create: async () => { throw new Error('root audit create must not be used for role execution writes'); } },
    } as never);

    const result = await service.executeRoleChangeRequest('request-1', 'admin-1');

    assert.equal(result.status, 'EXECUTED');
    assert.equal(result.previousRole, UserRole.USER);
    assert.equal(result.newRole, UserRole.ADMIN);
    assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ['transaction.begin', 'tx.admin.update', 'tx.request.update', 'tx.audit.create', 'transaction.commit']);
  });

  it('creates role-change requests and audit in one transaction', async () => {
    const calls: unknown[] = [];
    const service = new GovernanceService({
      $transaction: async (callback: (transactionClient: unknown) => Promise<unknown>) => callback({
        adminRoleChangeRequest: {
          create: async (input: unknown) => {
            calls.push(['tx.request.create', input]);
            return { id: 'request-1', targetAdminId: 'admin-2', fromRole: UserRole.USER, toRole: UserRole.ADMIN, status: 'PLANNED', executionEnabled: false, idempotencyKey: 'role-key', createdAt: new Date('2026-04-24T12:00:00.000Z') };
          },
        },
        adminAuditLog: { create: async (input: unknown) => calls.push(['tx.audit.create', input]) },
      }),
      adminUser: { findUnique: async () => ({ id: 'admin-2', role: UserRole.USER }) },
      adminRoleChangeRequest: { create: async () => { throw new Error('root role request create must not be used'); } },
      adminAuditLog: { create: async () => { throw new Error('root audit create must not be used'); } },
    } as never);

    const result = await service.createRoleChangeRequest({ adminUserId: 'admin-1', dto: { targetAdminId: 'admin-2', toRole: UserRole.ADMIN, reason: ' promote ', idempotencyKey: 'role-key' } });

    assert.equal(result.id, 'request-1');
    assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ['tx.request.create', 'tx.audit.create']);
  });

  it('blocks only-DEV demotion requests', async () => {
    const service = new GovernanceService({
      adminRoleChangeRequest: {
        findUnique: async () => ({ id: 'request-1', targetAdminId: 'admin-1', fromRole: UserRole.DEV, toRole: UserRole.ADMIN, reason: 'demotion', idempotencyKey: null, status: 'PLANNED', executionEnabled: false, createdAt: new Date('2026-04-24T12:00:00.000Z') }),
      },
      adminUser: {
        findUnique: async () => ({ id: 'admin-1', role: UserRole.DEV }),
        count: async () => 1,
      },
    } as never);

    const result = await service.executeRoleChangeRequest('request-1', 'admin-2');

    assert.equal(result.status, 'BLOCKED');
  });

  it('executes safe active-state requests and writes audit', async () => {
    const calls: unknown[] = [];
    const service = new GovernanceService({
      $transaction: async (callback: (transactionClient: unknown) => Promise<unknown>) => callback({
        adminActiveStateRequest: { update: async (input: unknown) => calls.push(['tx.request.update', input]) },
        adminUser: {
          findUnique: async () => ({ isActive: true }),
          update: async (input: unknown) => {
            calls.push(['tx.admin.update', input]);
            return { id: 'admin-2', isActive: false };
          },
        },
        adminAuditLog: { create: async (input: unknown) => calls.push(['tx.audit.create', input]) },
      }),
      adminActiveStateRequest: {
        findUnique: async () => ({ id: 'active-request-1', targetAdminId: 'admin-2', desiredActiveState: false, reason: 'offboard', idempotencyKey: null, status: 'PLANNED', executionEnabled: false, createdAt: new Date('2026-04-24T12:00:00.000Z') }),
        update: async () => { throw new Error('root active request update must not be used for execution writes'); },
      },
      adminUser: {
        findUnique: async () => ({ id: 'admin-2', role: UserRole.USER, isActive: true, login: 'support', email: null, name: null, lastLoginAt: null, createdAt: new Date('2026-04-24T12:00:00.000Z') }),
        count: async () => 2,
        update: async () => { throw new Error('root admin update must not be used for active execution writes'); },
      },
      adminAuditLog: { create: async () => { throw new Error('root audit create must not be used for active execution writes'); } },
    } as never);

    const result = await service.executeActiveStateRequest('active-request-1', 'admin-1');

    assert.equal(result.status, 'EXECUTED');
    assert.equal(result.previousActiveState, true);
    assert.equal(result.newActiveState, false);
    assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ['tx.admin.update', 'tx.request.update', 'tx.audit.create']);
  });

  it('creates active-state requests and audit in one transaction', async () => {
    const calls: unknown[] = [];
    const service = new GovernanceService({
      $transaction: async (callback: (transactionClient: unknown) => Promise<unknown>) => callback({
        adminActiveStateRequest: {
          create: async (input: unknown) => {
            calls.push(['tx.request.create', input]);
            return { id: 'active-request-1', targetAdminId: 'admin-2', desiredActiveState: false, status: 'PLANNED', executionEnabled: false, idempotencyKey: 'active-key', createdAt: new Date('2026-04-24T12:00:00.000Z') };
          },
        },
        adminAuditLog: { create: async (input: unknown) => calls.push(['tx.audit.create', input]) },
      }),
      adminUser: { findUnique: async () => ({ id: 'admin-2' }) },
      adminActiveStateRequest: { create: async () => { throw new Error('root active request create must not be used'); } },
      adminAuditLog: { create: async () => { throw new Error('root audit create must not be used'); } },
    } as never);

    const result = await service.createActiveStateRequest({ adminUserId: 'admin-1', dto: { targetAdminId: 'admin-2', desiredActiveState: false, reason: 'offboard', idempotencyKey: 'active-key' } });

    assert.equal(result.id, 'active-request-1');
    assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ['tx.request.create', 'tx.audit.create']);
  });

  it('blocks self-disable active-state requests', async () => {
    const service = new GovernanceService({
      adminActiveStateRequest: {
        findUnique: async () => ({ id: 'active-request-1', targetAdminId: 'admin-1', desiredActiveState: false, reason: 'self-disable', idempotencyKey: null, status: 'PLANNED', executionEnabled: false, createdAt: new Date('2026-04-24T12:00:00.000Z') }),
      },
      adminUser: {
        findUnique: async () => ({ id: 'admin-1', role: UserRole.ADMIN, isActive: true, login: 'admin', email: null, name: null, lastLoginAt: null, createdAt: new Date('2026-04-24T12:00:00.000Z') }),
        count: async () => 2,
      },
    } as never);

    const result = await service.executeActiveStateRequest('active-request-1', 'admin-1');

    assert.equal(result.status, 'BLOCKED');
  });

  it('executes token revoke requests and writes audit', async () => {
    const calls: unknown[] = [];
    const service = new GovernanceService({
      $transaction: async (callback: (transactionClient: unknown) => Promise<unknown>) => callback({
        adminApiToken: { update: async (input: unknown) => calls.push(['tx.token.update', input]) },
        adminAuditLog: { create: async (input: unknown) => calls.push(['tx.audit.create', input]) },
      }),
      adminAuditLog: {
        findMany: async () => [{
          id: 'token-request-1',
          metadata: { adminId: 'admin-2', tokenId: 'token-1', reasonProvided: true },
          createdAt: new Date('2026-04-24T12:00:00.000Z'),
        }],
        create: async () => { throw new Error('root audit create must not be used for token execution writes'); },
      },
      adminApiToken: {
        findFirst: async () => ({ id: 'token-1', createdByAdminUserId: 'admin-2', revokedAt: null }),
        update: async () => { throw new Error('root token update must not be used for token execution writes'); },
      },
    } as never);

    const result = await service.executeTokenRevokeRequest('admin-2', 'token-request-1', 'admin-1');

    assert.equal(result.status, 'EXECUTED');
    assert.equal(result.tokenId, 'token-1');
    assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ['tx.token.update', 'tx.audit.create']);
  });
});
