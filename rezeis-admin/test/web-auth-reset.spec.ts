import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { Logger, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Locale, SubscriptionStatus } from '@prisma/client';

import { RawCacheService } from '../src/common/cache/raw-cache.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  isEventTelegramAllowed,
  resolveTelegramDeliveryTarget,
} from '../src/common/services/telegram-delivery-target.util';
import {
  EVENT_TYPES,
  REGISTERED_EVENT_TYPES,
  SystemEventsService,
  type SystemEventPayload,
} from '../src/common/services/system-events.service';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { EmailDeliveryService } from '../src/modules/email/services/email-delivery.service';
import { EmailEventBridgeService } from '../src/modules/email/services/email-event-bridge.service';
import type { SendEmailPayload } from '../src/modules/email/interfaces/email.interface';
import { LegalDocumentsService } from '../src/modules/legal-documents/services/legal-documents.service';
import { ReferralManualAttachService } from '../src/modules/referrals/services/referral-manual-attach.service';
import { AccessModeGuard } from '../src/modules/settings/services/access-mode-guard.service';
import type { InternalPlatformPolicyInterface } from '../src/modules/settings/interfaces/internal-platform-policy.interface';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import { RegistrationSnapshotService } from '../src/modules/web-auth/services/registration-snapshot.service';
import { BotNotifierClient, type NotifyDeliveryResult } from '../src/modules/notifications/services/bot-notifier.client';
import {
  configUrlShortIds,
  panelShortUuidFromConfigUrl,
} from '../src/modules/remnawave/services/panel-user-address';
import { InternalWebAuthController } from '../src/modules/web-auth/controllers/internal-web-auth.controller';
import {
  LINK_OWNER_SELECT,
  PASSWORD_RESET_DATABASE,
  PASSWORD_RESET_TTL_SECONDS,
  PasswordResetService,
  RESET_ACCOUNT_SELECT,
  type LinkOwnerRow,
  type PasswordResetDatabase,
  type PasswordResetEvents,
  type PasswordResetMail,
  type PasswordResetPolicy,
  type PasswordResetPush,
  type PasswordResetTelegram,
  type PasswordResetTransaction,
  type ResetAccountRow,
} from '../src/modules/web-auth/services/password-reset.service';
import { BotSigninTokenService } from '../src/modules/web-auth/services/bot-signin-token.service';
import { WebAuthService } from '../src/modules/web-auth/services/web-auth.service';
import { ipAttemptBucket } from '../src/modules/web-auth/utils/ip-bucket.util';
import {
  findRecoveryWithdrawalHold,
  RECOVERY_WITHDRAWAL_HOLD_PURPOSE,
  type RecoveryWithdrawalHoldReader,
} from '../src/modules/web-auth/utils/recovery-withdrawal-hold.util';
import { escapeLikeLiteral, parseSubscriptionLink } from '../src/modules/web-auth/utils/subscription-link.util';
import { applySessionsRevokedAtRaise } from './helpers/sessions-revoked-at-sql';

/**
 * A customer who forgot the password gets back in without support.
 * ═══════════════════════════════════════════════════════════════════
 *
 * These cases drive the REAL `PasswordResetService` with the REAL
 * `RawCacheService` over a fake ioredis client (every command one round trip,
 * MULTI/EXEC applied together — the model of `bot-signin-token-single-use.spec`),
 * the REAL `PasswordHashService`, and a fake database that implements the
 * service's database PORT. The port is a compile-time type, so the fake's
 * shape is checked by the compiler rather than cast into place, and the fake
 * honours `where` — including Postgres LIKE semantics, wildcards and the
 * backslash escape — and refuses any shape it was not written for.
 */

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Fake ioredis ────────────────────────────────────────────────────────────

interface StoredValue {
  value: string;
  ttlSeconds: number | null;
}

class FakeRedis {
  public status: 'ready' | 'end' = 'ready';
  public readonly sent: string[] = [];
  public readonly store = new Map<string, StoredValue>();

