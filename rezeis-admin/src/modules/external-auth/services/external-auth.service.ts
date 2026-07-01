import {
  BadRequestException,
  ConflictException,
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
    const config = await this.configService.getEnabledAdapterConfig(provider);
    const profile = await adapter.exchange(config, input);
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
      return { action: 'login', userId: link.userId };
    }

    // 2. Verified-email match → auto-link.
    if (profile.emailVerified && profile.email) {
      const emailNormalized = profile.email.trim().toLowerCase();
      const account = await this.prismaService.webAccount.findUnique({
        where: { emailNormalized },
        select: { userId: true, user: { select: { isBlocked: true } } },
      });
      if (account) {
        if (account.user.isBlocked) return { action: 'denied' };
        await this.createLink(account.userId, profile);
        return { action: 'login', userId: account.userId };
      }
    }

    // 3. New account → shell + finish-setup.
    const userId = await this.createShellAccount(profile);
    return { action: 'finish_setup', userId };
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

    const userId = await this.prismaService.$transaction(async (tx) => {
      // NB: `User.email` is a unique column and is intentionally left unset —
      // the email identity lives on the `WebAccount` (unique `emailNormalized`,
      // already proven free by the step-2 match). Setting `User.email` here
      // would collide with an admin-created / imported `User` that has the same
      // email but no `WebAccount`.
      const user = await tx.user.create({
        data: { name: profile.name ?? '' },
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
