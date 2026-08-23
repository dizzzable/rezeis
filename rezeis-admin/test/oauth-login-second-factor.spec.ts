import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthProviderType } from '@prisma/client';
import request from 'supertest';

import { RawCacheService } from '../src/common/cache/raw-cache.service';
import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { OAuthPublicController } from '../src/modules/oauth/controllers/admin-oauth.controller';
import { GitHubAuthService } from '../src/modules/oauth/services/github-auth.service';
import { OAuthConfigService } from '../src/modules/oauth/services/oauth-config.service';
import { OAuthLoginService } from '../src/modules/oauth/services/oauth-login.service';
import { TelegramAuthService } from '../src/modules/oauth/services/telegram-auth.service';
import { OAuthUserProfile } from '../src/modules/oauth/interfaces/oauth-provider.interface';
import { TwoFactorService } from '../src/modules/two-factor/services/two-factor.service';
import { base32Decode } from '../src/modules/two-factor/utils/base32';
import { encryptTotpSecret } from '../src/modules/two-factor/utils/secret-cipher';
import { computeTotpCode, generateTotpSecret } from '../src/modules/two-factor/utils/totp';

/**
 * Logging in through an OAuth provider skipped the second factor entirely.
 *
 * `OAuthLoginService.issueTokenForAdmin()` signed a full 24h admin JWT after
 * checking `isActive` and nothing else — the file contained no reference to
 * `totpEnabled` or `TwoFactorService` at all. So an operator who switched 2FA
 * on, believing every login now needed their authenticator, could still be
 * signed in by whoever controlled their linked Telegram or GitHub account,
 * with neither password nor code. The panel's own schema promises the
 * opposite: `AdminUser.totpEnabled` is documented as "Operators with
 * `totpEnabled = true` MUST present a valid 6-digit code on every login"
 * (`prisma/schema.prisma:502`).
 *
 * Two things are asserted, and the repo has already paid for skipping either.
 *
 *   1. The DECISION — a token is not issued without the second factor, on
 *      both the already-linked and the auto-link paths. The real
 *      `TwoFactorService` runs, over the real secret cipher and the real TOTP
 *      algorithm; a stub here could report "verified" while the production
 *      verifier was never wired in.
 *   2. The WIRE — the refusal arrives at the browser as
 *      `401 { code: 'totp_required' }` after passing through the real
 *      `AdminSafeExceptionFilter`. That filter strips any `code` missing from
 *      `SAFE_PRODUCT_CODES`, which is precisely how the password path's
 *      second-factor screen stayed unreachable for months while two green
 *      specs each covered half of it.
 */

const CRYPT_KEY = 'k'.repeat(32);
const ADMIN_ID = 'admin-1';
const TELEGRAM_ID = '778899';

const AUTH_CONFIG = { jwtSecret: 'test-secret', jwtExpiresIn: '24h' };

interface AdminRow {
  totpEnabled: boolean;
  isActive: boolean;
}

class FakeCache {
  private readonly claims = new Set<string>();
  public async claimOnce(key: string): Promise<boolean> {
    if (this.claims.has(key)) return false;
    this.claims.add(key);
    return true;
  }
  public async exists(key: string): Promise<boolean> {
    return this.claims.has(key);
  }
}

interface World {
  adminRow: AdminRow;
  linkExists: boolean;
  whitelistedTelegramIds: bigint[];
  readonly secret: string;
  readonly signedTokens: string[];
  readonly adminUpdates: Array<Record<string, unknown>>;
  readonly linkCreates: Array<Record<string, unknown>>;
}

function buildWorld(): World {
  return {
    adminRow: { totpEnabled: false, isActive: true },
    linkExists: true,
    whitelistedTelegramIds: [],
    secret: generateTotpSecret(),
    signedTokens: [],
    adminUpdates: [],
    linkCreates: [],
  };
}

