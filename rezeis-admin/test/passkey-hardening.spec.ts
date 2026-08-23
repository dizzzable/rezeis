import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { describe, it } from 'node:test';

import { UnauthorizedException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type { KeyObject } from 'node:crypto';

import type { authConfig } from '../src/common/config/auth.config';
import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import type { RawCacheService } from '../src/common/cache/raw-cache.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { AdminAuthController } from '../src/modules/auth/controllers/admin-auth.controller';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { PasskeyPublicController } from '../src/modules/oauth/controllers/passkey.controller';
import { PasskeyService } from '../src/modules/oauth/services/passkey.service';

/**
 * The passkey surface's security contract, exercised through real WebAuthn
 * ceremonies.
 *
 * Nothing here stubs `@simplewebauthn/server`. Every registration and every
 * login below builds a real attestation or assertion — a P-256 key generated
 * per test, a hand-assembled `authenticatorData`, a CBOR attestation object,
 * and a raw ECDSA signature over `authData || SHA-256(clientDataJSON)` — and
 * hands it to the same `verifyRegistrationResponse` / `verifyAuthenticationResponse`
 * production calls. That costs about eighty lines of ceremony builders and buys
 * the one thing a stubbed verifier cannot: when a test here says a login
 * succeeded, a signature was actually checked.
 *
 * It matters for this file in particular. Two of the properties asserted below
 * — that the AAGUID the authenticator reports reaches the database column, and
 * that an assertion without the user-verification flag is refused — are
 * properties OF the library's output. A stub would have to invent both, and
 * would then be asserting the stub.
 */

// ── CBOR, enough of it ──────────────────────────────────────────────────────
//
// `@simplewebauthn/server` ships an encoder, but only behind its `./helpers`
// subpath export, which this project's `moduleResolution` (node10, implied by
// `module: commonjs`) cannot resolve for types. Four major types are needed —
// unsigned int, negative int, byte string, map — and they are 30 lines.

function cborHead(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(value, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(value, 1);
  return out;
}

/** Signed integer: major type 0 for >= 0, major type 1 for < 0. */
function cborInt(value: number): Buffer {
  return value >= 0 ? cborHead(0, value) : cborHead(1, -value - 1);
}

function cborBytes(value: Buffer): Buffer {
  return Buffer.concat([cborHead(2, value.length), value]);
}

function cborText(value: string): Buffer {
  const encoded = Buffer.from(value, 'utf8');
  return Buffer.concat([cborHead(3, encoded.length), encoded]);
}

function cborMap(entries: readonly (readonly [Buffer, Buffer])[]): Buffer {
  return Buffer.concat([
    cborHead(5, entries.length),
    ...entries.map(([key, value]) => Buffer.concat([key, value])),
  ]);
}

// ── A software authenticator ────────────────────────────────────────────────

const RP_ID = 'panel.example.com';
const ORIGIN = `https://${RP_ID}`;

/** WebAuthn authenticator-data flags. */
const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified — the PIN/biometric this file turns on
const FLAG_AT = 0x40; // attested credential data follows

interface SoftAuthenticator {
  readonly credentialId: string;
  readonly aaguid: Buffer;
  /** A registration ceremony's `response` payload, for a given challenge. */
  attestation(challenge: string, flags?: number): Record<string, unknown>;
  /** An authentication ceremony's `response` payload, for a given challenge. */
  assertion(challenge: string, flags?: number): Record<string, unknown>;
}

function createAuthenticator(aaguidHex: string): SoftAuthenticator {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  // COSE_Key for ES256: kty=EC2(2), alg=ES256(-7), crv=P-256(1), x, y.
  const cosePublicKey = cborMap([
    [cborInt(1), cborInt(2)],
    [cborInt(3), cborInt(-7)],
    [cborInt(-1), cborInt(1)],
    [cborInt(-2), cborBytes(Buffer.from(jwk.x, 'base64url'))],
    [cborInt(-3), cborBytes(Buffer.from(jwk.y, 'base64url'))],
  ]);

  const aaguid = Buffer.from(aaguidHex.replace(/-/g, ''), 'hex');
  const rawCredentialId = randomBytes(32);
  const credentialId = rawCredentialId.toString('base64url');
  const rpIdHash = createHash('sha256').update(RP_ID).digest();

  function authData(flags: number, signCount: number, attested: boolean): Buffer {
    const header = Buffer.alloc(37);
    rpIdHash.copy(header, 0);
    header[32] = flags;
    header.writeUInt32BE(signCount, 33);
    if (!attested) return header;
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(rawCredentialId.length, 0);
    return Buffer.concat([header, aaguid, idLength, rawCredentialId, cosePublicKey]);
  }

  function clientData(type: string, challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }),
      'utf8',
    );
  }

  return {
    credentialId,
    aaguid,
    attestation(challenge, flags = FLAG_UP | FLAG_UV | FLAG_AT): Record<string, unknown> {
      const attestationObject = cborMap([
        [cborText('fmt'), cborText('none')],
        [cborText('attStmt'), cborMap([])],
        [cborText('authData'), cborBytes(authData(flags, 0, true))],
      ]);
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: clientData('webauthn.create', challenge).toString('base64url'),
          attestationObject: attestationObject.toString('base64url'),
          transports: ['internal'],
        },
      };
    },
    assertion(challenge, flags = FLAG_UP | FLAG_UV): Record<string, unknown> {
      const data = authData(flags, 1, false);
      const clientDataJSON = clientData('webauthn.get', challenge);
      const signatureBase = Buffer.concat([
        data,
        createHash('sha256').update(clientDataJSON).digest(),
      ]);
      // DER, which is Node's default and what a real authenticator emits for
      // ES256: `unwrapEC2Signature` in the library's CJS build parses the
      // ASN.1 SEQUENCE before handing r||s to WebCrypto, and rejects raw bytes.
      const signature = cryptoSign('sha256', signatureBase, {
        key: privateKey as KeyObject,
      });
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          authenticatorData: data.toString('base64url'),
          signature: signature.toString('base64url'),
          userHandle: null,
        },
      };
    },
  };
}

