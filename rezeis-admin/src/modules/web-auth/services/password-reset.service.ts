import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { PasswordHashService } from '../../auth/services/password-hash.service';
import { SettingsService } from '../../settings/services/settings.service';
import { loginPolicy } from '../../auth/utils/login-policy.util';
import { EmailDeliveryService } from '../../email/services/email-delivery.service';
import { BotNotifierClient } from '../../notifications/services/bot-notifier.client';
import { WebPushService } from '../../push/services/web-push.service';
import { configUrlShortIds } from '../../remnawave/services/panel-user-address';
import { tempPasswordCacheKey } from '../../users/utils/temp-password-cache.util';
import type {
  PasswordRecoveryMethod,
  PasswordResetConsumeResultInterface,
  PasswordResetFirstPasswordResultInterface,
  PasswordResetInspectResultInterface,
  PasswordResetRequestResultInterface,
  PasswordResetSubscriptionResultInterface,
  PasswordResetTelegramResultInterface,
  WebAuthRecoverResultInterface,
} from '../interfaces/web-auth.interface';
import { ipAttemptBucket } from '../utils/ip-bucket.util';
import {
  minutesLeft,
  resetCopyLocale,
  subscriptionResetPushNotice,
  telegramResetMessage,
} from '../utils/password-reset-copy.util';
import {
  RECOVERY_WITHDRAWAL_HOLD_CHANNEL,
  RECOVERY_WITHDRAWAL_HOLD_HOURS,
  RECOVERY_WITHDRAWAL_HOLD_PURPOSE,
} from '../utils/recovery-withdrawal-hold.util';
import { canReceiveResetLink, hasVerifiedEmail, smtpCanDeliver } from '../utils/reset-channels.util';
import { escapeLikeLiteral, parseSubscriptionLink } from '../utils/subscription-link.util';

// ── Limits ─────────────────────────────────────────────────────────────────

/** A reset link lives fifteen minutes. */
export const PASSWORD_RESET_TTL_SECONDS = 15 * 60;
/** How long a spent link is remembered, to say "already used" rather than "expired". */
export const PASSWORD_RESET_SPENT_MEMORY_SECONDS = 24 * 60 * 60;
/** At most one link is SENT to an account per minute… */
export const PASSWORD_RESET_SEND_COOLDOWN_SECONDS = 60;
/** …and at most this many per hour. */
export const PASSWORD_RESET_SENDS_PER_HOUR = 5;
/** Recovery-by-subscription attempts one address (an IPv6 /64) may make per hour. */
export const SUBSCRIPTION_RECOVERY_ATTEMPTS_PER_IP_PER_HOUR = 5;
/** Attempts that name one account's subscription, per window, before the path refuses it. */
export const SUBSCRIPTION_RECOVERY_ATTEMPTS_PER_OWNER = 5;
/** The window those attempts are counted in. */
export const SUBSCRIPTION_RECOVERY_OWNER_WINDOW_SECONDS = 24 * 60 * 60;
/** An expired subscription still counts for this many days. */
export const SUBSCRIPTION_RECOVERY_EXPIRED_GRACE_DAYS = 30;

const HOUR_SECONDS = 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^[a-f0-9]{64}$/;

const KEY = {
  token: (hash: string) => `web-auth:pwreset:token:${hash}`,
  spent: (hash: string) => `web-auth:pwreset:spent:${hash}`,
  cooldown: (webAccountId: string) => `web-auth:pwreset:cooldown:${webAccountId}`,
  /** Slot prefix — see `claimSlot`. */
  hourly: (webAccountId: string) => `web-auth:pwreset:hourly:${webAccountId}`,
  /** Slot prefix, keyed by the hashed address bucket. */
  subscriptionIp: (bucketHash: string) => `web-auth:subrec:ip:${bucketHash}`,
  /** Slot prefix, keyed by the web account the pasted link belongs to. */
  subscriptionOwner: (webAccountId: string) => `web-auth:subrec:owner:${webAccountId}`,
} as const;

// ── Ports ──────────────────────────────────────────────────────────────────
//
// The service names the few Prisma calls it makes instead of taking the whole
// client, so a spec can hand it a fake whose SHAPE the compiler still checks.
// `asPasswordResetDatabase` below is where the real client is proven to fit:
// if Prisma's generated types drift from these, the module stops compiling.

/** Every account read of this service uses this one shape. */
export const RESET_ACCOUNT_SELECT = {
  id: true,
  userId: true,
  login: true,
  loginNormalized: true,
  email: true,
  emailVerifiedAt: true,
  passwordHash: true,
  passwordBootstrapPending: true,
  credentialsBootstrappedAt: true,
  user: { select: { telegramId: true, isBlocked: true, language: true } },
} as const satisfies Prisma.WebAccountSelect;

