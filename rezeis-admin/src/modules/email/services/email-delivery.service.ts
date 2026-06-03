import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import { emailConfig } from '../../../common/config/email.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
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
   * Send a test email to verify SMTP configuration.
   */
  public async sendTest(to: string): Promise<{ success: boolean; error?: string }> {
    return this.sendImmediate({
      to,
      subject: 'Test Email',
      templateType: '__test__',
      variables: { serviceName: 'Rezeis Admin' },
      rawHtml: `
        <h2 style="margin:0 0 16px 0;color:#1f2937;">SMTP Test</h2>
        <p>This is a test email from Rezeis Admin.</p>
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
      select: { systemNotifications: true },
    });
    const json = (settings?.systemNotifications ?? {}) as Record<string, unknown>;
    const dbEmail = (json.email ?? {}) as Record<string, unknown>;

    // Merge: DB overrides env
    return {
      enabled: typeof dbEmail.enabled === 'boolean' ? dbEmail.enabled : this.emailConfiguration.enabled,
      host: typeof dbEmail.host === 'string' ? dbEmail.host : this.emailConfiguration.host,
      port: typeof dbEmail.port === 'number' ? dbEmail.port : this.emailConfiguration.port,
      username: typeof dbEmail.username === 'string' ? dbEmail.username : this.emailConfiguration.username,
      password: typeof dbEmail.password === 'string' ? dbEmail.password : this.emailConfiguration.password,
      fromAddress: typeof dbEmail.fromAddress === 'string' ? dbEmail.fromAddress : this.emailConfiguration.fromAddress,
      fromName: typeof dbEmail.fromName === 'string' ? dbEmail.fromName : this.emailConfiguration.fromName,
      useTls: typeof dbEmail.useTls === 'boolean' ? dbEmail.useTls : this.emailConfiguration.useTls,
      useSsl: typeof dbEmail.useSsl === 'boolean' ? dbEmail.useSsl : this.emailConfiguration.useSsl,
    };
  }

  private async getTransporter(config: SmtpSettingsInterface): Promise<Transporter> {
    if (this.transporter) return this.transporter;

    this.transporter = nodemailer.createTransport({
      host: config.host ?? undefined,
      port: config.port,
      secure: config.useSsl,
      auth: config.username
        ? { user: config.username, pass: config.password ?? '' }
        : undefined,
      tls: config.useTls ? { rejectUnauthorized: false } : undefined,
    });

    return this.transporter;
  }
}