function buildLoginService(
  world: World,
  options: { readonly withVerifier?: boolean } = {},
): OAuthLoginService {
  const prismaService = {
    adminOAuthLink: {
      findUnique: async () =>
        world.linkExists ? { id: 'link-1', adminUserId: ADMIN_ID } : null,
      update: async (args: unknown) => args,
      create: async (args: { data: Record<string, unknown> }) => {
        world.linkCreates.push(args.data);
        return args.data;
      },
    },
    adminUser: {
      // One fake, two real callers. `TwoFactorService` selects the 2FA
      // columns; `OAuthLoginService` selects the identity columns. Splitting on
      // the select keeps the fake honest for both instead of inventing a
      // friendlier service for one of them.
      findUnique: async (args: { select?: Record<string, unknown> }) => {
        if (args.select && 'totpSecretEncrypted' in args.select) {
          return {
            totpEnabled: world.adminRow.totpEnabled,
            totpSecretEncrypted: encryptTotpSecret(world.secret, CRYPT_KEY),
            totpRecoveryCodes: [],
          };
        }
        if (args.select && 'tokenVersion' in args.select) {
          return {
            id: ADMIN_ID,
            login: 'operator',
            name: 'Operator',
            role: 'DEV',
            isActive: world.adminRow.isActive,
            tokenVersion: 1,
            rbacRoleId: null,
            totpEnabled: world.adminRow.totpEnabled,
          };
        }
        return { id: ADMIN_ID, isActive: world.adminRow.isActive };
      },
      update: async (args: { data: Record<string, unknown> }) => {
        world.adminUpdates.push(args.data);
        return args.data;
      },
    },
    authProviderConfig: {
      findUnique: async () => ({
        allowedEmails: [],
        allowedTelegramIds: world.whitelistedTelegramIds,
      }),
    },
  } as unknown as PrismaService;

  const twoFactorService = new TwoFactorService(
    prismaService,
    { cryptKey: CRYPT_KEY, serviceName: 'Rezeis Admin' } as never,
    new FakeCache() as unknown as RawCacheService,
  );

  const jwtService = {
    signAsync: async (): Promise<string> => {
      const token = `token-${world.signedTokens.length + 1}`;
      world.signedTokens.push(token);
      return token;
    },
  } as unknown as JwtService;

  const moduleRef = {
    get: (token: unknown): unknown => {
      if (token === TwoFactorService) return twoFactorService;
      throw new Error('unexpected ModuleRef lookup');
    },
  };

  return new OAuthLoginService(
    prismaService,
    jwtService,
    AUTH_CONFIG as never,
    options.withVerifier === false ? undefined : (moduleRef as never),
  );
}

function telegramProfile(): OAuthUserProfile {
  return {
    providerId: TELEGRAM_ID,
    providerType: AuthProviderType.TELEGRAM,
    email: null,
    name: 'Operator',
    avatarUrl: null,
    rawProfile: { id: TELEGRAM_ID },
  };
}

function currentCode(secret: string): string {
  return computeTotpCode(base32Decode(secret), Math.floor(Date.now() / 1000));
}