export type ResetAccountRow = Prisma.WebAccountGetPayload<{ select: typeof RESET_ACCOUNT_SELECT }>;

/** A subscription a pasted link could name, with what deciding about it needs. */
export const LINK_OWNER_SELECT = {
  id: true,
  status: true,
  expiresAt: true,
  configUrl: true,
  user: {
    select: {
      isBlocked: true,
      webAccount: { select: { id: true, login: true, loginNormalized: true } },
    },
  },
} as const satisfies Prisma.SubscriptionSelect;

export type LinkOwnerRow = Prisma.SubscriptionGetPayload<{ select: typeof LINK_OWNER_SELECT }>;

export interface PasswordResetTransaction {
  readonly webAccount: {
    updateMany(args: {
      where: Prisma.WebAccountWhereInput;
      data: Prisma.WebAccountUpdateManyMutationInput;
    }): PromiseLike<Prisma.BatchPayload>;
  };
  readonly authChallenge: {
    create(args: {
      data: Prisma.AuthChallengeUncheckedCreateInput;
      select: { id: true };
    }): PromiseLike<{ id: string }>;
  };
}

export interface PasswordResetDatabase {
  readonly webAccount: {
    findUnique(args: {
      where: Prisma.WebAccountWhereUniqueInput;
      select: typeof RESET_ACCOUNT_SELECT;
    }): PromiseLike<ResetAccountRow | null>;
    findFirst(args: {
      where: Prisma.WebAccountWhereInput;
      select: typeof RESET_ACCOUNT_SELECT;
    }): PromiseLike<ResetAccountRow | null>;
  };
  readonly subscription: {
    findMany(args: {
      where: Prisma.SubscriptionWhereInput;
      select: typeof LINK_OWNER_SELECT;
    }): PromiseLike<LinkOwnerRow[]>;
  };
  $transaction<R>(fn: (tx: PasswordResetTransaction) => Promise<R>): Promise<R>;
}

/** DI token for the database port. */
export const PASSWORD_RESET_DATABASE = Symbol('PASSWORD_RESET_DATABASE');

/** The real client, typed as the port — this line is the compile-time proof it fits. */
export function asPasswordResetDatabase(prisma: PrismaService): PasswordResetDatabase {
  return prisma;
}

export type PasswordResetEvents = Pick<SystemEventsService, 'info'>;
/** The operator's switch for recovery by subscription link lives in the platform policy. */
export type PasswordResetPolicy = Pick<SettingsService, 'getInternalPlatformPolicy'>;
export type PasswordResetMail = Pick<EmailDeliveryService, 'getSmtpSettings' | 'sendPasswordResetLink'>;
export type PasswordResetTelegram = Pick<BotNotifierClient, 'notifyUser' | 'isEnabled'>;
export type PasswordResetPush = Pick<WebPushService, 'sendToUser'>;

/** What the controller calls — narrow, so its spec needs no cast to stand in for it. */
export type PasswordResetFacade = Pick<
  PasswordResetService,
  | 'request'
  | 'legacyRecover'
  | 'inspect'
  | 'consume'
  | 'issueForTelegram'
  | 'recoverBySubscription'
  | 'sendFirstPasswordLink'
>;

/**
 * Runs work that must not hold the caller's response. Production fires and
 * forgets (with the rejection logged); a spec collects the tasks and awaits
 * them, which is the only reason this is injectable.
 */
export type PasswordResetDispatch = (task: () => Promise<void>) => void;
export const PASSWORD_RESET_DISPATCH = Symbol('PASSWORD_RESET_DISPATCH');

/** What Redis holds under a token's hash. Never the token itself. */
interface StoredResetToken {
  readonly webAccountId: string;
  readonly userId: string;
  readonly channel: PasswordRecoveryMethod;
  /** sha256 of the password hash when the link was issued — see `fingerprintOf`. */
  readonly fingerprint: string;
  readonly expiresAt: string;
}

/** The answer of an atomic attempt budget — see `claimSlot`. */
type SlotClaim = 'claimed' | 'full' | 'unavailable';

/** Whether a reset link may go out to an account right now, and if not, why. */
type SendSlot = 'ok' | 'recently_sent' | 'hourly_limit' | 'unavailable';

/**
 * What `sendResetLinks` did. `method` names the first channel the account can
 * be reached on (or `none`); `outcome` says whether a link actually went there
 * just now, went there recently, or could not be sent.
 */
interface ResetLinksSent {
  readonly method: 'telegram' | 'email' | 'none';
  readonly outcome: 'sent' | 'recently_sent' | 'hourly_limit' | 'unavailable' | 'no_channel';
}

