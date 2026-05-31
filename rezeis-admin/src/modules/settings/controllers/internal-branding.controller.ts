import { Controller, Get, UseGuards } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { appConfig } from '../../../common/config/app.config';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
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
}

@Controller('internal/branding')
@UseGuards(InternalAdminAuthGuard)
export class InternalBrandingController {
  public constructor(
    private readonly settingsService: SettingsService,
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
    const locales = this.appConfiguration.locales;
    const defaultLocale = this.appConfiguration.defaultLocale;
    return {
      branding,
      locales,
      defaultLocale,
      customIcons,
      defaultCurrency: policy.defaultCurrency,
    };
  }
}
