import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ExternalAuthProvider, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { PasswordHashService } from '../../auth/services/password-hash.service';
import { loginPolicy } from '../../auth/utils/login-policy.util';
import { EmailDeliveryService } from '../../email/services/email-delivery.service';
import {
  ExternalAuthResolution,
  ExternalUserProfile,
} from '../interfaces/external-auth.interface';
import { AuthorizeUrlInput, ExchangeInput, OAuthProviderAdapter } from '../interfaces/oauth-adapter.interface';
import { GoogleOAuthAdapter } from './providers/google-oauth.adapter';
import { MailruOAuthAdapter } from './providers/mailru-oauth.adapter';
import { TelegramOidcAdapter } from './providers/telegram-oidc.adapter';
import { YandexOAuthAdapter } from './providers/yandex-oauth.adapter';
import { DisposableEmailService } from './disposable-email.service';
import { ExternalProviderConfigService } from './external-provider-config.service';

/**
 * Core external-auth engine: builds authorization URLs, runs OAuth adapters,
 * verifies Telegram (pre-verified by reiwa), and resolves a verified profile to
 * a login / register(finish-setup) / denied decision. Login + password stays
 * mandatory — a fresh external sign-up always lands on finish-setup.
 */
@Injectable()
export class ExternalAuthService {
  private readonly logger = new Logger(ExternalAuthService.name);
  private readonly oauthAdapters: ReadonlyMap<ExternalAuthProvider, OAuthProviderAdapter>;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ExternalProviderConfigService,
    private readonly disposableEmailService: DisposableEmailService,
    private readonly passwordHashService: PasswordHashService,
    private readonly systemEventsService: SystemEventsService,
    private readonly emailDeliveryService: EmailDeliveryService,
    google: GoogleOAuthAdapter,
    yandex: YandexOAuthAdapter,
    mailru: MailruOAuthAdapter,
    telegramOidc: TelegramOidcAdapter,
  ) {
    this.oauthAdapters = new Map<ExternalAuthProvider, OAuthProviderAdapter>([
      [ExternalAuthProvider.GOOGLE, google],
      [ExternalAuthProvider.YANDEX, yandex],
      [ExternalAuthProvider.MAILRU, mailru],
      // Telegram OIDC (oauth.telegram.org) — the classic Login Widget path is
      // handled separately by `resolveTelegram`. This adapter drives the
      // redirect flow when the operator enables Telegram's OIDC mode.
      [ExternalAuthProvider.TELEGRAM, telegramOidc],
    ]);
  }

  /** Builds the provider authorization redirect URL (OAuth providers only). */
  public async buildAuthorizationUrl(
    provider: ExternalAuthProvider,
    input: AuthorizeUrlInput,
  ): Promise<string> {
    const adapter = this.requireOAuthAdapter(provider);
    const config = await this.configService.getEnabledAdapterConfig(provider);
    return adapter.buildAuthorizationUrl(config, input);
  }

  /** Runs the OAuth code exchange and resolves the resulting profile. */
  public async resolveOAuth(
    provider: ExternalAuthProvider,
    input: ExchangeInput,
  ): Promise<ExternalAuthResolution> {
    const adapter = this.requireOAuthAdapter(provider);
    let profile: ExternalUserProfile;
    try {
      const config = await this.configService.getEnabledAdapterConfig(provider);
      profile = await adapter.exchange(config, input);
    } catch (err: unknown) {
      // Preserve intentional 4xx (disabled / misconfigured / unauthorized). Any
      // other failure — a client secret that can't be decrypted, or the provider
      // token endpoint rejecting the code (invalid_grant / invalid_client /
      // redirect_uri mismatch) — must NOT surface as an opaque 500: log the real
      // cause and fail with a clean 401 so the callback shows a normal "sign-in
      // failed" while the operator can see exactly why in the server logs.
      if (err instanceof HttpException) throw err;
      this.logger.error(`OAuth exchange failed for ${provider}: ${describeExchangeError(err)}`);
      throw new UnauthorizedException(`External sign-in failed for ${provider}`);
    }
    return this.resolve(profile);
  }

  /**
   * Resolves a Telegram identity ALREADY verified by reiwa (which holds the bot
   * token). Telegram must be enabled (default-on). No email is provided.
   */
  public async resolveTelegram(input: {
    readonly providerUserId: string;
    readonly name: string | null;
  }): Promise<ExternalAuthResolution> {
    if (!(await this.configService.isProviderEnabled(ExternalAuthProvider.TELEGRAM))) {
      throw new UnauthorizedException('Telegram sign-in is disabled');
    }
    return this.resolve({
      provider: ExternalAuthProvider.TELEGRAM,
      providerUserId: input.providerUserId,
      email: null,
      emailVerified: false,
      name: input.name,
      avatarUrl: null,
      rawProfile: {},
    });
  }

  /**
   * Decision engine (design §resolve): link-by-identity → verified-email
   * auto-link → new shell + finish-setup → denied(blocked).
   */
  public async resolve(profile: ExternalUserProfile): Promise<ExternalAuthResolution> {
    const isTelegram = profile.provider === ExternalAuthProvider.TELEGRAM;

    // 1. Existing identity link.
    const link = await this.prismaService.userOAuthLink.findUnique({
      where: { provider_providerUserId: { provider: profile.provider, providerUserId: profile.providerUserId } },
      select: { id: true, userId: true, user: { select: { isBlocked: true } } },
    });
    if (link) {
      if (link.user.isBlocked) return { action: 'denied' };
      await this.prismaService.userOAuthLink.update({
        where: { id: link.id },
        data: { lastUsedAt: new Date() },
      });
      // Telegram identity is itself a credential — the user can always
      // re-authenticate via Telegram, so never force finish-setup on them.
      if (isTelegram) {
        // Backfill `User.telegramId` on the login path. Older OIDC/widget
        // sign-ins created only a `userOAuthLink` and left `User.telegramId`
        // null, so the cabinet session carried no telegramId → the reiwa gate
        // treated them as non-Telegram and forced finish-setup regardless of
        // the operator's "don't require web credentials for Telegram" toggle.
        // Setting it makes the session carry telegramId (toggle works) and lets
        // bot notifications reach the user.
        await this.ensureTelegramIdLinked(link.userId, profile.providerUserId);
        return { action: 'login', userId: link.userId };
      }
      // For OAuth (email) providers: a shell created by a prior sign-up that
      // never completed finish-setup still has no login/password. Route it
      // back to finish-setup instead of silently logging into a credential-less
      // account (which then can't sign in by login and looks "missing").
      return (await this.hasCompletedCredentials(link.userId))
        ? { action: 'login', userId: link.userId }
        : { action: 'finish_setup', userId: link.userId };
    }

    // 1.5 Telegram: match an EXISTING user by telegram id even when there is
    // no web OAuth link yet. Bot / Mini-App users are created with
    // `User.telegramId` but never had a web link, so without this they'd be
    // treated as brand-new and wrongly sent to finish-setup ("создаёт новый
    // аккаунт"). Link them and log in — Telegram is their credential.
    if (isTelegram) {
      const telegramId = parseBigintOrNull(profile.providerUserId);
      if (telegramId !== null) {
        const user = await this.prismaService.user.findUnique({
          where: { telegramId },
          select: { id: true, isBlocked: true },
        });
        if (user) {
          if (user.isBlocked) return { action: 'denied' };
          await this.createLink(user.id, profile);
          return { action: 'login', userId: user.id };
        }
      }
    }

    // 2. Verified-email match → auto-link.
    if (profile.emailVerified && profile.email) {
      const emailNormalized = profile.email.trim().toLowerCase();
      const account = await this.prismaService.webAccount.findUnique({
        where: { emailNormalized },
        select: { userId: true, passwordHash: true, user: { select: { isBlocked: true } } },
      });
      if (account) {
        if (account.user.isBlocked) return { action: 'denied' };
        await this.createLink(account.userId, profile);
        // Same guard: a matched account without credentials (e.g. a shell from
        // another provider's abandoned sign-up) must finish setup first.
        return account.passwordHash !== null
          ? { action: 'login', userId: account.userId }
          : { action: 'finish_setup', userId: account.userId };
      }
    }

    // 3. New account → shell + finish-setup.
    const userId = await this.createShellAccount(profile);
    return { action: 'finish_setup', userId };
  }

  /**
   * True when the user's WebAccount has completed the mandatory finish-setup
   * (login + password set). A freshly created external shell returns false
   * until `finishSetup` runs, so callers keep routing it to finish-setup.
   */
  private async hasCompletedCredentials(userId: string): Promise<boolean> {
    const account = await this.prismaService.webAccount.findUnique({
      where: { userId },
      select: { passwordHash: true },
    });
    return account?.passwordHash != null;
  }

  /**
   * Finish-setup: set the mandatory login + password on the shell WebAccount
   * created during external registration. `passwordHash` is the client-side
   * SHA-256 digest (same contract as web-auth register/claim).
   */
  public async finishSetup(input: {
    readonly userId: string;
    readonly login: string;
    readonly passwordHash: string;
  }): Promise<{ readonly ok: true }> {
    if (!loginPolicy.isValidLogin(input.login)) {
      throw new BadRequestException('login is invalid');
    }
    const login = loginPolicy.sanitizeLogin(input.login);
    const loginNormalized = loginPolicy.normalizeLogin(input.login);
    const passwordHash = await this.passwordHashService.hashPassword({
      plainTextPassword: input.passwordHash,
    });

    const outcome = await this.prismaService.$transaction(async (tx) => {
      const account = await tx.webAccount.findUnique({
        where: { userId: input.userId },
        select: { id: true, passwordHash: true, email: true },
      });
      if (!account) throw new NotFoundException('Web account not found');
      if (account.passwordHash !== null) {
        // Credentials already set (idempotent double-submit) — nothing to do.
        return { credentialsSet: false, email: null as string | null };
      }
      const loginConflict = await tx.webAccount.findUnique({
        where: { loginNormalized },
        select: { id: true },
      });
      if (loginConflict !== null && loginConflict.id !== account.id) {
        throw new ConflictException('login is already taken');
      }
      await tx.webAccount.update({
        where: { id: account.id },
        data: {
          login,
          loginNormalized,
          passwordHash,
          requiresPasswordChange: false,
          credentialsBootstrappedAt: new Date(),
        },
      });
      return { credentialsSet: true, email: account.email };
    });

    // Best-effort welcome email (login only — never the password). Skips
    // silently when the email module is off or the account has no email.
    if (outcome.credentialsSet && outcome.email) {
      try {
        await this.emailDeliveryService.send({
          to: outcome.email,
          subject: 'Welcome',
          templateType: 'web_welcome',
          variables: { login },
        });
      } catch (err) {
        this.logger.warn(`External-auth welcome email failed: ${(err as Error).message}`);
      }
    }
    return { ok: true };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private requireOAuthAdapter(provider: ExternalAuthProvider): OAuthProviderAdapter {
    const adapter = this.oauthAdapters.get(provider);
    if (!adapter) throw new BadRequestException(`Provider ${provider} does not use the OAuth code flow`);
    return adapter;
  }

  /** Whether the profile email may be attached (verified bypasses the policy). */
  private async emailAttachable(profile: ExternalUserProfile): Promise<string | null> {
    if (!profile.email) return null;
    const email = profile.email.trim();
    if (profile.emailVerified) return email;
    const policy = await this.configService.getPolicy();
    const check = await this.disposableEmailService.check(email, policy);
    return check.allowed ? email : null;
  }

  private async createShellAccount(profile: ExternalUserProfile): Promise<string> {
    const attachEmail = await this.emailAttachable(profile);
    const emailNormalized = attachEmail ? attachEmail.toLowerCase() : null;
    // For a NEW Telegram sign-up, stamp `User.telegramId` on the shell so the
    // cabinet session carries it (the reiwa credential-gate + notifications rely
    // on it). The step-1.5 lookup already proved this id is free. Non-Telegram
    // providers never set it (their identity is email / OAuth link only).
    const telegramId =
      profile.provider === ExternalAuthProvider.TELEGRAM
        ? parseBigintOrNull(profile.providerUserId)
        : null;

    const userId = await this.prismaService.$transaction(async (tx) => {
      // NB: `User.email` is a unique column and is intentionally left unset —
      // the email identity lives on the `WebAccount` (unique `emailNormalized`,
      // already proven free by the step-2 match). Setting `User.email` here
      // would collide with an admin-created / imported `User` that has the same
      // email but no `WebAccount`.
      const user = await tx.user.create({
        data: { name: profile.name ?? '', ...(telegramId !== null ? { telegramId } : {}) },
        select: { id: true },
      });
      await tx.webAccount.create({
        data: {
          userId: user.id,
          email: attachEmail,
          emailNormalized,
          emailVerifiedAt: attachEmail && profile.emailVerified ? new Date() : null,
        },
        select: { id: true },
      });
      await tx.userOAuthLink.create({
        data: {
          userId: user.id,
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          providerEmail: profile.email,
          providerName: profile.name,
          emailVerified: profile.emailVerified,
          profileData: sanitizeProfile(profile.rawProfile),
        },
      });
      return user.id;
    });

    this.systemEventsService.info(
      EVENT_TYPES.USER_WEB_REGISTERED,
      'USER',
      `External registration via ${profile.provider}`,
      {
        userId,
        userName: profile.name ?? undefined,
        reiwaId: userId,
        provider: profile.provider,
        source: 'external_auth',
      },
    );
    return userId;
  }

  /**
   * Ensures the resolved user carries `User.telegramId` after a Telegram
   * sign-in. Sets it only when the row currently has none AND no other user
   * already owns that id (never steals it / breaks the unique constraint —
   * a split identity is left as-is and logged). Best-effort: a failure here
   * must never block a successful login.
   */
  private async ensureTelegramIdLinked(userId: string, providerUserId: string): Promise<void> {
    const telegramId = parseBigintOrNull(providerUserId);
    if (telegramId === null) return;
    try {
      const user = await this.prismaService.user.findUnique({
        where: { id: userId },
        select: { telegramId: true },
      });
      if (user?.telegramId != null) return;
      const owner = await this.prismaService.user.findUnique({
        where: { telegramId },
        select: { id: true },
      });
      if (owner && owner.id !== userId) {
        this.logger.warn(
          `Telegram id ${telegramId} already linked to a different user; skipping backfill for ${userId}`,
        );
        return;
      }
      await this.prismaService.user.update({ where: { id: userId }, data: { telegramId } });
    } catch (err) {
      this.logger.warn(`ensureTelegramIdLinked failed for ${userId}: ${(err as Error).message}`);
    }
  }

  private async createLink(userId: string, profile: ExternalUserProfile): Promise<void> {
    await this.prismaService.userOAuthLink.create({
      data: {
        userId,
        provider: profile.provider,
        providerUserId: profile.providerUserId,
        providerEmail: profile.email,
        providerName: profile.name,
        emailVerified: profile.emailVerified,
        profileData: sanitizeProfile(profile.rawProfile),
        lastUsedAt: new Date(),
      },
    });
  }
}

