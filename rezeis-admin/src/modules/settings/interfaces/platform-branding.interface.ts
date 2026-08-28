/**
 * Platform branding texts — strongly-typed view over the
 * `Settings.platformPolicy` JSON column (an existing, previously-unused
 * column repurposed to hold these texts; no migration required).
 *
 * Distinct from `BrandingSettingsInterface` (visual branding: colors, logo,
 * card effects) which lives in `Settings.brandingSettings`. Keeping the two
 * in separate columns avoids the shape collision that caused the platform
 * settings save to 400.
 */
export interface VerificationTemplateLocales {
  readonly ru: string | null;
  readonly en: string | null;
}

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
  readonly verification: {
    readonly telegramTemplate: VerificationTemplateLocales;
    readonly passwordResetTelegramTemplate: VerificationTemplateLocales;
  };
}

export const DEFAULT_PLATFORM_BRANDING: PlatformBrandingInterface = {
  projectName: null,
  timezone: null,
  webTitle: null,
  channelUsername: null,
  channelRecheck: true,
  requireTelegramWebCredentials: false,
  verification: {
    telegramTemplate: { ru: null, en: null },
    passwordResetTelegramTemplate: { ru: null, en: null },
  },
};