// ── Fakes for everything that is not the subject ────────────────────────────

interface AdminRow {
  id: string;
  login: string;
  loginNormalized: string;
  name: string | null;
  role: string;
  isActive: boolean;
  tokenVersion: number;
  rbacRoleId: string | null;
  totpEnabled: boolean;
  passwordHash: string;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
}

interface PasskeyRow {
  id: string;
  adminUserId: string;
  name: string;
  credentialId: string;
  publicKey: string;
  counter: bigint;
  transports: string[];
  backedUp: boolean;
  aaguid: string | null;
  registeredAt: Date;
  lastUsedAt: Date | null;
}

interface AuditRow {
  action: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  adminUserId: string | null;
}

interface LoginAttempt {
  loginNormalized: string;
  ipAddress: string;
  success: boolean;
  reason: string | null;
}

function createPrisma(admin: AdminRow) {
  const admins = new Map<string, AdminRow>([[admin.id, admin]]);
  const passkeys: PasskeyRow[] = [];
  const audit: AuditRow[] = [];
  let passkeySequence = 0;

  function applyUpdate(row: AdminRow, data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === 'object' && 'increment' in (value as object)) {
        const current = (row as unknown as Record<string, number>)[key];
        (row as unknown as Record<string, number>)[key] =
          current + (value as { increment: number }).increment;
        continue;
      }
      (row as unknown as Record<string, unknown>)[key] = value;
    }
  }

  const prisma = {
    adminUser: {
      findUnique: async ({ where }: { where: { id: string } }): Promise<AdminRow | null> =>
        admins.get(where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }): Promise<AdminRow> => {
        const row = admins.get(where.id);
        if (!row) throw new Error(`no admin ${where.id}`);
        applyUpdate(row, data);
        return row;
      },
    },
    adminPasskey: {
      findMany: async ({
        where,
      }: {
        where: { adminUserId: string };
      }): Promise<PasskeyRow[]> => passkeys.filter((p) => p.adminUserId === where.adminUserId),
      findUnique: async ({
        where,
      }: {
        where: { credentialId: string };
      }): Promise<PasskeyRow | null> =>
        passkeys.find((p) => p.credentialId === where.credentialId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }): Promise<PasskeyRow> => {
        passkeySequence += 1;
        const row: PasskeyRow = {
          id: `pk-${passkeySequence}`,
          registeredAt: new Date('2026-08-19T10:00:00.000Z'),
          lastUsedAt: null,
          ...(data as unknown as Omit<PasskeyRow, 'id' | 'registeredAt' | 'lastUsedAt'>),
        };
        passkeys.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }): Promise<PasskeyRow> => {
        const row = passkeys.find((p) => p.id === where.id);
        if (!row) throw new Error(`no passkey ${where.id}`);
        Object.assign(row, data);
        return row;
      },
      updateMany: async (): Promise<{ count: number }> => ({ count: 0 }),
      deleteMany: async ({
        where,
      }: {
        where: { id: string; adminUserId: string };
      }): Promise<{ count: number }> => {
        const index = passkeys.findIndex(
          (p) => p.id === where.id && p.adminUserId === where.adminUserId,
        );
        if (index === -1) return { count: 0 };
        passkeys.splice(index, 1);
        return { count: 1 };
      },
    },
    adminAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }): Promise<AuditRow> => {
        const connect = data.adminUser as { connect?: { id: string } } | undefined;
        const row: AuditRow = {
          action: data.action as string,
          ipAddress: (data.ipAddress as string | null) ?? null,
          userAgent: (data.userAgent as string | null) ?? null,
          metadata: data.metadata as Record<string, unknown>,
          adminUserId: connect?.connect?.id ?? null,
        };
        audit.push(row);
        return row;
      },
    },
  };

  return { prisma: prisma as unknown as PrismaService, admins, passkeys, audit };
}

