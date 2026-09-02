import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Put, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation } from '@nestjs/swagger';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { UpdateBrandingSettingsDto } from '../dto/update-branding-settings.dto';
import { UpdateCustomIconsDto } from '../dto/custom-icons.dto';
import { GenerateWebPushKeysDto } from '../dto/generate-web-push-keys.dto';
import { UpdateNotificationsTogglesDto } from '../dto/update-notifications-toggles.dto';
import { UpdatePlatformSettingsDto } from '../dto/update-platform-settings.dto';
import { UpdatePointsSettingsDto } from '../dto/update-points-settings.dto';
import { UpdateReferralSettingsDto } from '../dto/update-referral-settings.dto';
import { UpdateRemnawaveCleanupSettingsDto } from '../dto/update-remnawave-cleanup-settings.dto';
import { UpdateAntiFraudSettingsDto } from '../dto/update-anti-fraud-settings.dto';
import { UpdateQuestPartnerSecretsDto } from '../dto/update-quest-partner-secrets.dto';
import type { QuestPartnerView } from '../utils/quest-partner-settings.util';
import {
  SendPaymentOpsAlertTestDto,
  UpdatePaymentOpsAlertSettingsDto,
} from '../dto/update-payment-ops-alert-settings.dto';
import {
  SendTelegramDeliveryTestDto,
  UpdateTelegramDeliveryDto,
} from '../dto/update-telegram-delivery.dto';
import { BrandingSettingsInterface } from '../interfaces/branding-settings.interface';
import { CustomIconInterface } from '../interfaces/custom-icon.interface';
import { PlatformSettingsInterface } from '../interfaces/platform-settings.interface';
import { IconUploadService, ICON_MAX_FILE_SIZE, IconUploadedInterface } from '../services/icon-upload.service';
import {
  BrandingAssetUploadService,
  BRANDING_ASSET_MAX_FILE_SIZE,
  BrandingAssetUploadedInterface,
} from '../services/branding-asset-upload.service';
import { SettingsService } from '../services/settings.service';
import { PaymentOpsAlertSettingsInterface } from '../../../common/interfaces/payment-ops-alert-settings.interface';

/**
 * Exposes JWT-protected platform settings endpoints for the admin panel.
 */
@Controller('admin/settings')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('settings', 'view')
export class SettingsController {
  public constructor(
    private readonly settingsService: SettingsService,
    private readonly iconUploadService: IconUploadService,
    private readonly brandingAssetUploadService: BrandingAssetUploadService,
  ) {}

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
  @RequirePermission('settings', 'edit')
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

