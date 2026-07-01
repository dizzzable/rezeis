import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ExternalAuthProvider, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CryptoService } from '../../oauth/services/crypto.service';
import {
  DisposableEmailMode,
  ExternalAuthPolicy,
  ExternalProviderConfigView,
  PublicExternalProvider,
} from '../interfaces/external-auth.interface';

/** Providers that use the OAuth2 code flow (need client id + secret). */
const OAUTH_PROVIDERS: readonly ExternalAuthProvider[] = [
  ExternalAuthProvider.GOOGLE,
  ExternalAuthProvider.YANDEX,
  ExternalAuthProvider.MAILRU,
];

const DEFAULT_DISPLAY_NAMES: Record<ExternalAuthProvider, string> = {
  TELEGRAM: 'Telegram',
  GOOGLE: 'Google',
  YANDEX: 'Yandex',
  MAILRU: 'Mail.ru',
};

const DEFAULT_POLICY: ExternalAuthPolicy = {
  mode: 'blocklist',
  customBlocklist: [],
  allowlist: ['gmail.com', 'yandex.ru', 'mail.ru', 'outlook.com'],
  gateProvidersByEmailModule: false,
};

const DISPOSABLE_MODES: readonly DisposableEmailMode[] = ['off', 'blocklist', 'blocklist_mx', 'allowlist'];

/**
 * CRUD for end-user external-auth provider configs + the disposable-email
 * policy. Secrets are AES-256-GCM encrypted (reuses the admin OAuth
 * `CryptoService`) and never returned in plaintext.
 */
@Injectable()
export class ExternalProviderConfigService {
  private readonly logger = new Logger(ExternalProviderConfigService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly cryptoService: CryptoService,
  ) {}

  /** Every supported provider, creating a default (disabled) row on first read. */
  public async getAllConfigs(): Promise<ExternalProviderConfigView[]> {
    const existing = await this.prismaService.externalAuthProviderConfig.findMany();
    const byProvider = new Map(existing.map((c) => [c.provider, c]));
    const views: ExternalProviderConfigView[] = [];

    for (const provider of Object.values(ExternalAuthProvider)) {
      let row = byProvider.get(provider);
      if (!row) {
        row = await this.prismaService.externalAuthProviderConfig.create({
          data: {
            provider,
            displayName: DEFAULT_DISPLAY_NAMES[provider],
            isEnabled: provider === ExternalAuthProvider.TELEGRAM,
            usePkce: provider !== ExternalAuthProvider.TELEGRAM,
          },
        });
      }
      views.push(this.toView(row));
    }
    return views;
  }

  /** Enabled providers for the web cabinet (public — no secrets). */
  public async getEnabledProviders(): Promise<PublicExternalProvider[]> {
    const rows = await this.prismaService.externalAuthProviderConfig.findMany({
      select: {
        provider: true,
        displayName: true,
        isEnabled: true,
        useOidc: true,
        clientId: true,
        clientSecretEnc: true,
      },
    });
    const byProvider = new Map(rows.map((r) => [r.provider, r] as const));
    const result: PublicExternalProvider[] = [];
    // Telegram is default-on (reuses the bot token) even before the admin ever
    // opens the External Auth page — so it must surface without a seeded row.
    // OAuth providers stay default-off. An explicit admin row always wins.
    for (const provider of Object.values(ExternalAuthProvider)) {
      const row = byProvider.get(provider);
      const enabled = row ? row.isEnabled : provider === ExternalAuthProvider.TELEGRAM;
      if (!enabled) continue;
      if (provider === ExternalAuthProvider.TELEGRAM) {
        // OIDC only when the operator supplied a Client ID + Secret from
        // @BotFather; otherwise fall back to the classic Login Widget.
        const mode: 'oidc' | 'widget' =
          row?.useOidc && row.clientId && row.clientSecretEnc ? 'oidc' : 'widget';
        result.push({ provider, displayName: row?.displayName ?? DEFAULT_DISPLAY_NAMES[provider], mode });
      } else {
        result.push({ provider, displayName: row?.displayName ?? DEFAULT_DISPLAY_NAMES[provider] });
      }
    }
    return result;
  }

