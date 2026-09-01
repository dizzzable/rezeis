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
