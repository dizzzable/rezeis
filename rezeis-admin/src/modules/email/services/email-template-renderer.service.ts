import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { wrapInBrandedEmailLayout } from '../utils/email-branded-layout.util';
import { emailThemeFromBranding } from '../utils/email-theme.util';
import { readBrandingSettings } from '../../settings/utils/branding-settings.util';
import type { EmailBrandingInterface } from '../interfaces/email.interface';
import {
  resolveTemplateLocale,
  type NotificationLocale,
} from '../../notifications/utils/notification-template-locale.util';

/**
 * Renders notification templates into branded HTML emails.
 *
 * Template resolution:
 *   1. Look up NotificationTemplate by `type`
 *   2. Substitute `{{variable}}` placeholders with provided values
 *   3. Wrap in branded HTML layout (logo, colors, footer)
 *
 * Branding is pulled from Settings.brandingSettings and applied to every
 * email. Reiwa operators can customize logo, colors, and service name
 * through the admin panel.
 */
@Injectable()
export class EmailTemplateRendererService {
  private readonly logger = new Logger(EmailTemplateRendererService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Render a notification template into a full HTML email.
   */
  public async render(input: {
    templateType: string;
    variables: Record<string, string | number | null>;
    rawHtml?: string;
    /** Subject for the rawHtml path (DB templates derive it from the title). */
    subject?: string;
    /** Recipient's language. Absent = Russian, the previous behaviour. */
    locale?: NotificationLocale;
  }): Promise<{ subject: string; html: string } | null> {
    const branding = await this.loadBranding();

    // If raw HTML provided, just wrap it in the layout
    if (input.rawHtml) {
      return {
        subject:
          input.subject && input.subject.trim().length > 0
            ? input.subject
            : // One language, and it happened to be the other one from every
              // other default in this file. A caller that supplies no subject
              // at least gets it in the recipient's language.
              (input.locale ?? 'ru') === 'en'
              ? 'Notification'
              : 'Уведомление',
        html: this.wrapInLayout(input.rawHtml, branding, input.locale ?? 'ru'),
      };
    }

    // Load template from DB
    const template = await this.prismaService.notificationTemplate.findUnique({
      where: { type: input.templateType },
      // `titleEn`/`bodyEn` belong here or the whole English half of the
      // template table is dead weight: every row in the catalogue carries
      // both languages, and this query asked for one of them.
      select: { title: true, body: true, titleEn: true, bodyEn: true, isActive: true },
    });

    if (!template || !template.isActive) {
      this.logger.debug(`Template "${input.templateType}" not found or inactive`);
      return null;
    }

    // The same resolver the Telegram and feed legs use — per FIELD, so an
    // operator who translated only the body still gets an English body rather
    // than two Russian strings.
    const localized = resolveTemplateLocale(template, input.locale ?? 'ru');
    const subject = this.interpolate(localized.title, input.variables);
    const bodyText = this.interpolate(localized.body, input.variables);
    const bodyHtml = this.textToHtml(bodyText);
    const html = this.wrapInLayout(bodyHtml, branding, input.locale ?? 'ru');

    return { subject, html };
  }

  /**
   * Replace {{variable}} placeholders with values.
   */
  private interpolate(text: string, variables: Record<string, string | number | null>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      const value = variables[key];
      if (value === null || value === undefined) return '';
      return String(value);
    });
  }

  /**
   * Convert plain text to simple HTML (preserve line breaks, escape HTML).
   */
  private textToHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }

  /**
   * Wrap content in the branded HTML email layout.
   *
   * The layout itself lives in `wrapInBrandedEmailLayout` so the broadcast
   * module can send the same shell — it did not go through this service at all,
   * which is why one email out of the whole system arrived unbranded.
   */
  private wrapInLayout(
    content: string,
    branding: EmailBrandingInterface,
    locale: NotificationLocale = 'ru',
  ): string {
    return wrapInBrandedEmailLayout(content, branding, locale);
  }

  /**
   * Load branding for emails.
   *
   * Emails are user-facing and must look like they come from the operator's
   * service (the reiwa-side brand) — NEVER the hidden admin panel ("Rezeis").
   * So we resolve the brand through the canonical `readBrandingSettings`
   * reader (same source the cabinet uses), which defaults to the project brand
   * ("Reiwa") and the project's primary color — not a "Rezeis" placeholder.
   * `websiteUrl` is derived from `REZEIS_DOMAIN`; `supportEmail` from the
   * operator's email support contact / From address.
   */
  private async loadBranding(): Promise<EmailBrandingInterface> {
    const settings = await this.prismaService.settings.findFirst({
      select: { brandingSettings: true, systemNotifications: true },
    });

    const branding = readBrandingSettings(settings?.brandingSettings ?? null);
    const notif = (settings?.systemNotifications ?? {}) as Record<string, unknown>;
    const emailCfg = (notif.email ?? {}) as Record<string, unknown>;

    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

    // Website: the deployment domain (operator's public service URL).
    const domain = str(process.env.REZEIS_DOMAIN);
    const websiteUrl =
      domain !== null && domain !== 'localhost'
        ? `${domain.includes('.') ? 'https' : 'http'}://${domain}`
        : null;

    // Support address: operator-configured contact, else the From address.
    const supportEmail = str(emailCfg.supportEmail) ?? str(emailCfg.fromAddress);

    return {
      serviceName: branding.brandName,
      logoUrl: branding.logoUrl,
      primaryColor: branding.primary,
      supportEmail,
      websiteUrl,
      // ── THE OPERATOR'S THEME, NOT A GENERIC LIGHT CARD ──────────────────
      //
      // Every email carried the brand's name, logo and accent and then framed
      // them in a fixed light-grey shell, so a cabinet themed dark still sent
      // mail that looked like it came from somewhere else. The variant the
      // operator set as their DEFAULT mode is the one a reader should
      // recognise; `themeVariants` is null on a custom/legacy theme, and then
      // the root-level colours are the theme.
      theme: emailThemeFromBranding(branding),
    };
  }
}