  /**
   * Returns the decrypted adapter config for an ENABLED OAuth provider.
   * Throws when the provider is disabled or missing credentials.
   */
  public async getEnabledAdapterConfig(provider: ExternalAuthProvider): Promise<{
    readonly clientId: string;
    readonly clientSecret: string;
    readonly usePkce: boolean;
    readonly scopes: string | null;
  }> {
    const row = await this.prismaService.externalAuthProviderConfig.findUnique({ where: { provider } });
    if (!row || !row.isEnabled) {
      throw new UnauthorizedException(`Provider ${provider} is not enabled`);
    }
    if (!row.clientId || !row.clientSecretEnc) {
      throw new UnauthorizedException(`Provider ${provider} is not configured`);
    }
    return {
      clientId: row.clientId,
      clientSecret: this.cryptoService.decrypt(row.clientSecretEnc),
      usePkce: row.usePkce,
      scopes: row.scopes,
    };
  }

  /** Whether a provider is currently enabled (used to gate Telegram resolve). */
  public async isProviderEnabled(provider: ExternalAuthProvider): Promise<boolean> {
    const row = await this.prismaService.externalAuthProviderConfig.findUnique({
      where: { provider },
      select: { isEnabled: true },
    });
    // Mirror getEnabledProviders: Telegram is default-on when no row exists yet,
    // so its callback resolve doesn't fail before the admin seeds config rows.
    if (!row) return provider === ExternalAuthProvider.TELEGRAM;
    return row.isEnabled === true;
  }

  /**
   * Upserts a provider config. Encrypts the secret when supplied. Enabling an
   * OAuth provider requires a client id + a stored secret (Requirement 1.2);
   * Telegram reuses the bot token and needs no credentials.
   */
  public async updateConfig(
    provider: ExternalAuthProvider,
    input: {
      readonly isEnabled?: boolean;
      readonly displayName?: string;
      readonly clientId?: string | null;
      readonly clientSecret?: string | null;
      readonly usePkce?: boolean;
      readonly useOidc?: boolean;
      readonly scopes?: string | null;
    },
  ): Promise<ExternalProviderConfigView> {
    const current = await this.prismaService.externalAuthProviderConfig.findUnique({
      where: { provider },
    });

    const data: Prisma.ExternalAuthProviderConfigUpdateInput = {};
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.clientId !== undefined) data.clientId = input.clientId;
    if (input.usePkce !== undefined) data.usePkce = input.usePkce;
    if (input.useOidc !== undefined) data.useOidc = input.useOidc;
    if (input.scopes !== undefined) data.scopes = input.scopes;
    if (input.clientSecret !== undefined && input.clientSecret !== null && input.clientSecret !== '') {
      data.clientSecretEnc = this.cryptoService.encrypt(input.clientSecret);
    }

    // Resolve the post-update credential state to guard enabling.
    const nextClientId = input.clientId !== undefined ? input.clientId : current?.clientId ?? null;
    const nextHasSecret =
      (input.clientSecret !== undefined && input.clientSecret !== null && input.clientSecret !== '') ||
      Boolean(current?.clientSecretEnc);
    const nextUseOidc = input.useOidc !== undefined ? input.useOidc : current?.useOidc ?? false;
    const nextEnabled =
      input.isEnabled !== undefined
        ? input.isEnabled
        : current?.isEnabled ?? provider === ExternalAuthProvider.TELEGRAM;

    // OAuth providers always need credentials to be enabled; Telegram needs them
    // only when using the OAuth2/OIDC flow (the widget reuses the bot token).
    const requiresCredentials =
      OAUTH_PROVIDERS.includes(provider) ||
      (provider === ExternalAuthProvider.TELEGRAM && nextUseOidc);
    if (nextEnabled && requiresCredentials && (!nextClientId || !nextHasSecret)) {
      throw new BadRequestException(
        `Provider ${provider} requires a client id and client secret before it can be enabled`,
      );
    }
    if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;

