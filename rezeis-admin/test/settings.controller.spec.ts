import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AccessMode, Currency, UserRole } from '@prisma/client';
import { Request } from 'express';

import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../src/modules/auth/interfaces/request-metadata.interface';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { CreateAdminApiTokenDto } from '../src/modules/settings/dto/create-admin-api-token.dto';
import {
  SendPaymentOpsAlertTestDto,
  UpdatePaymentOpsAlertSettingsDto,
} from '../src/modules/settings/dto/update-payment-ops-alert-settings.dto';
import { UpdatePlatformSettingsDto } from '../src/modules/settings/dto/update-platform-settings.dto';
import { UpdateReferralExchangePolicyDto } from '../src/modules/referrals/dto/update-referral-exchange-policy.dto';
import { UpdatePartnerWithdrawalPolicyDto } from '../src/modules/settings/dto/update-partner-withdrawal-policy.dto';
import {
  AdminApiTokenInterface,
  CreatedAdminApiTokenInterface,
} from '../src/modules/settings/interfaces/admin-api-token.interface';
import { PaymentOpsAlertSettingsInterface } from '../src/common/interfaces/payment-ops-alert-settings.interface';
import { PlatformSettingsInterface } from '../src/modules/settings/interfaces/platform-settings.interface';
import { ReferralExchangePolicyInterface } from '../src/modules/referrals/interfaces/referral-summary.interface';
import { PartnerWithdrawalPolicyInterface } from '../src/modules/settings/interfaces/partner-withdrawal-policy.interface';
import { SettingsController } from '../src/modules/settings/controllers/settings.controller';
import { SettingsService } from '../src/modules/settings/services/settings.service';

interface UpdatePlatformSettingsCall {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly updatePlatformSettingsDto: UpdatePlatformSettingsDto;
}

interface CreateAdminApiTokenCall {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly createAdminApiTokenDto: CreateAdminApiTokenDto;
}

interface UpdatePaymentOpsAlertSettingsCall {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly updatePaymentOpsAlertSettingsDto: UpdatePaymentOpsAlertSettingsDto;
}

interface SendPaymentOpsAlertTestCall {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly sendPaymentOpsAlertTestDto: SendPaymentOpsAlertTestDto;
}

interface UpdateReferralExchangePolicyCall {
  readonly adminUserId: string;
  readonly dto: UpdateReferralExchangePolicyDto;
}

interface UpdatePartnerWithdrawalPolicyCall {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly updatePartnerWithdrawalPolicyDto: UpdatePartnerWithdrawalPolicyDto;
}

interface RevokeAdminApiTokenCall {
  readonly tokenId: string;
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
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
  };
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
    branding: {
      projectName: null,
      webTitle: null,
      supportUrl: null,
      supportUsername: null,
      accessRequestIntro: null,
      accessApprovedMessage: null,
      accessRejectedMessage: null,
    },
    updatedAt: '2026-04-16T10:00:00.000Z',
  };
}

