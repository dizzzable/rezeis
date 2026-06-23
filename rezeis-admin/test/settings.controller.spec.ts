import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AccessMode, Currency, UserRole } from '@prisma/client';
import { Request } from 'express';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { PaymentOpsAlertSettingsInterface } from '../src/common/interfaces/payment-ops-alert-settings.interface';
import { UpdateBrandingSettingsDto } from '../src/modules/settings/dto/update-branding-settings.dto';
import { UpdateCustomIconsDto } from '../src/modules/settings/dto/custom-icons.dto';
import { UpdateNotificationsTogglesDto } from '../src/modules/settings/dto/update-notifications-toggles.dto';
import { SendPaymentOpsAlertTestDto, UpdatePaymentOpsAlertSettingsDto } from '../src/modules/settings/dto/update-payment-ops-alert-settings.dto';
import { UpdatePlatformSettingsDto } from '../src/modules/settings/dto/update-platform-settings.dto';
import { SendTelegramDeliveryTestDto, UpdateTelegramDeliveryDto } from '../src/modules/settings/dto/update-telegram-delivery.dto';
import { BrandingSettingsInterface } from '../src/modules/settings/interfaces/branding-settings.interface';
import { CustomIconInterface } from '../src/modules/settings/interfaces/custom-icon.interface';
import { PlatformSettingsInterface } from '../src/modules/settings/interfaces/platform-settings.interface';
import { IconUploadService, IconUploadedInterface } from '../src/modules/settings/services/icon-upload.service';
import { BrandingAssetUploadService } from '../src/modules/settings/services/branding-asset-upload.service';
import { SettingsService, TelegramDeliveryConfig } from '../src/modules/settings/services/settings.service';
import { SettingsController } from '../src/modules/settings/controllers/settings.controller';

interface DelegatedCall<TBody> {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: {
    readonly requestId: string | null;
    readonly remoteAddress: string | null;
    readonly userAgent: string | null;
  };
  readonly body?: TBody;
  readonly updatePlatformSettingsDto?: UpdatePlatformSettingsDto;
  readonly updatePaymentOpsAlertSettingsDto?: UpdatePaymentOpsAlertSettingsDto;
  readonly sendPaymentOpsAlertTestDto?: SendPaymentOpsAlertTestDto;
  readonly updateBrandingSettingsDto?: UpdateBrandingSettingsDto;
  readonly icons?: UpdateCustomIconsDto['icons'];
  readonly patch?: Record<string, unknown>;
  readonly enabled?: boolean;
  readonly chatId?: string | null;
  readonly topicId?: number | null;
  readonly errorTopicId?: number | null;
  readonly topics?: Record<string, number | null>;
  readonly mirrorUserNotifications?: boolean;
  readonly note?: string | null;
  readonly category?: string | null;
}

function buildCurrentAdmin(): CurrentAdminInterface {
  return {
    id: 'admin-1',
    login: 'admin',
    email: 'admin@example.com',
    name: 'Admin',
    role: UserRole.ADMIN,
    isActive: true,
    tokenVersion: 3,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    lastLoginAt: new Date('2026-04-15T12:00:00.000Z'),
    lastLoginIp: '203.0.113.10',
    rbacRoleId: null,
    mustChangePassword: false,
  };
}

function buildRequest(requestId: string): Request {
  return {
    headers: {
      'x-request-id': requestId,
      'x-forwarded-for': '198.51.100.50, 203.0.113.10',
      'user-agent': 'settings-controller-spec',
    },
    ip: '127.0.0.1',
    socket: {
      remoteAddress: '127.0.0.2',
    },
  } as unknown as Request;
}

function buildPlatformSettings(): PlatformSettingsInterface {
  return {
    rulesRequired: true,
    rulesLink: 'https://example.com/rules',
    channelRequired: true,
    channelId: '-1001234567890',
    channelLink: 'https://t.me/example',
    accessMode: AccessMode.INVITED,
    inviteModeStartedAt: '2026-04-01T00:00:00.000Z',
    defaultCurrency: Currency.USD,
    updatedAt: '2026-04-16T10:00:00.000Z',
  };
}

function buildPaymentOpsAlertSettings(): PaymentOpsAlertSettingsInterface {
  return {
    enabled: true,
    chatId: '-1001234567890',
    threadId: '42',
    hashtag: '#payments_ops',
  };
}