  private roundTrip<T>(apply: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      setImmediate(() => {
        try {
          resolve(apply());
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private readNow(key: string): string | null {
    return this.store.get(key)?.value ?? null;
  }

  private deleteNow(keys: readonly string[]): number {
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed += 1;
    return removed;
  }

  public get(key: string): Promise<string | null> {
    this.sent.push(`GET ${key}`);
    return this.roundTrip(() => this.readNow(key));
  }

  public set(key: string, value: string, ...options: Array<string | number>): Promise<'OK' | null> {
    this.sent.push(`SET ${key} ${options.join(' ')}`.trim());
    return this.roundTrip(() => {
      const ex = options.indexOf('EX');
      const ttlSeconds = ex === -1 ? null : Number(options[ex + 1]);
      if (options.includes('NX') && this.store.has(key)) return null;
      this.store.set(key, { value, ttlSeconds });
      return 'OK' as const;
    });
  }

  public del(...keys: string[]): Promise<number> {
    this.sent.push(`DEL ${keys.join(' ')}`);
    return this.roundTrip(() => this.deleteNow(keys));
  }

  public exists(...keys: string[]): Promise<number> {
    this.sent.push(`EXISTS ${keys.join(' ')}`);
    return this.roundTrip(() => keys.filter((key) => this.store.has(key)).length);
  }

  public incrby(key: string, by: number): Promise<number> {
    this.sent.push(`INCRBY ${key} ${by}`);
    return this.roundTrip(() => {
      const next = Number(this.readNow(key) ?? '0') + by;
      const ttlSeconds = this.store.get(key)?.ttlSeconds ?? null;
      this.store.set(key, { value: String(next), ttlSeconds });
      return next;
    });
  }

  public expire(key: string, seconds: number): Promise<number> {
    this.sent.push(`EXPIRE ${key} ${seconds}`);
    return this.roundTrip(() => {
      const entry = this.store.get(key);
      if (entry === undefined) return 0;
      entry.ttlSeconds = seconds;
      return 1;
    });
  }

  public multi() {
    const queued: Array<() => unknown> = [];
    const names: string[] = [];
    const chain = {
      get: (key: string) => {
        names.push(`GET ${key}`);
        queued.push(() => this.readNow(key));
        return chain;
      },
      del: (...keys: string[]) => {
        names.push(`DEL ${keys.join(' ')}`);
        queued.push(() => this.deleteNow(keys));
        return chain;
      },
      exec: () => {
        this.sent.push(`MULTI ${names.join('; ')} EXEC`);
        return this.roundTrip(() => queued.map((command) => [null, command()] as const));
      },
    };
    return chain;
  }

  public keysStartingWith(prefix: string): string[] {
    return [...this.store.keys()].filter((key) => key.startsWith(prefix));
  }
}

// ── Fake database (implements the service's port) ───────────────────────────

interface UserFixture {
  id: string;
  telegramId: bigint | null;
  isBlocked: boolean;
  language: Locale;
}

interface AccountFixture {
  id: string;
  userId: string;
  login: string | null;
  loginNormalized: string | null;
  email: string | null;
  emailNormalized: string | null;
  emailVerifiedAt: Date | null;
  passwordHash: string | null;
  requiresPasswordChange: boolean;
  temporaryPasswordExpiresAt: Date | null;
  passwordBootstrapPending: boolean;
  credentialsBootstrappedAt: Date | null;
  sessionsRevokedAt: Date | null;
}

interface SubscriptionFixture {
  id: string;
  userId: string;
  status: SubscriptionStatus;
  expiresAt: Date | null;
  configUrl: string | null;
}

interface ChallengeFixture {
  id: string;
  webAccountId: string;
  purpose: string;
  channel: string;
  destination: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface DatabaseState {
  users: UserFixture[];
  accounts: AccountFixture[];
  subscriptions: SubscriptionFixture[];
  challenges: ChallengeFixture[];
}

/**
 * Postgres `LIKE`, whole-string: `%` any run, `_` any one character, and a
 * backslash makes the next character literal (the default ESCAPE). Prisma's
 * `endsWith: v` is `LIKE ('%' || v)` with `v` bound verbatim.
 */
function likeMatches(value: string, pattern: string): boolean {
  let regex = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\' && index + 1 < pattern.length) {
      index += 1;
      regex += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (char === '%') regex += '[\\s\\S]*';
    else if (char === '_') regex += '[\\s\\S]';
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${regex}$`).test(value);
}

class FakeDatabase implements PasswordResetDatabase {
  public state: DatabaseState;
  /** Successful password writes, in order. */
  public readonly passwordWrites: Array<{ id: string; passwordHash: string }> = [];
  /** The sign-out moment statements that landed, with the rows each reported. */
  public readonly raises: number[] = [];
  /** Every subscription lookup's LIKE patterns, as Postgres receives them. */
  public readonly subscriptionQueries: string[][] = [];

  public constructor(state: DatabaseState) {
    this.state = state;
  }

  private projectAccount(account: AccountFixture): ResetAccountRow {
    const user = this.state.users.find((candidate) => candidate.id === account.userId);
    assert.ok(user, `fixture account ${account.id} has no user`);
    return {
      id: account.id,
      userId: account.userId,
      login: account.login,
      loginNormalized: account.loginNormalized,
      email: account.email,
      emailVerifiedAt: account.emailVerifiedAt,
      passwordHash: account.passwordHash,
      passwordBootstrapPending: account.passwordBootstrapPending,
      credentialsBootstrappedAt: account.credentialsBootstrappedAt,
      user: { telegramId: user.telegramId, isBlocked: user.isBlocked, language: user.language },
    };
  }

  /**
   * The two calls `WebAuthService.login` makes, over the SAME rows the reset
   * service reads and writes — so a sign-in after a reset sees the new
   * password, and a sign-in that wrote anything is caught in `loginWrites`.
   */
  public readonly loginWrites: Array<{ where: unknown; data: Record<string, unknown> }> = [];

  public loginPrisma() {
    return {
      webAccount: {
        findUnique: async (args: {
          where: { loginNormalized?: string };
          include?: { user?: { select?: Record<string, boolean> } };
        }) => {
          assert.deepEqual(Object.keys(args.where), ['loginNormalized'], 'sign-in looks accounts up by login');
          const account = this.state.accounts.find((row) => row.loginNormalized === args.where.loginNormalized);
          if (account === undefined) return null;
          const user = this.state.users.find((row) => row.id === account.userId);
          assert.ok(user, `fixture account ${account.id} has no user`);
          return { ...account, user: { telegramId: user.telegramId, isBlocked: user.isBlocked } };
        },
        update: async (args: { where: { id?: string }; data: Record<string, unknown> }) => {
          this.loginWrites.push(args);
          const account = this.state.accounts.find((row) => row.id === args.where.id);
          if (account !== undefined) Object.assign(account, args.data);
          return { id: args.where.id };
        },
        updateMany: async (args: { where: { id?: string }; data: Record<string, unknown> }) => {
          this.loginWrites.push(args);
          return { count: 0 };
        },
      },
    };
  }

  public readonly webAccount: PasswordResetDatabase['webAccount'] = {
    findUnique: async (args) => {
      // Every account read goes through the one select the projection mirrors.
      assert.equal(args.select, RESET_ACCOUNT_SELECT, 'an account read used another select');
      const keys = Object.keys(args.where);
      assert.equal(keys.length, 1, `unexpected unique where: ${JSON.stringify(keys)}`);
      const [key] = keys;
      assert.ok(
        key === 'id' || key === 'loginNormalized' || key === 'emailNormalized',
        `unexpected unique where key: ${key}`,
      );
      const value = (args.where as Record<string, unknown>)[key];
      const account = this.state.accounts.find(
        (candidate) => (candidate as unknown as Record<string, unknown>)[key] === value,
      );
      return account === undefined ? null : this.projectAccount(account);
    },
    findFirst: async (args) => {
      assert.equal(args.select, RESET_ACCOUNT_SELECT, 'an account read used another select');
      const where = args.where as { user?: { telegramId?: unknown } };
      assert.deepEqual(Object.keys(where), ['user'], 'findFirst supports a user filter only');
      assert.equal(typeof where.user?.telegramId, 'bigint', 'findFirst filters by a bigint telegramId');
      const user = this.state.users.find((candidate) => candidate.telegramId === where.user?.telegramId);
      const account = user === undefined ? undefined : this.state.accounts.find((a) => a.userId === user.id);
      return account === undefined ? null : this.projectAccount(account);
    },
  };

  public readonly subscription: PasswordResetDatabase['subscription'] = {
    // Postgres as Prisma drives it: an OR of `configUrl` string filters, each a
    // LIKE with its value bound verbatim; rows in storage order; `take` cuts.
    // Anything else is a shape this fake was not written for, and it says so.
    findMany: async (args) => {
      assert.equal(args.select, LINK_OWNER_SELECT, 'a subscription lookup used another select');
      const extra = Object.keys(args).filter((key) => key !== 'select' && key !== 'where' && key !== 'take');
      assert.deepEqual(extra, [], 'the fake models select, where and take only');
      const take = (args as { take?: unknown }).take;
      assert.ok(take === undefined || (Number.isInteger(take) && Number(take) > 0), `take: ${String(take)}`);
      const or = (args.where as { OR?: Array<{ configUrl?: Record<string, unknown> }> }).OR;
      assert.ok(Array.isArray(or) && or.length > 0, 'the lookup is an OR of configUrl filters');
      const LIKE_OF: Record<string, (value: string) => string> = {
        endsWith: (value) => `%${value}`,
        startsWith: (value) => `${value}%`,
        contains: (value) => `%${value}%`,
      };
      const patterns = or.map((clause) => {
        const filters = Object.entries(clause.configUrl ?? {});
        assert.equal(filters.length, 1, `one configUrl filter per clause: ${JSON.stringify(clause)}`);
        const [operator, value] = filters[0];
        assert.ok(operator in LIKE_OF, `unmodelled configUrl filter: ${operator}`);
        assert.equal(typeof value, 'string');
        return LIKE_OF[operator](String(value));
      });
      this.subscriptionQueries.push(patterns);
      const rows: LinkOwnerRow[] = [];
      for (const subscription of this.state.subscriptions) {
        if (take !== undefined && rows.length >= Number(take)) break;
        const url = subscription.configUrl;
        if (url === null || !patterns.some((pattern) => likeMatches(url, pattern))) continue;
        const user = this.state.users.find((candidate) => candidate.id === subscription.userId);
        assert.ok(user, `fixture subscription ${subscription.id} has no user`);
        const account = this.state.accounts.find((candidate) => candidate.userId === subscription.userId);
        rows.push({
          id: subscription.id,
          status: subscription.status,
          expiresAt: subscription.expiresAt,
          configUrl: subscription.configUrl,
          user: {
            isBlocked: user.isBlocked,
            webAccount:
              account === undefined
                ? null
                : { id: account.id, login: account.login, loginNormalized: account.loginNormalized },
          },
        });
      }
      return rows;
    },
  };

  public async $transaction<R>(fn: (tx: PasswordResetTransaction) => Promise<R>): Promise<R> {
    const staged = structuredClone(this.state);
    const writes: Array<{ id: string; passwordHash: string }> = [];
    const raises: number[] = [];
    const tx: PasswordResetTransaction = {
      $executeRaw: async (query) => {
        const count = applySessionsRevokedAtRaise(query, staged.accounts);
        raises.push(count);
        return count;
      },
      webAccount: {
        updateMany: async (args) => {
          const where = args.where as Record<string, unknown>;
          const unmodelled = Object.keys(where).filter((key) => key !== 'id' && key !== 'passwordHash');
          assert.deepEqual(unmodelled, [], 'the fake models id and passwordHash filters only');
          let count = 0;
          for (const account of staged.accounts) {
            if ('id' in where && account.id !== where['id']) continue;
            if ('passwordHash' in where && account.passwordHash !== where['passwordHash']) continue;
            const data = args.data as Record<string, unknown>;
            for (const [field, value] of Object.entries(data)) {
              assert.ok(
                value === null || typeof value !== 'object' || value instanceof Date,
                `the fake applies plain values only (${field})`,
              );
              (account as unknown as Record<string, unknown>)[field] = value;
            }
            writes.push({ id: account.id, passwordHash: String(data['passwordHash']) });
            count += 1;
          }
          return { count };
        },
      },
      authChallenge: {
        create: async (args) => {
          const data = args.data;
          const row: ChallengeFixture = {
            id: `challenge-${staged.challenges.length + 1}`,
            webAccountId: data.webAccountId,
            purpose: data.purpose,
            channel: data.channel,
            destination: data.destination,
            expiresAt: new Date(data.expiresAt as Date),
            consumedAt: null,
          };
          staged.challenges.push(row);
          return { id: row.id };
        },
      },
    };
    const result = await fn(tx);
    this.state = staged;
    this.passwordWrites.push(...writes);
    this.raises.push(...raises);
    return result;
  }

  public account(id: string): AccountFixture {
    const account = this.state.accounts.find((candidate) => candidate.id === id);
    assert.ok(account, `no account ${id}`);
    return account;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const ALICE_SHORT = 'AliceShort01q';
const BOB_SHORT = 'Bob_Short_77z';
const GINA_SHORT = 'GinaShort01q';
const IVAN_SHORT = 'IvanShort029';
const JUNE_SHORT = 'JuneShort031';
const KATE_SHORT = 'KateShort0001';
const LEO_SHORT = 'LeoShort00001';
const FRANK_SHORT = 'FrankShort01';

function account(
  overrides: Partial<AccountFixture> & Pick<AccountFixture, 'id' | 'userId'>,
  now = new Date(),
): AccountFixture {
  return {
    login: null,
    loginNormalized: null,
    email: null,
    emailNormalized: null,
    emailVerifiedAt: null,
    passwordHash: `scrypt$old-password-of-${overrides.id}`,
    requiresPasswordChange: false,
    temporaryPasswordExpiresAt: null,
    passwordBootstrapPending: false,
    credentialsBootstrappedAt: new Date(now.getTime() - 100 * DAY_MS),
    sessionsRevokedAt: null,
    ...overrides,
  };
}

/** A customer with a web login and nothing else, and one subscription. */
function loneCustomer(
  name: string,
  subscription: Pick<SubscriptionFixture, 'status' | 'expiresAt' | 'configUrl'>,
  options: { readonly isBlocked?: boolean } = {},
): { user: UserFixture; account: AccountFixture; subscription: SubscriptionFixture } {
  return {
    user: { id: `u-${name}`, telegramId: null, isBlocked: options.isBlocked ?? false, language: Locale.RU },
    account: account({ id: `wa-${name}`, userId: `u-${name}`, login: name, loginNormalized: name.toLowerCase() }),
    subscription: { id: `s-${name}`, userId: `u-${name}`, ...subscription },
  };
}

function fixtures(now = new Date()): DatabaseState {
  const lone = [
    loneCustomer('gina', {
      status: SubscriptionStatus.ACTIVE,
      expiresAt: new Date(now.getTime() + 20 * DAY_MS),
      configUrl: `https://sub.example.com/${GINA_SHORT}`,
    }),
    loneCustomer('ivan', {
      status: SubscriptionStatus.EXPIRED,
      expiresAt: new Date(now.getTime() - 29 * DAY_MS),
      configUrl: `https://sub.example.com/${IVAN_SHORT}`,
    }),
    loneCustomer('june', {
      status: SubscriptionStatus.EXPIRED,
      expiresAt: new Date(now.getTime() - 31 * DAY_MS),
      configUrl: `https://sub.example.com/${JUNE_SHORT}`,
    }),
    // An operator's subscription page under a custom path prefix.
    loneCustomer('kate', {
      status: SubscriptionStatus.ACTIVE,
      expiresAt: null,
      configUrl: `https://sub.example.com/vpn/${KATE_SHORT}`,
    }),
    loneCustomer(
      'leo',
      { status: SubscriptionStatus.ACTIVE, expiresAt: null, configUrl: `https://sub.example.com/${LEO_SHORT}` },
      { isBlocked: true },
    ),
  ];
  return {
    users: [
      { id: 'u-alice', telegramId: 700_001n, isBlocked: false, language: Locale.RU },
      { id: 'u-bob', telegramId: null, isBlocked: false, language: Locale.EN },
      { id: 'u-carol', telegramId: null, isBlocked: false, language: Locale.RU },
      { id: 'u-dave', telegramId: 700_004n, isBlocked: true, language: Locale.RU },
      { id: 'u-erin', telegramId: 700_005n, isBlocked: false, language: Locale.RU },
      { id: 'u-frank', telegramId: 700_006n, isBlocked: false, language: Locale.RU },
      ...lone.map((entry) => entry.user),
    ],
    accounts: [
      account(
        {
          id: 'wa-alice',
          userId: 'u-alice',
          login: 'Alice',
          loginNormalized: 'alice',
          email: 'alice@example.com',
          emailNormalized: 'alice@example.com',
          emailVerifiedAt: new Date(now.getTime() - 10 * DAY_MS),
          requiresPasswordChange: true,
          temporaryPasswordExpiresAt: new Date(now.getTime() + DAY_MS),
        },
        now,
      ),
      account(
        {
          id: 'wa-bob',
          userId: 'u-bob',
          login: 'bob',
          loginNormalized: 'bob',
          email: 'Bob@Example.com',
          emailNormalized: 'bob@example.com',
          emailVerifiedAt: new Date(now.getTime() - 3 * DAY_MS),
        },
        now,
      ),
      account(
        {
          id: 'wa-carol',
          userId: 'u-carol',
          login: 'carol',
          loginNormalized: 'carol',
          email: 'carol@example.com',
          emailNormalized: 'carol@example.com',
          emailVerifiedAt: null,
        },
        now,
      ),
      account({ id: 'wa-dave', userId: 'u-dave', login: 'dave', loginNormalized: 'dave' }, now),
      // A Telegram shell that never set a login.
      account({ id: 'wa-erin', userId: 'u-erin', passwordHash: null, credentialsBootstrappedAt: null }, now),
      // Telegram linked, e-mail typed in but never confirmed.
      account(
        {
          id: 'wa-frank',
          userId: 'u-frank',
          login: 'frank',
          loginNormalized: 'frank',
          email: 'frank@example.com',
          emailNormalized: 'frank@example.com',
          emailVerifiedAt: null,
        },
        now,
      ),
      ...lone.map((entry) => entry.account),
    ],
    subscriptions: [
      {
        id: 's-alice',
        userId: 'u-alice',
        status: SubscriptionStatus.ACTIVE,
        expiresAt: new Date(now.getTime() + 20 * DAY_MS),
        configUrl: `https://sub.example.com/${ALICE_SHORT}`,
      },
      {
        id: 's-bob',
        userId: 'u-bob',
        status: SubscriptionStatus.EXPIRED,
        expiresAt: new Date(now.getTime() - 29 * DAY_MS),
        configUrl: `https://panel.example.com/api/sub/${BOB_SHORT}`,
      },
      {
        id: 's-frank',
        userId: 'u-frank',
        status: SubscriptionStatus.LIMITED,
        expiresAt: new Date(now.getTime() + 5 * DAY_MS),
        configUrl: `https://sub.example.com/${FRANK_SHORT}`,
      },
      ...lone.map((entry) => entry.subscription),
    ],
    challenges: [],
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────

type NotifyInput = Parameters<PasswordResetTelegram['notifyUser']>[0];
type MailInput = Parameters<PasswordResetMail['sendPasswordResetLink']>[0];
type PushInput = Parameters<PasswordResetPush['sendToUser']>[0];

interface RecordedEvent {
  readonly type: string;
  readonly category: string;
  readonly message: string;
  readonly metadata: Record<string, unknown> | undefined;
}

interface HarnessOptions {
  readonly smtpEnabled?: boolean;
  readonly relayEnabled?: boolean;
  /** The operator's «Восстановление пароля по ссылке подписки»; ON unless a case says otherwise. */
  readonly subscriptionLinkRecovery?: boolean | 'unreadable';
  readonly state?: DatabaseState;
  /** Called while the new password is being hashed — the window before the write. */
  readonly duringHash?: (db: FakeDatabase) => void;
}

/** A whole platform policy, as `SettingsService.getInternalPlatformPolicy` answers it. */
function platformPolicy(overrides: Partial<InternalPlatformPolicyInterface> = {}): InternalPlatformPolicyInterface {
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
    accessMode: 'PUBLIC',
    inviteModeStartedAt: null,
    defaultCurrency: 'RUB',
    ...overrides,
  };
}

function harness(options: HarnessOptions = {}) {
  const redis = new FakeRedis();
  const cache = new RawCacheService();
  // The ioredis client `onModuleInit` would have built; everything above it is production code.
  (cache as unknown as { redis: FakeRedis }).redis = redis;
  const db = new FakeDatabase(options.state ?? fixtures());
  const events: RecordedEvent[] = [];
  const telegramSends: NotifyInput[] = [];
  const mails: MailInput[] = [];
  const pushes: PushInput[] = [];
  const tasks: Array<() => Promise<void>> = [];
  const realHasher = new PasswordHashService();

  const eventsPort: PasswordResetEvents = {
    info: (type, category, message, metadata) => {
      events.push({ type, category, message, metadata });
    },
  };
  const mailPort: PasswordResetMail = {
    getSmtpSettings: async () => ({
      enabled: options.smtpEnabled ?? true,
      notifyUsers: false,
      host: 'smtp.example.com',
      port: 587,
      username: null,
      password: null,
      fromAddress: 'noreply@example.com',
      fromName: 'Example',
      useTls: true,
      useSsl: false,
    }),
    sendPasswordResetLink: async (input) => {
      mails.push(input);
      return { success: true };
    },
  };
  const telegramPort: PasswordResetTelegram = {
    isEnabled: options.relayEnabled ?? true,
    notifyUser: async (input): Promise<NotifyDeliveryResult> => {
      telegramSends.push(input);
      return { status: 'confirmed', messageId: 1, httpStatus: 200, detail: null };
    },
  };
  const pushPort: PasswordResetPush = {
    sendToUser: async (input) => {
      pushes.push(input);
      return { attempted: 1, delivered: 1, failed: 0, disabled: false };
    },
  };
  // A pass-through: every decision is the real hasher's; the seam only lets a
  // case change the stored row between "checked" and "written", and tells it
  // when the last hash was done.
  let hashedAt = 0;
  class SeamHasher extends PasswordHashService {
    public override async hashPassword(input: Parameters<PasswordHashService['hashPassword']>[0]): Promise<string> {
      options.duringHash?.(db);
      const hash = await super.hashPassword(input);
      hashedAt = Date.now();
      return hash;
    }
  }

  const policyPort: PasswordResetPolicy = {
    getInternalPlatformPolicy: async () => {
      if (options.subscriptionLinkRecovery === 'unreadable') throw new Error('settings row unreadable');
      return platformPolicy({ subscriptionLinkRecovery: options.subscriptionLinkRecovery ?? true });
    },
  };

  const service = new PasswordResetService(
    db,
    cache,
    new SeamHasher(),
    eventsPort,
    mailPort,
    telegramPort,
    policyPort,
    pushPort,
    (task) => {
      tasks.push(task);
    },
  );

  return {
    service,
    redis,
    db,
    events,
    telegramSends,
    mails,
    pushes,
    tasks,
    realHasher,
    /** When the last new password finished hashing (ms). */
    get hashedAt(): number {
      return hashedAt;
    },
    async runTasks(): Promise<void> {
      while (tasks.length > 0) await tasks.shift()!();
    },
    /** The tokens stored in Redis, with the channel each was minted for. */
    storedTokens(): Array<{ channel: string; webAccountId: string }> {
      return redis
        .keysStartingWith(TOKEN_PREFIX)
        .map((key) => JSON.parse(redis.store.get(key)!.value) as { channel: string; webAccountId: string });
    },
  };
}

const TOKEN_PREFIX = 'web-auth:pwreset:token:';
const NEW_PASSWORD = 'a3f1'.repeat(16); // the SHA-256 hex the cabinet sends
const CABINET = 'https://cabinet.example.com';

async function telegramToken(h: ReturnType<typeof harness>, telegramId = '700001'): Promise<string> {
  const issued = await h.service.issueForTelegram(telegramId);
  assert.equal(issued.status, 'issued', `issueForTelegram refused: ${JSON.stringify(issued)}`);
  if (issued.status !== 'issued') throw new Error('unreachable');
  return issued.token;
}

/** The token in a link — in its fragment (`#token=`) or its query (`?token=`). */
function tokenOf(link: string): string {
  const url = new URL(link, 'https://cabinet.invalid');
  const token = new URLSearchParams(url.hash.slice(1)).get('token') ?? url.searchParams.get('token');
  assert.ok(token !== null && /^[a-f0-9]{64}$/.test(token), `no token in ${link}`);
  return token;
}

let address = 0;
/** A fresh IPv4 address per attempt, so the per-address budget never decides a case by accident. */
function nextIp(): string {
  address += 1;
  return `10.${(address >> 16) & 255}.${(address >> 8) & 255}.${address & 255}`;
}

function recover(
  h: ReturnType<typeof harness>,
  link: string,
  login: string,
  clientIp: string = nextIp(),
) {
  return h.service.recoverBySubscription({ link, login, clientIp, cabinetUrl: CABINET });
}

// ── The token ───────────────────────────────────────────────────────────────

describe('password reset: the token', () => {
  it('is 32 random bytes, stored only as its hash, for exactly fifteen minutes', async () => {
    const h = harness();
    const token = await telegramToken(h);

    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(PASSWORD_RESET_TTL_SECONDS, 900);
    const keys = h.redis.keysStartingWith(TOKEN_PREFIX);
    assert.deepEqual(keys, [`${TOKEN_PREFIX}${sha256(token)}`]);
    const stored = h.redis.store.get(keys[0])!;
    assert.equal(stored.ttlSeconds, 900);
    assert.ok(!stored.value.includes(token), 'the plaintext token was written to Redis');
    assert.ok(
      !stored.value.includes('scrypt$old-password-of-wa-alice'),
      'the password hash itself was written to Redis',
    );
    assert.deepEqual(Object.keys(JSON.parse(stored.value)).sort(), [
      'channel',
      'expiresAt',
      'fingerprint',
      'userId',
      'webAccountId',
    ]);
  });

  it('lets exactly one of eight simultaneous consumes set a password', async () => {
    const h = harness();
    const token = await telegramToken(h);

    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => h.service.consume(token, `${NEW_PASSWORD.slice(0, 60)}${i}bcd`)),
    );

    const winners = answers.filter((answer) => answer.status === 'ok');
    assert.equal(winners.length, 1, `${winners.length} consumes set a password with one single-use link`);
    assert.equal(h.db.passwordWrites.length, 1, 'the password was written more than once');
    assert.ok(
      answers.every((answer) => answer.status === 'ok' || answer.status === 'used' || answer.status === 'expired'),
    );
    const key = `${TOKEN_PREFIX}${sha256(token)}`;
    assert.equal(h.redis.sent.filter((command) => command === `MULTI GET ${key}; DEL ${key} EXEC`).length, 8);
    assert.equal(h.redis.store.has(key), false, 'the token outlived its use');
  });

  it('says "used" for a spent link and "expired" for one that is gone or malformed', async () => {
    const h = harness();
    const token = await telegramToken(h);
    assert.equal((await h.service.consume(token, NEW_PASSWORD)).status, 'ok');

    assert.deepEqual(await h.service.consume(token, NEW_PASSWORD), { status: 'used' });
    assert.deepEqual(await h.service.inspect(token), { status: 'used' });
    assert.deepEqual(await h.service.consume('b'.repeat(64), NEW_PASSWORD), { status: 'expired' });
    assert.deepEqual(await h.service.inspect('not-a-token'), { status: 'expired' });

    // Fifteen minutes pass: Redis drops the key.
    const second = harness();
    const lapsed = await telegramToken(second);
    second.redis.store.delete(`${TOKEN_PREFIX}${sha256(lapsed)}`);
    assert.deepEqual(await second.service.consume(lapsed, NEW_PASSWORD), { status: 'expired' });
  });

  it('inspects without spending, and names the login', async () => {
    const h = harness();
    const token = await telegramToken(h);

    const inspected = await h.service.inspect(token);
    assert.equal(inspected.status, 'valid');
    if (inspected.status !== 'valid') throw new Error('unreachable');
    assert.equal(inspected.login, 'Alice');
    assert.equal((await h.service.consume(token, NEW_PASSWORD)).status, 'ok');
  });
});

describe('password reset: what a consume writes', () => {
  it('stores the new password through the subscriber scrypt path and lifts every forced-change state', async () => {
    const h = harness();
    const token = await telegramToken(h);
    h.redis.store.set('web-auth:temp-password:wa-alice', { value: '"TempPass1"', ttlSeconds: 3600 });

    const result = await h.service.consume(token, NEW_PASSWORD);

    const row = h.db.account('wa-alice');
    assert.ok(row.sessionsRevokedAt instanceof Date, 'the new password left older sessions signed in');
    assert.deepEqual(result, {
      status: 'ok',
      userId: 'u-alice',
      login: 'Alice',
      sessionsRevokedAt: row.sessionsRevokedAt.toISOString(),
    });
    assert.ok(row.passwordHash !== null && row.passwordHash.startsWith('scrypt$16384$8$5$'), row.passwordHash ?? '');
    assert.equal(
      await h.realHasher.verifyPassword({ plainTextPassword: NEW_PASSWORD, passwordHash: row.passwordHash }),
      true,
    );
    assert.equal(row.requiresPasswordChange, false);
    assert.equal(row.temporaryPasswordExpiresAt, null);
    assert.equal(row.passwordBootstrapPending, false);
    assert.equal(h.redis.store.has('web-auth:temp-password:wa-alice'), false, 'the temporary password stayed readable');
  });

  it('signs every older session out in the same transaction as the new password — whatever the channel', async () => {
    // A link sent to Telegram, a link sent to a verified e-mail, and a link won
    // with the subscription link: each is a new password, and each names the
    // moment before which every cabinet session of the account ends.
    const viaTelegram = harness();
    const telegram = await viaTelegram.service.consume(await telegramToken(viaTelegram), NEW_PASSWORD);

    const viaEmail = harness();
    await viaEmail.service.request({ identifier: 'bob', cabinetUrl: CABINET });
    await viaEmail.runTasks();
    assert.equal(viaEmail.mails.length, 1, 'no e-mail link went out');
    const email = await viaEmail.service.consume(tokenOf(viaEmail.mails[0].link), NEW_PASSWORD);

    const viaSubscription = harness();
    const verified = await recover(viaSubscription, `https://sub.example.com/${GINA_SHORT}`, 'gina');
    assert.equal(verified.status, 'verified');
    const subscription = await viaSubscription.service.consume(
      (verified as { token: string }).token,
      NEW_PASSWORD,
    );

    for (const [h, result, id] of [
      [viaTelegram, telegram, 'wa-alice'],
      [viaEmail, email, 'wa-bob'],
      [viaSubscription, subscription, 'wa-gina'],
    ] as const) {
      const row = h.db.account(id);
      assert.equal(result.status, 'ok', id);
      assert.ok(row.sessionsRevokedAt instanceof Date, `${id}: older sessions stay signed in`);
      assert.equal((result as { sessionsRevokedAt: string }).sessionsRevokedAt, row.sessionsRevokedAt.toISOString());
      assert.ok(Date.now() - row.sessionsRevokedAt.getTime() < 60_000);
      assert.deepEqual(h.db.raises, [1], `${id}: the moment was not written through the statement that never moves it back`);
    }
  });

  it('takes the sign-out moment once the new password is hashed, not before', async () => {
    // scrypt takes a while. A moment taken BEFORE it is older than the write
    // that carries it, by the whole hash — and a session opened in that gap
    // survives the reset.
    const h = harness();
    const token = await telegramToken(h);

    const result = await h.service.consume(token, NEW_PASSWORD);

    assert.equal(result.status, 'ok');
    const moment = Date.parse((result as { sessionsRevokedAt: string }).sessionsRevokedAt);
    assert.ok(h.hashedAt > 0, 'no new password was hashed');
    assert.ok(moment >= h.hashedAt, `the moment ${new Date(moment).toISOString()} predates the hash (${new Date(h.hashedAt).toISOString()})`);
    assert.equal(h.db.account('wa-alice').sessionsRevokedAt?.getTime(), moment);
  });

  it('never moves the sign-out moment back — whatever the channel', async () => {
    // While this reset hashes, another writer (a password change elsewhere,
    // «Выйти на всех устройствах») commits a LATER moment. This reset must not
    // pull it back: every session opened between the two would survive it.
    const later = new Date(Date.now() + 60 * 60 * 1000);
    const stampLater = (id: string) => (db: FakeDatabase) => {
      db.account(id).sessionsRevokedAt = new Date(later);
    };

    const viaTelegram = harness({ duringHash: stampLater('wa-alice') });
    const telegram = await viaTelegram.service.consume(await telegramToken(viaTelegram), NEW_PASSWORD);

    const viaEmail = harness({ duringHash: stampLater('wa-bob') });
    await viaEmail.service.request({ identifier: 'bob', cabinetUrl: CABINET });
    await viaEmail.runTasks();
    const email = await viaEmail.service.consume(tokenOf(viaEmail.mails[0].link), NEW_PASSWORD);

    const viaSubscription = harness({ duringHash: stampLater('wa-gina') });
    const verified = await recover(viaSubscription, `https://sub.example.com/${GINA_SHORT}`, 'gina');
    const subscription = await viaSubscription.service.consume((verified as { token: string }).token, NEW_PASSWORD);

    for (const [h, result, id] of [
      [viaTelegram, telegram, 'wa-alice'],
      [viaEmail, email, 'wa-bob'],
      [viaSubscription, subscription, 'wa-gina'],
    ] as const) {
      assert.equal(result.status, 'ok', id);
      assert.deepEqual(h.db.account(id).sessionsRevokedAt, later, `${id}: the stored moment moved back`);
      // The browser that reset it counts from ITS moment.
      assert.ok(Date.parse((result as { sessionsRevokedAt: string }).sessionsRevokedAt) < later.getTime(), id);
    }
  });

  it('refuses a link issued before the password changed', async () => {
    const h = harness();
    const token = await telegramToken(h);
    h.db.account('wa-alice').passwordHash = 'scrypt$changed-in-settings-since';

    assert.deepEqual(await h.service.inspect(token), { status: 'used' });
    assert.deepEqual(await h.service.consume(token, NEW_PASSWORD), { status: 'used' });
    assert.equal(h.db.account('wa-alice').passwordHash, 'scrypt$changed-in-settings-since');
    assert.equal(h.db.passwordWrites.length, 0);
  });

  it('loses to a password change that lands between its check and its write', async () => {
    const h = harness({
      duringHash: (db) => {
        db.account('wa-alice').passwordHash = 'scrypt$operator-temp-issued-meanwhile';
      },
    });
    const token = await telegramToken(h);

    assert.deepEqual(await h.service.consume(token, NEW_PASSWORD), { status: 'used' });
    assert.equal(h.db.account('wa-alice').passwordHash, 'scrypt$operator-temp-issued-meanwhile');
    assert.equal(h.events.length, 0, 'a reset that did not happen was announced');
  });

  it('gives an account imported without a password its first one through the Telegram link', async () => {
    // What the AltShop importer writes: a login, no password, the bootstrap
    // flag — and a Telegram id, which every AltShop customer has.
    const state = fixtures();
    state.users.push({ id: 'u-imported', telegramId: 700_009n, isBlocked: false, language: Locale.RU });
    state.accounts.push(
      account({
        id: 'wa-imported',
        userId: 'u-imported',
        login: 'imported_user',
        loginNormalized: 'imported_user',
        passwordHash: null,
        passwordBootstrapPending: true,
        requiresPasswordChange: true,
        credentialsBootstrappedAt: null,
      }),
    );
    const h = harness({ state });

    const token = await telegramToken(h, '700009');
    assert.equal((await h.service.consume(token, NEW_PASSWORD)).status, 'ok');

    const row = h.db.account('wa-imported');
    assert.equal(row.passwordBootstrapPending, false);
    assert.equal(row.requiresPasswordChange, false);
    assert.ok(row.credentialsBootstrappedAt instanceof Date);
    assert.ok(row.passwordHash !== null, 'no password was written');
    assert.equal(
      await h.realHasher.verifyPassword({ plainTextPassword: NEW_PASSWORD, passwordHash: row.passwordHash }),
      true,
    );
  });

  it('spends the link of a customer blocked since it was issued, and sets nothing', async () => {
    const h = harness();
    const token = await telegramToken(h);
    h.db.state.users.find((user) => user.id === 'u-alice')!.isBlocked = true;

    assert.deepEqual(await h.service.consume(token, NEW_PASSWORD), { status: 'expired' });
    assert.equal(h.db.passwordWrites.length, 0);
    assert.equal(h.redis.store.has(`${TOKEN_PREFIX}${sha256(token)}`), false);
  });

  it('announces auth.password_recovery with who and how — never the link, the token or a hash', async () => {
    const h = harness();
    const token = await telegramToken(h);

    await h.service.consume(token, NEW_PASSWORD);

    assert.deepEqual(
      h.events.map(({ type, category, metadata }) => ({ type, category, metadata })),
      [{ type: 'auth.password_recovery', category: 'AUTH', metadata: { userId: 'u-alice', method: 'telegram' } }],
    );
    const serialised = JSON.stringify(h.events);
    assert.ok(!serialised.includes(token));
    assert.ok(!serialised.includes('scrypt$'));
    assert.ok(!serialised.includes(NEW_PASSWORD));
  });
});

// ── Asking for a link ───────────────────────────────────────────────────────

describe('password reset: request from the cabinet', () => {
  it('answers before anything is sent, then sends a Telegram link on the cabinet origin, token in the fragment', async () => {
    const h = harness();

    const answer = await h.service.request({
      identifier: 'ALICE',
      cabinetUrl: 'https://cabinet.example.com/some/path?x=1#frag',
    });

    assert.deepEqual(answer, { method: 'telegram', resetLinks: true });
    assert.equal(h.telegramSends.length, 0, 'the answer waited for delivery');
    assert.equal(h.tasks.length, 2, 'Telegram and the verified e-mail should both be scheduled');
    await h.runTasks();

    assert.equal(h.telegramSends.length, 1);
    const sent = h.telegramSends[0];
    assert.equal(sent.telegramId, '700001');
    assert.equal(sent.parseMode, 'HTML');
    assert.match(sent.text, /<b>Alice<\/b>/);
    assert.match(sent.text, /15 минут/);
    const button = sent.buttons?.[0];
    assert.ok(button?.url !== undefined, 'a cabinet address was given, so the button is a URL');
    const url = new URL(button.url);
    assert.equal(url.origin, CABINET);
    assert.equal(url.pathname, '/reset-password');
    assert.equal(url.search, '', 'the token must not be in the query, where access logs and Referer carry it');
    assert.match(url.hash, /^#token=[a-f0-9]{64}$/);
    assert.equal((await h.service.inspect(tokenOf(button.url))).status, 'valid');
  });

  it('falls back to a webAppPath the bot resolves on its own address — token in the query there', async () => {
    const h = harness();

    await h.service.request({ identifier: 'alice', cabinetUrl: null });
    await h.runTasks();

    const button = h.telegramSends[0]?.buttons?.[0];
    assert.equal(button?.url, undefined);
    assert.match(button?.webAppPath ?? '', /^\/reset-password\?token=[a-f0-9]{64}$/);
    assert.equal(h.mails.length, 0, 'an e-mail needs an absolute link and must not be sent without one');
  });

  it('sends the e-mail link only to a VERIFIED address, only with SMTP on, token in the fragment', async () => {
    const on = harness();
    assert.deepEqual(await on.service.request({ identifier: 'bob', cabinetUrl: CABINET }), {
      method: 'email',
      resetLinks: true,
    });
    await on.runTasks();
    assert.equal(on.mails.length, 1);
    assert.equal(on.mails[0].to, 'Bob@Example.com');
    assert.equal(on.mails[0].login, 'bob');
    assert.equal(on.mails[0].locale, 'en');
    const link = new URL(on.mails[0].link);
    assert.equal(link.origin, CABINET);
    assert.equal(link.search, '');
    assert.match(link.hash, /^#token=[a-f0-9]{64}$/);
    assert.equal((await on.service.inspect(tokenOf(on.mails[0].link))).status, 'valid');

    const off = harness({ smtpEnabled: false });
    assert.deepEqual(await off.service.request({ identifier: 'bob', cabinetUrl: CABINET }), {
      method: 'none',
      resetLinks: true,
    });
    const unverified = harness();
    assert.deepEqual(await unverified.service.request({ identifier: 'carol', cabinetUrl: CABINET }), {
      method: 'none',
      resetLinks: true,
    });
    assert.equal(off.tasks.length + unverified.tasks.length, 0);
  });

  it('finds the account by its verified e-mail, and not by an unverified one', async () => {
    const h = harness();
    assert.equal((await h.service.request({ identifier: ' BOB@example.com ', cabinetUrl: CABINET })).method, 'email');
    assert.equal((await h.service.request({ identifier: 'carol@example.com', cabinetUrl: CABINET })).method, 'none');
    // An unconfirmed address names nobody — not even an account that has
    // Telegram to send to.
    assert.deepEqual(await h.service.request({ identifier: 'frank@example.com', cabinetUrl: CABINET }), {
      method: 'none',
      resetLinks: true,
    });
    assert.equal((await h.service.request({ identifier: 'frank', cabinetUrl: CABINET })).method, 'telegram');
  });

  it('answers unknown, blocked and login-less accounts exactly like an account with nowhere to send', async () => {
    const h = harness();
    const answers = await Promise.all(
      ['nobody-here', 'dave', 'nobody@example.com', 'x', 'gina'].map((identifier) =>
        h.service.request({ identifier, cabinetUrl: CABINET }),
      ),
    );
    for (const answer of answers) assert.deepEqual(answer, { method: 'none', resetLinks: true });
    assert.equal(h.tasks.length, 0);
    assert.equal(h.redis.keysStartingWith(TOKEN_PREFIX).length, 0);
  });

  it('sends at most one link a minute and five an hour to one account, however often it is asked', async () => {
    const h = harness({ smtpEnabled: false });
    const ask = () => h.service.request({ identifier: 'alice', cabinetUrl: CABINET });

    await ask();
    await ask();
    await h.runTasks();
    assert.equal(h.telegramSends.length, 1, 'a second request within the minute sent again');

    for (let minute = 2; minute <= 7; minute += 1) {
      h.redis.store.delete('web-auth:pwreset:cooldown:wa-alice'); // the minute passes
      await ask();
    }
    await h.runTasks();
    assert.equal(h.telegramSends.length, 5, 'more than five links went out within the hour');
    const slots = h.redis.keysStartingWith('web-auth:pwreset:hourly:wa-alice:').sort();
    assert.equal(slots.length, 5);
    for (const slot of slots) assert.equal(h.redis.store.get(slot)?.ttlSeconds, 3600, slot);
  });

  it('counts the relay as a channel only when it is configured', async () => {
    const h = harness({ relayEnabled: false, smtpEnabled: false });
    assert.deepEqual(await h.service.request({ identifier: 'alice', cabinetUrl: null }), {
      method: 'none',
      resetLinks: true,
    });
  });
});

describe('password reset: the legacy route of cabinets up to 0.9.7.45', () => {
  it('answers what it always answered, and sends and stores nothing', async () => {
    const h = harness();
    const answers = {
      telegram: await h.service.legacyRecover('ALICE'),
      verifiedEmail: await h.service.legacyRecover('bob'),
      unverifiedEmail: await h.service.legacyRecover('carol'),
      blockedWithTelegram: await h.service.legacyRecover('dave'),
      nothing: await h.service.legacyRecover('gina'),
      unknown: await h.service.legacyRecover('nobody'),
    };

    assert.deepEqual(answers, {
      telegram: { method: 'telegram' },
      verifiedEmail: { method: 'email' },
      unverifiedEmail: { method: 'none' },
      blockedWithTelegram: { method: 'telegram' },
      nothing: { method: 'none' },
      unknown: { method: 'none' },
    });
    assert.equal(h.tasks.length, 0, 'the legacy route scheduled a send');
    assert.deepEqual(h.redis.keysStartingWith('web-auth:pwreset:'), [], 'the legacy route touched the reset keys');

    const smtpOff = harness({ smtpEnabled: false });
    assert.deepEqual(await smtpOff.service.legacyRecover('bob'), { method: 'none' });
  });
});

describe('password reset: from the bot, without a login', () => {
  it('issues a link for the linked account and names its login', async () => {
    const h = harness();
    const issued = await h.service.issueForTelegram('700001');
    assert.equal(issued.status, 'issued');
    if (issued.status !== 'issued') throw new Error('unreachable');
    assert.equal(issued.login, 'Alice');
    assert.equal((await h.service.inspect(issued.token)).status, 'valid');
  });

  it('has nothing for a Telegram user without a web login, a blocked one, or a stranger', async () => {
    const h = harness();
    for (const telegramId of ['700005', '700004', '700999', 'not-an-id']) {
      assert.deepEqual(await h.service.issueForTelegram(telegramId), { status: 'no_account' }, telegramId);
    }
  });

  it('says "just sent" only when a link really went out within the minute', async () => {
    const h = harness();
    await h.service.request({ identifier: 'alice', cabinetUrl: null });
    assert.deepEqual(await h.service.issueForTelegram('700001'), { status: 'recently_sent' });
  });

  it('says "the hour is used up" when five links went out, and leaves no false "just sent" behind', async () => {
    const h = harness();
    for (let slot = 1; slot <= 5; slot += 1) {
      h.redis.store.set(`web-auth:pwreset:hourly:wa-alice:${slot}`, { value: '1', ttlSeconds: 3600 });
    }

    assert.deepEqual(await h.service.issueForTelegram('700001'), { status: 'hourly_limit' });
    assert.equal(h.redis.store.has('web-auth:pwreset:cooldown:wa-alice'), false);
    assert.deepEqual(await h.service.issueForTelegram('700001'), { status: 'hourly_limit' });
  });

  it('says "unavailable" when Redis does not answer, not "just sent"', async () => {
    const h = harness();
    h.redis.status = 'end';
    assert.deepEqual(await h.service.issueForTelegram('700001'), { status: 'unavailable' });
  });
});

// ── An account with no password yet ─────────────────────────────────────────

describe('an account imported without a password: first sign-in', () => {
  /**
   * What the AltShop importer writes: the donor's username as the login (for
   * most customers their PUBLIC Telegram username), no password, the bootstrap
   * flag, the e-mail unverified — plus, here, a Telegram id or none.
   */
  function importedWorld(options: { readonly telegramId: bigint | null; readonly emailVerified?: boolean }) {
    const state = fixtures();
    state.users.push({ id: 'u-imported', telegramId: options.telegramId, isBlocked: false, language: Locale.RU });
    state.accounts.push(
      account({
        id: 'wa-imported',
        userId: 'u-imported',
        login: 'imported_user',
        loginNormalized: 'imported_user',
        email: 'imported@example.com',
        emailNormalized: 'imported@example.com',
        emailVerifiedAt: options.emailVerified === true ? new Date() : null,
        passwordHash: null,
        passwordBootstrapPending: true,
        requiresPasswordChange: true,
        credentialsBootstrappedAt: null,
      }),
    );
    return state;
  }

  /** The REAL `WebAuthService.login`, over the same rows; every other dependency refuses to be used. */
  async function signIn(h: ReturnType<typeof harness>, smtpEnabled = true) {
    const warnings: string[] = [];
    const moduleRef = await Test.createTestingModule({
      providers: [
        WebAuthService,
        { provide: PrismaService, useValue: h.db.loginPrisma() },
        { provide: PasswordHashService, useValue: new PasswordHashService() },
        { provide: EmailDeliveryService, useValue: { getSmtpSettings: async () => ({ enabled: smtpEnabled, host: 'smtp.example.com' }) } },
        { provide: ReferralManualAttachService, useValue: {} },
        { provide: SettingsService, useValue: {} },
        { provide: AccessModeGuard, useValue: {} },
        { provide: RawCacheService, useValue: {} },
        { provide: SystemEventsService, useValue: {} },
        { provide: RegistrationSnapshotService, useValue: {} },
        { provide: LegalDocumentsService, useValue: {} },
      ],
    }).compile();
    const service = moduleRef.get(WebAuthService);
    // The service's own logger, recorded: the operator's warning is part of the behaviour.
    (service as unknown as { logger: Pick<Logger, 'warn' | 'log' | 'error'> }).logger = {
      warn: (message: unknown) => {
        warnings.push(String(message));
      },
      log: () => undefined,
      error: () => undefined,
    };
    return {
      warnings,
      login: (login: string, password: string) => service.login({ login, password }),
    };
  }

  const isOrdinaryRefusal = (error: unknown): boolean =>
    error instanceof UnauthorizedException && error.message === 'Invalid login or password';

  it('lets nobody in with the login and a password of their choosing — and writes nothing', async () => {
    const h = harness({ state: importedWorld({ telegramId: 700_009n }) });
    const door = await signIn(h);

    for (const password of ['a'.repeat(64), 'whatever-they-typed', NEW_PASSWORD]) {
      await assert.rejects(() => door.login('imported_user', password), isOrdinaryRefusal);
    }

    assert.deepEqual(h.db.loginWrites, [], 'a refused sign-in wrote to the account');
    const row = h.db.account('wa-imported');
    assert.equal(row.passwordHash, null);
    assert.equal(row.passwordBootstrapPending, true);
    assert.deepEqual(door.warnings, [], 'an account with Telegram is not the operator’s problem');
  });

  it('sends the owner the ordinary reset link on Telegram, and the owner then signs in with the new password', async () => {
    const h = harness({ state: importedWorld({ telegramId: 700_009n }) });
    const door = await signIn(h);
    await assert.rejects(() => door.login('imported_user', 'stranger-password-1'), isOrdinaryRefusal);

    const answer = await h.service.sendFirstPasswordLink({ login: 'Imported_User', cabinetUrl: CABINET });

    assert.deepEqual(answer, { status: 'sent', channel: 'telegram' });
    await h.runTasks();
    assert.equal(h.telegramSends.length, 1);
    assert.equal(h.telegramSends[0].telegramId, '700009');
    const link = h.telegramSends[0].buttons?.[0]?.url;
    assert.ok(link !== undefined && new URL(link).origin === CABINET, `not a cabinet link: ${String(link)}`);
    assert.match(new URL(link).hash, /^#token=[a-f0-9]{64}$/);

    assert.equal((await h.service.consume(tokenOf(link), NEW_PASSWORD)).status, 'ok');
    const row = h.db.account('wa-imported');
    assert.equal(row.passwordBootstrapPending, false, 'the reset must end the bootstrap state');
    assert.equal(row.requiresPasswordChange, false);

    const signedIn = await door.login('imported_user', NEW_PASSWORD);
    assert.equal(signedIn.userId, 'u-imported');
    assert.equal(signedIn.requiresPasswordChange, false);
    await assert.rejects(() => door.login('imported_user', 'stranger-password-1'), isOrdinaryRefusal);
  });

  it('keeps to the per-account caps of "forgot password"', async () => {
    const h = harness({ state: importedWorld({ telegramId: 700_009n }) });
    const ask = () => h.service.sendFirstPasswordLink({ login: 'imported_user', cabinetUrl: CABINET });

    assert.deepEqual(await ask(), { status: 'sent', channel: 'telegram' });
    // Within the minute: the link that just went out is the answer; nothing new goes.
    assert.deepEqual(await ask(), { status: 'sent', channel: 'telegram' });
    await h.runTasks();
    assert.equal(h.telegramSends.length, 1);

    for (let minute = 2; minute <= 5; minute += 1) {
      h.redis.store.delete('web-auth:pwreset:cooldown:wa-imported');
      assert.deepEqual(await ask(), { status: 'sent', channel: 'telegram' });
    }
    h.redis.store.delete('web-auth:pwreset:cooldown:wa-imported');
    assert.deepEqual(await ask(), { status: 'hourly_limit' });
    await h.runTasks();
    assert.equal(h.telegramSends.length, 5);
  });

  it('points at the bot when the panel cannot push to it, and says so when Redis is down', async () => {
    const noRelay = harness({ relayEnabled: false, state: importedWorld({ telegramId: 700_009n }) });
    assert.deepEqual(await noRelay.service.sendFirstPasswordLink({ login: 'imported_user', cabinetUrl: CABINET }), {
      status: 'use_bot',
    });
    assert.equal(noRelay.storedTokens().length, 0);

    const noRedis = harness({ state: importedWorld({ telegramId: 700_009n }) });
    noRedis.redis.status = 'end';
    assert.deepEqual(await noRedis.service.sendFirstPasswordLink({ login: 'imported_user', cabinetUrl: CABINET }), {
      status: 'unavailable',
    });
  });

  it('refuses an account no link can reach the ordinary way, and tells the operator which one', async () => {
    const h = harness({ state: importedWorld({ telegramId: null }) });
    const door = await signIn(h);

    await assert.rejects(() => door.login('imported_user', 'anything-at-all'), isOrdinaryRefusal);

    assert.equal(door.warnings.length, 1);
    assert.match(door.warnings[0], /web account wa-imported has no password yet/);
    assert.deepEqual(await h.service.sendFirstPasswordLink({ login: 'imported_user', cabinetUrl: CABINET }), {
      status: 'not_applicable',
    });
    assert.deepEqual(h.db.loginWrites, []);
    assert.equal(h.tasks.length, 0);
  });

  it('counts a verified e-mail as a way in only while SMTP can send', async () => {
    const withSmtp = harness({ state: importedWorld({ telegramId: null, emailVerified: true }) });
    assert.deepEqual(await withSmtp.service.sendFirstPasswordLink({ login: 'imported_user', cabinetUrl: CABINET }), {
      status: 'sent',
      channel: 'email',
    });
    await withSmtp.runTasks();
    assert.equal(withSmtp.mails.length, 1);
    assert.equal(withSmtp.mails[0].to, 'imported@example.com');

    const smtpOff = harness({ smtpEnabled: false, state: importedWorld({ telegramId: null, emailVerified: true }) });
    const door = await signIn(smtpOff, false);
    await assert.rejects(() => door.login('imported_user', 'anything-at-all'), isOrdinaryRefusal);
    assert.equal(door.warnings.length, 1);
    assert.deepEqual(await smtpOff.service.sendFirstPasswordLink({ login: 'imported_user', cabinetUrl: CABINET }), {
      status: 'not_applicable',
    });
  });

  it('is not a way to send links to anybody else', async () => {
    const h = harness({ state: importedWorld({ telegramId: 700_009n }) });
    h.db.state.users.push({ id: 'u-plain', telegramId: 700_010n, isBlocked: false, language: Locale.RU });
    // A null password WITHOUT the bootstrap flag is not an imported account.
    h.db.state.accounts.push(
      account({ id: 'wa-plain', userId: 'u-plain', login: 'plain', loginNormalized: 'plain', passwordHash: null }),
    );
    // An imported account an operator has since given a temporary password:
    // the flag is still set, but the account HAS a password.
    h.db.state.users.push({ id: 'u-temp', telegramId: 700_011n, isBlocked: false, language: Locale.RU });
    h.db.state.accounts.push(
      account({
        id: 'wa-temp',
        userId: 'u-temp',
        login: 'temp_pass',
        loginNormalized: 'temp_pass',
        passwordBootstrapPending: true,
        requiresPasswordChange: true,
      }),
    );

    for (const login of ['alice', 'dave', 'plain', 'temp_pass', 'nobody-here', 'x', 'bad login']) {
      assert.deepEqual(
        await h.service.sendFirstPasswordLink({ login, cabinetUrl: CABINET }),
        { status: 'not_applicable' },
        login,
      );
    }
    assert.equal(h.tasks.length, 0);
    assert.equal(h.storedTokens().length, 0);
  });
});

// ── Recovery by subscription link ───────────────────────────────────────────

describe('subscription link: what a customer can paste', () => {
  const cases: Array<[string, string, string]> = [
    ['a bare-domain URL', `https://sub.example.com/${ALICE_SHORT}`, ALICE_SHORT],
    ['a client suffix and a query', `https://sub.example.com/${ALICE_SHORT}/singbox?format=json`, ALICE_SHORT],
    ['the /api/sub/ form with a suffix', `https://panel.example.com/api/sub/${BOB_SHORT}/json`, BOB_SHORT],
    ['the /sub/ form', `https://example.com/sub/${ALICE_SHORT}`, ALICE_SHORT],
    ['a bare short id', `  ${ALICE_SHORT}  `, ALICE_SHORT],
    ['happ://add/', `happ://add/https://sub.example.com/${ALICE_SHORT}`, ALICE_SHORT],
    [
      'v2rayng://install-sub?url=<encoded>',
      `v2rayng://install-sub?url=${encodeURIComponent(`https://sub.example.com/${ALICE_SHORT}/v2ray`)}&name=VPN`,
      ALICE_SHORT,
    ],
    ['streisand://import/', `streisand://import/https://sub.example.com/${ALICE_SHORT}#My%20VPN`, ALICE_SHORT],
    [
      'sing-box://import-remote-profile?url=',
      `sing-box://import-remote-profile?url=${encodeURIComponent(`https://sub.example.com/${ALICE_SHORT}`)}#name`,
      ALICE_SHORT,
    ],
    [
      'a doubly encoded clash link',
      `clash://install-config?url=${encodeURIComponent(encodeURIComponent(`https://sub.example.com/${ALICE_SHORT}`))}`,
      ALICE_SHORT,
    ],
    [
      'sub://<base64>',
      `sub://${Buffer.from(`https://sub.example.com/${ALICE_SHORT}`, 'utf8').toString('base64')}`,
      ALICE_SHORT,
    ],
    ['a custom path prefix with a client suffix', `https://sub.example.com/vpn/${KATE_SHORT}/singbox`, KATE_SHORT],
    [
      'a deep custom prefix',
      `https://sub.example.com/aaaaaaaa1/bbbbbbbb2/cccccccc3/dddddddd4/${KATE_SHORT}`,
      KATE_SHORT,
    ],
  ];
  for (const [shape, input, expected] of cases) {
    it(`finds the id in ${shape}`, () => {
      const parsed = parseSubscriptionLink(input);
      assert.equal(parsed.encrypted, false);
      assert.ok(parsed.candidates.includes(expected), JSON.stringify(parsed.candidates));
    });
  }

  it('reports an encrypted Happ link as unresolvable, and finds nothing in noise', () => {
    assert.deepEqual(parseSubscriptionLink('happ://crypt3/AbCdEfGh0123456789'), { candidates: [], encrypted: true });
    assert.deepEqual(parseSubscriptionLink('hello, my vpn does not work'), { candidates: [], encrypted: false });
    assert.deepEqual(parseSubscriptionLink('https://sub.example.com/'), { candidates: [], encrypted: false });
    assert.deepEqual(parseSubscriptionLink('%%%'), { candidates: [], encrypted: false });
  });

  it('escapes every LIKE metacharacter of a candidate', () => {
    assert.equal(escapeLikeLiteral('a_b%c\\d'), 'a\\_b\\%c\\\\d');
    assert.equal(likeMatches('xa_bz', `%${escapeLikeLiteral('a_b')}%`), true);
    assert.equal(likeMatches('xaQbz', `%${escapeLikeLiteral('a_b')}%`), false, 'an escaped _ matched another character');
  });
});

describe('subscription link: which stored addresses are recognised', () => {
  it('recognises a custom path prefix for recovery, and leaves the panel addressing reader strict', () => {
    const custom = `https://sub.example.com/vpn/${KATE_SHORT}`;
    assert.deepEqual(configUrlShortIds(custom), [KATE_SHORT]);
    assert.equal(panelShortUuidFromConfigUrl(custom), null, 'panel addressing must not start reading custom paths');
    assert.deepEqual(configUrlShortIds(`https://sub.example.com/${ALICE_SHORT}`), [ALICE_SHORT]);
    assert.deepEqual(configUrlShortIds(`https://panel.example.com/api/sub/${BOB_SHORT}`), [BOB_SHORT]);
    assert.deepEqual(configUrlShortIds(`https://sub.example.com/vpn/${KATE_SHORT}/`), [KATE_SHORT]);
  });

  it('never takes a route or a client format for an id', () => {
    for (const tail of ['singbox', 'subscription', 'xray-json', 'short']) {
      assert.deepEqual(configUrlShortIds(`https://sub.example.com/vpn/${tail}`), [], tail);
    }
  });

  it('answers "cannot tell" for malformed percent-encoding instead of throwing', () => {
    for (const bad of ['https://sub.example.com/sub/%E0%A4%A', '/api/sub/%E0%A4%A', 'https://sub.example.com/%E0%A4%A']) {
      assert.doesNotThrow(() => panelShortUuidFromConfigUrl(bad), bad);
      assert.equal(panelShortUuidFromConfigUrl(bad), null, bad);
      assert.doesNotThrow(() => configUrlShortIds(bad), bad);
      assert.deepEqual(configUrlShortIds(bad), [], bad);
    }
  });
});

describe('subscription link: recovery', () => {
  const ginaLink = `happ://add/https://sub.example.com/${GINA_SHORT}/json`;

  it('verifies an account with no channel, and the token resets the password with a 72-hour withdrawal hold', async () => {
    const h = harness();

    const verified = await recover(h, ginaLink, 'GINA');
    assert.equal(verified.status, 'verified');
    if (verified.status !== 'verified') throw new Error('unreachable');
    assert.equal(verified.login, 'gina');

    const before = Date.now();
    assert.equal((await h.service.consume(verified.token, NEW_PASSWORD)).status, 'ok');
    const holds = h.db.state.challenges.filter((row) => row.purpose === RECOVERY_WITHDRAWAL_HOLD_PURPOSE);
    assert.equal(holds.length, 1, 'no withdrawal hold was written with the new password');
    assert.equal(holds[0].webAccountId, 'wa-gina');
    const holdHours = (holds[0].expiresAt.getTime() - before) / 3_600_000;
    assert.ok(holdHours > 71.99 && holdHours < 72.01, `hold of ${holdHours}h`);
    assert.deepEqual(h.events.map((event) => event.metadata), [{ userId: 'u-gina', method: 'subscription_link' }]);

    await h.runTasks();
    assert.equal(h.pushes.length, 1);
    assert.equal(h.pushes[0].userId, 'u-gina');
    assert.equal(h.pushes[0].body, 'Пароль от кабинета изменён по ссылке подписки. Если это были не вы — напишите в поддержку.');
  });

  it('never resets an account that has a channel: it sends the ordinary link there instead', async () => {
    const h = harness();

    const both = await recover(h, `https://sub.example.com/${ALICE_SHORT}`, 'alice');
    const email = await recover(h, `https://panel.example.com/api/sub/${BOB_SHORT}`, 'bob');
    // Telegram only — the e-mail typed in was never confirmed.
    const telegram = await recover(h, `https://sub.example.com/${FRANK_SHORT}/json`, 'frank');

    assert.deepEqual(both, { status: 'sent_to_channels' });
    assert.deepEqual(email, { status: 'sent_to_channels' });
    assert.deepEqual(telegram, { status: 'sent_to_channels' });
    assert.ok(
      h.storedTokens().every((token) => token.channel !== 'subscription_link'),
      `a subscription-link token was minted for an account with a channel: ${JSON.stringify(h.storedTokens())}`,
    );
    await h.runTasks();
    assert.deepEqual(h.telegramSends.map((send) => send.telegramId).sort(), ['700001', '700006']);
    assert.deepEqual(h.mails.map((mail) => mail.to).sort(), ['Bob@Example.com', 'alice@example.com']);
    assert.ok(h.mails.every((mail) => new URL(mail.link).origin === CABINET));
  });

  it('counts a linked Telegram as a channel even when the panel cannot reach the bot', async () => {
    // The bot's own "send me a link" still works, so the link is not the only way in.
    const h = harness({ relayEnabled: false, smtpEnabled: false });
    assert.deepEqual(await recover(h, `https://sub.example.com/${FRANK_SHORT}`, 'frank'), {
      status: 'sent_to_channels',
    });
    assert.equal(h.storedTokens().length, 0);
  });

  it('treats an e-mail as no channel when the operator has SMTP off', async () => {
    const h = harness({ smtpEnabled: false });
    const answer = await recover(h, `https://panel.example.com/api/sub/${BOB_SHORT}`, 'bob');
    assert.equal(answer.status, 'verified');
  });

  it('gives a wrong link, a wrong login, an unknown login, a blocked owner and an encrypted link the same answer', async () => {
    const h = harness();
    const answers = [
      await recover(h, `https://sub.example.com/${IVAN_SHORT}`, 'gina'),
      await recover(h, ginaLink, 'ivan'),
      await recover(h, ginaLink, 'nobody-at-all'),
      await recover(h, `https://sub.example.com/${LEO_SHORT}`, 'leo'),
      await recover(h, 'happ://crypt3/AbCdEfGh0123456789', 'gina'),
    ];
    for (const answer of answers) assert.deepEqual(answer, { status: 'mismatch' });
    assert.equal(h.redis.keysStartingWith(TOKEN_PREFIX).length, 0, 'a failed verification minted a token');
  });

  it('accepts a subscription expired 29 days ago and refuses one expired 31 days ago', async () => {
    const h = harness();
    assert.equal((await recover(h, `https://sub.example.com/${IVAN_SHORT}`, 'ivan')).status, 'verified');
    assert.deepEqual(await recover(h, `https://sub.example.com/${JUNE_SHORT}`, 'june'), { status: 'mismatch' });
  });

  it('recognises an address under a custom path prefix', async () => {
    const h = harness();
    const answer = await recover(h, `https://sub.example.com/vpn/${KATE_SHORT}/singbox`, 'kate');
    assert.equal(answer.status, 'verified');
  });

  it('allows five attempts an hour per address — an IPv6 /64 counting as one address', async () => {
    const h = harness();
    const nobodysLink = 'https://sub.example.com/Nothing00001';
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const answer = await recover(h, nobodysLink, `nobody${attempt}`, `2001:db8:1:2::${attempt}`);
      assert.deepEqual(answer, { status: 'mismatch' }, `attempt ${attempt}`);
    }
    assert.deepEqual(await recover(h, ginaLink, 'gina', '2001:db8:1:2:ffff:ffff:ffff:9'), {
      status: 'rate_limited',
      retryAfterSeconds: 3600,
    });
    const bucket = `web-auth:subrec:ip:${sha256('2001:db8:1:2::/64')}`;
    for (let slot = 1; slot <= 5; slot += 1) {
      assert.equal(h.redis.store.get(`${bucket}:${slot}`)?.ttlSeconds, 3600, `slot ${slot}`);
    }
    assert.equal((await recover(h, ginaLink, 'gina', '2001:db8:1:3::1')).status, 'verified', 'another /64 was blocked');
  });

  it('refuses the owner of a link for 24 hours after five attempts that named it — even the right pair', async () => {
    const h = harness();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.deepEqual(await recover(h, ginaLink, `guess${attempt}`), { status: 'mismatch' });
    }
    for (let slot = 1; slot <= 5; slot += 1) {
      assert.equal(h.redis.store.get(`web-auth:subrec:owner:wa-gina:${slot}`)?.ttlSeconds, 86_400, `slot ${slot}`);
    }
    assert.deepEqual(await recover(h, ginaLink, 'gina'), { status: 'mismatch' });
  });

  it('does not lock a login somebody merely TYPED — only the owner of a real link', async () => {
    const h = harness();
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      assert.deepEqual(await recover(h, `https://sub.example.com/Garbage0000${attempt}`, 'gina'), {
        status: 'mismatch',
      });
    }
    assert.equal((await recover(h, ginaLink, 'gina')).status, 'verified', 'typing a login locked its owner out');
  });

  it('gives a verified owner a clean count', async () => {
    const h = harness();
    await recover(h, ginaLink, 'typo1');
    await recover(h, ginaLink, 'typo2');
    assert.equal((await recover(h, ginaLink, 'gina')).status, 'verified');
    assert.deepEqual(h.redis.keysStartingWith('web-auth:subrec:owner:wa-gina:'), []);
  });

  it('refuses to verify at all without Redis, rather than verify unmetered', async () => {
    const h = harness();
    h.redis.status = 'end';
    // A WRONG pair is the case that matters: answered `mismatch` without the
    // per-address budget, this path would be an unmetered oracle for guessing —
    // and a link that names nobody must not answer differently from one that
    // names somebody.
    for (const login of ['gina', 'ivan', 'nobody-at-all']) {
      assert.deepEqual(await recover(h, ginaLink, login), { status: 'unavailable' }, login);
    }
    assert.deepEqual(await recover(h, 'https://sub.example.com/Nothing00001', 'gina'), { status: 'unavailable' });
  });
});

describe('subscription link: the operator switch', () => {
  const ginaLink = `https://sub.example.com/${GINA_SHORT}`;

  it('refuses everything the same way when OFF — before anything is counted or looked up', async () => {
    const h = harness({ subscriptionLinkRecovery: false });

    const answers = [
      await recover(h, ginaLink, 'gina'),
      await recover(h, ginaLink, 'somebody-else'),
      await recover(h, 'https://sub.example.com/Nothing00001', 'gina'),
      await recover(h, `https://sub.example.com/${ALICE_SHORT}`, 'alice'),
    ];

    for (const answer of answers) assert.deepEqual(answer, { status: 'disabled' });
    assert.deepEqual(h.db.subscriptionQueries, [], 'a switched-off path looked the link up');
    assert.deepEqual(h.redis.keysStartingWith('web-auth:'), [], 'a switched-off path counted or minted');
    assert.equal(h.tasks.length, 0);
    assert.equal(h.db.passwordWrites.length, 0);
  });

  it('works as before when ON', async () => {
    const h = harness({ subscriptionLinkRecovery: true });
    assert.equal((await recover(h, ginaLink, 'gina')).status, 'verified');
  });

  it('says "unavailable", not "off" and not "on", when the policy cannot be read', async () => {
    const h = harness({ subscriptionLinkRecovery: 'unreadable' });
    assert.deepEqual(await recover(h, ginaLink, 'gina'), { status: 'unavailable' });
    assert.deepEqual(h.db.subscriptionQueries, []);
  });

  it('leaves the channel paths alone', async () => {
    const h = harness({ subscriptionLinkRecovery: false });
    assert.deepEqual(await h.service.request({ identifier: 'alice', cabinetUrl: CABINET }), {
      method: 'telegram',
      resetLinks: true,
    });
    assert.equal((await h.service.issueForTelegram('700001')).status, 'recently_sent');
  });
});

// ── The reviewer's probe, kept as a regression test ─────────────────────────

describe('regression: the owner lock cannot be crowded out or raced (review probe)', () => {
  /** 25 other customers whose rows come first, and the victim — no channel. */
  function world(): DatabaseState {
    const victim = loneCustomer('victim', {
      status: SubscriptionStatus.ACTIVE,
      expiresAt: null,
      configUrl: 'https://sub.vpnbrand.com/VictimShort01',
    });
    const fillers = Array.from({ length: 25 }, (_, i) =>
      loneCustomer(`user${i}`, {
        status: SubscriptionStatus.ACTIVE,
        expiresAt: null,
        configUrl: `https://sub.vpnbrand.com/Filler${String(i).padStart(4, '0')}xyz`,
      }),
    );
    const all = [...fillers, victim];
    return {
      users: all.map((entry) => entry.user),
      accounts: all.map((entry) => entry.account),
      subscriptions: all.map((entry) => entry.subscription),
      challenges: [],
    };
  }

  it('CONTROL: five wrong logins with the victim link, and the right pair is refused', async () => {
    const h = harness({ state: world() });
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(await recover(h, 'https://sub.vpnbrand.com/VictimShort01', `guess${i}`), { status: 'mismatch' });
    }
    assert.deepEqual(await recover(h, 'https://sub.vpnbrand.com/VictimShort01', 'victim'), { status: 'mismatch' });
  });

  it('a second candidate matching every address does not push the owner out', async () => {
    const h = harness({ state: world() });
    const link = 'https://anything.invalid/VictimShort01/vpnbrand';
    for (let i = 0; i < 40; i += 1) {
      assert.deepEqual(await recover(h, link, `guess${i}`), { status: 'mismatch' });
    }
    assert.deepEqual(await recover(h, link, 'victim'), { status: 'mismatch' }, 'the owner lock was bypassed');
  });

  it('a run of underscores (a LIKE wildcard) names nobody and does not push the owner out', async () => {
    const h = harness({ state: world() });
    const link = 'https://anything.invalid/VictimShort01/______';
    for (let i = 0; i < 40; i += 1) await recover(h, link, `guess${i}`);
    assert.deepEqual(await recover(h, link, 'victim'), { status: 'mismatch' });
    assert.ok(
      h.db.subscriptionQueries.flat().some((pattern) => pattern.includes('\\_\\_\\_\\_\\_\\_')),
      `the underscores reached the database unescaped: ${JSON.stringify(h.db.subscriptionQueries.slice(0, 3))}`,
    );
  });

  it('a concurrent burst is counted before any of it is judged', async () => {
    const h = harness({ state: world() });
    const link = 'https://sub.vpnbrand.com/VictimShort01';
    const burst = Array.from({ length: 30 }, (_, i) => (i === 29 ? 'victim' : `guess${i}`));

    const results = await Promise.all(burst.map((login) => recover(h, link, login)));

    assert.deepEqual(results[29], { status: 'mismatch' }, '29 wrong guesses in the same burst did not lock the owner');
    assert.equal(h.redis.keysStartingWith('web-auth:subrec:owner:wa-victim:').length, 5);
    assert.ok(results.every((result) => result.status === 'mismatch'));
  });
});