describe('OAuthLoginService — a provider assertion is one factor, not two', () => {
  it('still issues a token for an admin without 2FA', async () => {
    // The fix must not turn OAuth login off for everyone.
    const world = buildWorld();
    const service = buildLoginService(world);
    const result = await service.processOAuthLogin(telegramProfile());
    assert.equal(result.accessToken, 'token-1');
    assert.equal(result.tokenType, 'Bearer');
  });

  it('refuses to sign a token when 2FA is on and no code came with the login', async () => {
    const world = buildWorld();
    world.adminRow.totpEnabled = true;
    const service = buildLoginService(world);

    await assert.rejects(
      () => service.processOAuthLogin(telegramProfile()),
      (err: unknown) =>
        err instanceof UnauthorizedException &&
        (err.getResponse() as { message?: string }).message === 'totp_required',
      'a 24h admin JWT was issued to a provider identity alone. Whoever ' +
        'controls the linked Telegram or GitHub account is now signed in as ' +
        'the operator, with neither password nor code.',
    );

    assert.deepStrictEqual(
      world.signedTokens,
      [],
      'a token was signed despite the refusal',
    );
    assert.deepStrictEqual(
      world.adminUpdates,
      [],
      '`lastLoginAt` was stamped for a login that did not happen',
    );
  });

  it('refuses a wrong code, and does not label it `totp_required`', async () => {
    // `totp_required` means "start the second step". A rejected code carrying
    // that label would send the form round the loop with the operator's typo
    // silently swallowed — the same trap the password path documents.
    const world = buildWorld();
    world.adminRow.totpEnabled = true;
    const service = buildLoginService(world);

    await assert.rejects(
      () => service.processOAuthLogin(telegramProfile(), { totpCode: '000000' }),
      (err: unknown) =>
        err instanceof UnauthorizedException &&
        (err.getResponse() as { message?: string }).message === 'Invalid verification code',
    );
    assert.deepStrictEqual(world.signedTokens, []);
  });

  it('issues a token when a valid code comes with the login', async () => {
    const world = buildWorld();
    world.adminRow.totpEnabled = true;
    const service = buildLoginService(world);

    const result = await service.processOAuthLogin(telegramProfile(), {
      totpCode: currentCode(world.secret),
    });
    assert.equal(result.accessToken, 'token-1');
  });

  it('consumes the code, so the same one cannot sign a second OAuth session', async () => {
    // The single-use claim and this gate have to hold together: a gate that
    // accepted a replayed code would give back exactly what the replay fix
    // took away.
    const world = buildWorld();
    world.adminRow.totpEnabled = true;
    const service = buildLoginService(world);
    const code = currentCode(world.secret);

    await service.processOAuthLogin(telegramProfile(), { totpCode: code });
    await assert.rejects(
      () => service.processOAuthLogin(telegramProfile(), { totpCode: code }),
      UnauthorizedException,
      'the same code signed two OAuth sessions',
    );
    assert.equal(world.signedTokens.length, 1);
  });

  it('gates the auto-link path too', async () => {
    // Two ways in, one gate. The auto-link branch reaches `issueTokenForAdmin`
    // by its own route, and a gate placed on only the already-linked branch
    // would leave the more permissive one open.
    const world = buildWorld();
    world.adminRow.totpEnabled = true;
    world.linkExists = false;
    world.whitelistedTelegramIds = [BigInt(TELEGRAM_ID)];
    const service = buildLoginService(world);

    const profile = { ...telegramProfile(), email: 'operator@example.test' };
    await assert.rejects(
      () => service.processOAuthLogin(profile),
      (err: unknown) =>
        err instanceof UnauthorizedException &&
        (err.getResponse() as { message?: string }).message === 'totp_required',
      'an admin auto-linked by email walked in without the second factor',
    );
    assert.deepStrictEqual(world.signedTokens, []);
  });

  it('fails CLOSED when the verifier cannot be resolved', async () => {
    // `AdminAuthService` treats an unresolvable `TwoFactorService` as "no 2FA
    // configured" and continues; it can afford to, because it already checked
    // a password. Here the provider assertion is the ONLY other factor, so a
    // missing verifier has to refuse.
    //
    // Matched on the message too, like every sibling above. `UnauthorizedException`
    // alone lets this refusal be relabelled `totp_required`, and that label is
    // not a wording choice: the SPA branches on it and renders the code prompt.
    // A wiring failure would come back as "enter your code", the code the
    // operator types would be checked by the verifier that does not exist, and
    // the form would ask again — an unbreakable loop where an error belongs.
    const world = buildWorld();
    world.adminRow.totpEnabled = true;
    const service = buildLoginService(world, { withVerifier: false });

    await assert.rejects(
      () => service.processOAuthLogin(telegramProfile(), { totpCode: currentCode(world.secret) }),
      (err: unknown) => {
        assert.ok(err instanceof UnauthorizedException, `expected 401, got ${String(err)}`);
        const message = (err.getResponse() as { message?: string }).message;
        assert.notEqual(
          message,
          'totp_required',
          'a wiring failure is being reported to the SPA as the second-factor ' +
            'pivot. The sign-in form will ask for a code that no code can ' +
            'satisfy, forever, instead of showing an error.',
        );
        assert.equal(message, 'Invalid verification code');
        return true;
      },
      'a token was issued on one factor because the verifier was missing',
    );
    assert.deepStrictEqual(world.signedTokens, []);
    assert.deepStrictEqual(
      world.adminUpdates,
      [],
      '`lastLoginAt` was stamped for a login that did not happen',
    );
  });

  it('fails CLOSED on the auto-link path as well', async () => {
    // Finding 3b, pinned rather than asserted in prose: BOTH routes into
    // `issueTokenForAdmin()` go through `assertSecondFactor()`, so both inherit
    // the fail-closed branch. The auto-link route is the more permissive one —
    // it mints the link before it ever reaches the gate — so a gate that held
    // only on the already-linked route would leave the wider door open.
    const world = buildWorld();
    world.adminRow.totpEnabled = true;
    world.linkExists = false;
    world.whitelistedTelegramIds = [BigInt(TELEGRAM_ID)];
    const service = buildLoginService(world, { withVerifier: false });

    const profile = { ...telegramProfile(), email: 'operator@example.test' };
    await assert.rejects(
      () => service.processOAuthLogin(profile, { totpCode: currentCode(world.secret) }),
      (err: unknown) =>
        err instanceof UnauthorizedException &&
        (err.getResponse() as { message?: string }).message === 'Invalid verification code',
      'an auto-linked admin got a token on one factor because the verifier ' +
        'was missing — the fail-closed branch is not on this route',
    );
    assert.deepStrictEqual(world.signedTokens, []);
  });
});

