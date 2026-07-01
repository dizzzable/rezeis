import { ExternalAuthProvider } from '@prisma/client';

/**
 * Unified profile every provider adapter normalizes its response into.
 */
export interface ExternalUserProfile {
  readonly provider: ExternalAuthProvider;
  readonly providerUserId: string;
  readonly email: string | null;
  /** Whether the provider asserts the email is verified. */
  readonly emailVerified: boolean;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  /** Sanitized raw profile (never contains tokens/secrets). */
  readonly rawProfile: Record<string, unknown>;
}

/**
 * Admin-facing provider config (secret never exposed — only `hasSecret`).
 */
export interface ExternalProviderConfigView {
  readonly provider: ExternalAuthProvider;
  readonly isEnabled: boolean;
  readonly displayName: string;
  readonly clientId: string | null;
  readonly hasSecret: boolean;
  readonly usePkce: boolean;
  readonly scopes: string | null;
  /** Telegram reuses the bot token; it has no client id/secret to configure. */
  readonly usesBotToken: boolean;
  /**
   * Telegram only: when true (and client id/secret set) the OAuth2/OIDC flow
   * (oauth.telegram.org) is used instead of the classic Login Widget.
   */
  readonly useOidc: boolean;
}

/**
 * Public provider info exposed to the web cabinet (no secrets).
 */
export interface PublicExternalProvider {
  readonly provider: ExternalAuthProvider;
  readonly displayName: string;
  /**
   * Telegram sign-in method the cabinet must render: `oidc` = redirect flow
   * (oauth.telegram.org), `widget` = classic Login Widget. Omitted for the
   * pure-OAuth providers (always redirect).
   */
  readonly mode?: 'oidc' | 'widget';
}

/** Disposable-email policy modes (Requirement 5.1). */
export type DisposableEmailMode = 'off' | 'blocklist' | 'blocklist_mx' | 'allowlist';

/**
 * Operator-configured external-auth policy, persisted under
 * `Settings.platformPolicy.externalAuth`.
 */
export interface ExternalAuthPolicy {
  readonly mode: DisposableEmailMode;
  readonly customBlocklist: readonly string[];
  readonly allowlist: readonly string[];
  /** When true, OAuth providers are only offered while the email module is on. */
  readonly gateProvidersByEmailModule: boolean;
}

/** Result of a disposable/allowlist email check. */
export interface EmailPolicyResult {
  readonly allowed: boolean;
  readonly reason?: 'disposable' | 'no_mx' | 'not_allowlisted';
}

/** Outcome of resolving a verified external profile to an account decision. */
export type ExternalAuthResolution =
  | { readonly action: 'login'; readonly userId: string }
  | { readonly action: 'finish_setup'; readonly userId: string }
  | { readonly action: 'denied' };