// ── Where the pieces are wired ──────────────────────────────────────────────

describe('password reset: wiring', () => {
  it('sends the reset e-mail directly and never through the delivery queue', async () => {
    const service: EmailDeliveryService = Object.create(EmailDeliveryService.prototype);
    const immediate: SendEmailPayload[] = [];
    const queued: SendEmailPayload[] = [];
    service.sendImmediate = async (payload) => {
      immediate.push(payload);
      return { success: true };
    };
    service.send = async (payload) => {
      queued.push(payload);
    };

    await service.sendPasswordResetLink({
      to: 'bob@example.com',
      login: 'bob',
      link: `${CABINET}/reset-password#token=${'c'.repeat(64)}`,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      locale: 'en',
    });

    assert.equal(queued.length, 0, 'a live reset link was put on the queue');
    assert.equal(immediate.length, 1);
    assert.match(immediate[0].rawHtml ?? '', /href="https:\/\/cabinet\.example\.com\/reset-password#token=c{64}"/);
    assert.match(immediate[0].rawHtml ?? '', /<b>bob<\/b>/);
    assert.equal(immediate[0].locale, 'en');
  });

  it('resolves every dependency of the reset service by the tokens the module provides', async () => {
    // The ports are type aliases, which emit no usable DI metadata — each one
    // needs its explicit @Inject token. A missing one would inject `Object`
    // or fail at boot; neither the compiler nor the direct-construction cases
    // above can see that.
    const redis = new FakeRedis();
    const cache = new RawCacheService();
    (cache as unknown as { redis: FakeRedis }).redis = redis;
    const events: PasswordResetEvents = { info: () => undefined };
    const policy: PasswordResetPolicy = {
      getInternalPlatformPolicy: async () => platformPolicy({ subscriptionLinkRecovery: false }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        PasswordResetService,
        BotNotifierClient,
        { provide: PASSWORD_RESET_DATABASE, useValue: new FakeDatabase(fixtures()) },
        { provide: RawCacheService, useValue: cache },
        { provide: PasswordHashService, useValue: new PasswordHashService() },
        { provide: SystemEventsService, useValue: events },
        { provide: EmailDeliveryService, useValue: { getSmtpSettings: async () => ({ enabled: false }) } },
        { provide: SettingsService, useValue: policy },
      ],
    }).compile();

    const service = moduleRef.get(PasswordResetService);
    const issued = await service.issueForTelegram('700001');
    assert.equal(issued.status, 'issued');
    // The switch is read through the SettingsService token, not some other object.
    assert.deepEqual(
      await service.recoverBySubscription({ link: `https://sub.example.com/${GINA_SHORT}`, login: 'gina', clientIp: null, cabinetUrl: null }),
      { status: 'disabled' },
    );
  });

  it('routes the legacy recover route to the answer-only method, on its old shape', async () => {
    const calls: string[] = [];
    const passwordReset: Pick<PasswordResetService, 'legacyRecover'> = {
      legacyRecover: async (login) => {
        calls.push(login);
        return { method: 'telegram' };
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [InternalWebAuthController],
      providers: [
        { provide: WebAuthService, useValue: {} },
        { provide: BotSigninTokenService, useValue: {} },
        { provide: PasswordResetService, useValue: passwordReset },
      ],
    })
      .overrideGuard(InternalAdminAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const controller = moduleRef.get(InternalWebAuthController);

    assert.deepEqual(await controller.recover({ login: 'alice' }), { method: 'telegram' });
    assert.deepEqual(calls, ['alice']);
  });

  it('reaches the operators: the type is registered, delivered in "all" mode, and tickable in "selected" mode', () => {
    assert.equal(EVENT_TYPES.AUTH_PASSWORD_RECOVERY, 'auth.password_recovery');
    assert.ok(REGISTERED_EVENT_TYPES.has('auth.password_recovery'));
    const known = { knownTypes: REGISTERED_EVENT_TYPES };
    assert.equal(isEventTelegramAllowed('auth.password_recovery', { eventsMode: 'all', events: [], ...known }), true);
    assert.equal(
      isEventTelegramAllowed('auth.password_recovery', { eventsMode: 'selected', events: [], ...known }),
      false,
    );
    assert.equal(
      isEventTelegramAllowed('auth.password_recovery', {
        eventsMode: 'selected',
        events: ['auth.password_recovery'],
        ...known,
      }),
      true,
    );
    const target = resolveTelegramDeliveryTarget(
      {
        enabled: true,
        chatId: '-1001',
        topicMap: { AUTH: 42 },
        defaultTopicId: 7,
        errorTopicId: null,
        devChatId: null,
      },
      { type: 'auth.password_recovery', category: 'AUTH', severity: 'INFO' },
    );
    assert.deepEqual(target, { chatId: '-1001', topicId: 42, isDevFallback: false });
  });
});

