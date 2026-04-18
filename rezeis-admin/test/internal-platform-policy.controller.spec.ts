import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AccessMode, Currency } from '@prisma/client';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalPlatformPolicyController } from '../src/modules/settings/controllers/internal-platform-policy.controller';
import { InternalPlatformPolicyInterface } from '../src/modules/settings/interfaces/internal-platform-policy.interface';
import { SettingsService } from '../src/modules/settings/services/settings.service';

const EXPECTED_POLICY_KEYS: readonly string[] = [
  'accessMode',
  'channelLink',
  'channelRequired',
  'defaultCurrency',
  'inviteModeStartedAt',
  'rulesLink',
  'rulesRequired',
];

describe('InternalPlatformPolicyController', () => {
  it('exposes the shipped internal platform policy route contract', () => {
    const actualControllerPath = Reflect.getMetadata(PATH_METADATA, InternalPlatformPolicyController) as
      | string
      | undefined;
    const actualGetPlatformPolicyPath = Reflect.getMetadata(
      PATH_METADATA,
      InternalPlatformPolicyController.prototype.getPlatformPolicy,
    ) as string | undefined;
    const actualGetPlatformPolicyMethod = Reflect.getMetadata(
      METHOD_METADATA,
      InternalPlatformPolicyController.prototype.getPlatformPolicy,
    ) as RequestMethod | undefined;
    assert.equal(actualControllerPath, 'internal/settings');
    assert.equal(actualGetPlatformPolicyPath, 'platform-policy');
    assert.equal(actualGetPlatformPolicyMethod, RequestMethod.GET);
  });

  it('returns only the user-safe platform policy contract', async () => {
    let getInternalPlatformPolicyCallsCount: number = 0;
    const expectedPolicy: InternalPlatformPolicyInterface = {
      rulesRequired: true,
      rulesLink: 'https://example.com/rules',
      channelRequired: true,
      channelLink: 'https://t.me/example',
      accessMode: AccessMode.INVITED,
      inviteModeStartedAt: '2026-04-01T00:00:00.000Z',
      defaultCurrency: Currency.USD,
    };
    const settingsService = {
      getInternalPlatformPolicy: async (): Promise<InternalPlatformPolicyInterface> => {
        getInternalPlatformPolicyCallsCount += 1;
        return expectedPolicy;
      },
    } as SettingsService;
    const controller = new InternalPlatformPolicyController(settingsService);
    const actualPolicy = await controller.getPlatformPolicy();
    assert.equal(getInternalPlatformPolicyCallsCount, 1);
    assert.deepStrictEqual(actualPolicy, expectedPolicy);
    assert.deepStrictEqual(Object.keys(actualPolicy).sort(), [...EXPECTED_POLICY_KEYS]);
  });

  it('requires the internal API key guard at the controller level', () => {
    const actualGuards = Reflect.getMetadata(GUARDS_METADATA, InternalPlatformPolicyController) as
      | readonly unknown[]
      | undefined;
    assert.deepStrictEqual(actualGuards, [InternalAdminAuthGuard]);
  });
});