function buildTelegramConfig(): TelegramDeliveryConfig {
  return {
    enabled: true,
    chatId: '-1001234567890',
    topicId: 42,
    errorTopicId: null,
    topics: { PAYMENT: 7 },
    mirrorUserNotifications: true,
    devChatId: null,
    errorReports: { mode: 'manual', telegramTxt: true },
    eventsMode: 'all',
    events: [],
  };
}

function createController(
  settingsService: object,
  iconUploadService: object = {},
  brandingAssetUploadService: object = {},
): SettingsController {
  return new SettingsController(
    settingsService as unknown as SettingsService,
    iconUploadService as unknown as IconUploadService,
    brandingAssetUploadService as unknown as BrandingAssetUploadService,
  );
}

function getRoute(methodName: keyof SettingsController): { path: string; method: RequestMethod } {
  const method = SettingsController.prototype[methodName] as object;
  return {
    path: Reflect.getMetadata(PATH_METADATA, method) as string,
    method: Reflect.getMetadata(METHOD_METADATA, method) as RequestMethod,
  };
}

describe('SettingsController', () => {
  it('exposes the current admin settings route contract', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, SettingsController), 'admin/settings');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, SettingsController), [AdminJwtAuthGuard]);
    assert.deepStrictEqual(
      [
        ['getOverview', '/', RequestMethod.GET],
        ['getPlatformSettings', 'platform', RequestMethod.GET],
        ['updatePlatformSettings', 'platform', RequestMethod.PATCH],
        ['getPaymentOpsAlertSettings', 'system-notifications/payment-ops', RequestMethod.GET],
        ['updatePaymentOpsAlertSettings', 'system-notifications/payment-ops', RequestMethod.PATCH],
        ['sendPaymentOpsAlertTest', 'system-notifications/payment-ops/test', RequestMethod.POST],
        ['updateNotificationToggles', 'notifications', RequestMethod.PATCH],
        ['updateTelegramDelivery', 'system-notifications/telegram', RequestMethod.PATCH],
        ['sendTelegramDeliveryTest', 'system-notifications/telegram/test', RequestMethod.POST],
        ['getBrandingSettings', 'branding', RequestMethod.GET],
        ['updateBrandingSettings', 'branding', RequestMethod.PATCH],
        ['getReferralSettings', 'referral', RequestMethod.GET],
        ['updateReferralSettings', 'referral', RequestMethod.PATCH],
        ['getPartnerSettings', 'partner', RequestMethod.GET],
        ['updatePartnerSettings', 'partner', RequestMethod.PATCH],
        ['getCustomIcons', 'icons', RequestMethod.GET],
        ['updateCustomIcons', 'icons', RequestMethod.PUT],
        ['uploadCustomIcon', 'icons/upload', RequestMethod.POST],
      ].map(([methodName, expectedPath, expectedMethod]) => ({
        methodName,
        expectedPath,
        expectedMethod,
        actual: getRoute(methodName as keyof SettingsController),
      })),
      [
        { methodName: 'getOverview', expectedPath: '/', expectedMethod: RequestMethod.GET, actual: { path: '/', method: RequestMethod.GET } },
        { methodName: 'getPlatformSettings', expectedPath: 'platform', expectedMethod: RequestMethod.GET, actual: { path: 'platform', method: RequestMethod.GET } },
        { methodName: 'updatePlatformSettings', expectedPath: 'platform', expectedMethod: RequestMethod.PATCH, actual: { path: 'platform', method: RequestMethod.PATCH } },
        { methodName: 'getPaymentOpsAlertSettings', expectedPath: 'system-notifications/payment-ops', expectedMethod: RequestMethod.GET, actual: { path: 'system-notifications/payment-ops', method: RequestMethod.GET } },
        { methodName: 'updatePaymentOpsAlertSettings', expectedPath: 'system-notifications/payment-ops', expectedMethod: RequestMethod.PATCH, actual: { path: 'system-notifications/payment-ops', method: RequestMethod.PATCH } },
        { methodName: 'sendPaymentOpsAlertTest', expectedPath: 'system-notifications/payment-ops/test', expectedMethod: RequestMethod.POST, actual: { path: 'system-notifications/payment-ops/test', method: RequestMethod.POST } },
        { methodName: 'updateNotificationToggles', expectedPath: 'notifications', expectedMethod: RequestMethod.PATCH, actual: { path: 'notifications', method: RequestMethod.PATCH } },
        { methodName: 'updateTelegramDelivery', expectedPath: 'system-notifications/telegram', expectedMethod: RequestMethod.PATCH, actual: { path: 'system-notifications/telegram', method: RequestMethod.PATCH } },
        { methodName: 'sendTelegramDeliveryTest', expectedPath: 'system-notifications/telegram/test', expectedMethod: RequestMethod.POST, actual: { path: 'system-notifications/telegram/test', method: RequestMethod.POST } },
        { methodName: 'getBrandingSettings', expectedPath: 'branding', expectedMethod: RequestMethod.GET, actual: { path: 'branding', method: RequestMethod.GET } },
        { methodName: 'updateBrandingSettings', expectedPath: 'branding', expectedMethod: RequestMethod.PATCH, actual: { path: 'branding', method: RequestMethod.PATCH } },
        { methodName: 'getReferralSettings', expectedPath: 'referral', expectedMethod: RequestMethod.GET, actual: { path: 'referral', method: RequestMethod.GET } },
        { methodName: 'updateReferralSettings', expectedPath: 'referral', expectedMethod: RequestMethod.PATCH, actual: { path: 'referral', method: RequestMethod.PATCH } },
        { methodName: 'getPartnerSettings', expectedPath: 'partner', expectedMethod: RequestMethod.GET, actual: { path: 'partner', method: RequestMethod.GET } },
        { methodName: 'updatePartnerSettings', expectedPath: 'partner', expectedMethod: RequestMethod.PATCH, actual: { path: 'partner', method: RequestMethod.PATCH } },
        { methodName: 'getCustomIcons', expectedPath: 'icons', expectedMethod: RequestMethod.GET, actual: { path: 'icons', method: RequestMethod.GET } },
        { methodName: 'updateCustomIcons', expectedPath: 'icons', expectedMethod: RequestMethod.PUT, actual: { path: 'icons', method: RequestMethod.PUT } },
        { methodName: 'uploadCustomIcon', expectedPath: 'icons/upload', expectedMethod: RequestMethod.POST, actual: { path: 'icons/upload', method: RequestMethod.POST } },
      ],
    );
  });

  it('forwards platform and payment-ops updates with extracted request metadata', async () => {
    const calls: Array<DelegatedCall<unknown>> = [];
    const controller = createController({
      updatePlatformSettings: async (input: DelegatedCall<UpdatePlatformSettingsDto>): Promise<PlatformSettingsInterface> => {
        calls.push(input);
        return buildPlatformSettings();
      },
      updatePaymentOpsAlertSettings: async (input: DelegatedCall<UpdatePaymentOpsAlertSettingsDto>): Promise<PaymentOpsAlertSettingsInterface> => {
        calls.push(input);
        return buildPaymentOpsAlertSettings();
      },
      sendPaymentOpsAlertTest: async (input: DelegatedCall<SendPaymentOpsAlertTestDto>): Promise<void> => {
        calls.push(input);
      },
    });
    const currentAdmin = buildCurrentAdmin();
    const platformDto: UpdatePlatformSettingsDto = {
      accessMode: AccessMode.PUBLIC,
      channelId: '-1009876543210',
      rulesRequired: false,
    };
    const paymentDto: UpdatePaymentOpsAlertSettingsDto = {
      enabled: true,
      chatId: '-1009876543210',
      threadId: '84',
    };
    const testDto: SendPaymentOpsAlertTestDto = { note: 'Confirm routing' };

    assert.deepStrictEqual(await controller.updatePlatformSettings(platformDto, currentAdmin, buildRequest('request-1')), buildPlatformSettings());
    assert.deepStrictEqual(await controller.updatePaymentOpsAlertSettings(paymentDto, currentAdmin, buildRequest('request-2')), buildPaymentOpsAlertSettings());
    assert.deepStrictEqual(await controller.sendPaymentOpsAlertTest(testDto, currentAdmin, buildRequest('request-3')), { sent: true });
    assert.deepStrictEqual(calls, [
      {
        currentAdmin,
        requestMetadata: { requestId: 'request-1', remoteAddress: '198.51.100.50', userAgent: 'settings-controller-spec' },
        updatePlatformSettingsDto: platformDto,
      },
      {
        currentAdmin,
        requestMetadata: { requestId: 'request-2', remoteAddress: '198.51.100.50', userAgent: 'settings-controller-spec' },
        updatePaymentOpsAlertSettingsDto: paymentDto,
      },
      {
        currentAdmin,
        requestMetadata: { requestId: 'request-3', remoteAddress: '198.51.100.50', userAgent: 'settings-controller-spec' },
        sendPaymentOpsAlertTestDto: testDto,
      },
    ]);
  });

  it('forwards current notification, Telegram, referral, partner, branding, and icon settings contracts', async () => {
    const calls: Array<DelegatedCall<unknown>> = [];
    const branding: BrandingSettingsInterface = {
      brandName: 'Rezeis',
      tagline: null,
      logoUrl: null,
      pwaIconUrl: null,
      primary: '#ffffff',
      primaryFg: '#000000',
      bgPrimary: '#111111',
      bgSecondary: '#222222',
      cardGradient: 'linear-gradient(#000,#111)',
      cardPattern: null,
      cardLogo: 'NONE',
      cardLogoUrl: null,
      cardEffect: 'NONE',
      cardEffectProps: {},
      cardEffectOpacity: 0.25,
      cardEffectsByIndex: [],
      bgEffect: 'NONE',
      appBackground: {
        kind: 'none',
        effect: 'NONE',
        props: {},
        opacity: 1,
        gradient: 'linear-gradient(135deg, #0a0a0a 0%, #171717 100%)',
        texture: { pattern: 'dots', color: '#22c55e', background: '#0a0a0a', scale: 24, opacity: 0.15 },
      },
      iconColorMode: 'default',
      iconColors: {},
      borderRadius: '1rem',
      fontFamily: 'Inter',
      profileNaming: { prefix: 'rz', separator: '_', suffixBase: 'sub' },
    };
    const icons: CustomIconInterface[] = [{ id: 'icon-1', name: 'Rocket', url: '/uploads/icons/rocket.svg', color: '#ffffff' }];
    const controller = createController({
      updateNotificationToggles: async (input: DelegatedCall<UpdateNotificationsTogglesDto>) => {
        calls.push(input);
        return { userNotifications: { renew: true }, systemNotifications: { incidents: false } };
      },
      updateTelegramDelivery: async (input: DelegatedCall<UpdateTelegramDeliveryDto>): Promise<TelegramDeliveryConfig> => {
        calls.push(input);
        return buildTelegramConfig();
      },
      sendTelegramDeliveryTest: async (input: DelegatedCall<SendTelegramDeliveryTestDto>): Promise<void> => {
        calls.push(input);
      },
      updateReferralSettings: async (input: DelegatedCall<Record<string, unknown>>): Promise<Record<string, unknown>> => {
        calls.push(input);
        return { pointsExchange: { enabled: true } };
      },
      updatePartnerSettings: async (input: DelegatedCall<Record<string, unknown>>): Promise<Record<string, unknown>> => {
        calls.push(input);
        return { withdrawals: { enabled: true } };
      },
      updateBrandingSettings: async (input: DelegatedCall<UpdateBrandingSettingsDto>): Promise<BrandingSettingsInterface> => {
        calls.push(input);
        return branding;
      },
      updateCustomIcons: async (input: DelegatedCall<UpdateCustomIconsDto>): Promise<CustomIconInterface[]> => {
        calls.push(input);
        return icons;
      },
    });
    const currentAdmin = buildCurrentAdmin();
    const notificationsDto: UpdateNotificationsTogglesDto = { userNotifications: { renew: true } };
    const telegramDto: UpdateTelegramDeliveryDto = { enabled: true, chatId: '-100123', topics: { payment: 7 }, mirrorUserNotifications: true };
    const telegramTestDto: SendTelegramDeliveryTestDto = { note: 'probe' };
    const referralPatch = { pointsExchange: { enabled: true } };
    const partnerPatch = { withdrawals: { enabled: true } };
    const brandingDto: UpdateBrandingSettingsDto = { brandName: 'Rezeis' };
    const iconsDto: UpdateCustomIconsDto = { icons };

    assert.deepStrictEqual(await controller.updateNotificationToggles(notificationsDto, currentAdmin, buildRequest('request-4')), { userNotifications: { renew: true }, systemNotifications: { incidents: false } });
    assert.deepStrictEqual(await controller.updateTelegramDelivery(telegramDto, currentAdmin, buildRequest('request-5')), buildTelegramConfig());
    assert.deepStrictEqual(await controller.sendTelegramDeliveryTest(telegramTestDto, currentAdmin, buildRequest('request-6')), { sent: true });
    assert.deepStrictEqual(await controller.updateReferralSettings(referralPatch, currentAdmin, buildRequest('request-7')), referralPatch);
    assert.deepStrictEqual(await controller.updatePartnerSettings(partnerPatch, currentAdmin, buildRequest('request-8')), partnerPatch);
    assert.deepStrictEqual(await controller.updateBrandingSettings(brandingDto, currentAdmin, buildRequest('request-9')), branding);
    assert.deepStrictEqual(await controller.updateCustomIcons(iconsDto, currentAdmin, buildRequest('request-10')), icons);
    assert.deepStrictEqual(calls.map((call) => call.requestMetadata.requestId), ['request-4', 'request-5', 'request-6', 'request-7', 'request-8', 'request-9', 'request-10']);
    assert.deepStrictEqual(calls[0], {
      currentAdmin,
      requestMetadata: { requestId: 'request-4', remoteAddress: '198.51.100.50', userAgent: 'settings-controller-spec' },
      userNotifications: notificationsDto.userNotifications,
      systemNotifications: notificationsDto.systemNotifications,
    });
    assert.deepStrictEqual(calls[1], {
      currentAdmin,
      requestMetadata: { requestId: 'request-5', remoteAddress: '198.51.100.50', userAgent: 'settings-controller-spec' },
      enabled: telegramDto.enabled,
      chatId: telegramDto.chatId,
      topicId: telegramDto.topicId,
      errorTopicId: telegramDto.errorTopicId,
      topics: telegramDto.topics,
      mirrorUserNotifications: telegramDto.mirrorUserNotifications,
      devChatId: telegramDto.devChatId,
      errorReportMode: telegramDto.errorReportMode,
      errorReportTelegramTxt: telegramDto.errorReportTelegramTxt,
      eventsMode: telegramDto.eventsMode,
      events: telegramDto.events,
    });
    assert.deepStrictEqual(calls[2], {
      currentAdmin,
      requestMetadata: { requestId: 'request-6', remoteAddress: '198.51.100.50', userAgent: 'settings-controller-spec' },
      note: telegramTestDto.note,
      category: telegramTestDto.category ?? null,
    });
    assert.deepStrictEqual(calls[3]?.patch, referralPatch);
    assert.deepStrictEqual(calls[4]?.patch, partnerPatch);
    assert.deepStrictEqual(calls[5]?.updateBrandingSettingsDto, brandingDto);
    assert.deepStrictEqual(calls[6]?.icons, icons);
  });

  it('delegates custom icon uploads and rejects missing files', async () => {
    const uploaded: IconUploadedInterface = {
      url: '/uploads/icons/icon.svg',
      originalName: 'icon.svg',
      mimeType: 'image/svg+xml',
      size: 64,
    };
    let persistedInput: { readonly buffer: Buffer; readonly originalName: string; readonly mimeType: string } | undefined;
    const controller = createController({}, {
      persist: async (input: { readonly buffer: Buffer; readonly originalName: string; readonly mimeType: string }): Promise<IconUploadedInterface> => {
        persistedInput = input;
        return uploaded;
      },
    });
    const file = {
      buffer: Buffer.from('<svg />'),
      originalname: 'icon.svg',
      mimetype: 'image/svg+xml',
    } as Express.Multer.File;

    await assert.rejects(controller.uploadCustomIcon(undefined), BadRequestException);
    assert.deepStrictEqual(await controller.uploadCustomIcon(file), uploaded);
    assert.deepStrictEqual(persistedInput, {
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });
  });

  it('delegates branding asset uploads and rejects missing files', async () => {
    const uploaded = {
      url: '/uploads/branding/abc.png',
      originalName: 'logo.png',
      mimeType: 'image/png',
      size: 128,
    };
    let persistedInput: { readonly buffer: Buffer; readonly originalName: string; readonly mimeType: string } | undefined;
    const controller = createController({}, {}, {
      persist: async (input: { readonly buffer: Buffer; readonly originalName: string; readonly mimeType: string }) => {
        persistedInput = input;
        return uploaded;
      },
    });
    const file = {
      buffer: Buffer.from('PNG'),
      originalname: 'logo.png',
      mimetype: 'image/png',
    } as Express.Multer.File;

    await assert.rejects(controller.uploadBrandingAsset(undefined), BadRequestException);
    assert.deepStrictEqual(await controller.uploadBrandingAsset(file), uploaded);
    assert.deepStrictEqual(persistedInput, {
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });
  });
});