// ── The e-mail bridge ───────────────────────────────────────────────────────

describe('e-mail bridge: credential events go only to a verified address', () => {
  async function bridgeFor(user: {
    email: string | null;
    webAccount: { email: string | null; emailVerifiedAt: Date | null } | null;
  }) {
    const sent: Array<{ to: string; templateType: string }> = [];
    let hook: ((event: SystemEventPayload & { timestamp: string }) => void) | null = null;
    const events = {
      registerHook: (registered: (event: SystemEventPayload & { timestamp: string }) => void) => {
        hook = registered;
        return () => undefined;
      },
    };
    const prisma = {
      notificationTemplate: {
        findUnique: async (args: { where: { type: string } }) => ({ isActive: args.where.type.length > 0 }),
      },
      user: {
        findUnique: async (args: { where: { id: string } }) =>
          args.where.id === 'u-1' ? { name: 'Alice', language: 'RU', ...user } : null,
      },
    };
    const email = {
      send: async (payload: { to: string; templateType: string }) => {
        sent.push({ to: payload.to, templateType: payload.templateType });
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        EmailEventBridgeService,
        { provide: SystemEventsService, useValue: events },
        { provide: EmailDeliveryService, useValue: email },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    moduleRef.get(EmailEventBridgeService).onModuleInit();
    return {
      sent,
      async fire(type: string): Promise<void> {
        assert.ok(hook !== null, 'the bridge registered no hook');
        hook({
          type,
          category: 'AUTH',
          severity: 'INFO',
          message: 'x',
          metadata: { userId: 'u-1', method: 'subscription_link' },
          timestamp: new Date().toISOString(),
        });
        for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      },
    };
  }

  it('does not mail auth.password_recovery to an unverified or a user-row address', async () => {
    const unverified = await bridgeFor({
      email: 'profile@example.com',
      webAccount: { email: 'typo@example.com', emailVerifiedAt: null },
    });
    await unverified.fire('auth.password_recovery');
    assert.deepEqual(unverified.sent, []);

    const verified = await bridgeFor({
      email: 'profile@example.com',
      webAccount: { email: 'owner@example.com', emailVerifiedAt: new Date() },
    });
    await verified.fire('auth.password_recovery');
    assert.deepEqual(verified.sent, [{ to: 'owner@example.com', templateType: 'auth.password_recovery' }]);
  });

  it('leaves every other event on its old address rule', async () => {
    const bridge = await bridgeFor({
      email: 'profile@example.com',
      webAccount: { email: 'typo@example.com', emailVerifiedAt: null },
    });
    await bridge.fire('subscription.expired');
    assert.deepEqual(bridge.sent, [{ to: 'profile@example.com', templateType: 'subscription.expired' }]);
  });
});

// ── Address buckets ─────────────────────────────────────────────────────────

describe('address buckets for attempt budgets', () => {
  it('counts an IPv6 /64 as one address, an IPv4 as itself, a mapped IPv4 as the IPv4', () => {
    assert.equal(ipAttemptBucket('2001:db8:1:2::1'), '2001:db8:1:2::/64');
    assert.equal(ipAttemptBucket('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
    assert.equal(ipAttemptBucket('2001:db8:1:2:3:4:5:6%eth0'), '2001:db8:1:2::/64');
    assert.notEqual(ipAttemptBucket('2001:db8:1:3::1'), ipAttemptBucket('2001:db8:1:2::1'));
    assert.equal(ipAttemptBucket('::1'), '0:0:0:0::/64');
    assert.equal(ipAttemptBucket('198.51.100.7'), '198.51.100.7');
    assert.equal(ipAttemptBucket('::ffff:198.51.100.7'), '198.51.100.7');
    assert.equal(ipAttemptBucket(null), 'unknown');
    assert.equal(ipAttemptBucket('not an address'), 'unknown');
  });
});

// ── The withdrawal hold ─────────────────────────────────────────────────────

describe('withdrawal hold after a reset by subscription link', () => {
  interface Hold {
    readonly userId: string;
    readonly purpose: string;
    readonly expiresAt: Date;
    readonly consumedAt: Date | null;
  }

  function holdReader(holds: readonly Hold[]): RecoveryWithdrawalHoldReader {
    return {
      authChallenge: {
        findFirst: async (args) => {
          const where = args.where as {
            purpose?: string;
            consumedAt?: null;
            expiresAt?: { gt?: Date };
            webAccount?: { userId?: string };
          };
          assert.deepEqual(Object.keys(where).sort(), ['consumedAt', 'expiresAt', 'purpose', 'webAccount']);
          const live = holds
            .filter(
              (hold) =>
                hold.purpose === where.purpose &&
                hold.consumedAt === null &&
                where.expiresAt?.gt !== undefined &&
                hold.expiresAt > where.expiresAt.gt &&
                hold.userId === where.webAccount?.userId,
            )
            .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
          return live[0] === undefined ? null : { expiresAt: live[0].expiresAt };
        },
      },
    };
  }

  it('finds a live hold for the user and ignores expired, spent and foreign ones', async () => {
    const now = new Date();
    const later = new Date(now.getTime() + 3 * DAY_MS);
    const reader = holdReader([
      { userId: 'u-1', purpose: RECOVERY_WITHDRAWAL_HOLD_PURPOSE, expiresAt: later, consumedAt: null },
      { userId: 'u-2', purpose: RECOVERY_WITHDRAWAL_HOLD_PURPOSE, expiresAt: new Date(now.getTime() - 1), consumedAt: null },
      { userId: 'u-3', purpose: RECOVERY_WITHDRAWAL_HOLD_PURPOSE, expiresAt: later, consumedAt: now },
      { userId: 'u-4', purpose: 'email_verify', expiresAt: later, consumedAt: null },
    ]);
    assert.deepEqual(await findRecoveryWithdrawalHold(reader, 'u-1', now), later);
    for (const userId of ['u-2', 'u-3', 'u-4', 'u-5']) {
      assert.equal(await findRecoveryWithdrawalHold(reader, userId, now), null, userId);
    }
  });

  // What the hold REFUSES — a withdrawal request and a purchase paid with the
  // balance, both before their debit, both with the same code and end of hold
  // after the panel's error filter — is pinned in
  // `test/partner-balance-recovery-hold.spec.ts`, through the real services.
});

// ── The fakes are honest ────────────────────────────────────────────────────

describe('the fakes behave as the real servers do', () => {
  it('Redis: two read-then-delete callers both read one value — the defect `take` rules out', async () => {
    const redis = new FakeRedis();
    const cache = new RawCacheService();
    (cache as unknown as { redis: FakeRedis }).redis = redis;
    redis.store.set('one-time', { value: '"payload"', ttlSeconds: 300 });

    const readThenDelete = async (): Promise<string | null> => {
      const value = await cache.get<string>('one-time');
      await cache.del('one-time');
      return value;
    };

    assert.deepEqual(await Promise.all([readThenDelete(), readThenDelete()]), ['payload', 'payload']);
  });

  it('Postgres LIKE: an unescaped underscore matches any character, an escaped one only itself', () => {
    assert.equal(likeMatches('https://x/Filler0001xyz', '%/______%'), true);
    assert.equal(likeMatches('https://x/Filler0001xyz', `%/${escapeLikeLiteral('______')}`), false);
    assert.equal(likeMatches('https://x/______', `%/${escapeLikeLiteral('______')}`), true);
  });

  it('Postgres rows: a wide filter returns every match in storage order, and `take` cuts it there', async () => {
    const db = new FakeDatabase(fixtures());
    const everything = await db.subscription.findMany({
      where: { OR: [{ configUrl: { contains: '/' } }] },
      select: LINK_OWNER_SELECT,
    });
    assert.deepEqual(
      everything.map((row) => row.id),
      db.state.subscriptions.map((row) => row.id),
    );
    const cut = await db.subscription.findMany({
      where: { OR: [{ configUrl: { contains: '/' } }] },
      select: LINK_OWNER_SELECT,
      take: 2,
    } as Parameters<FakeDatabase['subscription']['findMany']>[0]);
    assert.deepEqual(cut.map((row) => row.id), ['s-alice', 's-bob']);
  });
});
