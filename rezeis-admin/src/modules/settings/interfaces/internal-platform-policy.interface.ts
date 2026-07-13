import { AccessMode, Currency } from '@prisma/client';

/**
 * Describes the user-safe platform policy payload exposed to the internal edge.
 */
export interface InternalPlatformPolicyInterface {
  readonly rulesRequired: boolean;
  readonly rulesLink: string | null;
  readonly channelRequired: boolean;
  readonly channelLink: string | null;
  /** Numeric channel id (`-100…`) as a string, when configured. */
  readonly channelId: string | null;
  /** Channel `@username`, when configured (branding tab). */
  readonly channelUsername: string | null;
  /** When true, re-check membership on each gated entry (default true). */
  readonly channelRecheck: boolean;
  /**
   * When true (default), Telegram users without web login/password must set
   * them (claim / finish-setup) before entering the cabinet. When false,
   * Telegram alone is accepted and such users go straight in.
   */
  readonly requireTelegramWebCredentials: boolean;
  readonly accessMode: AccessMode;
  readonly inviteModeStartedAt: string | null;
  readonly defaultCurrency: Currency;
  /**
   * Capability signal: whether renewal add-on composition is enabled
   * (rezeis env `ADDON_RENEWAL_ADDONS`). The cabinet only shows the renewal
   * add-on selection step when this is true — otherwise the backend pricing
   * ignores add-on selections, so surfacing them would mislead. Deployment-time
   * flag, not panel-editable.
   */
  readonly renewalAddOns: boolean;
}