function createCache() {
  // JSON round-tripped exactly as Redis does it, so a field that survives here
  // is a field that survives in production.
  const store = new Map<string, string>();
  const cache = {
    get: async <T>(key: string): Promise<T | null> => {
      const raw = store.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    set: async (key: string, value: unknown): Promise<void> => {
      store.set(key, JSON.stringify(value));
    },
    del: async (key: string): Promise<void> => {
      store.delete(key);
    },
  };
  return { cache: cache as unknown as RawCacheService, store };
}

const jwtService = {
  signAsync: async (payload: Record<string, unknown>): Promise<string> =>
    `jwt:${JSON.stringify(payload)}`,
} as unknown as JwtService;

const authConfiguration = { jwtExpiresIn: '24h' } as unknown as ConfigType<typeof authConfig>;

interface TwoFactorCalls {
  readonly verifyForLogin: { adminId: string; code: string }[];
}

/**
 * Stands in for `TwoFactorService`, whose file belongs to another change.
 *
 * The contract borrowed is one method: `verifyForLogin(adminId, code)` answers
 * true or false and never throws — the same method `TwoFactorService.disable`
 * calls to refuse a hijacked session. What is under test is what
 * `PasskeyService` DOES with that answer, so every test that uses this double
 * also asserts it was CALLED, and with which code. A double nobody consults
 * would otherwise be indistinguishable from a check that passed.
 */
function createTwoFactor(acceptedCodes: readonly string[]): {
  double: unknown;
  calls: TwoFactorCalls;
} {
  const calls: TwoFactorCalls = { verifyForLogin: [] };
  return {
    calls,
    double: {
      verifyForLogin: async (adminId: string, code: string): Promise<boolean> => {
        calls.verifyForLogin.push({ adminId, code });
        return acceptedCodes.includes(code);
      },
    },
  };
}

function createLoginGuard(rateLimited = false): {
  double: unknown;
  attempts: LoginAttempt[];
  rateLimitChecks: { ipAddress: string; loginNormalized: string }[];
} {
  const attempts: LoginAttempt[] = [];
  const rateLimitChecks: { ipAddress: string; loginNormalized: string }[] = [];
  return {
    attempts,
    rateLimitChecks,
    double: {
      isRateLimited: async (ipAddress: string, loginNormalized: string): Promise<boolean> => {
        rateLimitChecks.push({ ipAddress, loginNormalized });
        return rateLimited;
      },
      recordAttempt: async (input: LoginAttempt): Promise<{ autoBlocked: boolean }> => {
        attempts.push(input);
        return { autoBlocked: false };
      },
    },
  };
}

/**
 * A `ModuleRef` that resolves by provider CLASS NAME.
 *
 * `PasskeyService` looks its collaborators up with
 * `moduleRef.get(Class, { strict: false })` after `require`-ing the real
 * modules, so the tokens arriving here are the genuine classes. A name absent
 * from `providers` throws, which is exactly what a missing provider does in
 * Nest — and the service is required to treat that as a FAILED check.
 */
function createModuleRef(providers: Record<string, unknown>): ModuleRef {
  return {
    get: (token: unknown): unknown => {
      const name = (token as { name?: string } | undefined)?.name ?? '<anonymous>';
      if (!(name in providers)) {
        throw new Error(`provider ${name} is not registered`);
      }
      return providers[name];
    },
  } as unknown as ModuleRef;
}

const REQUEST = {
  requestId: 'req-1',
  remoteAddress: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (test)',
};

interface Harness {
  service: PasskeyService;
  prisma: ReturnType<typeof createPrisma>;
  cache: ReturnType<typeof createCache>;
  twoFactor: ReturnType<typeof createTwoFactor>;
  loginGuard: ReturnType<typeof createLoginGuard>;
  admin: AdminRow;
}

const passwordHashService = new PasswordHashService();

async function createHarness(options?: {
  totpEnabled?: boolean;
  password?: string;
  acceptedCodes?: readonly string[];
  rateLimited?: boolean;
  /** Omit a provider to reproduce a wiring failure. */
  omitProviders?: readonly string[];
}): Promise<Harness> {
  const admin: AdminRow = {
    id: 'admin-1',
    login: 'Operator',
    loginNormalized: 'operator',
    name: 'The Operator',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 3,
    rbacRoleId: 'role-1',
    totpEnabled: options?.totpEnabled ?? false,
    passwordHash: await passwordHashService.hashPassword({
      plainTextPassword: options?.password ?? 'correct horse battery staple',
      audience: 'admin',
    }),
    lastLoginAt: null,
    lastLoginIp: null,
  };

  const prisma = createPrisma(admin);
  const cache = createCache();
  const twoFactor = createTwoFactor(options?.acceptedCodes ?? ['123456']);
  const loginGuard = createLoginGuard(options?.rateLimited ?? false);

  const providers: Record<string, unknown> = {
    TwoFactorService: twoFactor.double,
    LoginGuardService: loginGuard.double,
    PasswordHashService: passwordHashService,
  };
  for (const omitted of options?.omitProviders ?? []) {
    delete providers[omitted];
  }

  const service = new PasskeyService(
    prisma.prisma,
    cache.cache,
    jwtService,
    authConfiguration,
    createModuleRef(providers),
  );

  return { service, prisma, cache, twoFactor, loginGuard, admin };
}

/** Runs a passkey enrolment end to end and returns the stored row. */
async function enrol(
  harness: Harness,
  authenticator: SoftAuthenticator,
  reauth: { code?: string; password?: string },
): Promise<PasskeyRow> {
  const options = (await harness.service.generateRegistrationOptions(
    harness.admin.id,
    RP_ID,
    reauth,
    REQUEST,
  )) as { challenge: string };
  await harness.service.verifyRegistration(
    harness.admin.id,
    RP_ID,
    ORIGIN,
    authenticator.attestation(options.challenge) as never,
    'Test key',
    REQUEST,
  );
  const row = harness.prisma.passkeys[harness.prisma.passkeys.length - 1];
  assert.ok(row, 'enrolment did not store a credential');
  return row;
}

/** Runs a passkey login end to end and returns the issued token. */
async function signIn(
  harness: Harness,
  authenticator: SoftAuthenticator,
  flags?: number,
): Promise<string> {
  const options = (await harness.service.generateAuthenticationOptions(RP_ID)) as {
    challenge: string;
  };
  const result = await harness.service.verifyAuthentication(
    RP_ID,
    ORIGIN,
    authenticator.assertion(options.challenge, flags) as never,
    REQUEST,
  );
  return result.accessToken;
}

// ── What the operator's browser actually receives ───────────────────────────
//
// These helpers used to read `error.getResponse()` — the exception object, as
// the service constructed it. Nothing in production ever sees that. Every
// response leaves through `AdminSafeExceptionFilter`, registered globally in
// `main.ts`, which rebuilds the body from scratch and forwards `code` only
// from an allowlist and `factor` only from a second one.
//
// That gap is not hypothetical: it is where this file was green while the
// feature was broken for every real client. `passkey_reauth_required` was not
// on the allowlist, so the 401 reached the SPA bare — untyped, factorless, and
// indistinguishable from an expired session. Asserting against the exception
// could not see it, and would not see it come back.
//
// So the filter runs here, on the real thrown exception, and the assertions
// are made on the body it hands to `response.json(...)`.

interface WireResponse {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

/**
 * Drives the real filter with a minimal `ArgumentsHost`, capturing the status
 * and body it writes. The request is a plain enrolment path with no request id,
 * so nothing in the fixture can influence which fields survive.
 */
function throughSafeFilter(exception: unknown): WireResponse {
  let statusCode = 0;
  let body: Record<string, unknown> = {};
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(payload: unknown) {
      body = (payload ?? {}) as Record<string, unknown>;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: '/api/admin/passkey/register/options', headers: {} }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  new AdminSafeExceptionFilter().catch(exception, host);
  return { statusCode, body };
}

/** The response body as it goes on the wire — never the exception object. */
function payloadOf(error: unknown): Record<string, unknown> {
  return throughSafeFilter(error).body;
}

function messageOf(error: unknown): string {
  return String(payloadOf(error).message);
}

// ── 1. Enrolment demands a factor the bearer token does not carry ───────────

describe('passkey enrolment demands a fresh factor', () => {
  /**
   * The whole finding in one test. A stolen bearer token got an attacker past
   * `AdminJwtAuthGuard`, and nothing else stood between it and a permanently
   * enrolled authenticator — one that afterwards mints 24 h sessions without
   * the password and without the TOTP code, and that changing the password
   * does not revoke.
   */
  it('refuses a bearer token on its own, and names the factor it wants', async () => {
    const harness = await createHarness({ totpEnabled: true });

    const error = await harness.service
      .generateRegistrationOptions(harness.admin.id, RP_ID, {}, REQUEST)
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.ok(error, 'a session alone must not be enough to enrol an authenticator');
    const wire = throughSafeFilter(error);
    assert.equal(wire.statusCode, 401, 'the status the operator actually gets');
    assert.equal(wire.body.statusCode, 401);
    assert.equal(wire.body.code, 'passkey_reauth_required');
    assert.equal(wire.body.factor, 'totp', 'a 2FA account must be asked for its code');
    assert.equal(wire.body.message, 'Confirm it is you before adding a passkey');
    // And no challenge was parked, so `register/verify` has nothing to accept.
    assert.equal(harness.cache.store.size, 0);
  });

  it('is a TYPED 401 on the wire, not the bare one that reads as a dead session', async () => {
    // The failure this file could not see. `AdminSafeExceptionFilter` rebuilds
    // every error body and forwards `code` only from an allowlist, so for as
    // long as `passkey_reauth_required` was missing from it the operator got a
    // 401 carrying no code and no factor — the exact shape the SPA's axios
    // interceptor spends on "your session expired". Opening the enrol dialog
    // signed the operator out.
    //
    // Asserting the whole key set, in both directions: the two fields have to
    // arrive, and nothing beyond the known envelope may ride along with them.
    // A `factor` passthrough written loosely enough to forward one arbitrary
    // field is a hole for the next one.
    const harness = await createHarness({ totpEnabled: true });

    const error = await harness.service
      .generateRegistrationOptions(harness.admin.id, RP_ID, {}, REQUEST)
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.deepStrictEqual(
      Object.keys(throughSafeFilter(error).body).sort(),
      ['code', 'errorCode', 'factor', 'message', 'path', 'requestId', 'statusCode', 'timestamp'],
    );
  });

  it('drops a factor that is neither of the two credentials the panel can demand', () => {
    // The value is matched, never copied. A thrower that names something the
    // panel cannot prompt for — or parks anything else in that field — leaves
    // nothing behind, so the allowlist cannot be turned into a general channel
    // for exception internals by choosing a different `factor`.
    const smuggled = new UnauthorizedException({
      statusCode: 401,
      code: 'passkey_reauth_required',
      factor: '/srv/rezeis/admin/src/modules/oauth/services/passkey.service.ts:679',
      adminId: 'admin-1',
      message: 'Confirm it is you before adding a passkey',
    });

    const body = throughSafeFilter(smuggled).body;
    assert.equal(body.code, 'passkey_reauth_required');
    assert.equal('factor' in body, false, 'an unrecognised factor must not be forwarded');
    assert.equal('adminId' in body, false, 'and neither may its neighbours');
  });

  it('will not attach a factor to a product code that has no business carrying one', () => {
    // Two allowlists, not one. `totp_required` is a sibling entry in
    // `SAFE_PRODUCT_CODES` and its value here is even a legal factor — it is
    // dropped because that code is not in `CODES_CARRYING_REAUTH_FACTOR`.
    // Without the second gate, adding any future product code would silently
    // open a second field on it.
    const body = throughSafeFilter(
      new UnauthorizedException({
        statusCode: 401,
        code: 'totp_required',
        factor: 'password',
        message: 'Two-factor code required',
      }),
    ).body;

    assert.equal(body.code, 'totp_required');
    assert.equal('factor' in body, false);
  });

  it('asks a passwordless-2FA account for its password instead', async () => {
    const harness = await createHarness({ totpEnabled: false });

    const error = await harness.service
      .generateRegistrationOptions(harness.admin.id, RP_ID, {}, REQUEST)
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.equal(payloadOf(error).factor, 'password');
  });

  it('refuses a wrong TOTP code, consults the real verifier, and audits it', async () => {
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });

    const error = await harness.service
      .generateRegistrationOptions(harness.admin.id, RP_ID, { code: '000000' }, REQUEST)
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.ok(error);
    assert.equal(messageOf(error), 'Invalid verification code');
    // The double was actually asked — "nobody checked" and "the check failed"
    // must not look the same from here.
    assert.deepStrictEqual(harness.twoFactor.calls.verifyForLogin, [
      { adminId: 'admin-1', code: '000000' },
    ]);
    assert.deepStrictEqual(
      harness.prisma.audit.map((row) => [row.action, row.metadata.reason]),
      [['admin.passkey.registration_rejected', 'invalid_totp']],
    );
    assert.equal(harness.cache.store.size, 0);
  });

  it('refuses a wrong password when the account has no 2FA', async () => {
    const harness = await createHarness({ totpEnabled: false, password: 'right-one' });

    const error = await harness.service
      .generateRegistrationOptions(harness.admin.id, RP_ID, { password: 'wrong-one' }, REQUEST)
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.ok(error);
    assert.equal(messageOf(error), 'Re-authentication failed');
    assert.deepStrictEqual(
      harness.prisma.audit.map((row) => [row.action, row.metadata.reason]),
      [['admin.passkey.registration_rejected', 'invalid_password']],
    );
  });

  it('ignores a password offered by a 2FA account — the account picks the factor', async () => {
    // The attacker's move if the caller could choose: send whichever factor it
    // happens to hold. This account has 2FA on, so the password is not the
    // question being asked, even though it is the correct password.
    const harness = await createHarness({ totpEnabled: true, password: 'right-one' });

    const error = await harness.service
      .generateRegistrationOptions(harness.admin.id, RP_ID, { password: 'right-one' }, REQUEST)
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.equal(payloadOf(error).code, 'passkey_reauth_required');
    assert.equal(payloadOf(error).factor, 'totp');
  });

  it('accepts a valid TOTP code and parks a challenge carrying the proof', async () => {
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });

    const options = (await harness.service.generateRegistrationOptions(
      harness.admin.id,
      RP_ID,
      { code: '123456' },
      REQUEST,
    )) as { challenge: string };

    assert.equal(typeof options.challenge, 'string');
    const record = JSON.parse(harness.cache.store.get('passkey:reg:admin-1') ?? '{}') as {
      challenge?: string;
      reauthAt?: number;
    };
    assert.equal(record.challenge, options.challenge);
    assert.equal(typeof record.reauthAt, 'number');
  });

  it('accepts a recovery code, because that is what disabling 2FA accepts', async () => {
    const harness = await createHarness({
      totpEnabled: true,
      acceptedCodes: ['0123456789'],
    });

    await harness.service.generateRegistrationOptions(
      harness.admin.id,
      RP_ID,
      { code: '0123456789' },
      REQUEST,
    );

    assert.equal(harness.twoFactor.calls.verifyForLogin.length, 1);
    assert.ok(harness.cache.store.has('passkey:reg:admin-1'));
  });

  it('fails CLOSED when the verifier cannot be resolved', async () => {
    // A wiring mistake must not become an enrolment route. The code supplied
    // here is the one the fake would have accepted.
    const harness = await createHarness({
      totpEnabled: true,
      acceptedCodes: ['123456'],
      omitProviders: ['TwoFactorService'],
    });

    const error = await harness.service
      .generateRegistrationOptions(harness.admin.id, RP_ID, { code: '123456' }, REQUEST)
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.ok(error, 'an unresolvable verifier must refuse, not wave through');
    assert.equal(harness.cache.store.size, 0);
  });

  /**
   * The gate lives on `register/options`, so the second half has to refuse any
   * challenge that did not come through it. Without this, a challenge minted by
   * some future ungated path — or one left in Redis across the deploy that
   * added the gate — would still be spendable.
   */
  it('refuses a stored challenge that carries no re-authentication proof', async () => {
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });
    const authenticator = createAuthenticator('00000000-0000-0000-0000-000000000001');

    const options = (await harness.service.generateRegistrationOptions(
      harness.admin.id,
      RP_ID,
      { code: '123456' },
      REQUEST,
    )) as { challenge: string };

    // Exactly the record the pre-gate code wrote: the bare challenge string.
    harness.cache.store.set('passkey:reg:admin-1', JSON.stringify(options.challenge));

    const error = await harness.service
      .verifyRegistration(
        harness.admin.id,
        RP_ID,
        ORIGIN,
        authenticator.attestation(options.challenge) as never,
        'Smuggled key',
        REQUEST,
      )
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.ok(error, 'a challenge with no proof of re-authentication must not be spendable');
    assert.equal(harness.prisma.passkeys.length, 0);
  });
});

