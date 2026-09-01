/**
 * SMTP configuration stored in Settings.systemNotifications.email JSON.
 */
export interface SmtpSettingsInterface {
  readonly enabled: boolean;
  readonly host: string | null;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly useTls: boolean;
  readonly useSsl: boolean;
}

/**
 * Branding data injected into email templates.
 * Pulled from Settings.brandingSettings + reiwa config.
 */
export interface EmailBrandingInterface {
  readonly serviceName: string;
  readonly logoUrl: string | null;
  readonly primaryColor: string;
  readonly supportEmail: string | null;
  readonly websiteUrl: string | null;
  /**
   * The operator's own surface colours, so an email looks like the cabinet it
   * came from rather than a generic light card with one accent borrowed from it.
   *
   * Optional because an older stored settings blob may not carry a theme; the
   * layout falls back to the light palette it always used, which is what those
   * deployments already see.
   */
  readonly theme?: EmailThemeColorsInterface;
}

/**
 * The four colours an email actually needs out of a cabinet theme.
 *
 * Deliberately not the whole `BrandingThemeVariant`: an inbox cannot do card
 * effects, background shaders, corner-radius scales or webfonts, and pretending
 * otherwise would mean a template that claims to mirror the cabinet and
 * silently drops most of it.
 */
export interface EmailThemeColorsInterface {
  /** The page ground behind the card. */
  readonly background: string;
  /** The card itself. */
  readonly surface: string;
  /** Body text, chosen for contrast against `surface`. */
  readonly text: string;
  /** Secondary text (the footer), chosen for contrast against `surface`. */
  readonly mutedText: string;
  /** Text on the accent header, chosen for contrast against `primaryColor`. */
  readonly onPrimary: string;
}

/**
 * Payload for sending an email via the queue.
 */
export interface SendEmailPayload {
  /** Recipient email address. */
  readonly to: string;
  /** Email subject line. */
  readonly subject: string;
  /** Notification template type (e.g. 'expires_in_3_days'). */
  readonly templateType: string;
  /** Template variables for placeholder substitution. */
  readonly variables: Record<string, string | number | null>;
  /** Optional override: raw HTML body (skips template rendering). */
  readonly rawHtml?: string;
  /**
   * Optional plain-text alternative, sent alongside the HTML part.
   *
   * A message with no text alternative scores worse with spam filters, and a
   * reader whose client refuses HTML currently receives nothing at all.
   */
  readonly text?: string;
  /**
   * Optional stable key that makes this send happen at most once.
   *
   * Callers that can be re-run over the same recipients — a broadcast batch
   * retried by BullMQ, resumed after a lost fan-out, or replayed by the
   * "retry failed" button — pass one. Without it those paths mail the same
   * person again on every pass, which is the one leg of a broadcast that had
   * no deduplication at all while Telegram and the cabinet feed both did.
   */
  readonly dedupeKey?: string;
}
