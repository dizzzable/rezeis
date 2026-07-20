import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RbacService } from '../src/modules/rbac/services/rbac.service';
import { AdminUsersController } from '../src/modules/users/controllers/admin-users.controller';
import { AdminUsersService } from '../src/modules/users/services/admin-users.service';
import { RegistrationExportService } from '../src/modules/users/services/registration-export.service';

/**
 * S7 elevated export: real RbacService + real RbacGuard paths.
 * - bare ADMIN (no rbacRoleId) must NOT get users:export_registration
 * - HTTP export without grant → 403; with grant (DEV) → 200 + CSV body
 * - deny/pass asserted twice for consistency (plan VP2)
 */
describe('Registration export permission (RbacService + HTTP)', () => {
  describe('RbacService.hasPermission', () => {
    it('bare ADMIN is denied users:export_registration but keeps users:view', async () => {
      // No DB hits for legacy ADMIN path (resolvePermissions is in-memory).
      const prisma = {} as unknown as PrismaService;
      const rbac = new RbacService(prisma);
      const bareAdmin = { id: 'legacy-admin', role: UserRole.ADMIN, rbacRoleId: null };

      const canExport = await rbac.hasPermission(bareAdmin, 'users', 'export_registration');
      const canView = await rbac.hasPermission(bareAdmin, 'users', 'view');
      // Second pass — cache must not flip the elevated deny.
      const canExportAgain = await rbac.hasPermission(bareAdmin, 'users', 'export_registration');

      assert.equal(canView, true);
      assert.equal(canExport, false);
      assert.equal(canExportAgain, false);
    });

    it('DEV and superadmin-named role receive export_registration', async () => {
      const prisma = {
        adminRole: {
          findUnique: async () => ({
            name: 'superadmin',
            permissions: [{ resource: 'users', action: 'export_registration' }],
          }),
        },
      } as unknown as PrismaService;
      const rbac = new RbacService(prisma);

      const devOk = await rbac.hasPermission(
        { id: 'dev-1', role: UserRole.DEV, rbacRoleId: null },
        'users',
        'export_registration',
      );
      const superOk = await rbac.hasPermission(
        { id: 'sa-1', role: UserRole.ADMIN, rbacRoleId: 'role-super' },
        'users',
        'export_registration',
      );

      assert.equal(devOk, true);
      assert.equal(superOk, true);
    });

    it('custom role without export_registration is denied', async () => {
      const prisma = {
        adminRole: {
          findUnique: async () => ({
            name: 'operator',
            permissions: [
              { resource: 'users', action: 'view' },
              { resource: 'users', action: 'view_registration' },
            ],
          }),
        },
      } as unknown as PrismaService;
      const rbac = new RbacService(prisma);
      const operator = { id: 'op-1', role: UserRole.ADMIN, rbacRoleId: 'role-op' };

      assert.equal(await rbac.hasPermission(operator, 'users', 'view'), true);
      assert.equal(await rbac.hasPermission(operator, 'users', 'export_registration'), false);
      assert.equal(await rbac.hasPermission(operator, 'users', 'export_registration'), false);
    });
  });

  describe('HTTP export route with real RbacGuard', () => {
    let application: INestApplication;
    let currentUser: { id: string; role: UserRole; rbacRoleId: string | null };
    const exportCalls: unknown[] = [];
    const auditCalls: unknown[] = [];

    before(async () => {
      currentUser = { id: 'admin-bare', role: UserRole.ADMIN, rbacRoleId: null };

      const testingModule: TestingModule = await Test.createTestingModule({
        controllers: [AdminUsersController],
        providers: [
          {
            provide: AdminUsersService,
            useValue: {
              listUsers: async () => ({ items: [], total: 0 }),
              searchUser: async () => ({ session: null, subscription: null }),
              resolveUser: async () => null,
            },
          },
          {
            provide: RegistrationExportService,
            useValue: {
              exportCsv: async (query: unknown) => {
                exportCalls.push(query);
                return {
                  csv:
                    '\ufeffuser_id,telegram_id,username,created_at,registration_ip,registration_user_agent,registration_referer,registration_utm_json,registration_channel,acquisition_placement_id,acquisition_at\r\n' +
                    'u-seed,1,alice,2026-07-01T00:00:00.000Z,176.119.1.2,Mozilla,https://t.me/ch,"{""source"":""tg""}",web,,',
                  rowCount: 1,
                  limit: 1000,
                  from: null,
                  to: null,
                };
              },
            },
          },
          {
            provide: PrismaService,
            useValue: {
              adminAuditLog: {
                create: async (args: { data: unknown }) => {
                  auditCalls.push(args.data);
                  return args.data;
                },
              },
              // RbacService bare-ADMIN path does not touch prisma; keep stubs
              // for any accidental seed/onModuleInit.
              adminRole: {
                findUnique: async () => null,
                findMany: async () => [],
              },
            },
          },
          RbacService,
          RbacGuard,
        ],
      })
        .overrideGuard(AdminJwtAuthGuard)
        .useValue({
          canActivate: (ctx: {
            switchToHttp: () => { getRequest: () => Record<string, unknown> };
          }): boolean => {
            const req = ctx.switchToHttp().getRequest();
            req.user = { ...currentUser };
            return true;
          },
        })
        // Real RbacGuard — do NOT override.
        .compile();

      application = testingModule.createNestApplication();
      application.setGlobalPrefix('api');
      await application.init();
    });

    after(async () => {
      await application.close();
    });

    it('denies bare ADMIN export twice (403, service never called)', async () => {
      currentUser = { id: 'admin-bare', role: UserRole.ADMIN, rbacRoleId: null };
      exportCalls.length = 0;

      const first = await request(application.getHttpServer())
        .get('/api/admin/users/export/registration.csv')
        .expect(403);
      const second = await request(application.getHttpServer())
        .get('/api/admin/users/export/registration.csv')
        .expect(403);

      assert.match(String(first.body.message ?? first.text), /export_registration|Missing permission/i);
      assert.match(String(second.body.message ?? second.text), /export_registration|Missing permission/i);
      assert.equal(exportCalls.length, 0);
    });

    it('allows DEV export twice with CSV body and registration columns', async () => {
      currentUser = { id: 'dev-1', role: UserRole.DEV, rbacRoleId: null };
      exportCalls.length = 0;
      auditCalls.length = 0;

      const first = await request(application.getHttpServer())
        .get('/api/admin/users/export/registration.csv')
        .query({ limit: '50' })
        .expect(200);
      const second = await request(application.getHttpServer())
        .get('/api/admin/users/export/registration.csv')
        .query({ limit: '50' })
        .expect(200);

      for (const res of [first, second]) {
        assert.ok(String(res.headers['content-type'] ?? '').includes('text/csv'));
        assert.equal(res.headers['x-export-row-count'], '1');
        const body = String(res.text);
        assert.ok(body.includes('registration_ip'));
        assert.ok(body.includes('176.119.1.2'));
        assert.ok(body.includes('registration_utm_json'));
      }
      assert.equal(exportCalls.length, 2);
      assert.equal(auditCalls.length, 2);
    });
  });
});
