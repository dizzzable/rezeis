import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { UpdateBrandingSettingsDto } from '../dto/update-branding-settings.dto';
import { UpdateNotificationsTogglesDto } from '../dto/update-notifications-toggles.dto';
import { UpdatePlatformSettingsDto } from '../dto/update-platform-settings.dto';
import {
  SendPaymentOpsAlertTestDto,
  UpdatePaymentOpsAlertSettingsDto,
} from '../dto/update-payment-ops-alert-settings.dto';
import {
  SendTelegramDeliveryTestDto,
  UpdateTelegramDeliveryDto,
} from '../dto/update-telegram-delivery.dto';
import { BrandingSettingsInterface } from '../interfaces/branding-settings.interface';
import { PlatformSettingsInterface } from '../interfaces/platform-settings.interface';
import { SettingsService } from '../services/settings.service';
import { PaymentOpsAlertSettingsInterface } from '../../../common/interfaces/payment-ops-alert-settings.interface';

/**
 * Exposes JWT-protected platform settings endpoints for the admin panel.
 */
@Controller('admin/settings')
@UseGuards(AdminJwtAuthGuard)
export class SettingsController {
  public constructor(private readonly settingsService: SettingsService) {}

  /**
   * Returns the singleton platform settings payload merged with the
   * notification toggles, branding payload and Telegram delivery config.
   * Used by the React notifications page which hydrates every panel from
   * a single request.
   */
  @Get()
  public async getOverview() {
    return this.settingsService.getOverview();
  }

  /**
   * Returns the singleton platform settings payload.
   */
  @Get('platform')
  public async getPlatformSettings(): Promise<PlatformSettingsInterface> {
    return this.settingsService.getPlatformSettings();
  }

  /**
   * Updates the singleton platform settings payload.
   */
  @Patch('platform')
  public async updatePlatformSettings(
    @Body() updatePlatformSettingsDto: UpdatePlatformSettingsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<PlatformSettingsInterface> {
    return this.settingsService.updatePlatformSettings({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      updatePlatformSettingsDto,
    });
  }

  @Get('system-notifications/payment-ops')
  public async getPaymentOpsAlertSettings(): Promise<PaymentOpsAlertSettingsInterface> {
    return this.settingsService.getPaymentOpsAlertSettings();
  }

  @Patch('system-notifications/payment-ops')
  public async updatePaymentOpsAlertSettings(
    @Body() updatePaymentOpsAlertSettingsDto: UpdatePaymentOpsAlertSettingsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<PaymentOpsAlertSettingsInterface> {
    return this.settingsService.updatePaymentOpsAlertSettings({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      updatePaymentOpsAlertSettingsDto,
    });
  }

  @Post('system-notifications/payment-ops/test')
  public async sendPaymentOpsAlertTest(
    @Body() sendPaymentOpsAlertTestDto: SendPaymentOpsAlertTestDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<{ readonly sent: true }> {
    await this.settingsService.sendPaymentOpsAlertTest({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      sendPaymentOpsAlertTestDto,
    });
    return { sent: true };
  }

  // ── Notification toggles + Telegram delivery ──────────────────────────────

  /**
   * Merges the user/system notification toggle maps. Either branch can be
   * partially supplied — keys not present in the patch retain their value.
   */
  @Patch('notifications')
  public async updateNotificationToggles(
    @Body() body: UpdateNotificationsTogglesDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ) {
    return this.settingsService.updateNotificationToggles({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      userNotifications: body.userNotifications as Record<string, unknown> | undefined,
      systemNotifications: body.systemNotifications as Record<string, unknown> | undefined,
    });
  }

  /**
   * Updates the Telegram delivery configuration (chat id, default topic,
   * per-category routing). Setting `enabled = true` requires a chat id.
   */
  @Patch('system-notifications/telegram')
  public async updateTelegramDelivery(
    @Body() body: UpdateTelegramDeliveryDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ) {
    return this.settingsService.updateTelegramDelivery({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      enabled: body.enabled,
      chatId: body.chatId,
      topicId: body.topicId,
      topics: body.topics,
    });
  }

  /**
   * Sends a one-off probe message to the configured Telegram chat so the
   * operator can confirm the bot has the right permissions and topic.
   */
  @Post('system-notifications/telegram/test')
  @HttpCode(HttpStatus.OK)
  public async sendTelegramDeliveryTest(
    @Body() body: SendTelegramDeliveryTestDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<{ readonly sent: true }> {
    await this.settingsService.sendTelegramDeliveryTest({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      note: body.note ?? null,
    });
    return { sent: true };
  }

  /**
   * Returns the current branding settings (colours, gradients, effects, fonts)
   * for the admin configurator UI.
   */
  @Get('branding')
  public async getBrandingSettings(): Promise<BrandingSettingsInterface> {
    return this.settingsService.getBrandingSettings();
  }

  /**
   * Returns the raw `referralSettings` JSON. The admin SPA reads this via
   * `GET /admin/settings` (overview) but a focused endpoint avoids the
   * full overview round-trip when the user only opened the Referrals tab.
   */
  @Get('referral')
  public async getReferralSettings(): Promise<Record<string, unknown>> {
    return this.settingsService.getReferralSettings();
  }

  /**
   * Partial-update of `referralSettings`. Top-level keys are replaced;
   * `pointsExchange` and `inviteLimits` are merged one level deeper so a
   * subsection patch does not blow away unrelated knobs.
   */
  @Patch('referral')
  public async updateReferralSettings(
    @Body() body: Record<string, unknown>,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.settingsService.updateReferralSettings({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      patch: body,
    });
  }

  /**
   * Applies a partial branding update. Only the supplied fields are touched;
   * the rest stay at their previous values.
   */
  @Patch('branding')
  public async updateBrandingSettings(
    @Body() updateBrandingSettingsDto: UpdateBrandingSettingsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<BrandingSettingsInterface> {
    return this.settingsService.updateBrandingSettings({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      updateBrandingSettingsDto,
    });
  }
}
