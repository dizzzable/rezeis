import { Controller, Get, UseGuards } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';

import { appConfig } from '../../../common/config/app.config';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { EmailDeliveryService } from '../../email/services/email-delivery.service';
import { BrandingSettingsInterface } from '../interfaces/branding-settings.interface';
import { CustomIconInterface } from '../interfaces/custom-icon.interface';
import { SettingsService } from '../services/settings.service';

/**
 * Public-config payload sent down to reiwa on first SPA render.
 *
 * Includes everything the SPA needs to bootstrap itself before the user is
 * authenticated:
 *   - branding visuals (colours, fonts, effects),
 *   - localisation defaults derived from the operator's `.env`
 *     (`REZEIS_LOCALES` / `REZEIS_DEFAULT_LOCALE`).
 */
export interface InternalPublicConfigInterface {
  readonly branding: BrandingSettingsInterface;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  /** Operator's custom icon library (reusable glyphs the cabinet can render). */
  readonly customIcons: CustomIconInterface[];
  /**
   * Operator-chosen default currency (Settings → "Валюта по умолчанию").
   * Drives display priority on the user edge: gateways that accept this
   * currency are listed first and plan prices in this currency are shown
   * first. It does NOT convert anything — prices still come from what the
   * operator configured per plan.
   */
  readonly defaultCurrency: string;
  /**
   * Platform-branding texts (project name, web page title) used by the SPA
   * to set the document title and brand-aware copy.
   */
  readonly platformBranding: {
    readonly projectName: string | null;
    readonly webTitle: string | null;
  };
  /**
   * Whether platform email delivery is configured + enabled (SMTP on with a
   * host). Drives the cabinet's email affordances: when `false`, reiwa hides
   * "link email" and email password-recovery — there's no way to deliver the
   * code, so offering it would be a dead end.
   */
  readonly emailEnabled: boolean;
}

@Controller('internal/branding')
@UseGuards(InternalAdminAuthGuard)
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalBrandingController {
  public constructor(
    private readonly settingsService: SettingsService,
    private readonly emailDeliveryService: EmailDeliveryService,
    @Inject(appConfig.KEY)
    private readonly appConfiguration: ConfigType<typeof appConfig>,
  ) {}

  /**
   * Returns the typed branding payload alone, for callers that only need
   * visuals (e.g. payment-return page, public landing).
   */
  @Get()
  public async getBranding(): Promise<BrandingSettingsInterface> {
    return this.settingsService.getBrandingSettings();
  }

  /**
   * Returns the full public configuration (branding + locale defaults).
   * Reiwa SPA hits this on the very first request.
   */
  @Get('public-config')
  public async getPublicConfig(): Promise<InternalPublicConfigInterface> {
    const [branding, policy, customIcons] = await Promise.all([
      this.settingsService.getBrandingSettings(),
      this.settingsService.getInternalPlatformPolicy(),
      this.settingsService.getCustomIcons(),
    ]);
    const platformBranding = await this.settingsService.getPlatformBranding();
    const smtp = await this.emailDeliveryService.getSmtpSettings();
    const locales = this.appConfiguration.locales;
    const defaultLocale = this.appConfiguration.defaultLocale;
    return {
      branding,
      locales,
      defaultLocale,
      customIcons,
      defaultCurrency: policy.defaultCurrency,
      platformBranding: {
        projectName: platformBranding.projectName,
        webTitle: platformBranding.webTitle,
      },
      emailEnabled: smtp.enabled === true && typeof smtp.host === 'string' && smtp.host.trim().length > 0,
    };
  }
}
