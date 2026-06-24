import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { readBrandingSettings } from '../../settings/utils/branding-settings.util';
import type { EmailBrandingInterface } from '../interfaces/email.interface';

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
  }): Promise<{ subject: string; html: string } | null> {
    const branding = await this.loadBranding();

    // If raw HTML provided, just wrap it in the layout
    if (input.rawHtml) {
      return {
        subject: input.subject && input.subject.trim().length > 0 ? input.subject : 'Notification',
        html: this.wrapInLayout(input.rawHtml, branding),
      };
    }

    // Load template from DB
    const template = await this.prismaService.notificationTemplate.findUnique({
      where: { type: input.templateType },
      select: { title: true, body: true, isActive: true },
    });

    if (!template || !template.isActive) {
      this.logger.debug(`Template "${input.templateType}" not found or inactive`);
      return null;
    }

    const subject = this.interpolate(template.title, input.variables);
    const bodyText = this.interpolate(template.body, input.variables);
    const bodyHtml = this.textToHtml(bodyText);
    const html = this.wrapInLayout(bodyHtml, branding);

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
   * Wrap content in a branded HTML email layout.
   */
  private wrapInLayout(content: string, branding: EmailBrandingInterface): string {
    const { serviceName, logoUrl, primaryColor, supportEmail, websiteUrl } = branding;

    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${serviceName}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background-color:${primaryColor};padding:24px 32px;text-align:center;">
              ${logoUrl ? `<img src="${logoUrl}" alt="${serviceName}" style="max-height:40px;margin-bottom:8px;">` : ''}
              <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">${serviceName}</h1>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding:32px;font-size:15px;line-height:1.6;color:#1f2937;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px;background-color:#f9fafb;border-top:1px solid #e5e7eb;text-align:center;font-size:12px;color:#6b7280;">
              <p style="margin:0 0 4px 0;">${serviceName}</p>
              ${websiteUrl ? `<p style="margin:0 0 4px 0;"><a href="${websiteUrl}" style="color:${primaryColor};text-decoration:none;">${websiteUrl}</a></p>` : ''}
              ${supportEmail ? `<p style="margin:0;"><a href="mailto:${supportEmail}" style="color:${primaryColor};text-decoration:none;">${supportEmail}</a></p>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
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
    };
  }
}
