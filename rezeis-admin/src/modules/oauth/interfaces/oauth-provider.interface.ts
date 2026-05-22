import { AuthProviderType } from '@prisma/client';

/**
 * Unified OAuth provider profile returned after successful authentication.
 * Each provider adapter normalizes its response into this shape.
 */
export interface OAuthUserProfile {
  /** Provider-specific unique user identifier. */
  readonly providerId: string;
  /** Provider type for matching. */
  readonly providerType: AuthProviderType;
  /** Email from the provider (may be null for Telegram). */
  readonly email: string | null;
  /** Display name from the provider. */
  readonly name: string | null;
  /** Avatar URL (if available). */
  readonly avatarUrl: string | null;
  /** Raw profile data (sanitized — no tokens). */
  readonly rawProfile: Record<string, unknown>;
}

/**
 * Configuration shape for a provider as stored in the database.
 */
export interface AuthProviderConfigInterface {
  readonly id: string;
  readonly type: AuthProviderType;
  readonly isEnabled: boolean;
  readonly displayName: string;
  readonly clientId: string | null;
  readonly frontendDomain: string | null;
  readonly backendDomain: string | null;
  readonly authorizationUrl: string | null;
  readonly tokenUrl: string | null;
  readonly realm: string | null;
  readonly providerDomain: string | null;
  readonly usePkce: boolean;
  readonly allowedEmails: readonly string[];
  readonly allowedTelegramIds: readonly bigint[];
}

/**
 * Result of an OAuth login attempt.
 */
export interface OAuthLoginResult {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: string;
  readonly admin: {
    readonly id: string;
    readonly login: string;
    readonly name: string | null;
    readonly role: string;
  };
  readonly isNewLink: boolean;
}

/**
 * Public provider info exposed to the login page (no secrets).
 */
export interface PublicProviderInfo {
  readonly type: AuthProviderType;
  readonly displayName: string;
  readonly isEnabled: boolean;
}
