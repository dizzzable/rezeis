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
   * «Проверять только новых». `null`: the gate asks everyone. An ISO
   * instant: it asks only accounts created at or after it — reiwa learns the
   * account's age from `internal/user/exists`, and an account it cannot
   * date is asked as before (the switch only ever relaxes the gate).
   */
  readonly channelNewUsersSince: string | null;
  /**
   * When true (default), Telegram users without web login/password must set
   * them (claim / finish-setup) before entering the cabinet. When false,
   * Telegram alone is accepted and such users go straight in.
   */
  readonly requireTelegramWebCredentials: boolean;
  /**
   * «Восстановление пароля по ссылке подписки» (default true). The cabinet
   * offers recovery by subscription link only when this is `true`; a cabinet
   * reading a panel that predates the field treats its absence as OFF.
   */
  readonly subscriptionLinkRecovery: boolean;
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
