import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import request from 'supertest';

import { appConfig } from '../src/common/config/app.config';
import { authConfig } from '../src/common/config/auth.config';
import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AdminAuthController } from '../src/modules/auth/controllers/admin-auth.controller';
import { AdminAuthService } from '../src/modules/auth/services/admin-auth.service';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { LoginGuardService } from '../src/modules/two-factor/services/login-guard.service';
import { TwoFactorService } from '../src/modules/two-factor/services/two-factor.service';
import { BlockedIpService } from '../src/modules/blocked-ips/services/blocked-ip.service';

/**
 * `POST /api/admin/auth/login` with 2FA on and no code — asserted on the bytes
 * that actually leave the process.
 *
 * WHY THIS SPEC EXISTS, in the words of the defect it was written after.
 *
 * Both halves of this path were already covered, separately, and both were
 * green. `auth.controller.spec.ts` asserted that the controller throws
 * `UnauthorizedException({ code: 'totp_required', … })`; it did — it caught the
 * exception object before any filter saw it.
 * `admin-safe-exception.filter.spec.ts` asserted that the filter forwards
 * allowlisted product codes and strips everything else; it did — every code it
 * fed in was one somebody had remembered to allowlist. Nobody put the two
 * together, and `totp_required` was never added to `SAFE_PRODUCT_CODES`. So the
 * filter deleted the field on its way out, `sign-in-page.tsx` never saw
 * `code === 'totp_required'`, the second-factor screen was unreachable dead
 * code, and every operator who switched 2FA on locked themselves out of the
 * panel.
 *
 * The rule this spec follows, therefore: no stubs on the path under test. The
 * real controller, the real `AdminAuthService` 2FA gate, the real
 * `TwoFactorService` and `LoginGuardService`, the real router, the real global
 * pipe and the real `AdminSafeExceptionFilter` all run; only the data stores
 * behind them (Prisma, password hashing) are faked, because they are the edge,
 * not the seam. What is asserted is `response.body` — the JSON the browser
 * parses — not an exception object, and not a filter invoked by hand.
 */