// ── The wire ─────────────────────────────────────────────────────────────────

describe('POST admin/oauth/telegram/login — the refusal as the browser receives it', () => {
  let application: INestApplication;
  let world: World;
  let widgetDataSeen: Record<string, string> | null;

  before(async () => {
    world = buildWorld();
    const loginService = buildLoginService(world);

    const telegramAuth = {
      verifyTelegramLogin: async (data: Record<string, string>): Promise<OAuthUserProfile> => {
        widgetDataSeen = data;
        return telegramProfile();
      },
    } as unknown as TelegramAuthService;

    const testingModule: TestingModule = await Test.createTestingModule({
      controllers: [OAuthPublicController],
      providers: [
        { provide: OAuthConfigService, useValue: { getEnabledProviders: async () => [] } },
        { provide: TelegramAuthService, useValue: telegramAuth },
        { provide: GitHubAuthService, useValue: {} },
        { provide: OAuthLoginService, useValue: loginService },
      ],
    }).compile();

    application = testingModule.createNestApplication();
    // Mirrors main.ts: same prefix, same pipe, same filter. The filter is the
    // part that historically ate the field this test is about.
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
    world.adminRow = { totpEnabled: true, isActive: true };
    world.linkExists = true;
    world.signedTokens.length = 0;
    world.adminUpdates.length = 0;
    widgetDataSeen = null;
  });

  it('delivers code: "totp_required" in the body the sign-in form parses', async () => {
    const response = await request(application.getHttpServer())
      .post('/api/admin/oauth/telegram/login')
      .send({ id: TELEGRAM_ID, auth_date: '1', hash: 'x' });

    assert.equal(
      (response.body as { code?: string }).code,
      'totp_required',
      'the refusal reached the client without `code: "totp_required"`. ' +
        'AdminSafeExceptionFilter forwards only codes listed in ' +
        'SAFE_PRODUCT_CODES, and sign-in-page.tsx compares against that exact ' +
        'literal — any other spelling is deleted in transit and invisible.',
    );
    assert.equal(response.status, 401);
    assert.equal(
      (response.body as { message?: string }).message,
      'Two-factor authentication required',
    );
    assert.equal(
      (response.body as { accessToken?: string }).accessToken,
      undefined,
      'the refusal shipped a token',
    );
  });

  it('lifts `totpCode` out of the body before the Telegram signature is checked', async () => {
    // The widget signs every field it sends and `verifyTelegramLogin()`
    // recomputes the HMAC over everything except `hash`. Leaving our own field
    // in the record would reject a perfectly good login with "invalid hash" —
    // a failure that would look like a Telegram problem and be debugged
    // nowhere near this line.
    world.adminRow.totpEnabled = false;

    const response = await request(application.getHttpServer())
      .post('/api/admin/oauth/telegram/login')
      .send({ id: TELEGRAM_ID, auth_date: '1', hash: 'x', totpCode: '123456' });

    assert.equal(response.status, 201);
    assert.ok(widgetDataSeen, 'the Telegram verifier never ran');
    assert.equal(
      'totpCode' in widgetDataSeen,
      false,
      '`totpCode` was passed through to the HMAC check, which signs every ' +
        'field but `hash` — the signature can no longer match',
    );
    assert.equal(widgetDataSeen['id'], TELEGRAM_ID, 'the widget fields were dropped instead');
  });

  it('completes the login when a valid code travels with the widget data', async () => {
    const response = await request(application.getHttpServer())
      .post('/api/admin/oauth/telegram/login')
      .send({
        id: TELEGRAM_ID,
        auth_date: '1',
        hash: 'x',
        totpCode: currentCode(world.secret),
      });

    assert.equal(response.status, 201);
    assert.equal((response.body as { accessToken?: string }).accessToken, 'token-1');
  });
});