  /**
   * Generate + store a fresh web-push VAPID keypair (private key encrypted).
   * Replaces any existing panel-managed keys; the cabinet re-subscribes on its
   * next load. Returns the public key for display.
   */
  @Post('web-push/generate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('settings', 'edit')
  @ApiOperation({ summary: 'Generate + store web-push VAPID keys' })
  public async generateWebPushKeys(
    @Body() dto: GenerateWebPushKeysDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<{ publicKey: string }> {
    return this.settingsService.generateWebPushKeys({
      contactEmail: dto.contactEmail,
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  /** Clear the panel-managed web-push VAPID keys — this disables push outright. */
  @Post('web-push/clear')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('settings', 'edit')
  @ApiOperation({ summary: 'Clear panel-managed web-push VAPID keys' })
  public async clearWebPushKeys(
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    await this.settingsService.clearWebPushKeys({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
    return { ok: true };
  }

  // ── Remnawave expired-profile cleanup policy ──────────────────────────────

  /** Current Remnawave cleanup policy (delete on/off + grace days). */
  @Get('remnawave-cleanup')
  @ApiOperation({ summary: 'Get Remnawave expired-profile cleanup policy' })
  public async getRemnawaveCleanupSettings() {
    return this.settingsService.getRemnawaveCleanupSettings();
  }

  /** Update the Remnawave cleanup policy. */
  @Patch('remnawave-cleanup')
  @RequirePermission('settings', 'edit')
  @ApiOperation({ summary: 'Update Remnawave expired-profile cleanup policy' })
  public async updateRemnawaveCleanupSettings(
    @Body() dto: UpdateRemnawaveCleanupSettingsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ) {
    return this.settingsService.updateRemnawaveCleanupSettings({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      patch: dto,
    });
  }

  // ── Anti-fraud detector tunables ──────────────────────────────────────────

  /**
   * Effective anti-fraud tunables plus the env/built-in fallback they sit on
   * and the list of fields the panel currently overrides. Inherits the
   * controller-level `settings:view`.
   */
  @Get('anti-fraud')
  @ApiOperation({ summary: 'Get anti-fraud detector tunables (panel value + env fallback)' })
  public async getAntiFraudSettings() {
    return this.settingsService.getAntiFraudSettings();
  }

  /**
   * Update the anti-fraud tunables. `null` on a field clears the panel value
   * and restores the environment fallback. Gated on `settings:edit`, the same
   * permission as every other write on this controller.
   */
  @Patch('anti-fraud')
  @RequirePermission('settings', 'edit')
  @ApiOperation({ summary: 'Update anti-fraud detector tunables' })
  public async updateAntiFraudSettings(
    @Body() dto: UpdateAntiFraudSettingsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ) {
    return this.settingsService.updateAntiFraudSettings({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      patch: dto,
    });
  }

  @Get('system-notifications/payment-ops')
  public async getPaymentOpsAlertSettings(): Promise<PaymentOpsAlertSettingsInterface> {
    return this.settingsService.getPaymentOpsAlertSettings();
  }

  @Patch('system-notifications/payment-ops')
  @RequirePermission('settings', 'edit')
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
  @RequirePermission('settings', 'edit')
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
  @RequirePermission('settings', 'edit')
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
  @RequirePermission('settings', 'edit')
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
      errorTopicId: body.errorTopicId,
      topics: body.topics,
      mirrorUserNotifications: body.mirrorUserNotifications,
      devChatId: body.devChatId,
      errorReportMode: body.errorReportMode,
      errorReportTelegramTxt: body.errorReportTelegramTxt,
      eventsMode: body.eventsMode,
      events: body.events,
    });
  }

  /**
   * Sends a one-off probe message to the configured Telegram chat so the
   * operator can confirm the bot has the right permissions and topic.
   */
  @Post('system-notifications/telegram/test')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('settings', 'edit')
  public async sendTelegramDeliveryTest(
    @Body() body: SendTelegramDeliveryTestDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<{ readonly sent: true }> {
    await this.settingsService.sendTelegramDeliveryTest({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      note: body.note ?? null,
      category: body.category ?? null,
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

  /** The raw `pointsSettings` JSON — the global points-cashback rule. */
  @Get('points')
  public async getPointsSettings(): Promise<Record<string, unknown>> {
    return this.settingsService.getPointsSettings();
  }

  /**
   * Partial-update of `pointsSettings`. `cashback` is merged one level deep,
   * so the page can send the switch without the percent and back. A DTO body
   * for the same reason as the referral one: a metatype of `Object` would
   * skip the validation pipe entirely.
   */
  @Patch('points')
  @RequirePermission('settings', 'edit')
  public async updatePointsSettings(
    @Body() body: UpdatePointsSettingsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.settingsService.updatePointsSettings({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      patch: toPlainPatch(body),
    });
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
   *
   * The body is a DTO and not a `Record<string, unknown>` for a reason that is
   * easy to miss: a body metatype of `Object` makes the global `ValidationPipe`
   * SKIP THE HANDLER ENTIRELY. Not one decorator ran here, and
   * `forbidNonWhitelisted` never saw the body, so any field of any type — a
   * negative slot count, a key nobody reads — was written verbatim into the
   * JSON column. See `update-referral-settings.dto.ts` for how the accepted
   * field list was derived and why omitted / `null` / `0` have to stay three
   * different requests.
   */
  @Patch('referral')
  @RequirePermission('settings', 'edit')
  public async updateReferralSettings(
    @Body() body: UpdateReferralSettingsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.settingsService.updateReferralSettings({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      // Spread, not the instance: `mergeReferralSettings` iterates
      // `Object.entries`, so what it sees is the DTO's own enumerable keys —
      // which is precisely the omitted/`null` distinction the pipe preserved.
      // An omitted field has no own property and is therefore invisible to the
      // merge; an explicit `null` has one and is written.
      patch: toPlainPatch(body),
    });
  }

  /**
   * Read the current `partnerSettings` JSON. Used by the partner program
   * settings tab on the frontend.
   */
  @Get('partner')
  public async getPartnerSettings(): Promise<Record<string, unknown>> {
    return this.settingsService.getPartnerSettings();
  }

  /**
   * Partial-update of `partnerSettings`. Mirrors `referral` semantics —
   * top-level keys are replaced; `levels`, `gatewayCommissions`, and
   * `withdrawals` are merged one level deeper.
   */
  @Patch('partner')
  @RequirePermission('settings', 'edit')
  public async updatePartnerSettings(
    @Body() body: Record<string, unknown>,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.settingsService.updatePartnerSettings({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      patch: body,
    });
  }

  /**
   * Quest PARTNER_TASK per-partner HMAC secrets. GET returns a presence-only
   * view (slug + label + configured) — the secret itself is never echoed. PATCH
   * upserts/clears secrets (empty secret clears); secrets are stored
   * AES-256-GCM-encrypted. `settings:edit` gates mutations (superadmin only).
   */
  @Get('quest-partner-secrets')
  public async getQuestPartnerSecrets(): Promise<readonly QuestPartnerView[]> {
    return this.settingsService.getQuestPartnerSecretsView();
  }

  @Patch('quest-partner-secrets')
  @RequirePermission('settings', 'edit')
  public async updateQuestPartnerSecrets(
    @Body() body: UpdateQuestPartnerSecretsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<readonly QuestPartnerView[]> {
    return this.settingsService.updateQuestPartnerSecrets({
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
  @RequirePermission('settings', 'edit')
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

  // ── Custom icon library ────────────────────────────────────────────────

  /**
   * Returns the operator's custom icon library.
   */
  @Get('icons')
  public async getCustomIcons(): Promise<CustomIconInterface[]> {
    return this.settingsService.getCustomIcons();
  }

  /**
   * Replaces the whole custom-icon library (add / rename / recolour / delete).
   */
  @Put('icons')
  @RequirePermission('settings', 'edit')
  public async updateCustomIcons(
    @Body() body: UpdateCustomIconsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<CustomIconInterface[]> {
    return this.settingsService.updateCustomIcons({
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
      icons: body.icons,
    });
  }

  /**
   * Uploads a single icon file (svg/png/webp) and returns its public URL.
   * The SPA then adds an entry to the library and saves via `PUT /icons`.
   */
  @Post('icons/upload')
  @RequirePermission('settings', 'edit')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: ICON_MAX_FILE_SIZE },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a custom icon and return its public URL' })
  public async uploadCustomIcon(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<IconUploadedInterface> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.iconUploadService.persist({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });
  }

  /**
   * Uploads a branding asset (header logo or square PWA icon) and returns its
   * public `/uploads/branding/<file>` URL. The SPA then PATCHes
   * `/admin/settings/branding` with `logoUrl` / `pwaIconUrl` set to it.
   */
  @Post('branding/logo-upload')
  @RequirePermission('settings', 'edit')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: BRANDING_ASSET_MAX_FILE_SIZE },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a branding asset (logo / PWA icon) and return its public URL' })
  public async uploadBrandingAsset(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<BrandingAssetUploadedInterface> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.brandingAssetUploadService.persist({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });
  }
}

/**
 * A validated DTO tree rendered as the plain JSON it describes.
 *
 * `SettingsService.updateReferralSettings` merges the two sections it knows
 * about one level deep and stores every other value wholesale, so a nested DTO
 * INSTANCE — `pointsExchange.subscriptionDays` is two levels down — would reach
 * the `referralSettings` JSON column as a class. It serialises to the same
 * bytes, which is exactly why nobody would notice, and why the column would
 * then hold a shape none of its readers ever produce.
 *
 * The round trip cannot lose the omitted/`null` distinction the pipe preserved:
 * an omitted field has NO OWN PROPERTY on the instance (these classes declare
 * no initialisers), so there is nothing for `JSON.stringify` to drop, and an
 * explicit `null` is an own property with a JSON value.
 */
function toPlainPatch(body: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}