describe('POST admin/auth/login — the two-factor signal on the wire', () => {
  let application: INestApplication;

  /** Rows the fake Prisma serves; each test sets the shape it needs. */
  let adminRow: Record<string, unknown>;
  let totpRow: { totpEnabled: boolean; totpSecretEncrypted: string | null; totpRecoveryCodes: string[] };
  let auditLogWrites: Array<Record<string, unknown>>;
  let loginAttemptWrites: Array<Record<string, unknown>>;

  before(async () => {
    const prismaService = {
      adminUser: {
        findUnique: async (args: { select?: Record<string, unknown> }) => {
          // `TwoFactorService.isEnabled` / `verifyForLogin` select the 2FA
          // columns; `AdminAuthService.loginAdmin` selects the auth columns.
          // Discriminating on the select keeps one fake honest for both real
          // callers instead of inventing a second, friendlier service.
          if (args.select && 'totpEnabled' in args.select) {
            return totpRow;
          }
          return adminRow;
        },
      },
      adminAuditLog: {
        create: async (args: { data: Record<string, unknown> }) => {
          auditLogWrites.push(args.data);
          return args.data;
        },
      },
      adminLoginAttempt: {
        create: async (args: { data: Record<string, unknown> }) => {
          loginAttemptWrites.push(args.data);
          return args.data;
        },
        count: async () => 0,
      },
    } as unknown as PrismaService;

    const passwordHashService = {
      verifyPassword: async (): Promise<boolean> => true,
      hashPassword: async (): Promise<string> => 'unused',
    } as unknown as PasswordHashService;

    const applicationConfiguration = {
      locales: ['ru'],
      defaultLocale: 'ru',
      serviceName: 'Rezeis Admin',
      cryptKey: 'a'.repeat(32),
    };

    // The REAL security services. `AdminAuthService` reaches them through
    // `ModuleRef` at call time (they sit behind a circular import), so this is
    // the one joint the spec has to hold open by hand. It hands over the
    // genuine classes — a stub here would let the gate be "enabled" without the
    // production `isEnabled` / `verifyForLogin` ever running.
    const twoFactorService = new TwoFactorService(
      prismaService,
      applicationConfiguration as never,
    );
    const loginGuardService = new LoginGuardService(prismaService, {
      create: async (): Promise<void> => {},
    } as unknown as BlockedIpService);
    const moduleRef = {
      get: (token: unknown): unknown => {
        if (token === TwoFactorService) return twoFactorService;
        if (token === LoginGuardService) return loginGuardService;
        throw new Error('unexpected ModuleRef lookup');
      },
    };

    const adminAuthService = new AdminAuthService(
      { jwtSecret: 'test-secret', jwtExpiresIn: '1h' } as never,
      { signAsync: async (): Promise<string> => 'unused-token' } as unknown as JwtService,
      passwordHashService,
      prismaService,
      moduleRef as never,
    );

    const testingModule: TestingModule = await Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        { provide: AdminAuthService, useValue: adminAuthService },
        { provide: PrismaService, useValue: prismaService },
        { provide: appConfig.KEY, useValue: applicationConfiguration },
        { provide: authConfig.KEY, useValue: { jwtSecret: 'test-secret', jwtExpiresIn: '1h' } },
      ],
    }).compile();

    application = testingModule.createNestApplication();
    // Mirrors `main.ts`: same prefix, same pipe, same filter. The filter is the
    // component under test — installing it globally here is the whole point,
    // and `keeps the safe filter installed …` below pins that production does
    // the same, so this cannot drift into a test-only arrangement.
    application.setGlobalPrefix('api');
    application.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    application.useGlobalFilters(new AdminSafeExceptionFilter());
    await application.init();
  });

  after(async () => {
    await application.close();
  });

  beforeEach(() => {
    adminRow = {
      id: 'admin-1',
      login: 'operator',
      loginNormalized: 'operator',
      email: null,
      name: 'Operator',
      role: UserRole.DEV,
      isActive: true,
      tokenVersion: 1,
      passwordHash: 'irrelevant-hash',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastLoginAt: null,
      lastLoginIp: null,
      rbacRoleId: null,
      mustChangePassword: false,
    };
    totpRow = { totpEnabled: true, totpSecretEncrypted: 'enc:secret', totpRecoveryCodes: [] };
    auditLogWrites = [];
    loginAttemptWrites = [];
  });

  it('delivers code: "totp_required" in the response body the browser parses', async () => {
    const response = await request(application.getHttpServer())
      .post('/api/admin/auth/login')
      .send({ username: 'operator', password: 'correct-password' });

    // Asserted before the status, because the status was never the broken part.
    // A failure here reads "the code is missing", which is the defect, rather
    // than "expected 401, got 401", which is not.
    assert.equal(
      (response.body as { code?: string }).code,
      'totp_required',
      'the login 401 reached the client without `code: "totp_required"` — ' +
        'sign-in-page.tsx branches on exactly this field, so the second-factor ' +
        'screen is unreachable and every admin with 2FA enabled is locked out. ' +
        'Add the label to SAFE_PRODUCT_CODES in admin-safe-exception.filter.ts.',
    );
    assert.equal(response.status, 401);
    assert.equal((response.body as { statusCode?: number }).statusCode, 401);
    assert.equal(
      (response.body as { message?: string }).message,
      'Two-factor authentication required',
    );

    // Vacuity guard. Without these the assertions above would also pass for a
    // login that failed for some entirely different reason before ever
    // consulting the second factor.
    assert.equal(
      loginAttemptWrites.length,
      1,
      'the login guard recorded no attempt — the 2FA gate never ran',
    );
    assert.equal((loginAttemptWrites[0] as { reason?: string }).reason, 'totp_required');
    assert.deepStrictEqual(auditLogWrites, [], 'asking for a code is not a login failure');
  });

  it('leaves a wrong code as a plain 401 the form can show against the code field', async () => {
    // The other half of the two-step contract, and the reason the first
    // assertion cannot simply be "the body carries some code". `totp_required`
    // means "ask for a code"; a wrong code must NOT carry it, or the form would
    // re-enter step two from scratch and silently swallow the operator's typo.
    //
    // A recovery-code-shaped value takes the real `verifyForLogin` down its
    // real mismatch branch without needing a live TOTP secret.
    totpRow = {
      totpEnabled: true,
      totpSecretEncrypted: 'enc:secret',
      totpRecoveryCodes: ['a-hash-of-some-other-code'],
    };

    const response = await request(application.getHttpServer())
      .post('/api/admin/auth/login')
      .send({ username: 'operator', password: 'correct-password', totpCode: 'bbbbbbbbbb' });

    assert.equal(response.status, 401);
    assert.equal(
      (response.body as { code?: string }).code,
      undefined,
      'a rejected code must not arrive labelled `totp_required` — the form ' +
        'reads that label as "start the second step", so the operator would be ' +
        'sent round the loop with no error shown',
    );
    assert.equal(
      (response.body as { message?: string }).message,
      'Invalid verification code',
      'the filter redacted the only text the form has to explain the refusal',
    );
    assert.equal((response.body as { errorCode?: string }).errorCode, 'UNAUTHORIZED');
    assert.equal((loginAttemptWrites[0] as { reason?: string }).reason, 'totp_invalid');
  });

  it('keeps the safe filter installed on the real entrypoint', () => {
    // The spec above installs `AdminSafeExceptionFilter` itself. That is only
    // evidence about production while production still installs it too —
    // otherwise this file would keep asserting a body shape nobody receives.
    const mainSource = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');
    assert.match(
      mainSource,
      /useGlobalFilters\(\s*new AdminSafeExceptionFilter\(\)\s*\)/u,
      'src/main.ts no longer installs AdminSafeExceptionFilter globally, so the ' +
        'response bodies asserted in this file are test-only fiction',
    );
  });
});