/**
 * Builds a diagnostic string from an OAuth-exchange failure — surfacing the
 * provider token-endpoint error body (`{ error, error_description }`) and HTTP
 * status when it's an axios error, so the operator can tell an `invalid_client`
 * (wrong secret) from an `invalid_grant` (reused/expired code) or a decrypt
 * failure. Never throws.
 */
function describeExchangeError(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { message?: unknown; response?: { status?: unknown; data?: unknown } };
    const status = e.response?.status;
    const statusStr = status !== undefined ? ` status=${String(status)}` : '';
    const dataStr = e.response?.data !== undefined ? ` body=${safeJson(e.response.data)}` : '';
    const msg = typeof e.message === 'string' ? e.message : String(err);
    return `${msg}${statusStr}${dataStr}`;
  }
  return String(err);
}

/** JSON-stringify without throwing, truncated to keep logs bounded. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return '[unserializable]';
  }
}

/** Parses a decimal Telegram id string to BigInt; null when not a positive int. */
function parseBigintOrNull(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  try {
    const n = BigInt(value);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/** Strips any token-like keys from the raw profile before persistence. */
function sanitizeProfile(raw: Record<string, unknown>): Record<string, Prisma.InputJsonValue> {
  const out: Record<string, Prisma.InputJsonValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (/token|secret|password/i.test(key)) continue;
    out[key] = value as Prisma.InputJsonValue;
  }
  return out;
}
