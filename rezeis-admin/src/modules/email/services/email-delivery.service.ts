import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import { emailConfig } from '../../../common/config/email.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { readBrandingSettings } from '../../settings/utils/branding-settings.util';
import { EMAIL_QUEUE, EMAIL_JOBS } from '../email.constants';
import type { SendEmailPayload, SmtpSettingsInterface } from '../interfaces/email.interface';
import { EmailTemplateRendererService } from './email-template-renderer.service';

/**
 * Email delivery service — sends emails via SMTP using nodemailer.
 *
 * Configuration priority:
 *   1. Settings.systemNotifications.email (DB — editable from admin UI)
 *   2. Environment variables (EMAIL_HOST, EMAIL_PORT, etc.)
 *
 * Delivery modes:
 *   - Async (default): enqueues a BullMQ job → processor sends
 *   - Sync (for test emails): sends immediately and returns result
 *
 * Branding:
 *   All emails are wrapped in a branded HTML template that pulls
 *   logo, colors, and service name from Settings.brandingSettings.
 *   Reiwa operators customize this through the admin panel.
 */
@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);
  private transporter: Transporter | null = null;

  public constructor(
    @Inject(emailConfig.KEY)
    private readonly emailConfiguration: ConfigType<typeof emailConfig>,
    private readonly prismaService: PrismaService,
    private readonly templateRenderer: EmailTemplateRendererService,
    @Optional()
    private readonly events?: SystemEventsService,
    @Optional()
    @InjectQueue(EMAIL_QUEUE)
    private readonly emailQueue?: Queue,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Enqueue an email for async delivery via BullMQ.
   * Returns immediately — the processor handles actual sending.
   */
  public async send(payload: SendEmailPayload): Promise<void> {
    const config = await this.resolveSmtpConfig();
    if (!config.enabled) {
      this.logger.debug(`Email disabled — skipping send to ${payload.to}`);
      return;
    }

    if (!this.emailQueue) {
      // Fallback: send synchronously if queue not available
      await this.sendImmediate(payload);
      return;
    }

    await this.emailQueue.add(EMAIL_JOBS.SEND, payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    });
  }

  /**
   * Send an email immediately (synchronous). Used by:
   *   - BullMQ processor
   *   - Test email endpoint
   */
  public async sendImmediate(payload: SendEmailPayload): Promise<{ success: boolean; error?: string }> {
    const config = await this.resolveSmtpConfig();
    if (!config.enabled || !config.host) {
      return { success: false, error: 'SMTP not configured or disabled' };
    }

    // Render template
    const rendered = await this.templateRenderer.render({
      templateType: payload.templateType,
      variables: payload.variables,
      rawHtml: payload.rawHtml,
      subject: payload.subject,
    });

    if (!rendered) {
      return { success: false, error: `Template "${payload.templateType}" not found or inactive` };
    }

    // Get or create transporter
    const transporter = await this.getTransporter(config);

    try {
      await transporter.sendMail({
        from: `"${config.fromName}" <${config.fromAddress}>`,
        to: payload.to,
        subject: rendered.subject,
        html: rendered.html,
      });
      this.logger.log(`Email sent: to=${payload.to} template=${payload.templateType}`);
      return { success: true };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`Email send failed: to=${payload.to} error=${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Send a one-time verification / password-reset code as a branded email,
   * synchronously (the caller needs the success/failure result to decide
   * whether to keep or revoke the issued challenge). Bypasses the DB template
   * lookup (uses a self-contained `rawHtml` block) so code delivery never
   * depends on a seeded template being present.
   */
  public async sendVerificationCode(input: {
    readonly to: string;
    readonly code: string;
    readonly expiresAt: Date;
    /** Optional heading override (defaults to a generic confirmation copy). */
    readonly heading?: string;
    readonly intro?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const minutes = Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 60_000));
    const heading = escapeEmailHtml(input.heading ?? 'Код подтверждения');
    const intro = escapeEmailHtml(
      input.intro ?? 'Используйте этот код, чтобы подтвердить действие в вашем аккаунте.',
    );
    const code = escapeEmailHtml(input.code);
    const rawHtml = `
      <h2 style="margin:0 0 12px 0;color:#111827;font-size:20px;">${heading}</h2>
      <p style="margin:0 0 20px 0;color:#374151;">${intro}</p>
      <div style="margin:0 0 20px 0;padding:18px 12px;background:#f3f4f6;border-radius:10px;text-align:center;">
        <span style="font-size:30px;font-weight:700;letter-spacing:8px;color:#111827;font-family:'Courier New',monospace;">${code}</span>
      </div>
      <p style="margin:0 0 8px 0;color:#6b7280;font-size:13px;">Код действует ${minutes} мин. Никому его не сообщайте.</p>
      <p style="margin:0;color:#9ca3af;font-size:12px;">Если вы не запрашивали это действие — просто проигнорируйте письмо.</p>
    `;
    return this.sendImmediate({
      to: input.to,
      subject: `${input.code} — код подтверждения`,
      templateType: '__verification_code__',
      variables: {},
      rawHtml,
    });
  }

  /**
   * Send a test email to verify SMTP configuration.
   */
  public async sendTest(to: string): Promise<{ success: boolean; error?: string }> {
    // Always rebuild from the latest settings — a test must reflect exactly
    // what the operator just entered, never a stale cached transporter.
    this.transporter = null;
    return this.sendImmediate({
      to,
      subject: 'Test Email',
      templateType: '__test__',
      variables: {},
      // The branded layout already shows the operator's brand in the header;
      // keep the body brand-neutral so a test never leaks the panel name.
      rawHtml: `
        <h2 style="margin:0 0 16px 0;color:#1f2937;">SMTP Test</h2>
        <p>This is a test email confirming your outgoing mail settings.</p>
        <p>If you received this, your SMTP configuration is working correctly.</p>
        <p style="margin-top:16px;padding:12px;background:#f0fdf4;border-radius:8px;color:#166534;">
          &#10004; SMTP connection verified successfully
        </p>
      `,
    });
  }

  /**
   * Verify SMTP connection without sending an email.
   */
  public async verifyConnection(): Promise<{ success: boolean; error?: string }> {
    const config = await this.resolveSmtpConfig();
    if (!config.enabled || !config.host) {
      return { success: false, error: 'SMTP not configured or disabled' };
    }

    // Rebuild from the latest settings for an accurate connection check.
    this.transporter = null;
    const transporter = await this.getTransporter(config);
    try {
      await transporter.verify();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ── SMTP Settings Management ───────────────────────────────────────────

  /**
   * Get current SMTP settings (from DB or env fallback).
   */
  public async getSmtpSettings(): Promise<SmtpSettingsInterface> {
    return this.resolveSmtpConfig();
  }

  /**
   * Save SMTP settings to the database (Settings.systemNotifications.email).
   */
  public async saveSmtpSettings(input: Partial<SmtpSettingsInterface>): Promise<SmtpSettingsInterface> {
    const settings = await this.prismaService.settings.findFirst({
      select: { id: true, systemNotifications: true },
    });

    const existing = (settings?.systemNotifications ?? {}) as Record<string, unknown>;
    const currentEmail = (existing.email ?? {}) as Record<string, unknown>;

    const updated = {
      ...existing,
      email: {
        ...currentEmail,
        ...input,
      },
    };

    if (settings) {
      await this.prismaService.settings.update({
        where: { id: settings.id },
        data: { systemNotifications: updated },
      });
      const updatedFields = Object.keys(input)
        .map((field) => field === 'password' ? 'passwordSet' : field)
        .sort();
      if (updatedFields.length > 0) {
        this.events?.info(EVENT_TYPES.SETTINGS_EMAIL_UPDATED, 'SYSTEM', 'Email settings updated', {
          updatedFields,
        });
      }
    }

    // Invalidate cached transporter
    this.transporter = null;

    return this.resolveSmtpConfig();
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async resolveSmtpConfig(): Promise<SmtpSettingsInterface> {
    // Priority 1: DB settings
    const settings = await this.prismaService.settings.findFirst({
      select: { systemNotifications: true, brandingSettings: true },
    });
    const json = (settings?.systemNotifications ?? {}) as Record<string, unknown>;
    const dbEmail = (json.email ?? {}) as Record<string, unknown>;

    // Sender NAME default = the operator's user-facing brand (e.g. "Reiwa"),
    // NEVER the hidden admin-panel name. Chain: DB value → explicit
    // EMAIL_FROM_NAME env → brand. So out of the box users see the project,
    // not "Rezeis".
    const brandName = readBrandingSettings(settings?.brandingSettings ?? null).brandName;
    const dbFromName =
      typeof dbEmail.fromName === 'string' && dbEmail.fromName.trim().length > 0
        ? dbEmail.fromName
        : null;
    const envFromNameSet =
      typeof process.env.EMAIL_FROM_NAME === 'string' && process.env.EMAIL_FROM_NAME.trim().length > 0;
    const fromName = dbFromName ?? (envFromNameSet ? this.emailConfiguration.fromName : brandName);

    // Merge: DB overrides env
    return {
      enabled: typeof dbEmail.enabled === 'boolean' ? dbEmail.enabled : this.emailConfiguration.enabled,
      host: typeof dbEmail.host === 'string' ? dbEmail.host : this.emailConfiguration.host,
      port: typeof dbEmail.port === 'number' ? dbEmail.port : this.emailConfiguration.port,
      username: typeof dbEmail.username === 'string' ? dbEmail.username : this.emailConfiguration.username,
      password: typeof dbEmail.password === 'string' ? dbEmail.password : this.emailConfiguration.password,
      fromAddress: typeof dbEmail.fromAddress === 'string' ? dbEmail.fromAddress : this.emailConfiguration.fromAddress,
      fromName,
      useTls: typeof dbEmail.useTls === 'boolean' ? dbEmail.useTls : this.emailConfiguration.useTls,
      useSsl: typeof dbEmail.useSsl === 'boolean' ? dbEmail.useSsl : this.emailConfiguration.useSsl,
    };
  }

  private async getTransporter(config: SmtpSettingsInterface): Promise<Transporter> {
    if (this.transporter) return this.transporter;

    // Encryption is chosen primarily by PORT, not by the raw toggle — using
    // implicit TLS (`secure:true`) on a STARTTLS port (587/25) is the classic
    // cause of `SSL routines:...:wrong version number`. We auto-heal that:
    //   - 465        → implicit TLS (SMTPS)
    //   - 587 / 25   → plaintext socket upgraded via STARTTLS (forced when the
    //                  operator asked for any encryption)
    //   - other ports → honour the explicit `useSsl` flag
    const { secure, requireTls } = deriveSmtpSecurity(config);
    const useAnyTls = secure || requireTls || config.useTls || config.useSsl;

    this.transporter = nodemailer.createTransport({
      host: config.host ?? undefined,
      port: config.port,
      secure,
      requireTLS: requireTls,
      auth: config.username
        ? { user: config.username, pass: config.password ?? '' }
        : undefined,
      // Tolerate self-signed / mismatched certs on private relays; keep SNI.
      tls: useAnyTls
        ? { rejectUnauthorized: false, servername: config.host ?? undefined }
        : undefined,
    });

    return this.transporter;
  }
}

/**
 * Derive nodemailer's `secure` (implicit TLS) + `requireTLS` (STARTTLS) from
 * the SMTP port and the operator's encryption toggles. Port wins for the two
 * well-known submission ports so a "use SSL on 587" misconfiguration upgrades
 * via STARTTLS instead of crashing the TLS handshake.
 */
export function deriveSmtpSecurity(config: SmtpSettingsInterface): {
  readonly secure: boolean;
  readonly requireTls: boolean;
} {
  if (config.port === 465) {
    return { secure: true, requireTls: false };
  }
  if (config.port === 587 || config.port === 25) {
    return { secure: false, requireTls: config.useTls || config.useSsl };
  }
  // Custom port: honour the explicit implicit-TLS flag; otherwise STARTTLS
  // when the operator enabled TLS.
  return { secure: config.useSsl, requireTls: !config.useSsl && config.useTls };
}

/** Minimal HTML escaping for values interpolated into a rawHtml email block. */
function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