/**
 * PasswordResetService
 * ════════════════════
 * Getting a customer back into the cabinet without support, three ways:
 *
 *  - **a link in Telegram** — to the account's linked Telegram, asked for from
 *    the cabinet (`request`) or from the bot itself (`issueForTelegram`, which
 *    hands the link to the bot to send, so nobody has to remember a login);
 *  - **a link by e-mail** — to the account's VERIFIED address, when the
 *    operator has SMTP on;
 *  - **the VPN subscription link** (`recoverBySubscription`) — ONLY for an
 *    account with neither. The link is effectively the whole proof: the login
 *    typed beside it is NOT a secret (the panel names Remnawave profiles after
 *    it, and a subscription's public info page shows that name), so it only
 *    selects the account and adds friction. That is why an account that has a
 *    channel never gets a password from this path — it gets the ordinary link
 *    on its channel — and why a reset here holds partner withdrawals for three
 *    days and tells the operators.
 *
 * Every road ends at the same single-use token and the same `consume`.
 *
 * ── The token ─────────────────────────────────────────────────────────────
 *
 * 32 random bytes, hex. Redis holds only its sha256, for fifteen minutes, and
 * `consume` takes it with `RawCacheService.take` — GET and DEL in one MULTI —
 * so of any number of simultaneous presentations exactly one gets through. The
 * payload remembers a fingerprint of the password hash at issue time: a link
 * issued before ANY later password change (a reset through another link, a
 * change in settings, an operator's temporary password) no longer works.
 *
 * ── What a caller can learn ───────────────────────────────────────────────
 *
 * `request` delivers in the background and answers before anything is sent,
 * so neither its body nor its duration depends on Telegram or SMTP; the cabinet
 * shows every visitor one message. `recoverBySubscription` answers `mismatch`
 * for every failed verification, whichever half was wrong.
 *
 * ── Where the link points ─────────────────────────────────────────────────
 *
 * Never at a host a visitor supplied. The e-mail link and the Telegram URL
 * button are built on the ORIGIN of `cabinetUrl`, which the cabinet reads from
 * its own configuration, and carry the token in the FRAGMENT (`#token=`), which
 * no server log and no Referer ever sees. Without a cabinet address the
 * Telegram button is a `webAppPath` the bot resolves on its own address; that
 * one keeps `?token=`, because Telegram appends its launch parameters to the
 * fragment of a Mini App URL. E-mail then carries no link and is not sent.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly dispatch: PasswordResetDispatch;

  public constructor(
    @Inject(PASSWORD_RESET_DATABASE) private readonly db: PasswordResetDatabase,
    private readonly cache: RawCacheService,
    private readonly passwordHashService: PasswordHashService,
    @Inject(SystemEventsService) private readonly events: PasswordResetEvents,
    @Inject(EmailDeliveryService) private readonly mail: PasswordResetMail,
    @Inject(BotNotifierClient) private readonly telegram: PasswordResetTelegram,
    @Inject(SettingsService) private readonly policy: PasswordResetPolicy,
    @Optional() @Inject(WebPushService) private readonly push?: PasswordResetPush,
    @Optional() @Inject(PASSWORD_RESET_DISPATCH) dispatch?: PasswordResetDispatch,
  ) {
    this.dispatch =
      dispatch ??
      ((task) => {
        void task().catch((error: unknown) => {
          this.logger.warn(
            `Password-reset background task failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      });
  }

  // ── Asking for a link ────────────────────────────────────────────────────

  /**
   * "Forgot password" from the cabinet: send a reset link to every channel the
   * account can be reached on. Answers at once; delivery runs in the
   * background (see the class header).
   */
  public async request(input: {
    readonly identifier: string;
    readonly cabinetUrl: string | null;
  }): Promise<PasswordResetRequestResultInterface> {
    const account = await this.findAccountByIdentifier(input.identifier);
    if (account === null) return { method: 'none', resetLinks: true };
    const { method } = await this.sendResetLinks(account, linkBase(input.cabinetUrl));
    return { method, resetLinks: true };
  }

  /**
   * The sign-in form's way on for an account that has NO password yet.
   *
   * The AltShop importer creates web accounts with a login — the donor's
   * `username`, usually the customer's PUBLIC Telegram username — no password
   * and `passwordBootstrapPending`. Their first sign-in used to ADOPT whatever
   * password was typed, so anybody who knew the username took the account.
   * `WebAuthService.login` now refuses them like any wrong password; the
   * cabinet, on that refusal, asks here, and the owner is sent the ordinary
   * reset link — the same issue path, the same once-a-minute and five-an-hour
   * caps as "forgot password", so this adds no way in and no new way to flood
   * anybody's Telegram.
   *
   * The answer is distinct from a wrong password: "this account has no
   * password yet, a link is on its way". That tells a visitor nothing they
   * could not learn already — whether a login exists is public through the
   * cabinet's `/auth/check-username` — and it is what gets the real owner in.
   *
   * `not_applicable` for everything else: no such login, a password already
   * set, a blocked account, and an account no link can reach (the sign-in form
   * then shows its ordinary refusal; `WebAuthService.login` tells the operator).
   */
  public async sendFirstPasswordLink(input: {
    readonly login: string;
    readonly cabinetUrl: string | null;
  }): Promise<PasswordResetFirstPasswordResultInterface> {
    if (!loginPolicy.isValidLogin(input.login)) return { status: 'not_applicable' };
    const account = await this.db.webAccount.findUnique({
      where: { loginNormalized: loginPolicy.normalizeLogin(input.login) },
      select: RESET_ACCOUNT_SELECT,
    });
    if (
      account === null ||
      account.login === null ||
      account.user.isBlocked ||
      account.passwordHash !== null ||
      !account.passwordBootstrapPending ||
      !(await this.hasWorkingChannel(account))
    ) {
      return { status: 'not_applicable' };
    }
    const { method, outcome } = await this.sendResetLinks(account, linkBase(input.cabinetUrl));
    switch (outcome) {
      case 'sent':
      case 'recently_sent':
        // `method` is a real channel whenever an outcome other than
        // `no_channel` came back.
        return method === 'none' ? { status: 'unavailable' } : { status: 'sent', channel: method };
      case 'hourly_limit':
        return { status: 'hourly_limit' };
      case 'no_channel':
        // Linked Telegram, but the panel cannot push to the bot: the bot's own
        // "send me a link" still works. With no Telegram there is nothing to
        // point at, and the account's e-mail needs a cabinet address to link to.
        return account.user.telegramId !== null ? { status: 'use_bot' } : { status: 'unavailable' };
      case 'unavailable':
        return { status: 'unavailable' };
    }
  }

  /**
   * The route cabinets up to 0.9.7.45 call. It answers exactly what it always
   * answered and SENDS NOTHING: those cabinets have no `/reset-password` page,
   * so any link sent to them would lead nowhere. The release goes cabinet
   * first, and the newer cabinet never calls this.
   */
  public async legacyRecover(login: string): Promise<WebAuthRecoverResultInterface> {
    const account = await this.db.webAccount.findUnique({
      where: { loginNormalized: loginPolicy.normalizeLogin(login) },
      select: RESET_ACCOUNT_SELECT,
    });
    if (account === null) return { method: 'none' };
    if (account.user.telegramId !== null) return { method: 'telegram' };
    if (hasVerifiedEmail(account) && (await this.smtpIsOn())) {
      return { method: 'email' };
    }
    return { method: 'none' };
  }

  /**
   * The bot asks on behalf of the Telegram user it is talking to — no login
   * typed, so this is also the answer to "I forgot my login". The token goes
   * back to the bot, which puts it behind a button on its own cabinet address.
   */
  public async issueForTelegram(telegramId: string): Promise<PasswordResetTelegramResultInterface> {
    if (!/^\d{1,19}$/.test(telegramId)) return { status: 'no_account' };
    const account = await this.db.webAccount.findFirst({
      where: { user: { telegramId: BigInt(telegramId) } },
      select: RESET_ACCOUNT_SELECT,
    });
    if (account === null || account.login === null || account.user.isBlocked) {
      return { status: 'no_account' };
    }
    const slot = await this.acquireSendSlot(account.id);
    if (slot !== 'ok') return { status: slot };
    const issued = await this.mintToken(account, 'telegram');
    if (issued === null) return { status: 'unavailable' };
    return { status: 'issued', token: issued.token, login: account.login, expiresAt: issued.expiresAt };
  }

  /**
   * Recovery by VPN subscription link. See the class header for why this path
   * trusts so little: the login selects the account, the link is the proof.
   *
   * The attempt is COUNTED before anything is decided — against the address,
   * and against every account the link names — each by an atomic slot claim,
   * so a burst of parallel guesses cannot all be judged against a count none
   * of them has raised yet. Every failure answers `mismatch`.
   */
  public async recoverBySubscription(input: {
    readonly link: string;
    readonly login: string;
    readonly clientIp: string | null;
    readonly cabinetUrl: string | null;
  }): Promise<PasswordResetSubscriptionResultInterface> {
    // The operator's switch («Восстановление пароля по ссылке подписки»), asked
    // before anything is counted or looked up: a refusal that came after the
    // lookup could differ by whether the link or the login matched.
    let enabled: boolean;
    try {
      enabled = (await this.policy.getInternalPlatformPolicy()).subscriptionLinkRecovery === true;
    } catch (error: unknown) {
      this.logger.warn(
        `Recovery by subscription link: the platform policy could not be read (${error instanceof Error ? error.message : String(error)})`,
      );
      return { status: 'unavailable' };
    }
    if (!enabled) return { status: 'disabled' };

    const address = await this.claimSlot(
      KEY.subscriptionIp(sha256(ipAttemptBucket(input.clientIp))),
      SUBSCRIPTION_RECOVERY_ATTEMPTS_PER_IP_PER_HOUR,
      HOUR_SECONDS,
    );
    if (address === 'unavailable') return { status: 'unavailable' };
    if (address === 'full') return { status: 'rate_limited', retryAfterSeconds: HOUR_SECONDS };

    const parsed = parseSubscriptionLink(input.link);
    const named = await this.findSubscriptionsNamedBy(parsed.candidates);

    // Counted against the OWNERS of what the link names — never against the
    // login typed beside it, which anybody can type to lock anybody out.
    const owners = [...new Set(named.map((row) => row.user.webAccount?.id).filter(isString))];
    for (const owner of owners) {
      const claim = await this.claimSlot(
        KEY.subscriptionOwner(owner),
        SUBSCRIPTION_RECOVERY_ATTEMPTS_PER_OWNER,
        SUBSCRIPTION_RECOVERY_OWNER_WINDOW_SECONDS,
      );
      if (claim === 'unavailable') return { status: 'unavailable' };
      if (claim === 'full') return { status: 'mismatch' };
    }

    const loginNormalized = loginPolicy.normalizeLogin(input.login);
    const now = new Date();
    const match = named.find(
      (row) =>
        row.user.webAccount !== null &&
        row.user.webAccount.login !== null &&
        row.user.webAccount.loginNormalized === loginNormalized &&
        !row.user.isBlocked &&
        qualifiesForRecovery(row, now),
    );
    if (match === undefined || match.user.webAccount === null) return { status: 'mismatch' };
    const account = await this.db.webAccount.findUnique({
      where: { id: match.user.webAccount.id },
      select: RESET_ACCOUNT_SELECT,
    });
    if (account === null || account.login === null || account.user.isBlocked) return { status: 'mismatch' };

    if (await this.hasWorkingChannel(account)) {
      // The link is not the proof here: this account can be reached. It gets
      // the ordinary link on its own channel, and the visitor the answer every
      // visitor of the recovery form gets.
      await this.sendResetLinks(account, linkBase(input.cabinetUrl));
      return { status: 'sent_to_channels' };
    }
    return this.grantLinkOnlyRecovery(account);
  }

  /**
   * THE POLICY SEAM for an account with no channel, where possession of the
   * subscription link is the whole proof. Today: self-service (A) — a
   * single-use token, with the 72-hour hold on the partner balance (no
   * withdrawal, no purchase paid with it) written by `consume` and the
   * operators told through `auth.password_recovery`.
   *
   * Switching to operator confirmation (B) is this method alone: instead of a
   * token, raise an operator event naming `account.userId` (the operator then
   * uses the existing temporary-password action on the customer's card) and
   * return a status the cabinet shows as "an operator will contact you".
   */
  private async grantLinkOnlyRecovery(
    account: ResetAccountRow,
  ): Promise<PasswordResetSubscriptionResultInterface> {
    if (account.login === null) return { status: 'mismatch' };
    const issued = await this.mintToken(account, 'subscription_link');
    if (issued === null) return { status: 'unavailable' };
    // A verified owner starts the next window with a clean count.
    await this.releaseSlots(KEY.subscriptionOwner(account.id), SUBSCRIPTION_RECOVERY_ATTEMPTS_PER_OWNER);
    return { status: 'verified', token: issued.token, login: account.login, expiresAt: issued.expiresAt };
  }

  // ── Using a link ─────────────────────────────────────────────────────────

  /** Whether a link still works, and for which login. Spends nothing. */
  public async inspect(token: string): Promise<PasswordResetInspectResultInterface> {
    if (!TOKEN_SHAPE.test(token)) return { status: 'expired' };
    const hash = sha256(token);
    const stored = await this.cache.get<StoredResetToken>(KEY.token(hash));
    if (stored === null) return { status: await this.missingTokenStatus(hash) };
    const account = await this.db.webAccount.findUnique({
      where: { id: stored.webAccountId },
      select: RESET_ACCOUNT_SELECT,
    });
    if (account === null || account.login === null || account.user.isBlocked) {
      return { status: 'expired' };
    }
    if (fingerprintOf(account.passwordHash) !== stored.fingerprint) return { status: 'used' };
    return { status: 'valid', login: account.login, expiresAt: stored.expiresAt };
  }

  /**
   * Spend a link and set the new password. The token is gone from the moment
   * `take` returns, whatever follows — a refusal below does not hand it back.
   */
  public async consume(token: string, password: string): Promise<PasswordResetConsumeResultInterface> {
    if (!TOKEN_SHAPE.test(token)) return { status: 'expired' };
    const hash = sha256(token);
    const stored = await this.cache.take<StoredResetToken>(KEY.token(hash));
    if (stored === null) return { status: await this.missingTokenStatus(hash) };
    await this.cache.set(KEY.spent(hash), 1, PASSWORD_RESET_SPENT_MEMORY_SECONDS);

    const now = new Date();
    if (Date.parse(stored.expiresAt) <= now.getTime()) return { status: 'expired' };
    const account = await this.db.webAccount.findUnique({
      where: { id: stored.webAccountId },
      select: RESET_ACCOUNT_SELECT,
    });
    if (account === null || account.login === null || account.user.isBlocked) {
      return { status: 'expired' };
    }
    if (fingerprintOf(account.passwordHash) !== stored.fingerprint) return { status: 'used' };

    const passwordHash = await this.passwordHashService.hashPassword({
      plainTextPassword: password,
      audience: 'subscriber',
    });
    const applied = await this.db.$transaction(async (tx) => {
      // Conditional on the hash we just checked the fingerprint of: a password
      // changed between that read and this write wins, and this link loses.
      // `sessionsRevokedAt` rides in the same statement, whatever the channel:
      // no new password without every older session signed out.
      const { count } = await tx.webAccount.updateMany({
        where: { id: account.id, passwordHash: account.passwordHash },
        data: {
          passwordHash,
          requiresPasswordChange: false,
          temporaryPasswordExpiresAt: null,
          passwordBootstrapPending: false,
          credentialsBootstrappedAt: account.credentialsBootstrappedAt ?? now,
          sessionsRevokedAt: now,
        },
      });
      if (count !== 1) return false;
      if (stored.channel === 'subscription_link') {
        // In the same transaction: no hold, no new password.
        await tx.authChallenge.create({
          data: {
            webAccountId: account.id,
            purpose: RECOVERY_WITHDRAWAL_HOLD_PURPOSE,
            channel: RECOVERY_WITHDRAWAL_HOLD_CHANNEL,
            destination: account.userId,
            expiresAt: new Date(now.getTime() + RECOVERY_WITHDRAWAL_HOLD_HOURS * HOUR_SECONDS * 1000),
          },
          select: { id: true },
        });
      }
      return true;
    });
    if (!applied) return { status: 'used' };

    // The operator-issued temporary password must stop being readable in the
    // panel, as after any password change.
    await this.cache.del(tempPasswordCacheKey(account.id));
    // Safe metadata only: who, and how. Never the token, a hash or the link —
    // this reaches the audit log, stdout, webhooks, the operators' Telegram and
    // any e-mail template an operator attaches to this event type.
    this.events.info(EVENT_TYPES.AUTH_PASSWORD_RECOVERY, 'AUTH', 'Password reset by a recovery link', {
      userId: account.userId,
      method: stored.channel,
    });
    if (stored.channel === 'subscription_link') {
      const push = this.push;
      if (push !== undefined) {
        const notice = subscriptionResetPushNotice(resetCopyLocale(account.user.language));
        this.dispatch(async () => {
          await push.sendToUser({
            userId: account.userId,
            title: notice.title,
            body: notice.body,
            url: '/support',
            tag: 'password-reset',
          });
        });
      }
    }
    return {
      status: 'ok',
      userId: account.userId,
      login: account.login,
      sessionsRevokedAt: now.toISOString(),
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** A login, or a VERIFIED e-mail. Blocked accounts and accounts without a login find nothing. */
  private async findAccountByIdentifier(identifier: string): Promise<ResetAccountRow | null> {
    const trimmed = identifier.trim();
    let account: ResetAccountRow | null;
    if (trimmed.includes('@')) {
      account = await this.db.webAccount.findUnique({
        where: { emailNormalized: trimmed.toLowerCase() },
        select: RESET_ACCOUNT_SELECT,
      });
      if (account !== null && account.emailVerifiedAt === null) return null;
    } else {
      if (!loginPolicy.isValidLogin(trimmed)) return null;
      account = await this.db.webAccount.findUnique({
        where: { loginNormalized: loginPolicy.normalizeLogin(trimmed) },
        select: RESET_ACCOUNT_SELECT,
      });
    }
    if (account === null || account.login === null || account.user.isBlocked) return null;
    return account;
  }

  /**
   * Sends a reset link to every channel the account can be reached on right
   * now, within the per-account send budget, and names the first channel. The
   * sends run in the background.
   */
  private async sendResetLinks(account: ResetAccountRow, base: string | null): Promise<ResetLinksSent> {
    const channels: Array<'telegram' | 'email'> = [];
    if (account.user.telegramId !== null && this.telegram.isEnabled) channels.push('telegram');
    if (hasVerifiedEmail(account) && base !== null && (await this.smtpIsOn())) {
      channels.push('email');
    }
    if (channels.length === 0) return { method: 'none', outcome: 'no_channel' };
    // Once a minute and five times an hour per ACCOUNT, however many visitors
    // ask: a login is public, and without this anyone could flood its owner's
    // Telegram and inbox. A refused slot still names the channel — a link went
    // there within the last minute, or the hour's links already did.
    const slot = await this.acquireSendSlot(account.id);
    if (slot !== 'ok') return { method: channels[0], outcome: slot };
    let dispatched = 0;
    for (const channel of channels) {
      const issued = await this.mintToken(account, channel);
      if (issued === null) continue;
      dispatched += 1;
      this.dispatch(() =>
        channel === 'telegram'
          ? this.sendTelegramLink(account, issued, base)
          : this.sendEmailLink(account, issued, base),
      );
    }
    return { method: channels[0], outcome: dispatched > 0 ? 'sent' : 'unavailable' };
  }

  /** See `canReceiveResetLink` — SMTP is asked only when an e-mail would decide. */
  private async hasWorkingChannel(account: ResetAccountRow): Promise<boolean> {
    const smtpOn = account.user.telegramId === null && hasVerifiedEmail(account) ? await this.smtpIsOn() : false;
    return canReceiveResetLink(
      { telegramId: account.user.telegramId, email: account.email, emailVerifiedAt: account.emailVerifiedAt },
      smtpOn,
    );
  }

  private async smtpIsOn(): Promise<boolean> {
    return smtpCanDeliver(await this.mail.getSmtpSettings());
  }

  /**
   * The once-a-minute, five-an-hour budget of sent links, and why it refused.
   * Fails closed without Redis.
   */
  private async acquireSendSlot(webAccountId: string): Promise<SendSlot> {
    if (!(await this.cache.claimOnce(KEY.cooldown(webAccountId), PASSWORD_RESET_SEND_COOLDOWN_SECONDS))) {
      return (await this.cache.exists(KEY.cooldown(webAccountId))) ? 'recently_sent' : 'unavailable';
    }
    const hourly = await this.claimSlot(KEY.hourly(webAccountId), PASSWORD_RESET_SENDS_PER_HOUR, HOUR_SECONDS);
    if (hourly === 'claimed') return 'ok';
    // Nothing goes out, so the coming minute must not read as "just sent".
    await this.cache.del(KEY.cooldown(webAccountId));
    return hourly === 'full' ? 'hourly_limit' : 'unavailable';
  }

  /**
   * An attempt budget of `slots` per `ttlSeconds`, counted ATOMICALLY: each
   * attempt takes the first free slot key with one `SET key 1 NX EX ttl`, so the
   * count and its expiry are written by the same command, and of any number of
   * simultaneous attempts exactly `slots` get one. A slot frees itself when it
   * expires. `unavailable` when Redis did not answer — `claimOnce` fails closed,
   * and the first slot is then absent too.
   */
  private async claimSlot(prefix: string, slots: number, ttlSeconds: number): Promise<SlotClaim> {
    for (let slot = 1; slot <= slots; slot += 1) {
      if (await this.cache.claimOnce(`${prefix}:${slot}`, ttlSeconds)) return 'claimed';
    }
    return (await this.cache.exists(`${prefix}:1`)) ? 'full' : 'unavailable';
  }

  private async releaseSlots(prefix: string, slots: number): Promise<void> {
    await this.cache.delMany(Array.from({ length: slots }, (_, index) => `${prefix}:${index + 1}`));
  }

  /** A fresh token, stored as its hash. `null` when Redis did not take it. */
  private async mintToken(
    account: ResetAccountRow,
    channel: PasswordRecoveryMethod,
  ): Promise<{ readonly token: string; readonly expiresAt: string } | null> {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const hash = sha256(token);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000).toISOString();
    const stored: StoredResetToken = {
      webAccountId: account.id,
      userId: account.userId,
      channel,
      fingerprint: fingerprintOf(account.passwordHash),
      expiresAt,
    };
    await this.cache.set(KEY.token(hash), stored, PASSWORD_RESET_TTL_SECONDS);
    if (!(await this.cache.exists(KEY.token(hash)))) return null;
    return { token, expiresAt };
  }

  private async missingTokenStatus(hash: string): Promise<'expired' | 'used'> {
    return (await this.cache.exists(KEY.spent(hash))) ? 'used' : 'expired';
  }

  /**
   * The subscriptions whose OWN stored address carries one of the candidate
   * ids: one exact lookup per candidate, the id escaped so none of its
   * characters is a LIKE wildcard, no truncation, and the exact comparison
   * against `configUrlShortIds` deciding.
   */
  private async findSubscriptionsNamedBy(candidates: readonly string[]): Promise<LinkOwnerRow[]> {
    const found = new Map<string, LinkOwnerRow>();
    for (const candidate of candidates) {
      const literal = escapeLikeLiteral(candidate);
      const rows = await this.db.subscription.findMany({
        where: {
          OR: [{ configUrl: { endsWith: `/${literal}` } }, { configUrl: { endsWith: `/${literal}/` } }],
        },
        select: LINK_OWNER_SELECT,
      });
      for (const row of rows) {
        if (configUrlShortIds(row.configUrl).includes(candidate)) found.set(row.id, row);
      }
    }
    return [...found.values()];
  }

  private async sendTelegramLink(
    account: ResetAccountRow,
    issued: { readonly token: string; readonly expiresAt: string },
    base: string | null,
  ): Promise<void> {
    if (account.user.telegramId === null || account.login === null) return;
    const copy = telegramResetMessage({
      locale: resetCopyLocale(account.user.language),
      login: account.login,
      minutes: minutesLeft(new Date(issued.expiresAt), new Date()),
    });
    // A URL button opens a real browser, where the new password can be saved
    // by a password manager, and carries the token in the fragment. Telegram
    // accepts only https there; anything else becomes a `webAppPath`, which the
    // bot resolves on its own address — in the QUERY, because Telegram appends
    // its launch parameters to the fragment of a Mini App URL.
    const button =
      base !== null && base.startsWith('https://')
        ? { text: copy.button, url: `${base}/reset-password#token=${issued.token}`, style: 'primary' as const }
        : { text: copy.button, webAppPath: `/reset-password?token=${issued.token}`, style: 'primary' as const };
    const outcome = await this.telegram.notifyUser({
      eventId: `pwreset-${randomBytes(12).toString('hex')}`,
      telegramId: account.user.telegramId.toString(),
      text: copy.text,
      parseMode: 'HTML',
      buttons: [button],
    });
    // The status only — the outcome's detail can quote the request.
    this.logger.log(`Password-reset link to Telegram for account ${account.id}: ${outcome.status}`);
  }

  private async sendEmailLink(
    account: ResetAccountRow,
    issued: { readonly token: string; readonly expiresAt: string },
    base: string | null,
  ): Promise<void> {
    if (account.email === null || account.login === null || base === null) return;
    const result = await this.mail.sendPasswordResetLink({
      to: account.email,
      login: account.login,
      link: `${base}/reset-password#token=${issued.token}`,
      expiresAt: new Date(issued.expiresAt),
      locale: resetCopyLocale(account.user.language),
    });
    this.logger.log(
      `Password-reset link by e-mail for account ${account.id}: ${result.success ? 'sent' : 'not sent'}`,
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}

/**
 * A stand-in for the password hash, compared at consume time. A digest rather
 * than the hash itself, so Redis never holds a crackable credential.
 */
function fingerprintOf(passwordHash: string | null): string {
  return sha256(`pwreset-fingerprint:${passwordHash ?? ''}`);
}

/** The origin to build links on, or `null` when the value is not an http(s) URL. */
export function linkBase(cabinetUrl: string | null): string | null {
  if (cabinetUrl === null) return null;
  try {
    const url = new URL(cabinetUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Active or limited, or expired no more than thirty days ago. */
export function qualifiesForRecovery(
  subscription: { readonly status: SubscriptionStatus; readonly expiresAt: Date | null },
  now: Date,
): boolean {
  if (subscription.status === SubscriptionStatus.ACTIVE || subscription.status === SubscriptionStatus.LIMITED) {
    return true;
  }
  if (subscription.status !== SubscriptionStatus.EXPIRED || subscription.expiresAt === null) return false;
  return subscription.expiresAt.getTime() >= now.getTime() - SUBSCRIPTION_RECOVERY_EXPIRED_GRACE_DAYS * DAY_MS;
}
