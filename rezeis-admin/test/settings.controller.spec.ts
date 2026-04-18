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
import { UpdatePlatformSettingsDto } from '../src/modules/settings/dto/update-platform-settings.dto';
import { PlatformSettingsInterface } from '../src/modules/settings/interfaces/platform-settings.interface';
import { SettingsController } from '../src/modules/settings/controllers/settings.controller';
import { SettingsService } from '../src/modules/settings/services/settings.service';

interface UpdatePlatformSettingsCall {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly updatePlatformSettingsDto: UpdatePlatformSettingsDto;
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
    assert.equal(actualControllerPath, 'admin/settings');
    assert.equal(actualGetPlatformPath, 'platform');
    assert.equal(actualGetPlatformMethod, RequestMethod.GET);
    assert.equal(actualUpdatePlatformPath, 'platform');
    assert.equal(actualUpdatePlatformMethod, RequestMethod.PATCH);
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
    const controller = new SettingsController(settingsService);
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
    const controller = new SettingsController(settingsService);
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
    } as Request;
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

  it('requires the admin jwt guard at the controller level', () => {
    const actualGuards = Reflect.getMetadata(GUARDS_METADATA, SettingsController) as
      | readonly unknown[]
      | undefined;
    assert.deepStrictEqual(actualGuards, [AdminJwtAuthGuard]);
  });
});