    const row = await this.prismaService.externalAuthProviderConfig.upsert({
      where: { provider },
      create: {
        provider,
        displayName: input.displayName ?? DEFAULT_DISPLAY_NAMES[provider],
        isEnabled: input.isEnabled ?? provider === ExternalAuthProvider.TELEGRAM,
        clientId: input.clientId ?? null,
        clientSecretEnc:
          input.clientSecret !== undefined && input.clientSecret !== null && input.clientSecret !== ''
            ? this.cryptoService.encrypt(input.clientSecret)
            : null,
        usePkce: input.usePkce ?? provider !== ExternalAuthProvider.TELEGRAM,
        useOidc: input.useOidc ?? false,
        scopes: input.scopes ?? null,
      },
      update: data,
    });
    this.logger.log(`External provider ${provider} updated (enabled: ${row.isEnabled})`);
    return this.toView(row);
  }

  // ── Disposable-email policy (Settings.platformPolicy.externalAuth) ─────────

  public async getPolicy(): Promise<ExternalAuthPolicy> {
    const settings = await this.prismaService.settings.findFirst({
      select: { platformPolicy: true },
    });
    return readPolicy(settings?.platformPolicy);
  }

  public async updatePolicy(input: Partial<ExternalAuthPolicy>): Promise<ExternalAuthPolicy> {
    const settings = await this.prismaService.settings.findFirst({
      select: { id: true, platformPolicy: true },
    });
    if (!settings) throw new BadRequestException('Settings row not initialized');
    const current = readPolicy(settings.platformPolicy);
    const next: ExternalAuthPolicy = {
      mode: input.mode !== undefined && DISPOSABLE_MODES.includes(input.mode) ? input.mode : current.mode,
      customBlocklist: normalizeDomains(input.customBlocklist ?? current.customBlocklist),
      allowlist: normalizeDomains(input.allowlist ?? current.allowlist),
      gateProvidersByEmailModule:
        input.gateProvidersByEmailModule ?? current.gateProvidersByEmailModule,
    };
    const base = isRecord(settings.platformPolicy) ? settings.platformPolicy : {};
    const externalAuthJson: Prisma.InputJsonObject = {
      mode: next.mode,
      customBlocklist: [...next.customBlocklist],
      allowlist: [...next.allowlist],
      gateProvidersByEmailModule: next.gateProvidersByEmailModule,
    };
    await this.prismaService.settings.update({
      where: { id: settings.id },
      data: { platformPolicy: { ...base, externalAuth: externalAuthJson } as Prisma.InputJsonObject },
    });
    return next;
  }

  private toView(row: {
    provider: ExternalAuthProvider;
    isEnabled: boolean;
    displayName: string;
    clientId: string | null;
    clientSecretEnc: string | null;
    usePkce: boolean;
    useOidc: boolean;
    scopes: string | null;
  }): ExternalProviderConfigView {
    return {
      provider: row.provider,
      isEnabled: row.isEnabled,
      displayName: row.displayName,
      clientId: row.clientId,
      hasSecret: Boolean(row.clientSecretEnc),
      usePkce: row.usePkce,
      scopes: row.scopes,
      usesBotToken: row.provider === ExternalAuthProvider.TELEGRAM,
      useOidc: row.useOidc,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDomains(list: readonly string[]): string[] {
  return Array.from(
    new Set(
      list
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0 && d.includes('.')),
    ),
  );
}

function readPolicy(platformPolicy: unknown): ExternalAuthPolicy {
  if (!isRecord(platformPolicy) || !isRecord(platformPolicy.externalAuth)) {
    return DEFAULT_POLICY;
  }
  const p = platformPolicy.externalAuth;
  const mode = p.mode;
  return {
    mode: typeof mode === 'string' && (DISPOSABLE_MODES as readonly string[]).includes(mode)
      ? (mode as DisposableEmailMode)
      : DEFAULT_POLICY.mode,
    customBlocklist: Array.isArray(p.customBlocklist)
      ? normalizeDomains(p.customBlocklist.filter((d): d is string => typeof d === 'string'))
      : DEFAULT_POLICY.customBlocklist,
    allowlist: Array.isArray(p.allowlist)
      ? normalizeDomains(p.allowlist.filter((d): d is string => typeof d === 'string'))
      : DEFAULT_POLICY.allowlist,
    gateProvidersByEmailModule:
      typeof p.gateProvidersByEmailModule === 'boolean'
        ? p.gateProvidersByEmailModule
        : DEFAULT_POLICY.gateProvidersByEmailModule,
  };
}
