import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Locale, UserRole } from '@prisma/client';
import { USER_EXPORT_COLUMNS } from '../src/modules/users/utils/user-export.catalog';
import request from 'supertest';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RbacService } from '../src/modules/rbac/services/rbac.service';
import { UserExportService } from '../src/modules/users/services/user-export.service';
import { AdminUserListQueryDto } from '../src/modules/users/dto/admin-user-list-query.dto';
import { AdminUserSearchQueryDto } from '../src/modules/users/dto/admin-user-search-query.dto';
import { AdminUsersController } from '../src/modules/users/controllers/admin-users.controller';
import { AdminUsersService } from '../src/modules/users/services/admin-users.service';
import { RegistrationExportService } from '../src/modules/users/services/registration-export.service';

/**
 * Permissions this run's admin does NOT hold, as `resource:action`.
 *
 * Empty by default — every case that does not care keeps the old behaviour of
 * an admin who may do anything.
 */
const deniedPermissions = new Set<string>();

describe('AdminUsersController HTTP contract', () => {
  let application: INestApplication;
  const listCalls: Array<{ readonly query: AdminUserListQueryDto }> = [];
  const searchCalls: Array<{ readonly query: AdminUserSearchQueryDto }> = [];
  const exportCalls: Array<Record<string, unknown>> = [];
  const auditCalls: Array<Record<string, unknown>> = [];
  const userExportCalls: Array<Record<string, unknown>> = [];

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
          // The full user export's collaborators. Stubbed rather than omitted:
          // Nest injects by position, so a missing provider does not fail to
          // resolve — it shifts every later one, and the controller's FIRST
          // dependency comes back undefined. That is what these specs saw as
          // "Cannot read properties of undefined (reading 'listUsers')".
          //
          // It RECORDS what it was asked for. The export shipped answering 400
          // to every request the dialog could make, and no test called the
          // route at all — the cases at the foot of this file are the ones that
          // would have caught it.
          provide: UserExportService,
          useValue: {
            exportCsv: async (query: Record<string, unknown>) => {
              userExportCalls.push(query);
              return {
                csv: 'reiwa_id\nuser-1',
                rowCount: 1,
                usersWithoutDevices: 0,
                devicesComplete: null,
              };
            },
          },
        },
        {
          // IT CAN REFUSE. The stub answered `true` to everything, so the
          // controller's elevated-column branch — the one guarding the
          // customer's IP, user agent, referer and UTM — could not be entered
          // from this harness at all, and the only assertion about it read
          // `typeof allowElevated === 'boolean'`, which `true` and `false`
          // both satisfy. The gate was unguarded in both senses at once.
          provide: RbacService,
          useValue: {
            hasPermission: async (_admin: unknown, resource: string, action: string) =>
              !deniedPermissions.has(`${resource}:${action}`),
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

  // Every case starts with an admin who may do anything; the ones about a
  // refusal opt in. Without this a denial leaks into every later case in file
  // order, which is the kind of coupling that makes one edit redden five.
  beforeEach(() => {
    deniedPermissions.clear();
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
  /**
   * THE ROUTE THE DIALOG ACTUALLY CALLS.
   *
   * It shipped answering `400 property columns should not exist` to every
   * press of Download, because the handler took `@Query() query:
   * AdminUserListQueryDto` beside `@Query('columns')` — and the global pipe
   * runs `forbidNonWhitelisted`, so the un-keyed decorator validates the WHOLE
   * query string against a DTO that declares neither `columns` nor
   * `rowLimit`. Nothing called the route over HTTP, so nothing saw it.
   */
  it('exports the chosen columns rather than refusing the request', async () => {
    userExportCalls.length = 0;

    const response = await request(application.getHttpServer())
      .get('/api/admin/users/export/users.csv')
      .query({ columns: 'reiwa_id,username', rowLimit: '10' })
      .expect(200);

    assert.match(response.headers['content-type'], /text\/csv/);
    assert.match(response.headers['content-disposition'], /users-export\.csv/);
    assert.equal(userExportCalls.length, 1);
    assert.deepEqual(
      (userExportCalls[0]['columns'] as Array<{ id: string }>).map((column) => column.id),
      ['reiwa_id', 'username'],
    );
    assert.equal(userExportCalls[0]['limit'], 10);
  });

  it('exports every permitted column when the operator picked none', async () => {
    userExportCalls.length = 0;

    await request(application.getHttpServer())
      .get('/api/admin/users/export/users.csv')
      .expect(200);

    assert.ok((userExportCalls[0]['columns'] as unknown[]).length > 30);
  });

  it('carries the list filters into the export, so it is the slice on screen', async () => {
    // "What I see" and "what I downloaded" being two populations is the failure
    // this shares a where-builder with the list to avoid — and it is only
    // avoided if the filters survive the request.
    userExportCalls.length = 0;

    await request(application.getHttpServer())
      .get('/api/admin/users/export/users.csv')
      .query({ columns: 'reiwa_id', isBlocked: 'true', subscriptionStatuses: 'ACTIVE' })
      .expect(200);

    const where = JSON.stringify(userExportCalls[0]['where']);
    assert.match(where, /isBlocked/);
    assert.match(where, /ACTIVE/);
  });

  it('serves the column catalogue the dialog draws from', async () => {
    const response = await request(application.getHttpServer())
      .get('/api/admin/users/export/columns')
      .expect(200);

    assert.ok(Array.isArray(response.body.columns));
    assert.ok(response.body.columns.length > 30);
    // `typeof … === 'boolean'` was the assertion here, and it is satisfied by
    // both answers — so hard-coding `allowElevated = true` and handing every
    // operator the customers' IPs left it green.
    assert.equal(response.body.allowElevated, true);
    assert.ok(
      response.body.columns.some((column: { elevated: boolean }) => column.elevated === true),
      'no column is marked elevated, so the flag guards nothing',
    );
  });

  it('tells the dialog when this operator may not have the registration columns', async () => {
    deniedPermissions.add('users:export_registration');

    const response = await request(application.getHttpServer())
      .get('/api/admin/users/export/columns')
      .expect(200);

    assert.equal(response.body.allowElevated, false);
  });

  it('refuses an elevated column rather than quietly leaving it out', async () => {
    // THE CUSTOMER'S IP, and the reason refusal beats omission: a column that
    // vanishes without a word is indistinguishable from one that came back
    // empty, so the operator reads "we have no IP for these people" and is
    // wrong about every row.
    deniedPermissions.add('users:export_registration');
    userExportCalls.length = 0;

    const response = await request(application.getHttpServer())
      .get('/api/admin/users/export/users.csv')
      .query({ columns: 'reiwa_id,registration_ip' })
      .expect(403);

    assert.match(String(response.body.message), /registration_ip/);
    assert.equal(userExportCalls.length, 0, 'the export ran anyway');
  });

  it('still exports the ordinary columns for that same operator', async () => {
    // The refusal must be about the elevated columns, not about the operator.
    deniedPermissions.add('users:export_registration');
    userExportCalls.length = 0;

    await request(application.getHttpServer())
      .get('/api/admin/users/export/users.csv')
      .query({ columns: 'reiwa_id,username' })
      .expect(200);

    assert.equal(userExportCalls.length, 1);
  });

  it('leaves the elevated columns out of a "give me everything" export it may not have', async () => {
    // Picking nothing means "every column I am allowed". That path does not go
    // through the refusal above — there is nothing to refuse — so it needs its
    // own case, or a role without the grant silently receives the IPs.
    deniedPermissions.add('users:export_registration');
    userExportCalls.length = 0;

    await request(application.getHttpServer())
      .get('/api/admin/users/export/users.csv')
      .expect(200);

    // Read off the CATALOGUE's own flag, not off the id. `registration_` as a
    // prefix test looked right and was wrong: `registration_channel` is where
    // the customer came from, not the IP snapshot, and it is not elevated — so
    // the shape of the name is not the permission.
    const asked = userExportCalls[0] as { columns: Array<{ id: string }> };
    const elevatedIds = new Set(
      USER_EXPORT_COLUMNS.filter((column) => column.elevated === true).map((column) => column.id),
    );
    assert.ok(elevatedIds.size > 0, 'no column is elevated, so this case guards nothing');

    assert.deepEqual(
      asked.columns.map((column) => column.id).filter((id) => elevatedIds.has(id)),
      [],
      'the export was handed columns this operator may not read',
    );
    assert.ok(asked.columns.length > 20, 'the ordinary columns went missing too');
  });

  it('refuses a request for nothing at all rather than sending an empty file', async () => {
    await request(application.getHttpServer())
      .get('/api/admin/users/export/users.csv')
      .query({ columns: 'from_the_future' })
      .expect(400);
  });

  /**
   * `?columns=a&columns=b` — a hand-edited or bookmarked export URL.
   *
   * Express hands a REPEATED query key to the handler as an array, and the DTO
   * declares `columns` as a string, so the global pipe answered
   *
   *   400 ["columns must be longer than or equal to 0 and shorter than or equal
   *        to 2048 characters", "columns must be a string"]
   *
   * — two messages that together read as if the column list were too long, over
   * a request that names perfectly good columns. Validation runs before the
   * handler, so the `String(query.columns)` in the controller never saw it.
   *
   * A `.query({ columns: [...] })` object cannot express this: supertest
   * serialises an array as `columns[0]=…`, which is a different key entirely.
   * The URL is written out by hand for that reason.
   */
  it('accepts a duplicated columns key rather than answering 400', async () => {
    userExportCalls.length = 0;

    await request(application.getHttpServer())
      .get('/api/admin/users/export/users.csv?columns=reiwa_id&columns=username')
      .expect(200);

    assert.equal(userExportCalls.length, 1);
    assert.deepEqual(
      (userExportCalls[0]['columns'] as Array<{ id: string }>).map((column) => column.id),
      ['reiwa_id', 'username'],
      'the two halves of the duplicated key did not both survive',
    );
  });

  it('still refuses a columns value that is not a list of ids', async () => {
    // The flattening must not become "accept anything": a nested key puts an
    // OBJECT where the ids go, and `String({})` would smuggle
    // `[object Object]` into the catalogue lookup as though it were a column.
    await request(application.getHttpServer())
      .get('/api/admin/users/export/users.csv?columns[deep]=reiwa_id')
      .expect(400);
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
        presence: 'offline' as const,
        openReviewFlags: 0,
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
      presence: 'offline' as const,
      webAccount: null,
    },
    subscription: null,
  };
}
