import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ArgumentsHost } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccessMode, Currency, ExternalAuthProvider, Prisma } from '@prisma/client';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { BlockedIdentityService } from '../src/modules/blocked-identities/services/blocked-identity.service';
import { EmailDeliveryService } from '../src/modules/email/services/email-delivery.service';
import type { ExternalAuthPolicy, ExternalUserProfile } from '../src/modules/external-auth/interfaces/external-auth.interface';
import { DisposableEmailService } from '../src/modules/external-auth/services/disposable-email.service';
import {
  EXTERNAL_EMAIL_UNVERIFIED_ACCOUNT,
  ExternalAuthService,
} from '../src/modules/external-auth/services/external-auth.service';
import { ExternalProviderConfigService } from '../src/modules/external-auth/services/external-provider-config.service';
import { GoogleOAuthAdapter } from '../src/modules/external-auth/services/providers/google-oauth.adapter';
import { MailruOAuthAdapter } from '../src/modules/external-auth/services/providers/mailru-oauth.adapter';
import { TelegramOidcAdapter } from '../src/modules/external-auth/services/providers/telegram-oidc.adapter';
import { YandexOAuthAdapter } from '../src/modules/external-auth/services/providers/yandex-oauth.adapter';
import type { InternalPlatformPolicyInterface } from '../src/modules/settings/interfaces/internal-platform-policy.interface';
import { AccessModeGuard } from '../src/modules/settings/services/access-mode-guard.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import { RegistrationSnapshotService } from '../src/modules/web-auth/services/registration-snapshot.service';

/**
 * Sign-in with Google, Yandex or Mail.ru never walks into an account by an
 * e-mail WE never verified
 * ══════════════════════════════════════════════════════════════════════════
 * A provider's `email_verified` proves that whoever signed in owns the
 * address today. It proves nothing about the account in OUR database that
 * carries the same address. AltShop imports bring the donor's e-mail over
 * unverified, and without a password — so whoever owns a mistyped address, or
 * one re-registered since, signed in with Google and landed in that account,
 * and set its password on `/auth/ext/finish-setup` or `/auth/first-password`.
 *
 * The auto-link now needs OUR `emailVerifiedAt`. An account whose address we
 * never verified is refused: no link, no session for it, a 409 with a code the
 * cabinet turns into a sentence — never a 500, and never a second account
 * colliding with the first on the unique address. An account we did verify
 * still links exactly as before.
 */

interface AccountRow {
  readonly id: string;
  readonly userId: string;
  readonly email: string | null;
  readonly emailNormalized: string | null;
  readonly emailVerifiedAt: Date | null;
  readonly passwordHash: string | null;
  readonly isBlocked: boolean;
}

interface LinkRow {
  readonly userId: string;
  readonly provider: ExternalAuthProvider;
  readonly providerUserId: string;
}

/** What the branch that decides the auto-link reads: OUR verification among it. */
const EMAIL_MATCH_FIELDS = ['emailVerifiedAt', 'passwordHash', 'user', 'userId'];
/** The code the cabinet branches on — a wire contract, written out. */
const REFUSAL_CODE = 'EXTERNAL_EMAIL_UNVERIFIED_ACCOUNT';

/**
 * The rows `resolve` reads and writes, served the way Postgres would: the
 * address is unique on `web_accounts`, and a second row with it fails the
 * insert exactly as the constraint does (P2002).
 */
