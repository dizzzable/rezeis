import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Locale, UserRole } from '@prisma/client';
import request from 'supertest';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminUsersController } from '../src/modules/users/controllers/admin-users.controller';
import { AdminUserSearchQueryDto } from '../src/modules/users/dto/admin-user-search-query.dto';
import { AdminUserSearchResultInterface } from '../src/modules/users/interfaces/admin-user-search-result.interface';
import { AdminUsersService } from '../src/modules/users/services/admin-users.service';

interface SearchCallRecord {
  readonly query: AdminUserSearchQueryDto;
}

function buildSearchResult(): AdminUserSearchResultInterface {
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
      purchaseDiscount: 5,
      points: 42,
      maxSubscriptions: 3,
      isBlocked: false,
      isBotBlocked: false,
      isRulesAccepted: true,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-16T00:00:00.000Z',
      webAccount: {
        id: 'web-account-1',
        login: 'user-login',
        loginNormalized: 'user-login',
        email: 'user@example.com',
        emailNormalized: 'user@example.com',
        emailVerifiedAt: '2026-04-01T01:00:00.000Z',
        requiresPasswordChange: false,
        linkPromptSnoozeUntil: null,
        credentialsBootstrappedAt: '2026-04-01T01:00:00.000Z',
        createdAt: '2026-04-01T00:30:00.000Z',
        updatedAt: '2026-04-16T00:00:00.000Z',
      },
    },
    subscription: null,
  };
}

describe('GET /api/admin/users/search', () => {
  let testingModule: TestingModule;
  let application: INestApplication;
  let searchCalls: SearchCallRecord[];

  before(async () => {
    searchCalls = [];
    testingModule = await Test.createTestingModule({
      controllers: [AdminUsersController],
      providers: [
        {
          provide: AdminUsersService,
          useValue: {
            searchUser: async (query: AdminUserSearchQueryDto): Promise<AdminUserSearchResultInterface> => {
              searchCalls.push({ query });
              return buildSearchResult();
            },
          } satisfies Pick<AdminUsersService, 'searchUser'>,
        },
      ],
    })
      .overrideGuard(AdminJwtAuthGuard)
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

  it('accepts trimmed email input and passes normalized DTO data to the route service', async () => {
    searchCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/search')
      .query({ email: '  user@example.com  ' })
      .expect(200);
    assert.equal(searchCalls.length, 1);
    assert.equal(searchCalls[0]?.query instanceof AdminUserSearchQueryDto, true);
    assert.deepStrictEqual(searchCalls[0]?.query, { email: 'user@example.com' });
    assert.deepStrictEqual(response.body, buildSearchResult());
  });

  it('accepts trimmed login input and passes sanitized DTO data to the route service', async () => {
    searchCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/search')
      .query({ login: '  User_Login  ' })
      .expect(200);
    assert.equal(searchCalls.length, 1);
    assert.equal(searchCalls[0]?.query instanceof AdminUserSearchQueryDto, true);
    assert.deepStrictEqual(searchCalls[0]?.query, { login: 'User_Login' });
    assert.deepStrictEqual(response.body, buildSearchResult());
  });

  it('rejects multi-identifier queries at the validation layer', async () => {
    searchCalls.length = 0;
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/search')
      .query({ email: 'user@example.com', login: 'user_login' })
      .expect(400);
    assert.equal(searchCalls.length, 0);
    assert.deepStrictEqual(response.body.message, [
      'Exactly one identifier must be provided: userId, telegramId, email, or login',
    ]);
  });
});