// ── 2. Challenge lifecycle, AAGUID, and what enrolment must NOT do ──────────

describe('passkey enrolment: challenge lifecycle and stored credential', () => {
  it('consumes the registration challenge even when verification fails', async () => {
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });
    const authenticator = createAuthenticator('00000000-0000-0000-0000-000000000002');

    const options = (await harness.service.generateRegistrationOptions(
      harness.admin.id,
      RP_ID,
      { code: '123456' },
      REQUEST,
    )) as { challenge: string };

    // A real attestation for a DIFFERENT challenge: verification rejects it.
    const rejected = await harness.service
      .verifyRegistration(
        harness.admin.id,
        RP_ID,
        ORIGIN,
        authenticator.attestation('a-challenge-nobody-issued') as never,
        'Test key',
        REQUEST,
      )
      .then(
        () => null,
        (err: unknown) => err,
      );
    assert.ok(rejected);

    // The challenge must be gone. Left behind, it stays retryable for the rest
    // of its 300 s TTL — the authentication path has always consumed on lookup.
    assert.equal(harness.cache.store.has('passkey:reg:admin-1'), false);

    // Proof that "gone" is what makes the retry fail, not something else: the
    // correct attestation for the original challenge is now refused too.
    const retried = await harness.service
      .verifyRegistration(
        harness.admin.id,
        RP_ID,
        ORIGIN,
        authenticator.attestation(options.challenge) as never,
        'Test key',
        REQUEST,
      )
      .then(
        () => null,
        (err: unknown) => err,
      );
    assert.ok(retried);
    assert.equal(harness.prisma.passkeys.length, 0);
  });

  it('persists the AAGUID the authenticator reported', async () => {
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });
    const authenticator = createAuthenticator('adce0002-35bc-c60a-648b-0b25f1f05503');

    const row = await enrol(harness, authenticator, { code: '123456' });

    assert.equal(
      row.aaguid,
      'adce0002-35bc-c60a-648b-0b25f1f05503',
      'the column has a comment promising the authenticator make and model; NULL keeps none of it',
    );
    assert.equal(row.credentialId, authenticator.credentialId);
    assert.equal(row.backedUp, false);
  });

  it('audits the enrolment and leaves tokenVersion alone', async () => {
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });
    const authenticator = createAuthenticator('00000000-0000-0000-0000-000000000003');

    const row = await enrol(harness, authenticator, { code: '123456' });

    const registered = harness.prisma.audit.filter((a) => a.action === 'admin.passkey.registered');
    assert.equal(registered.length, 1);
    assert.equal(registered[0].adminUserId, 'admin-1');
    assert.equal(registered[0].ipAddress, REQUEST.remoteAddress);
    assert.equal(registered[0].metadata.passkeyId, row.id);

    // Deliberate asymmetry with removal, asserted so it stays deliberate:
    // enrolling GRANTS authority to a new credential and revokes nothing, so
    // signing every other session out here would be friction with no gain. The
    // attacker-with-a-stolen-token case is closed by the fresh-factor gate.
    assert.equal(harness.admin.tokenVersion, 3);
  });
});