function buildAdminApiToken(): AdminApiTokenInterface {
  return {
    id: 'token-1',
    name: 'Internal automation',
    description: 'Used by CI jobs',
    tokenPrefix: 'rzadm_ab12cd34ef56',
    lastUsedAt: null,
    revokedAt: null,
    createdAt: '2026-04-16T10:00:00.000Z',
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

function buildReferralExchangePolicy(): ReferralExchangePolicyInterface {
  return {
    exchangeEnabled: true,
    giftPromocodeEnabled: true,
    allowedPlanIds: ['plan-basic'],
    allowedDurationDays: [30, 90],
    codePrefix: 'REF',
    costPerDay: 10,
  };
}

function buildPartnerWithdrawalPolicy(): PartnerWithdrawalPolicyInterface {
  return {
    enabled: true,
    minimumAmount: 1000,
    supportedMethods: ['card', 'sbp'],
    updatedAt: '2026-04-16T10:00:00.000Z',
  };
}

describe('SettingsController', () => {
  it('exposes the shipped admin settings route contract', () => {
    const actualControllerPath = Reflect.getMetadata(PATH_METADATA, SettingsController) as string | undefined;
    const actualGetPlatformPath = Reflect.getMetadata(
      PATH_METADATA,
      SettingsController.prototype.getPlatformSettings,
    ) as string | undefined;
    const actualGetPlatformMethod = Reflect.getMetadata(
      METHOD_METADATA,
      SettingsController.prototype.getPlatformSettings,
    ) as RequestMethod | undefined;
    const actualUpdatePlatformPath = Reflect.getMetadata(
      PATH_METADATA,
      SettingsController.prototype.updatePlatformSettings,
    ) as string | undefined;
    const actualUpdatePlatformMethod = Reflect.getMetadata(
      METHOD_METADATA,
      SettingsController.prototype.updatePlatformSettings,
    ) as RequestMethod | undefined;
    const actualListApiTokensPath = Reflect.getMetadata(
      PATH_METADATA,
      SettingsController.prototype.listApiTokens,
    ) as string | undefined;
    const actualListApiTokensMethod = Reflect.getMetadata(
      METHOD_METADATA,
      SettingsController.prototype.listApiTokens,
    ) as RequestMethod | undefined;
    const actualCreateApiTokenPath = Reflect.getMetadata(
      PATH_METADATA,
      SettingsController.prototype.createApiToken,
    ) as string | undefined;
    const actualCreateApiTokenMethod = Reflect.getMetadata(
      METHOD_METADATA,
      SettingsController.prototype.createApiToken,
    ) as RequestMethod | undefined;
    const actualRevokeApiTokenPath = Reflect.getMetadata(
      PATH_METADATA,
      SettingsController.prototype.revokeApiToken,
    ) as string | undefined;
    const actualRevokeApiTokenMethod = Reflect.getMetadata(
      METHOD_METADATA,
      SettingsController.prototype.revokeApiToken,
    ) as RequestMethod | undefined;
    const actualGetPaymentOpsAlertSettingsPath = Reflect.getMetadata(
      PATH_METADATA,
      SettingsController.prototype.getPaymentOpsAlertSettings,
    ) as string | undefined;
    const actualGetPaymentOpsAlertSettingsMethod = Reflect.getMetadata(
      METHOD_METADATA,
      SettingsController.prototype.getPaymentOpsAlertSettings,
    ) as RequestMethod | undefined;
    const actualUpdatePaymentOpsAlertSettingsPath = Reflect.getMetadata(
      PATH_METADATA,
      SettingsController.prototype.updatePaymentOpsAlertSettings,
    ) as string | undefined;
    const actualUpdatePaymentOpsAlertSettingsMethod = Reflect.getMetadata(
      METHOD_METADATA,
      SettingsController.prototype.updatePaymentOpsAlertSettings,
    ) as RequestMethod | undefined;
    const actualSendPaymentOpsAlertTestPath = Reflect.getMetadata(
      PATH_METADATA,
      SettingsController.prototype.sendPaymentOpsAlertTest,
    ) as string | undefined;
    const actualSendPaymentOpsAlertTestMethod = Reflect.getMetadata(
      METHOD_METADATA,
      SettingsController.prototype.sendPaymentOpsAlertTest,
    ) as RequestMethod | undefined;
    const actualGetReferralExchangePolicyPath = Reflect.getMetadata(
      PATH_METADATA,
      SettingsController.prototype.getReferralExchangePolicy,
    ) as string | undefined;
    const actualGetReferralExchangePolicyMethod = Reflect.getMetadata(
      METHOD_METADATA,
      SettingsController.prototype.getReferralExchangePolicy,
    ) as RequestMethod | undefined;
    const actualUpdateReferralExchangePolicyPath = Reflect.getMetadata(
      PATH_METADATA,
      SettingsController.prototype.updateReferralExchangePolicy,
    ) as string | undefined;
    const actualUpdateReferralExchangePolicyMethod = Reflect.getMetadata(
      METHOD_METADATA,
      SettingsController.prototype.updateReferralExchangePolicy,
    ) as RequestMethod | undefined;
    const actualGetPartnerWithdrawalPolicyPath = Reflect.getMetadata(
      PATH_METADATA,
      SettingsController.prototype.getPartnerWithdrawalPolicy,
    ) as string | undefined;
    const actualGetPartnerWithdrawalPolicyMethod = Reflect.getMetadata(
      METHOD_METADATA,
      SettingsController.prototype.getPartnerWithdrawalPolicy,
    ) as RequestMethod | undefined;
    const actualUpdatePartnerWithdrawalPolicyPath = Reflect.getMetadata(
      PATH_METADATA,
      SettingsController.prototype.updatePartnerWithdrawalPolicy,
    ) as string | undefined;
    const actualUpdatePartnerWithdrawalPolicyMethod = Reflect.getMetadata(
      METHOD_METADATA,
      SettingsController.prototype.updatePartnerWithdrawalPolicy,
    ) as RequestMethod | undefined;
    assert.equal(actualControllerPath, 'admin/settings');
    assert.equal(actualGetPlatformPath, 'platform');
    assert.equal(actualGetPlatformMethod, RequestMethod.GET);
    assert.equal(actualUpdatePlatformPath, 'platform');
    assert.equal(actualUpdatePlatformMethod, RequestMethod.PATCH);
    assert.equal(actualListApiTokensPath, 'api-tokens');
    assert.equal(actualListApiTokensMethod, RequestMethod.GET);
    assert.equal(actualCreateApiTokenPath, 'api-tokens');
    assert.equal(actualCreateApiTokenMethod, RequestMethod.POST);
    assert.equal(actualRevokeApiTokenPath, 'api-tokens/:tokenId/revoke');
    assert.equal(actualRevokeApiTokenMethod, RequestMethod.PATCH);
    assert.equal(actualGetPaymentOpsAlertSettingsPath, 'system-notifications/payment-ops');
    assert.equal(actualGetPaymentOpsAlertSettingsMethod, RequestMethod.GET);
    assert.equal(actualUpdatePaymentOpsAlertSettingsPath, 'system-notifications/payment-ops');
    assert.equal(actualUpdatePaymentOpsAlertSettingsMethod, RequestMethod.PATCH);
    assert.equal(actualSendPaymentOpsAlertTestPath, 'system-notifications/payment-ops/test');
    assert.equal(actualSendPaymentOpsAlertTestMethod, RequestMethod.POST);
    assert.equal(actualGetReferralExchangePolicyPath, 'referral-exchange-policy');
    assert.equal(actualGetReferralExchangePolicyMethod, RequestMethod.GET);
    assert.equal(actualUpdateReferralExchangePolicyPath, 'referral-exchange-policy');
    assert.equal(actualUpdateReferralExchangePolicyMethod, RequestMethod.PATCH);
    assert.equal(actualGetPartnerWithdrawalPolicyPath, 'partner-withdrawal-policy');
    assert.equal(actualGetPartnerWithdrawalPolicyMethod, RequestMethod.GET);
    assert.equal(actualUpdatePartnerWithdrawalPolicyPath, 'partner-withdrawal-policy');
    assert.equal(actualUpdatePartnerWithdrawalPolicyMethod, RequestMethod.PATCH);
  });

  it('delegates listApiTokens and returns the service response unchanged', async () => {
    let listApiTokensCallsCount = 0;
    const expectedTokens: readonly AdminApiTokenInterface[] = [buildAdminApiToken()];
    const settingsService = {
      listApiTokens: async (): Promise<readonly AdminApiTokenInterface[]> => {
        listApiTokensCallsCount += 1;
        return expectedTokens;
      },
    } as SettingsService;
    const controller = new SettingsController(settingsService, {} as never, {} as never);
    const actualTokens = await controller.listApiTokens();
    assert.equal(listApiTokensCallsCount, 1);
    assert.deepStrictEqual(actualTokens, expectedTokens);
  });

  it('delegates getPlatformSettings and returns the service response unchanged', async () => {
    let getPlatformSettingsCallsCount: number = 0;
    const expectedSettings: PlatformSettingsInterface = buildPlatformSettings();
    const settingsService = {
      getPlatformSettings: async (): Promise<PlatformSettingsInterface> => {
        getPlatformSettingsCallsCount += 1;
        return expectedSettings;
      },
    } as SettingsService;
    const controller = new SettingsController(settingsService, {} as never, {} as never);
    const actualSettings = await controller.getPlatformSettings();
    assert.equal(getPlatformSettingsCallsCount, 1);
    assert.deepStrictEqual(actualSettings, expectedSettings);
  });

  it('forwards the dto, current admin, and extracted request metadata to updatePlatformSettings', async () => {
    const updatePlatformSettingsCalls: UpdatePlatformSettingsCall[] = [];
    const expectedSettings: PlatformSettingsInterface = buildPlatformSettings();
    const settingsService = {
      updatePlatformSettings: async (
        input: UpdatePlatformSettingsCall,
      ): Promise<PlatformSettingsInterface> => {
        updatePlatformSettingsCalls.push(input);
        return expectedSettings;
      },
    } as SettingsService;
    const controller = new SettingsController(settingsService, {} as never, {} as never);
    const currentAdmin: CurrentAdminInterface = buildCurrentAdmin();
    const updatePlatformSettingsDto: UpdatePlatformSettingsDto = {
      accessMode: AccessMode.PUBLIC,
      channelId: '-1009876543210',
      channelLink: 'https://t.me/updated',
      rulesRequired: false,
    };
    const request = {
      headers: {
        'x-request-id': 'request-2',
        'x-forwarded-for': '198.51.100.50, 203.0.113.10',
        'user-agent': 'settings-controller-spec',
      },
      ip: '127.0.0.1',
      socket: {
        remoteAddress: '127.0.0.2',
      },
    } as unknown as Request;
    const actualSettings = await controller.updatePlatformSettings(
      updatePlatformSettingsDto,
      currentAdmin,
      request,
    );
    assert.deepStrictEqual(updatePlatformSettingsCalls, [
      {
        currentAdmin,
        requestMetadata: {
          requestId: 'request-2',
          remoteAddress: '198.51.100.50',
          userAgent: 'settings-controller-spec',
        },
        updatePlatformSettingsDto,
      },
    ]);
    assert.deepStrictEqual(actualSettings, expectedSettings);
  });

  it('forwards the dto, current admin, and extracted request metadata to createApiToken', async () => {
    const createApiTokenCalls: CreateAdminApiTokenCall[] = [];
    const expectedResponse: CreatedAdminApiTokenInterface = {
      token: buildAdminApiToken(),
      plaintextToken: 'rzadm_ab12cd34ef56.generated-secret',
    };
    const settingsService = {
      createApiToken: async (
        input: CreateAdminApiTokenCall,
      ): Promise<CreatedAdminApiTokenInterface> => {
        createApiTokenCalls.push(input);
        return expectedResponse;
      },
    } as SettingsService;
    const controller = new SettingsController(settingsService, {} as never, {} as never);
    const currentAdmin = buildCurrentAdmin();
    const createAdminApiTokenDto: CreateAdminApiTokenDto = {
      name: 'Internal automation',
      description: 'Used by CI jobs',
    };
    const request = {
      headers: {
        'x-request-id': 'request-3',
        'x-forwarded-for': '198.51.100.77, 203.0.113.10',
        'user-agent': 'settings-controller-spec',
      },
      ip: '127.0.0.1',
      socket: {
        remoteAddress: '127.0.0.2',
      },
    } as unknown as Request;
    const actualResponse = await controller.createApiToken(
      createAdminApiTokenDto,
      currentAdmin,
      request,
    );
    assert.deepStrictEqual(createApiTokenCalls, [
      {
        currentAdmin,
        requestMetadata: {
          requestId: 'request-3',
          remoteAddress: '198.51.100.77',
          userAgent: 'settings-controller-spec',
        },
        createAdminApiTokenDto,
      },
    ]);
    assert.deepStrictEqual(actualResponse, expectedResponse);
  });

  it('forwards tokenId, current admin, and extracted request metadata to revokeApiToken', async () => {
    const revokeApiTokenCalls: RevokeAdminApiTokenCall[] = [];
    const expectedToken = buildAdminApiToken();
    const settingsService = {
      revokeApiToken: async (
        input: RevokeAdminApiTokenCall,
      ): Promise<AdminApiTokenInterface> => {
        revokeApiTokenCalls.push(input);
        return expectedToken;
      },
    } as SettingsService;
    const controller = new SettingsController(settingsService, {} as never, {} as never);
    const currentAdmin = buildCurrentAdmin();
    const request = {
      headers: {
        'x-request-id': 'request-4',
        'x-forwarded-for': '198.51.100.88, 203.0.113.10',
        'user-agent': 'settings-controller-spec',
      },
      ip: '127.0.0.1',
      socket: {
        remoteAddress: '127.0.0.2',
      },
    } as unknown as Request;
    const actualResponse = await controller.revokeApiToken(
      'token-1',
      currentAdmin,
      request,
    );
    assert.deepStrictEqual(revokeApiTokenCalls, [
      {
        tokenId: 'token-1',
        currentAdmin,
        requestMetadata: {
          requestId: 'request-4',
          remoteAddress: '198.51.100.88',
          userAgent: 'settings-controller-spec',
        },
      },
    ]);
    assert.deepStrictEqual(actualResponse, expectedToken);
  });

  it('delegates getPaymentOpsAlertSettings and returns the service response unchanged', async () => {
    let getPaymentOpsAlertSettingsCallsCount = 0;
    const expectedSettings = buildPaymentOpsAlertSettings();
    const settingsService = {
      getPaymentOpsAlertSettings: async (): Promise<PaymentOpsAlertSettingsInterface> => {
        getPaymentOpsAlertSettingsCallsCount += 1;
        return expectedSettings;
      },
    } as SettingsService;
    const controller = new SettingsController(settingsService, {} as never, {} as never);
    const actualSettings = await controller.getPaymentOpsAlertSettings();
    assert.equal(getPaymentOpsAlertSettingsCallsCount, 1);
    assert.deepStrictEqual(actualSettings, expectedSettings);
  });

  it('forwards the dto, current admin, and extracted request metadata to updatePaymentOpsAlertSettings', async () => {
    const updatePaymentOpsAlertSettingsCalls: UpdatePaymentOpsAlertSettingsCall[] = [];
    const expectedSettings = buildPaymentOpsAlertSettings();
    const settingsService = {
      updatePaymentOpsAlertSettings: async (
        input: UpdatePaymentOpsAlertSettingsCall,
      ): Promise<PaymentOpsAlertSettingsInterface> => {
        updatePaymentOpsAlertSettingsCalls.push(input);
        return expectedSettings;
      },
    } as SettingsService;
    const controller = new SettingsController(settingsService, {} as never, {} as never);
    const currentAdmin = buildCurrentAdmin();
    const updatePaymentOpsAlertSettingsDto: UpdatePaymentOpsAlertSettingsDto = {
      enabled: true,
      chatId: '-1009876543210',
      threadId: '84',
      hashtag: '#urgent_ops',
    };
    const request = {
      headers: {
        'x-request-id': 'request-5',
        'x-forwarded-for': '198.51.100.99, 203.0.113.10',
        'user-agent': 'settings-controller-spec',
      },
      ip: '127.0.0.1',
      socket: {
        remoteAddress: '127.0.0.2',
      },
    } as unknown as Request;
    const actualSettings = await controller.updatePaymentOpsAlertSettings(
      updatePaymentOpsAlertSettingsDto,
      currentAdmin,
      request,
    );
    assert.deepStrictEqual(updatePaymentOpsAlertSettingsCalls, [
      {
        currentAdmin,
        requestMetadata: {
          requestId: 'request-5',
          remoteAddress: '198.51.100.99',
          userAgent: 'settings-controller-spec',
        },
        updatePaymentOpsAlertSettingsDto,
      },
    ]);
    assert.deepStrictEqual(actualSettings, expectedSettings);
  });

  it('forwards the dto, current admin, and extracted request metadata to sendPaymentOpsAlertTest', async () => {
    const sendPaymentOpsAlertTestCalls: SendPaymentOpsAlertTestCall[] = [];
    const settingsService = {
      sendPaymentOpsAlertTest: async (input: SendPaymentOpsAlertTestCall): Promise<void> => {
        sendPaymentOpsAlertTestCalls.push(input);
      },
    } as SettingsService;
    const controller = new SettingsController(settingsService, {} as never, {} as never);
    const currentAdmin = buildCurrentAdmin();
    const sendPaymentOpsAlertTestDto: SendPaymentOpsAlertTestDto = {
      note: 'Confirm routing for the test alert',
    };
    const request = {
      headers: {
        'x-request-id': 'request-6',
        'x-forwarded-for': '198.51.100.111, 203.0.113.10',
        'user-agent': 'settings-controller-spec',
      },
      ip: '127.0.0.1',
      socket: {
        remoteAddress: '127.0.0.2',
      },
    } as unknown as Request;
    const actualResponse = await controller.sendPaymentOpsAlertTest(
      sendPaymentOpsAlertTestDto,
      currentAdmin,
      request,
    );
    assert.deepStrictEqual(sendPaymentOpsAlertTestCalls, [
      {
        currentAdmin,
        requestMetadata: {
          requestId: 'request-6',
          remoteAddress: '198.51.100.111',
          userAgent: 'settings-controller-spec',
        },
        sendPaymentOpsAlertTestDto,
      },
    ]);
    assert.deepStrictEqual(actualResponse, { sent: true });
  });

  it('delegates getReferralExchangePolicy to the referral summary service unchanged', async () => {
    let getExchangePolicyCallsCount = 0;
    const expectedPolicy = buildReferralExchangePolicy();
    const referralSummaryService = {
      getExchangePolicy: async (): Promise<ReferralExchangePolicyInterface> => {
        getExchangePolicyCallsCount += 1;
        return expectedPolicy;
      },
    };
    const controller = new SettingsController({} as SettingsService, referralSummaryService as never, {} as never);
    const actualPolicy = await controller.getReferralExchangePolicy();
    assert.equal(getExchangePolicyCallsCount, 1);
    assert.deepStrictEqual(actualPolicy, expectedPolicy);
  });

  it('delegates updateReferralExchangePolicy with the current admin id and dto', async () => {
    const updateExchangePolicyCalls: UpdateReferralExchangePolicyCall[] = [];
    const expectedPolicy = buildReferralExchangePolicy();
    const referralSummaryService = {
      updateExchangePolicy: async (input: UpdateReferralExchangePolicyCall): Promise<ReferralExchangePolicyInterface> => {
        updateExchangePolicyCalls.push(input);
        return expectedPolicy;
      },
    };
    const controller = new SettingsController({} as SettingsService, referralSummaryService as never, {} as never);
    const currentAdmin = buildCurrentAdmin();
    const updateReferralExchangePolicyDto: UpdateReferralExchangePolicyDto = {
      exchangeEnabled: true,
      allowedPlanIds: ['plan-basic', 'plan-pro'],
    };
    const actualPolicy = await controller.updateReferralExchangePolicy(updateReferralExchangePolicyDto, currentAdmin);
    assert.deepStrictEqual(updateExchangePolicyCalls, [
      {
        adminUserId: currentAdmin.id,
        dto: updateReferralExchangePolicyDto,
      },
    ]);
    assert.deepStrictEqual(actualPolicy, expectedPolicy);
  });

  it('delegates getPartnerWithdrawalPolicy to the settings service unchanged', async () => {
    let getPartnerWithdrawalPolicyCallsCount = 0;
    const expectedPolicy = buildPartnerWithdrawalPolicy();
    const settingsService = {
      getPartnerWithdrawalPolicy: async (): Promise<PartnerWithdrawalPolicyInterface> => {
        getPartnerWithdrawalPolicyCallsCount += 1;
        return expectedPolicy;
      },
    } as SettingsService;
    const controller = new SettingsController(settingsService, {} as never, {} as never);
    const actualPolicy = await controller.getPartnerWithdrawalPolicy();
    assert.equal(getPartnerWithdrawalPolicyCallsCount, 1);
    assert.deepStrictEqual(actualPolicy, expectedPolicy);
  });

  it('forwards partner withdrawal policy dto, current admin, and request metadata', async () => {
    const updatePartnerWithdrawalPolicyCalls: UpdatePartnerWithdrawalPolicyCall[] = [];
    const expectedPolicy = buildPartnerWithdrawalPolicy();
    const settingsService = {
      updatePartnerWithdrawalPolicy: async (
        input: UpdatePartnerWithdrawalPolicyCall,
      ): Promise<PartnerWithdrawalPolicyInterface> => {
        updatePartnerWithdrawalPolicyCalls.push(input);
        return expectedPolicy;
      },
    } as SettingsService;
    const controller = new SettingsController(settingsService, {} as never, {} as never);
    const currentAdmin = buildCurrentAdmin();
    const updatePartnerWithdrawalPolicyDto: UpdatePartnerWithdrawalPolicyDto = {
      enabled: true,
      minimumAmount: 1500,
      supportedMethods: ['card'],
    };
    const request = {
      headers: {
        'x-request-id': 'request-7',
        'x-forwarded-for': '198.51.100.112, 203.0.113.10',
        'user-agent': 'settings-controller-spec',
      },
      ip: '127.0.0.1',
      socket: {
        remoteAddress: '127.0.0.2',
      },
    } as unknown as Request;
    const actualPolicy = await controller.updatePartnerWithdrawalPolicy(
      updatePartnerWithdrawalPolicyDto,
      currentAdmin,
      request,
    );
    assert.deepStrictEqual(updatePartnerWithdrawalPolicyCalls, [
      {
        currentAdmin,
        requestMetadata: {
          requestId: 'request-7',
          remoteAddress: '198.51.100.112',
          userAgent: 'settings-controller-spec',
        },
        updatePartnerWithdrawalPolicyDto,
      },
    ]);
    assert.deepStrictEqual(actualPolicy, expectedPolicy);
  });

  it('requires the admin jwt guard at the controller level', () => {
    const actualGuards = Reflect.getMetadata(GUARDS_METADATA, SettingsController) as
      | readonly unknown[]
      | undefined;
    assert.deepStrictEqual(actualGuards, [AdminJwtAuthGuard]);
  });
});