function world(accounts: AccountRow[]) {
  const rows = [...accounts];
  const links: LinkRow[] = [];
  const users: string[] = [];
  /** The fields each lookup by address read. */
  const emailMatchSelects: string[][] = [];
  const createUser = async (args: { data: { name: string }; select: { id: true } }) => {
    const id = `new-user-${users.length + 1}`;
    users.push(id);
    assert.equal(typeof args.data.name, 'string');
    return { id };
  };
  const createWebAccount = async (args: {
    data: { userId: string; email: string | null; emailNormalized: string | null; emailVerifiedAt: Date | null };
    select: { id: true };
  }) => {
    const { emailNormalized } = args.data;
    if (emailNormalized !== null && rows.some((row) => row.emailNormalized === emailNormalized)) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email_normalized`)', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['email_normalized'] },
      });
    }
    const id = `new-wa-${rows.length + 1}`;
    rows.push({ id, passwordHash: null, isBlocked: false, ...args.data });
    return { id };
  };
  const createLink = async (args: { data: LinkRow & Record<string, unknown> }) => {
    links.push({ userId: args.data.userId, provider: args.data.provider, providerUserId: args.data.providerUserId });
    return { id: `link-${links.length}` };
  };
  const findAccount = async (args: {
    where: { emailNormalized?: string; userId?: string };
    select: Record<string, unknown>;
  }) => {
    const { emailNormalized, userId } = args.where;
    const row = rows.find((candidate) =>
      emailNormalized !== undefined ? candidate.emailNormalized === emailNormalized : candidate.userId === userId,
    );
    if (row === undefined) return null;
    const full: Record<string, unknown> = {
      id: row.id,
      userId: row.userId,
      passwordHash: row.passwordHash,
      emailVerifiedAt: row.emailVerifiedAt,
      user: { isBlocked: row.isBlocked },
    };
    // As Prisma answers: the fields the query selected, and no others.
    return Object.fromEntries(Object.keys(args.select).map((field) => [field, full[field]]));
  };
  const prisma = {
    userOAuthLink: {
      findUnique: async (args: {
        where: { provider_providerUserId: { provider: ExternalAuthProvider; providerUserId: string } };
      }) => {
        const key = args.where.provider_providerUserId;
        const link = links.find((row) => row.provider === key.provider && row.providerUserId === key.providerUserId);
        return link === undefined ? null : { id: 'link', userId: link.userId, user: { isBlocked: false } };
      },
      create: createLink,
    },
    webAccount: {
      findUnique: async (args: { where: { emailNormalized?: string; userId?: string }; select: Record<string, unknown> }) => {
        if (args.where.emailNormalized !== undefined) emailMatchSelects.push(Object.keys(args.select).sort());
        return findAccount(args);
      },
    },
    $transaction: async <R>(
      fn: (tx: {
        user: { create: typeof createUser };
        webAccount: { create: typeof createWebAccount; findUnique: typeof findAccount };
        userOAuthLink: { create: typeof createLink };
      }) => Promise<R>,
    ): Promise<R> => fn({ user: { create: createUser }, webAccount: { create: createWebAccount, findUnique: findAccount }, userOAuthLink: { create: createLink } }),
  };
  return { rows, links, users, emailMatchSelects, prisma };
}

const OPEN_POLICY: ExternalAuthPolicy = { mode: 'off', customBlocklist: [], allowlist: [], gateProvidersByEmailModule: false };

function platformPolicy(): InternalPlatformPolicyInterface {
  return {
    rulesRequired: false,
    rulesLink: null,
    channelRequired: false,
    channelLink: null,
    channelId: null,
    channelUsername: null,
    channelRecheck: true,
    channelNewUsersSince: null,
    requireTelegramWebCredentials: false,
    subscriptionLinkRecovery: true,
    accessMode: AccessMode.PUBLIC,
    inviteModeStartedAt: null,
    defaultCurrency: Currency.RUB,
    renewalAddOns: false,
  };
}

async function service(db: ReturnType<typeof world>): Promise<ExternalAuthService> {
  const config: Pick<ExternalProviderConfigService, 'getPolicy' | 'isProviderEnabled'> = {
    getPolicy: async () => OPEN_POLICY,
    isProviderEnabled: async () => true,
  };
  const disposable: Pick<DisposableEmailService, 'check'> = { check: async () => ({ allowed: true }) };
  const events: Pick<SystemEventsService, 'info'> = { info: () => undefined };
  const snapshots: Pick<RegistrationSnapshotService, 'captureBestEffort'> = { captureBestEffort: async () => undefined };
  const settings: Pick<SettingsService, 'getInternalPlatformPolicy'> = { getInternalPlatformPolicy: async () => platformPolicy() };
  const blocked: Pick<BlockedIdentityService, 'findFirstMatch'> = { findFirstMatch: async () => null };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ExternalAuthService,
      { provide: PrismaService, useValue: db.prisma },
      { provide: ExternalProviderConfigService, useValue: config },
      { provide: DisposableEmailService, useValue: disposable },
      { provide: SystemEventsService, useValue: events },
      { provide: RegistrationSnapshotService, useValue: snapshots },
      { provide: SettingsService, useValue: settings },
      { provide: BlockedIdentityService, useValue: blocked },
      AccessModeGuard,
      // Not reached by `resolve`: empty, so a call would throw.
      { provide: PasswordHashService, useValue: {} },
      { provide: EmailDeliveryService, useValue: {} },
      { provide: GoogleOAuthAdapter, useValue: {} },
      { provide: YandexOAuthAdapter, useValue: {} },
      { provide: MailruOAuthAdapter, useValue: {} },
      { provide: TelegramOidcAdapter, useValue: {} },
    ],
  }).compile();
  return moduleRef.get(ExternalAuthService);
}

function google(overrides: Partial<ExternalUserProfile> = {}): ExternalUserProfile {
  return {
    provider: ExternalAuthProvider.GOOGLE,
    providerUserId: 'google-sub-1',
    email: 'Donor@Example.com',
    emailVerified: true,
    name: 'Whoever owns the address now',
    avatarUrl: null,
    rawProfile: {},
    ...overrides,
  };
}

/** An account imported from AltShop: the donor's address, never verified by us, and no password. */
const IMPORTED: AccountRow = {
  id: 'wa-imported',
  userId: 'u-imported',
  email: 'donor@example.com',
  emailNormalized: 'donor@example.com',
  emailVerifiedAt: null,
  passwordHash: null,
  isBlocked: false,
};

/** The body the cabinet receives for a refusal, after the panel's filter. */
function wireBody(error: unknown): Record<string, unknown> {
  let body: Record<string, unknown> | undefined;
  let status: number | undefined;
  const response = {
    status: (code: number) => {
      status = code;
      return { json: (payload: Record<string, unknown>) => void (body = payload) };
    },
  };
  const path = '/api/internal/ext-auth/oauth/resolve';
  const request = { headers: {}, ip: '127.0.0.1', socket: {}, originalUrl: path, url: path };
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) } as unknown as ArgumentsHost;
  new AdminSafeExceptionFilter().catch(error, host);
  assert.ok(body !== undefined, 'the filter wrote no body');
  assert.equal(status, body.statusCode);
  return body;
}

async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected a refusal, the sign-in went through');
}

describe('sign-in by a provider’s e-mail and an address we never verified', () => {
  it('does not link the imported account, signs nobody into it, and creates no second account', async () => {
    const db = world([IMPORTED]);
    const auth = await service(db);

    const refusal = await refusalOf(() => auth.resolve(google()));

    assert.deepEqual(db.links, [], 'the provider identity was linked to the imported account');
    assert.deepEqual(db.users, [], 'a second account was minted beside the imported one');
    assert.equal(db.rows.length, 1);
    assert.deepEqual(db.emailMatchSelects, [EMAIL_MATCH_FIELDS], 'the auto-link did not read our verification');
    const body = wireBody(refusal);
    assert.equal(body.statusCode, 409, `a refusal, not a ${String(body.statusCode)}`);
    assert.equal(EXTERNAL_EMAIL_UNVERIFIED_ACCOUNT, REFUSAL_CODE);
    assert.equal(body.code, REFUSAL_CODE, 'the cabinet has no code to say why');
    assert.equal(typeof body.message, 'string');
    assert.notEqual(body.message, 'Request failed', 'the filter scrubbed the message');
  });

  it('refuses the same way when that unverified account has a password', async () => {
    const db = world([{ ...IMPORTED, passwordHash: 'scrypt$someone-else' }]);
    const auth = await service(db);

    const body = wireBody(await refusalOf(() => auth.resolve(google())));

    assert.equal(body.code, REFUSAL_CODE);
    assert.deepEqual(db.links, []);
  });

  it('still links an account whose address we verified, as before', async () => {
    const verified = { ...IMPORTED, emailVerifiedAt: new Date('2026-09-01T00:00:00.000Z') };
    const withPassword = world([{ ...verified, passwordHash: 'scrypt$owner' }]);
    assert.deepEqual(await (await service(withPassword)).resolve(google()), { action: 'login', userId: 'u-imported' });
    assert.deepEqual(withPassword.links.map((link) => link.userId), ['u-imported']);

    const withoutPassword = world([verified]);
    assert.deepEqual(await (await service(withoutPassword)).resolve(google()), {
      action: 'finish_setup',
      userId: 'u-imported',
    });
    assert.deepEqual(withoutPassword.links.map((link) => link.userId), ['u-imported']);
  });

  it('gives a provider e-mail the provider did NOT verify a new account without that address — no collision, no 500', async () => {
    const db = world([IMPORTED]);
    const auth = await service(db);

    const result = await auth.resolve(google({ emailVerified: false }));

    assert.equal(result.action, 'finish_setup');
    assert.deepEqual(db.users, ['new-user-1']);
    const shell = db.rows.find((row) => row.userId === 'new-user-1');
    assert.ok(shell !== undefined, 'no web account for the new identity');
    assert.equal(shell.emailNormalized, null, 'the new account took an address another account holds');
    assert.deepEqual(db.links.map((link) => link.userId), ['new-user-1'], 'the identity was linked to someone else');
  });
});
