import 'reflect-metadata';

import assert from 'node:assert/strict';
import * as http from 'node:http';
import { describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';

import { appConfig } from '../src/common/config/app.config';
import { authConfig } from '../src/common/config/auth.config';
import { RawCacheService } from '../src/common/cache/raw-cache.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ThrottleModule } from '../src/common/throttle/throttle.module';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { AdminTwoFactorController } from '../src/modules/two-factor/controllers/admin-two-factor.controller';
import { TwoFactorService } from '../src/modules/two-factor/services/two-factor.service';
import { LoginGuardService } from '../src/modules/two-factor/services/login-guard.service';
import { OAuthPublicController } from '../src/modules/oauth/controllers/admin-oauth.controller';
import { PasskeyProtectedController } from '../src/modules/oauth/controllers/passkey.controller';
import { PasskeyService } from '../src/modules/oauth/services/passkey.service';
import { OAuthLoginService } from '../src/modules/oauth/services/oauth-login.service';
import { OAuthConfigService } from '../src/modules/oauth/services/oauth-config.service';
import { TelegramAuthService } from '../src/modules/oauth/services/telegram-auth.service';
import { GitHubAuthService } from '../src/modules/oauth/services/github-auth.service';
import { CryptoService } from '../src/modules/oauth/services/crypto.service';
import { encryptTotpSecret } from '../src/modules/two-factor/utils/secret-cipher';

/**
 * Brute-force ceilings on every route in the admin panel that checks a
 * guessable credential — asserted by firing requests at a real server and
 * counting what comes back.
 *
 * WHY THE TEST IS SHAPED LIKE THIS.
 *
 * `@Throttle` is a decorator, and a decorator is trivial to assert and
 * worthless to assert alone: `Reflect.getMetadata` returning 10 proves an
 * annotation was written, not that an eleventh request is refused. The
 * annotation can be on a handler the router never reaches, on a controller
 * whose module never registers the guard, or under a throttler name the module
 * does not define — and in all three cases the metadata assertion passes while
 * the route stays wide open. That gap is this repository's documented disease.
 *
 * So the real `ThrottleModule` is imported (global guard, `default` throttler,
 * 600/60 s ceiling and all), the real controllers are routed, the real
 * services run, and the assertions are on the STATUS HISTOGRAM of N real HTTP
 * requests and the attempt number at which 429 begins. Only the edges are
 * faked: Prisma, the password hasher, the provider adapters. The metadata
 * assertions at the bottom are an addition — they name the number in a form a
 * human can read in a diff — never the proof.
 *
 * The numbers being defended, and what they were before:
 *
 *   route                                 was      is
 *   POST /admin/2fa/disable               600/60s  10/60s
 *   POST /admin/2fa/recovery-codes/…      600/60s  10/60s
 *   POST /admin/2fa/enroll                600/60s  10/60s
 *   POST /admin/2fa/confirm               600/60s  20/60s
 *   POST /admin/passkey/register/options  600/60s  10/60s
 *   POST /admin/oauth/telegram/login      600/60s  10/60s
 *   GET  /admin/oauth/github/callback     600/60s  30/60s
 *
 * Measured before the change, from one IP inside one minute, every one of them
 * answered `{"401":600,"429":100}` to 700 wrong guesses with the first refusal
 * at attempt 601, and the OAuth path wrote nothing to `admin_login_attempts`
 * while doing it.
 */

const CRYPT_KEY = 'brute-force-spec-crypt-key';
const SECRET = 'JBSWY3DPEHPK3PXP';

const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });

function fire(port: number, method: string, path: string, body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
          : {},
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

interface Measurement {
  readonly histogram: Record<string, number>;
  readonly firstRefusal: number | null;
}

/** Fires `count` identical requests one after another and tallies the answers. */
async function measure(
  port: number,
  method: string,
  path: string,
  body: unknown,
  count: number,
): Promise<Measurement> {
  const histogram: Record<string, number> = {};
  let firstRefusal: number | null = null;
  for (let attempt = 1; attempt <= count; attempt += 1) {
    const status = await fire(port, method, path, body);
    histogram[String(status)] = (histogram[String(status)] ?? 0) + 1;
    if (status === 429 && firstRefusal === null) firstRefusal = attempt;
  }
  return { histogram, firstRefusal };
}

interface RecordedAttempt {
  readonly loginNormalized: string;
  readonly ipAddress: string;
  readonly success: boolean;
  readonly reason?: string | null;
  readonly userAgent?: string | null;
}

interface AppContext {
  readonly app: INestApplication;
  readonly port: number;
  readonly recordedAttempts: RecordedAttempt[];
  readonly rateLimitChecks: Array<{ ip: string; login: string }>;
  verifyForLoginCalls: number;
  totpEnabled: boolean;
}

interface AppOptions {
  /** Starts with 2FA already on. `confirm` / `enroll` need it off to reach their check. */
  readonly totpEnabled?: boolean;
  /** Makes the fail2ban counter answer "this IP has spent its budget". */
  readonly rateLimited?: boolean;
  /** Drops the counter out of the container entirely. */
  readonly withoutLoginGuard?: boolean;
  /** Makes the second factor accept the code, so the success path can be asserted. */
  readonly acceptSecondFactor?: boolean;
}

async function buildApp(options: AppOptions = {}): Promise<AppContext> {
  const context = {
    recordedAttempts: [] as RecordedAttempt[],
    rateLimitChecks: [] as Array<{ ip: string; login: string }>,
    verifyForLoginCalls: 0,
    totpEnabled: options.totpEnabled ?? true,
  };

  const prismaService = {
    adminUser: {
      findUnique: async () => ({
        id: 'admin-1',
        login: 'Root',
        loginNormalized: 'root',
        name: 'Root',
        role: 'DEV',
        isActive: true,
        tokenVersion: 1,
        rbacRoleId: null,
        totpEnabled: context.totpEnabled,
        totpSecretEncrypted: encryptTotpSecret(SECRET, CRYPT_KEY),
        totpRecoveryCodes: [],
        totpEnrolledAt: new Date(0),
        passwordHash: 'stored-hash',
      }),
      findUniqueOrThrow: async () => ({
        id: 'admin-1',
        login: 'Root',
        loginNormalized: 'root',
        totpEnabled: context.totpEnabled,
        totpSecretEncrypted: encryptTotpSecret(SECRET, CRYPT_KEY),
        totpRecoveryCodes: [],
        totpEnrolledAt: new Date(0),
        passwordHash: 'stored-hash',
      }),
      update: async () => ({
        totpEnabled: context.totpEnabled,
        totpEnrolledAt: null,
        totpRecoveryCodes: [],
      }),
    },
    adminOAuthLink: {
      findUnique: async () => ({ id: 'link-1', adminUserId: 'admin-1' }),
      update: async () => ({}),
    },
    adminAuditLog: { create: async () => ({}) },
    adminLoginAttempt: { create: async () => ({}), count: async () => 0 },
    adminPasskey: { findMany: async () => [], findUnique: async () => null },
    authProviderConfig: {
      findUnique: async () => ({ allowedEmails: [], allowedTelegramIds: [] }),
    },
  } as unknown as PrismaService;

  const rawCacheService = {
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
    exists: async () => false,
    claimOnce: async () => true,
  } as unknown as RawCacheService;

  const passwordHashService = {
    hashPassword: async () => 'stored-hash',
    verifyPassword: async () => false,
  } as unknown as PasswordHashService;

  const realTwoFactor = new TwoFactorService(
    prismaService,
    { cryptKey: CRYPT_KEY, serviceName: 'Rezeis Admin' } as never,
    rawCacheService,
    passwordHashService,
  );

  // Real `TwoFactorService` behaviour for every method, with `verifyForLogin`
  // counted so a test can assert how many guesses actually reached the
  // verifier — the number the throttle is there to cap.
  const countingTwoFactor = {
    isEnabled: async () => context.totpEnabled,
    verifyForLogin: async (adminId: string, code: string) => {
      context.verifyForLoginCalls += 1;
      if (options.acceptSecondFactor === true) return true;
      return realTwoFactor.verifyForLogin(adminId, code);
    },
    getStatus: (adminId: string) => realTwoFactor.getStatus(adminId),
    beginEnrollment: (adminId: string, password?: string) =>
      realTwoFactor.beginEnrollment(adminId, password),
    confirmEnrollment: (adminId: string, code: string) =>
      realTwoFactor.confirmEnrollment(adminId, code),
    disable: (adminId: string, code: string) => realTwoFactor.disable(adminId, code),
    regenerateRecoveryCodes: (adminId: string, code: string) =>
      realTwoFactor.regenerateRecoveryCodes(adminId, code),
  };

  const loginGuard = {
    isRateLimited: async (ip: string, login: string) => {
      context.rateLimitChecks.push({ ip, login });
      return options.rateLimited === true;
    },
    recordAttempt: async (input: RecordedAttempt) => {
      context.recordedAttempts.push(input);
      return { autoBlocked: false, failureCount: context.recordedAttempts.length };
    },
  };

  const providers: Array<Record<string, unknown>> = [
    { provide: PrismaService, useValue: prismaService },
    { provide: RawCacheService, useValue: rawCacheService },
    { provide: PasswordHashService, useValue: passwordHashService },
    { provide: TwoFactorService, useValue: countingTwoFactor },
    { provide: JwtService, useValue: { signAsync: async () => 'jwt-token' } },
    { provide: appConfig.KEY, useValue: { cryptKey: CRYPT_KEY, serviceName: 'Rezeis Admin' } },
    { provide: authConfig.KEY, useValue: { jwtExpiresIn: '24h', jwtSecret: 'x' } },
    { provide: OAuthConfigService, useValue: { getEnabledProviders: async () => [] } },
    {
      provide: TelegramAuthService,
      useValue: {
        verifyTelegramLogin: async () => ({
          providerType: 'TELEGRAM',
          providerId: '4242',
          email: null,
          name: 'tg',
          rawProfile: {},
        }),
      },
    },
    { provide: GitHubAuthService, useValue: { handleCallback: async () => ({}) } },
    { provide: CryptoService, useValue: {} },
  ];
  if (options.withoutLoginGuard !== true) {
    providers.push({ provide: LoginGuardService, useValue: loginGuard });
  }

  const moduleFixture = await Test.createTestingModule({
    imports: [ThrottleModule],
    controllers: [AdminTwoFactorController, OAuthPublicController, PasskeyProtectedController],
    providers: [...(providers as never[]), OAuthLoginService, PasskeyService],
  })
    .overrideGuard(AdminJwtAuthGuard)
    .useValue({
      canActivate: (executionContext: {
        switchToHttp: () => { getRequest: () => Record<string, unknown> };
      }) => {
        executionContext.switchToHttp().getRequest()['user'] = { id: 'admin-1' };
        return true;
      },
    })
    .compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return Object.assign(context, { app, port: address.port });
}

/** Builds an app, runs the body against it, and always closes it. */
async function withApp(
  options: AppOptions,
  body: (context: AppContext) => Promise<void>,
): Promise<void> {
  const context = await buildApp(options);
  try {
    await body(context);
  } finally {
    await context.app.close();
  }
}

describe('brute-force ceilings on the credential-checking admin routes', () => {
  it('POST /admin/2fa/disable refuses the 11th wrong code in a minute', async () => {
    await withApp({}, async (context) => {
      const result = await measure(
        context.port,
        'POST',
        '/admin/2fa/disable',
        { code: '000000' },
        15,
      );
      assert.deepEqual(
        result.histogram,
        { '401': 10, '429': 5 },
        `600 wrong codes a minute deleted the second factor at leisure; got ${JSON.stringify(result.histogram)}`,
      );
      assert.equal(result.firstRefusal, 11);
    });
  });

  it('POST /admin/2fa/recovery-codes/regenerate refuses the 11th wrong code in a minute', async () => {
    await withApp({}, async (context) => {
      const result = await measure(
        context.port,
        'POST',
        '/admin/2fa/recovery-codes/regenerate',
        { code: '000000' },
        15,
      );
      assert.deepEqual(result.histogram, { '401': 10, '429': 5 });
      assert.equal(result.firstRefusal, 11);
    });
  });

  it('POST /admin/2fa/enroll refuses the 11th wrong password in a minute', async () => {
    // 2FA must be OFF, or `beginEnrollment` answers 409 before it ever looks at
    // the password and the route under test is not the route being measured.
    await withApp({ totpEnabled: false }, async (context) => {
      const result = await measure(
        context.port,
        'POST',
        '/admin/2fa/enroll',
        { password: 'wrong-password' },
        15,
      );
      assert.deepEqual(result.histogram, { '401': 10, '429': 5 });
      assert.equal(result.firstRefusal, 11);
    });
  });

  it('POST /admin/2fa/confirm refuses the 21st wrong code in a minute', async () => {
    // Deliberately the loosest of the set: this is where an operator fumbles a
    // freshly-scanned code, and it is the weakest target in the file.
    await withApp({ totpEnabled: false }, async (context) => {
      const result = await measure(
        context.port,
        'POST',
        '/admin/2fa/confirm',
        { code: '000000' },
        25,
      );
      assert.deepEqual(result.histogram, { '401': 20, '429': 5 });
      assert.equal(result.firstRefusal, 21);
    });
  });

  it('POST /admin/passkey/register/options refuses the 11th wrong factor in a minute', async () => {
    await withApp({}, async (context) => {
      const result = await measure(
        context.port,
        'POST',
        '/admin/passkey/register/options',
        { code: '000000' },
        15,
      );
      assert.deepEqual(result.histogram, { '401': 10, '429': 5 });
      assert.equal(result.firstRefusal, 11);
    });
  });

  it('GET /admin/passkey/credentials keeps the global budget — the tight limit is on the handler, not the class', async () => {
    // If `@Throttle` had been put on `PasskeyProtectedController` instead of on
    // `register/options`, rendering the security page would spend a
    // brute-force budget. Fifteen list calls must all succeed.
    await withApp({}, async (context) => {
      const result = await measure(context.port, 'GET', '/admin/passkey/credentials', undefined, 15);
      assert.deepEqual(result.histogram, { '200': 15 });
      assert.equal(result.firstRefusal, null);
    });
  });

  it('GET /admin/2fa/status keeps the global budget — the settings page reads it on every render', async () => {
    await withApp({}, async (context) => {
      const result = await measure(context.port, 'GET', '/admin/2fa/status', undefined, 25);
      assert.deepEqual(result.histogram, { '200': 25 });
      assert.equal(result.firstRefusal, null);
    });
  });
});

describe('the OAuth sign-in path — the unauthenticated half', () => {
  it('POST /admin/oauth/telegram/login refuses the 11th second-factor guess in a minute', async () => {
    await withApp({}, async (context) => {
      const result = await measure(
        context.port,
        'POST',
        '/admin/oauth/telegram/login',
        { id: '4242', hash: 'x', totpCode: '000000' },
        15,
      );
      assert.deepEqual(
        result.histogram,
        { '401': 10, '429': 5 },
        `got ${JSON.stringify(result.histogram)}`,
      );
      assert.equal(result.firstRefusal, 11);
      // The number that matters: how many guesses actually reached the
      // verifier. It was 600 a minute.
      assert.equal(
        context.verifyForLoginCalls,
        10,
        `${context.verifyForLoginCalls} guesses reached TwoFactorService.verifyForLogin`,
      );
    });
  });

  it('charges every rejected second factor to the same (login, ip) budget a mistyped password spends', async () => {
    await withApp({}, async (context) => {
      const status = await fire(context.port, 'POST', '/admin/oauth/telegram/login', {
        id: '4242',
        hash: 'x',
        totpCode: '000000',
      });
      assert.equal(status, 401);

      const failures = context.recordedAttempts.filter((attempt) => !attempt.success);
      assert.equal(
        failures.length,
        1,
        'a wrong OAuth second factor left no row in admin_login_attempts',
      );
      const failure = failures[0]!;
      // `loginNormalized`, not `login`: a different key here would put OAuth
      // failures in a different bucket from password failures and the shared
      // budget would stop being shared.
      assert.equal(failure.loginNormalized, 'root');
      assert.equal(failure.ipAddress, '127.0.0.1');
      // The same reason string `AdminAuthService` writes, because both paths
      // write into one table read by one query.
      assert.equal(failure.reason, 'totp_invalid');
    });
  });

  it('records the missing-code refusal as `totp_required`, exactly as the password path does', async () => {
    await withApp({}, async (context) => {
      const status = await fire(context.port, 'POST', '/admin/oauth/telegram/login', {
        id: '4242',
        hash: 'x',
      });
      assert.equal(status, 401);
      const failures = context.recordedAttempts.filter((attempt) => !attempt.success);
      assert.equal(failures.length, 1);
      assert.equal(failures[0]!.reason, 'totp_required');
    });
  });

  it('refuses an OAuth sign-in whose (login, ip) budget is already spent, before the code is checked', async () => {
    await withApp({ rateLimited: true }, async (context) => {
      const status = await fire(context.port, 'POST', '/admin/oauth/telegram/login', {
        id: '4242',
        hash: 'x',
        totpCode: '000000',
      });
      assert.equal(status, 401);
      // The pre-flight ran with the real key, not a placeholder.
      assert.deepEqual(context.rateLimitChecks, [{ ip: '127.0.0.1', login: 'root' }]);
      // And it ran BEFORE the credential was consulted — a blocked address
      // gets no free guess out of the refusal.
      assert.equal(context.verifyForLoginCalls, 0);
    });
  });

  it('records a successful OAuth sign-in too, so the attempts table shows the session', async () => {
    await withApp({ acceptSecondFactor: true }, async (context) => {
      const status = await fire(context.port, 'POST', '/admin/oauth/telegram/login', {
        id: '4242',
        hash: 'x',
        totpCode: '123456',
      });
      assert.equal(status, 201);
      const successes = context.recordedAttempts.filter((attempt) => attempt.success);
      assert.equal(successes.length, 1);
      assert.equal(successes[0]!.loginNormalized, 'root');
      assert.equal(successes[0]!.ipAddress, '127.0.0.1');
    });
  });

  it('still signs in when the counter cannot be resolved — a missing counter must not become a lockout', async () => {
    // The asymmetry stated in `assertSecondFactor`: a missing VERIFIER refuses,
    // a missing COUNTER does not. Getting this backwards would turn a wiring
    // fault into a total sign-in outage.
    await withApp({ withoutLoginGuard: true, acceptSecondFactor: true }, async (context) => {
      const status = await fire(context.port, 'POST', '/admin/oauth/telegram/login', {
        id: '4242',
        hash: 'x',
        totpCode: '123456',
      });
      assert.equal(status, 201);
      assert.equal(context.recordedAttempts.length, 0);
    });
  });

  it('GET /admin/oauth/github/callback is capped high enough that no human sign-in reaches it', async () => {
    // Not a brute-force control: nothing here is guessable, and a 429 on a
    // browser redirect is a dead-end page mid-sign-in. The cap exists to stop
    // one address driving 600 outbound GitHub token exchanges a minute.
    await withApp({}, async (context) => {
      const result = await measure(
        context.port,
        'GET',
        '/admin/oauth/github/callback?code=x&state=y',
        undefined,
        35,
      );
      assert.deepEqual(result.histogram, { '403': 30, '429': 5 });
      assert.equal(result.firstRefusal, 31);
    });
  });
});

describe('the declared limits, named in a form a diff can show', () => {
  // An ADDITION to the request-level assertions above, never a replacement:
  // this proves the annotation exists and says 10, which the routed requests
  // above have already proved is enforced.
  const cases: Array<[string, object, string, number]> = [
    ['2fa/disable', AdminTwoFactorController.prototype, 'disable', 10],
    ['2fa/confirm', AdminTwoFactorController.prototype, 'confirm', 20],
    ['2fa/enroll', AdminTwoFactorController.prototype, 'enroll', 10],
    [
      '2fa/recovery-codes/regenerate',
      AdminTwoFactorController.prototype,
      'regenerateRecoveryCodes',
      10,
    ],
    [
      'passkey/register/options',
      PasskeyProtectedController.prototype,
      'getRegistrationOptions',
      10,
    ],
    ['oauth/telegram/login', OAuthPublicController.prototype, 'telegramLogin', 10],
    ['oauth/github/callback', OAuthPublicController.prototype, 'githubCallback', 30],
  ];

  for (const [label, prototype, method, limit] of cases) {
    it(`${label} declares ${limit}/60s on the \`default\` throttler`, () => {
      const handler = (prototype as Record<string, unknown>)[method];
      assert.equal(
        Reflect.getMetadata('THROTTLER:LIMITdefault', handler as object),
        limit,
        `${label} lost its @Throttle override`,
      );
      assert.equal(Reflect.getMetadata('THROTTLER:TTLdefault', handler as object), 60_000);
    });
  }
});

process.on('exit', () => agent.destroy());