// ── 3. Login leaves a trace, and is rate limited like a login ───────────────

describe('passkey login is audited and guarded like the password login', () => {
  it('writes admin.login.succeeded, records the attempt, and stamps lastLoginIp', async () => {
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });
    const authenticator = createAuthenticator('00000000-0000-0000-0000-000000000004');
    await enrol(harness, authenticator, { code: '123456' });
    harness.prisma.audit.length = 0;
    harness.loginGuard.attempts.length = 0;

    const token = await signIn(harness, authenticator);

    assert.ok(token.startsWith('jwt:'));
    const succeeded = harness.prisma.audit.filter((a) => a.action === 'admin.login.succeeded');
    assert.equal(succeeded.length, 1, 'a passkey sign-in must appear beside a password one');
    assert.equal(succeeded[0].adminUserId, 'admin-1');
    assert.equal(succeeded[0].metadata.method, 'passkey');
    assert.equal(succeeded[0].metadata.login, 'operator');
    assert.equal(succeeded[0].ipAddress, REQUEST.remoteAddress);
    assert.deepStrictEqual(harness.loginGuard.attempts, [
      {
        loginNormalized: 'operator',
        ipAddress: REQUEST.remoteAddress,
        success: true,
        reason: null,
        userAgent: REQUEST.userAgent,
      },
    ]);
    assert.equal(harness.admin.lastLoginIp, REQUEST.remoteAddress);
  });

  it('writes admin.login.failed and feeds the fail2ban counter on an unknown credential', async () => {
    const harness = await createHarness();
    const stranger = createAuthenticator('00000000-0000-0000-0000-000000000005');

    const error = await signIn(harness, stranger).then(
      () => null,
      (err: unknown) => err,
    );

    assert.ok(error);
    const failed = harness.prisma.audit.filter((a) => a.action === 'admin.login.failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].metadata.reason, 'credential_not_found');
    assert.equal(harness.loginGuard.attempts.length, 1);
    assert.equal(harness.loginGuard.attempts[0].success, false);
  });

  it('consults the login guard before doing any work, and stops when it says stop', async () => {
    const harness = await createHarness({ rateLimited: true });
    const authenticator = createAuthenticator('00000000-0000-0000-0000-000000000006');

    const error = await signIn(harness, authenticator).then(
      () => null,
      (err: unknown) => err,
    );

    assert.ok(error);
    assert.equal(messageOf(error), 'Too many login attempts. Try again later.');
    assert.deepStrictEqual(harness.loginGuard.rateLimitChecks, [
      { ipAddress: REQUEST.remoteAddress, loginNormalized: '' },
    ]);
  });

  /**
   * The coarse ceiling in front of all that. Asserted against the password
   * login's own declaration rather than a bare number, because the property
   * that matters is the RELATIONSHIP: passkey sign-in mints the same JWT with
   * no password, and used to sit at the global 600/60 s default — 120× looser
   * than the endpoint it replaces.
   */
  it('caps the public passkey routes at login parity, not at the global default', () => {
    const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', PasskeyPublicController) as
      | number
      | undefined;
    const ttl = Reflect.getMetadata('THROTTLER:TTLdefault', PasskeyPublicController) as
      | number
      | undefined;
    const loginLimit = Reflect.getMetadata(
      'THROTTLER:LIMITdefault',
      AdminAuthController.prototype.login,
    ) as number | undefined;
    const loginTtl = Reflect.getMetadata(
      'THROTTLER:TTLdefault',
      AdminAuthController.prototype.login,
    ) as number | undefined;

    assert.equal(loginLimit, 5, 'the reference point moved — re-derive the passkey budget');
    assert.equal(loginTtl, 60_000);
    assert.equal(ttl, loginTtl, 'both budgets must be measured over the same window');
    // One passkey sign-in ATTEMPT spends two requests here (options, then
    // verify) where the password login spends one, so parity is 2x, not 1x.
    assert.equal(
      limit,
      loginLimit * 2,
      'a passkey sign-in costs two requests, so the budget is twice the login route for the same number of attempts',
    );
  });
});

