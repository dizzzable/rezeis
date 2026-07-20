import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Locale, UserRole } from '@prisma/client';
import request from 'supertest';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { AdminUserListQueryDto } from '../src/modules/users/dto/admin-user-list-query.dto';
import { AdminUserSearchQueryDto } from '../src/modules/users/dto/admin-user-search-query.dto';
import { AdminUsersController } from '../src/modules/users/controllers/admin-users.controller';
import { AdminUsersService } from '../src/modules/users/services/admin-users.service';
import { RegistrationExportService } from '../src/modules/users/services/registration-export.service';

describe('AdminUsersController HTTP contract', () => {
  let application: INestApplication;
  const listCalls: Array<{ readonly query: AdminUserListQueryDto }> = [];
  const searchCalls: Array<{ readonly query: AdminUserSearchQueryDto }> = [];
  const exportCalls: Array<Record<string, unknown>> = [];
  const auditCalls: Array<Record<string, unknown>> = [];

  before(async () => {
    const testingModule: TestingModule = await Test.createTestingModule({
      controllers: [AdminUsersController],
      providers: [
        {
          provide: AdminUsersService,
          useValue: {
            listUsers: async (query: AdminUserListQueryDto) => {
              listCalls.push({ query });
              return buildListResult();
            },
            searchUser: async (query: AdminUserSearchQueryDto) => {
              searchCalls.push({ query });
              return buildSearchResult();
            },
          } satisfies Pick<AdminUsersService, 'listUsers' | 'searchUser'>,
        },
        {
          provide: RegistrationExportService,
          useValue: {
            exportCsv: async (query: Record<string, unknown>) => {
              exportCalls.push(query);
              return {
                csv: '\ufeffuser_id\r\nu1',
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
              create: async (args: { data: Record<string, unknown> }) => {
                auditCalls.push(args.data);
                return args.data;
              },
            },
          },
        },
      ],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }): boolean => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: 'admin-1', role: 'DEV', rbacRoleId: null };
          return true;
        },
      })
      .overrideGuard(RbacGuard)
      .useValue({ canActivate: (): boolean => true })
      .compile();

    application = testingModule.createNestApplication();
    application.setGlobalPrefix('api');
    application.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await application.init();
  });

  after(async () => {
    await application.close();
  });

  it('returns the current paginated users list and transforms paging params', async () => {
    listCalls.length = 0;

    const response = await request(application.getHttpServer())
      .get('/api/admin/users')
      .query({ search: ' user ', limit: '25', offset: '5' })
      .expect(200);

    assert.equal(listCalls.length, 1);
    assert.equal(listCalls[0]?.query instanceof AdminUserListQueryDto, true);
    assert.equal(listCalls[0]?.query.search, ' user ');
    assert.equal(listCalls[0]?.query.limit, 25);
    assert.equal(listCalls[0]?.query.offset, 5);
    assert.deepStrictEqual(response.body, buildListResult());
  });

  it('rejects invalid list pagination before reaching the service', async () => {
    listCalls.length = 0;

    const response = await request(application.getHttpServer())
      .get('/api/admin/users')
      .query({ limit: '250', offset: '-1' })
      .expect(400);

    assert.equal(listCalls.length, 0);
    assert.equal(Array.isArray(response.body.message), true);
    assert.equal(response.body.message.some((message: string) => message.includes('limit')), true);
    assert.equal(response.body.message.some((message: string) => message.includes('offset')), true);
  });

  it('accepts trimmed email and login search identifiers', async () => {
    searchCalls.length = 0;

    const emailResponse = await request(application.getHttpServer())
      .get('/api/admin/users/search')
      .query({ email: '  user@example.com  ' })
      .expect(200);
    const loginResponse = await request(application.getHttpServer())
      .get('/api/admin/users/search')
      .query({ login: '  User_Login  ' })
      .expect(200);

    assert.equal(searchCalls.length, 2);
    assert.equal(searchCalls[0]?.query instanceof AdminUserSearchQueryDto, true);
    assert.equal(searchCalls[0]?.query.email, 'user@example.com');
    assert.equal(searchCalls[1]?.query instanceof AdminUserSearchQueryDto, true);
    assert.equal(searchCalls[1]?.query.login, 'User_Login');
    assert.deepStrictEqual(emailResponse.body, buildSearchResult());
    assert.deepStrictEqual(loginResponse.body, buildSearchResult());
  });

  it('rejects removed referralCode and multi-identifier search queries', async () => {
    searchCalls.length = 0;

    const referralResponse = await request(application.getHttpServer())
      .get('/api/admin/users/search')
      .query({ referralCode: 'ref-code-123' })
      .expect(400);
    const multiIdentifierResponse = await request(application.getHttpServer())
      .get('/api/admin/users/search')
      .query({ email: 'user@example.com', login: 'user_login' })
      .expect(400);

    assert.equal(searchCalls.length, 0);
    assert.equal(referralResponse.body.message.includes('property referralCode should not exist'), true);
    assert.deepStrictEqual(multiIdentifierResponse.body.message, [
      'Exactly one identifier must be provided: userId, telegramId, email, or login',
    ]);
  });

  it('exports registration CSV with audit metadata when permitted', async () => {
    exportCalls.length = 0;
    auditCalls.length = 0;

    const response = await request(application.getHttpServer())
      .get('/api/admin/users/export/registration.csv')
      .query({ limit: '100' })
      .expect(200);

    assert.equal(exportCalls.length, 1);
    assert.equal(exportCalls[0]?.limit, 100);
    assert.equal(response.headers['content-type']?.includes('text/csv'), true);
    assert.equal(response.headers['x-export-row-count'], '1');
    assert.ok(String(response.text).includes('user_id'));
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0]?.action, 'users.registration.export');
  });
});

function buildListResult() {
  return {
    items: [
      {
        id: 'user-1',
        telegramId: '123456789',
        username: 'rezeis-user',
        email: 'user@example.com',
        name: 'Rezeis User',
        role: UserRole.USER,
        language: Locale.EN,
        isBlocked: false,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-16T00:00:00.000Z',
        login: null,
        lastSeenAt: null,
      },
    ],
    total: 1,
  };
}

function buildSearchResult() {
  return {
    session: {
      id: 'user-1',
      telegramId: '123456789',
      username: 'rezeis-user',
      name: 'Rezeis User',
      email: 'user@example.com',
      role: UserRole.USER,
      language: Locale.EN,
      personalDiscount: 0,
      purchaseDiscount: 0,
      points: 0,
      maxSubscriptions: 1,
      isBlocked: false,
      isBotBlocked: false,
      isRulesAccepted: true,
      onboardingCompleted: true,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-16T00:00:00.000Z',
      lastSeenAt: null,
      webAccount: null,
    },
    subscription: null,
  };
}
