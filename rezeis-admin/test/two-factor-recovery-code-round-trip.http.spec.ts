/**
 * The round trip, over real HTTP: a recovery code printed for the operator must
 * be a recovery code the verifier accepts.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE UNIT TESTS.
 *
 * Every property of the new codes can be — and is — asserted against the
 * generator and the verifier directly in
 * `test/two-factor-recovery-code-strength.spec.ts`. All of it stays green while
 * the feature is dead on the wire, because nothing in a unit test passes
 * through `ValidationPipe`, the DTO, JSON serialisation, or the response
 * filter. This module has already shipped exactly that defect once:
 * `test/two-factor-enrollment-reauth.spec.ts` asserted on the thrown object and
 * stayed green while the response filter stripped `totp_enroll_reauth_required`
 * off the wire, so 2FA could not be switched on at all.
 *
 * The change here is the same shape of risk. Codes went from 10 hex characters
 * to 19 (`ABCD-EFGH-JKLM-NPQR`), and `TwoFactorVerifyDto` caps `code` at
 * `@MaxLength(20)` while the panel's inputs cap at 20 as well. One character
 * more and every operator would be handed ten codes, print them, and then be
 * refused by validation before a verifier ever saw one — a permanent 2FA
 * lockout that no test of the generator could notice.
 *
 * So this drives the REAL controller through a REAL server with the REAL
 * `ValidationPipe`: enrol, read the codes out of the response BODY, confirm
 * with a TOTP derived from the secret in that same body, then spend one of the
 * printed codes against `POST /admin/2fa/disable` and assert 200.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import { describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { appConfig } from '../src/common/config/app.config';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ThrottleModule } from '../src/common/throttle/throttle.module';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { AdminTwoFactorController } from '../src/modules/two-factor/controllers/admin-two-factor.controller';
import { TwoFactorService } from '../src/modules/two-factor/services/two-factor.service';
import { base32Decode } from '../src/modules/two-factor/utils/base32';
import { encryptTotpSecret } from '../src/modules/two-factor/utils/secret-cipher';
import { computeTotpCode } from '../src/modules/two-factor/utils/totp';

const CRYPT_KEY = 'round-trip-spec-crypt-key';
const PASSWORD = 'the-operators-actual-password';

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function call(port: number, method: string, path: string, body?: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
          : {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: Record<string, unknown>;
          try {
            parsed = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            parsed = { raw };
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

interface Context {
  readonly app: INestApplication;
  readonly port: number;
  readonly row: AdminRow;
}

interface AdminRow {
  totpEnabled: boolean;
  totpSecretEncrypted: string | null;
  totpRecoveryCodes: string[];
  totpEnrolledAt: Date | null;
  passwordHash: string;
}

async function buildApp(seed: Partial<AdminRow> = {}): Promise<Context> {
  const hasher = new PasswordHashService();
  const row: AdminRow = {
    totpEnabled: false,
    totpSecretEncrypted: null,
    totpRecoveryCodes: [],
    totpEnrolledAt: null,
    passwordHash: await hasher.hashPassword({ plainTextPassword: PASSWORD, audience: 'admin' }),
    ...seed,
  };

  // A fake that REMEMBERS. The whole point is that what one request wrote is
  // what the next request reads; a per-call literal would make the round trip
  // untestable and the test meaningless.
  const prismaService = {
    adminUser: {
      findUnique: async () => ({ ...row, id: 'admin-1', login: 'operator' }),
      findUniqueOrThrow: async () => ({ ...row, id: 'admin-1', login: 'operator' }),
      update: async (args: { data: Partial<AdminRow> }) => {
        Object.assign(row, args.data);
        return { ...row };
      },
    },
    adminAuditLog: { create: async () => ({}) },
  } as unknown as PrismaService;

  const rawCacheService = { exists: async () => false, claimOnce: async () => true };

  const moduleFixture = await Test.createTestingModule({
    imports: [ThrottleModule],
    controllers: [AdminTwoFactorController],
    providers: [
      { provide: PrismaService, useValue: prismaService },
      { provide: appConfig.KEY, useValue: { cryptKey: CRYPT_KEY, serviceName: 'Rezeis Admin' } },
      {
        provide: TwoFactorService,
        useValue: new TwoFactorService(
          prismaService,
          { cryptKey: CRYPT_KEY, serviceName: 'Rezeis Admin' } as never,
          rawCacheService as never,
          hasher,
        ),
      },
    ],
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
  return { app, port: address.port, row };
}

async function withApp(
  seed: Partial<AdminRow>,
  body: (context: Context) => Promise<void>,
): Promise<void> {
  const context = await buildApp(seed);
  try {
    await body(context);
  } finally {
    await context.app.close();
  }
}

describe('a printed recovery code is a code the wire accepts', () => {
  it('enrol -> confirm -> disable with a code taken out of the response body', async () => {
    await withApp({}, async (context) => {
      const enrolled = await call(context.port, 'POST', '/admin/2fa/enroll', {
        password: PASSWORD,
      });
      assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));

      const codes = enrolled.body['recoveryCodes'] as string[];
      const secret = enrolled.body['secret'] as string;
      assert.equal(Array.isArray(codes), true, 'the response carried no recovery codes');
      assert.equal(codes.length, 10);
      for (const code of codes) {
        assert.match(
          code,
          /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/,
          `a code left the server in an unexpected shape: ${code}`,
        );
        assert.equal(code.length <= 20, true, `${code} exceeds the 20-character wire limit`);
      }

      const totp = computeTotpCode(base32Decode(secret), Math.floor(Date.now() / 1000));
      const confirmed = await call(context.port, 'POST', '/admin/2fa/confirm', { code: totp });
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      assert.equal(confirmed.body['recoveryCodesRemaining'], 10);
      assert.equal(
        confirmed.body['recoveryCodesLegacy'],
        0,
        'a freshly minted set reported legacy entries',
      );

      // The assertion the whole file exists for. Not "the verifier would accept
      // it" — the server, over HTTP, through validation, accepted the exact
      // string it printed.
      const disabled = await call(context.port, 'POST', '/admin/2fa/disable', { code: codes[0] });
      assert.equal(
        disabled.status,
        200,
        `the server refused a recovery code it issued: ${JSON.stringify(disabled.body)}`,
      );
      assert.equal(disabled.body['enabled'], false);
      assert.deepEqual(context.row.totpRecoveryCodes, [], 'disable left the recovery set behind');
    });
  });

  it('regenerated codes also survive the round trip', async () => {
    // `regenerate` is the operator's only route out of a legacy set, so it must
    // be the one route that cannot mint something the wire refuses.
    await withApp({}, async (context) => {
      const enrolled = await call(context.port, 'POST', '/admin/2fa/enroll', {
        password: PASSWORD,
      });
      const secret = enrolled.body['secret'] as string;
      await call(context.port, 'POST', '/admin/2fa/confirm', {
        code: computeTotpCode(base32Decode(secret), Math.floor(Date.now() / 1000)),
      });

      const regenerated = await call(context.port, 'POST', '/admin/2fa/recovery-codes/regenerate', {
        code: (enrolled.body['recoveryCodes'] as string[])[0],
      });
      assert.equal(regenerated.status, 200, JSON.stringify(regenerated.body));

      const fresh = regenerated.body['recoveryCodes'] as string[];
      assert.equal(fresh.length, 10);
      const disabled = await call(context.port, 'POST', '/admin/2fa/disable', { code: fresh[9] });
      assert.equal(
        disabled.status,
        200,
        `the server refused a regenerated code: ${JSON.stringify(disabled.body)}`,
      );
    });
  });

  it('a code already in an operator hand still gets them in, over HTTP', async () => {
    // The migration, asserted where an operator would feel it. This row is a
    // pre-change database row verbatim: an unsalted SHA-256 of a 40-bit hex
    // code. If it stops being accepted, the operator who lost their
    // authenticator is locked out of the panel permanently.
    const legacyCode = 'a1b2c3d4e5';
    await withApp(
      {
        totpEnabled: true,
        totpSecretEncrypted: null,
        totpRecoveryCodes: [createHash('sha256').update(legacyCode).digest('hex')],
      },
      async (context) => {
        // `verifyForLogin` needs a secret present to reach the recovery branch.
        assert.equal(buildEnrolledSecret(context), true);

        const status = await call(context.port, 'GET', '/admin/2fa/status');
        assert.equal(status.status, 200);
        assert.equal(status.body['recoveryCodesRemaining'], 1);
        assert.equal(
          status.body['recoveryCodesLegacy'],
          1,
          'the panel is not told the remaining code is the weak kind',
        );

        const disabled = await call(context.port, 'POST', '/admin/2fa/disable', {
          code: legacyCode,
        });
        assert.equal(
          disabled.status,
          200,
          `a code issued before this change was refused: ${JSON.stringify(disabled.body)}`,
        );
      },
    );
  });

  it('refuses a code that was never issued, with a 401 the form can show', async () => {
    await withApp({}, async (context) => {
      const enrolled = await call(context.port, 'POST', '/admin/2fa/enroll', {
        password: PASSWORD,
      });
      await call(context.port, 'POST', '/admin/2fa/confirm', {
        code: computeTotpCode(
          base32Decode(enrolled.body['secret'] as string),
          Math.floor(Date.now() / 1000),
        ),
      });

      const refused = await call(context.port, 'POST', '/admin/2fa/disable', {
        code: 'AAAA-BBBB-CCCC-DDDD',
      });

      assert.equal(refused.status, 401);
      assert.equal(refused.body['message'], 'Invalid verification code');
    });
  });

  it('refuses a code longer than the wire allows before any verifier runs', async () => {
    await withApp({ totpEnabled: true }, async (context) => {
      const refused = await call(context.port, 'POST', '/admin/2fa/disable', {
        code: 'A'.repeat(21),
      });

      assert.equal(refused.status, 400, 'the DTO length cap is not being enforced on this route');
    });
  });
});

/**
 * Puts a real encrypted secret on the row without going through `enroll`,
 * which would replace the legacy recovery set this case is about.
 */
function buildEnrolledSecret(context: Context): boolean {
  context.row.totpSecretEncrypted = encryptTotpSecret('JBSWY3DPEHPK3PXP', CRYPT_KEY);
  return true;
}