// ── 4. The challenge binding that was computed and never read ──────────────

describe('an admin-bound authentication challenge is actually bound', () => {
  it('refuses an assertion from a credential the challenge was not issued for', async () => {
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });
    const authenticator = createAuthenticator('00000000-0000-0000-0000-000000000007');
    await enrol(harness, authenticator, { code: '123456' });

    // What a username-first login would do: ask for a challenge on behalf of
    // one admin. Nothing in the SPA does this today, which is exactly why the
    // stored `adminId` was dead weight — and why the trap is worth closing
    // before someone builds on it.
    const options = (await harness.service.generateAuthenticationOptions(
      RP_ID,
      'a-different-admin',
    )) as { challenge: string };

    const error = await harness.service
      .verifyAuthentication(
        RP_ID,
        ORIGIN,
        authenticator.assertion(options.challenge) as never,
        REQUEST,
      )
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.ok(error, 'the credential belongs to admin-1; the challenge named someone else');
    const failed = harness.prisma.audit.filter((a) => a.action === 'admin.login.failed');
    assert.equal(failed[failed.length - 1]?.metadata.reason, 'challenge_admin_mismatch');
  });

  it('still accepts the usernameless flow, where no admin was named', async () => {
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });
    const authenticator = createAuthenticator('00000000-0000-0000-0000-000000000008');
    await enrol(harness, authenticator, { code: '123456' });

    const token = await signIn(harness, authenticator);

    assert.ok(token.startsWith('jwt:'));
  });
});

