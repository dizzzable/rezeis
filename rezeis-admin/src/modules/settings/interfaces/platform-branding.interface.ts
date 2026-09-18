/**
 * Platform branding texts — strongly-typed view over the
 * `Settings.platformPolicy` JSON column (an existing, previously-unused
 * column repurposed to hold these texts; no migration required).
 *
 * Distinct from `BrandingSettingsInterface` (visual branding: colors, logo,
 * card effects) which lives in `Settings.brandingSettings`. Keeping the two
 * in separate columns avoids the shape collision that caused the platform
 * settings save to 400.
 *
 * NO TELEGRAM TEMPLATES. The column also holds `verification` —
 * «Верификация (RU/EN)» and «Сброс пароля (RU/EN)», two Telegram message
 * templates the Branding card used to offer. Nothing in the panel, the cabinet
 * or the bot ever sent either (a reset goes out as a link with the bot's own
 * text, an e-mail code with the e-mail's own), so the panel no longer reads,
 * presents or writes them; what an install stored stays in the column as it
 * is. `VerificationTemplatesDto` still accepts them, for an admin SPA loaded
 * before the change.
 */
export interface PlatformBrandingInterface {
  /** Project / brand name, substituted as `{project_name}` in templates. */
  readonly projectName: string | null;
  /**
   * IANA time zone the operator works in, e.g. `Europe/Moscow`.
   *
   * The panel stores every timestamp in UTC and had nowhere to say what UTC
   * means locally, so a notification that printed a deadline printed it in a
   * zone nobody lives in. `null` keeps that behaviour — UTC, stated plainly —
   * rather than guessing from a server clock that is itself usually UTC.
   */
  readonly timezone: string | null;
  /** Browser document title for the Mini App / web cabinet. */
  readonly webTitle: string | null;
  /** Channel `@username` used to resolve the subscription-gate channel. */
  readonly channelUsername: string | null;
  /**
   * When `true` (default), channel membership is re-evaluated on each gated
   * entry point and a user who left is re-gated. When `false`, the gate is
   * enforced only until the user first passes it.
   */
  readonly channelRecheck: boolean;
  /**
   * When `true`, a Telegram-authenticated user who has no web login/password
   * yet must set them (claim / finish-setup) before entering the cabinet — on
   * both the web Telegram-widget sign-in and the Mini App. By default it is
   * `false`: signed Telegram initData is sufficient for Mini App auto-login.
   */
  readonly requireTelegramWebCredentials: boolean;
  /**
   * «Восстановление пароля по ссылке подписки». When `true` (default), a
   * customer whose account has neither Telegram nor a verified e-mail can set
   * a new password by pasting the VPN subscription link from their app — and
   * so can anybody else who has that link. After such a recovery the partner
   * balance is held for 72 hours — no withdrawal, and no purchase paid with
   * it — and the operators are told. When `false`, that path refuses and the
   * cabinet points to support instead.
   */
  readonly subscriptionLinkRecovery: boolean;
}

export const DEFAULT_PLATFORM_BRANDING: PlatformBrandingInterface = {
  projectName: null,
  timezone: null,
  webTitle: null,
  channelUsername: null,
  channelRecheck: true,
  requireTelegramWebCredentials: false,
  subscriptionLinkRecovery: true,
};