// ── 5. The standing decision: passkey login is already two factors ─────────

describe('passkey login as a second factor — the standing decision', () => {
  /**
   * `passkey.service.ts` states, in a dated comment, that a passkey login does
   * NOT additionally demand a TOTP code, and rests that on one fact: user
   * verification is enforced, so the assertion is possession PLUS a PIN or
   * biometric — two factors already.
   *
   * This is that fact, measured. An assertion with the UV flag clear is
   * refused. Setting `requireUserVerification: false` to accommodate some
   * authenticator would turn passkey login into a single factor and silently
   * void the decision; it cannot be done without this test going red.
   */
  it('refuses an assertion the authenticator did not user-verify', async () => {
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });
    const authenticator = createAuthenticator('00000000-0000-0000-0000-000000000009');
    await enrol(harness, authenticator, { code: '123456' });

    const error = await signIn(harness, authenticator, FLAG_UP).then(
      () => null,
      (err: unknown) => err,
    );

    assert.ok(
      error,
      'user verification is what makes a passkey two factors; without it this login is one',
    );
  });

  it('accepts a user-verified assertion without asking for a TOTP code', async () => {
    // The other half of the same decision: an admin WITH 2FA enabled is not
    // asked for a code here. If that ever changes, it changes here first.
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });
    const authenticator = createAuthenticator('00000000-0000-0000-0000-00000000000a');
    await enrol(harness, authenticator, { code: '123456' });
    const codesBefore = harness.twoFactor.calls.verifyForLogin.length;

    const token = await signIn(harness, authenticator);

    assert.ok(token.startsWith('jwt:'));
    assert.equal(
      harness.twoFactor.calls.verifyForLogin.length,
      codesBefore,
      'the login path must not consult the TOTP verifier — that is the decision, stated',
    );
  });
});

// ── 6. Removal revokes ─────────────────────────────────────────────────────

describe('removing a passkey ends the sessions it created', () => {
  it('bumps tokenVersion and hands back a replacement token', async () => {
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });
    const authenticator = createAuthenticator('00000000-0000-0000-0000-00000000000b');
    const row = await enrol(harness, authenticator, { code: '123456' });
    const versionBefore = harness.admin.tokenVersion;

    const result = await harness.service.deletePasskey(harness.admin.id, row.id, REQUEST);

    assert.equal(result.removed, true);
    assert.equal(
      harness.admin.tokenVersion,
      versionBefore + 1,
      'without the bump, a JWT this credential minted stays valid for the rest of its 24 h',
    );
    assert.ok(result.accessToken, 'the caller must be able to stay signed in');
    assert.match(result.accessToken ?? '', /"tokenVersion":4/);
    assert.equal(harness.prisma.passkeys.length, 0);

    const removed = harness.prisma.audit.filter((a) => a.action === 'admin.passkey.removed');
    assert.equal(removed.length, 1);
    assert.equal(removed[0].metadata.passkeyId, row.id);
  });

  it('does nothing at all when the id matches no row of this admin', async () => {
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });
    const authenticator = createAuthenticator('00000000-0000-0000-0000-00000000000c');
    await enrol(harness, authenticator, { code: '123456' });
    const versionBefore = harness.admin.tokenVersion;

    const result = await harness.service.deletePasskey(harness.admin.id, 'someone-elses-id', REQUEST);

    assert.equal(result.removed, false);
    assert.equal(result.accessToken, null);
    assert.equal(
      harness.admin.tokenVersion,
      versionBefore,
      'a stranger id must not be a way to sign an admin out of their own panel',
    );
    assert.equal(harness.prisma.passkeys.length, 1);
  });
});
