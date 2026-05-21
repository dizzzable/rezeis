import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';

import { WebRegistrationSettingsController } from '../src/modules/web-registration-settings/web-registration-settings.controller';
import { WebRegistrationSettingsService } from '../src/modules/web-registration-settings/web-registration-settings.service';
import { InternalApiGuard } from '../src/common/guards/internal-api.guard';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildMockPrismaService(settingRow: { id: number; enabled: boolean; recoveryConfirmMode: string; updatedAt: Date } | null = null) {
  return {
    webRegistrationSetting: {
      findUnique: async (_args: any) => settingRow,
      upsert: async (args: any) => ({
        id: 1,
        enabled: args.update?.enabled ?? args.create?.enabled ?? false,
        recoveryConfirmMode: args.update?.recoveryConfirmMode ?? args.create?.recoveryConfirmMode ?? 'automatic',
        updatedAt: new Date(),
      }),
    },
  };
}

function buildService(prisma: any): WebRegistrationSettingsService {
  return new WebRegistrationSettingsService(prisma);
}

// ── Controller Route Metadata ────────────────────────────────────────────────

describe('WebRegistrationSettingsController', () => {
  it('exposes the internal settings route contract', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, WebRegistrationSettingsController) as string;
    assert.equal(controllerPath, 'internal/settings');

    const controllerGuards = Reflect.getMetadata(GUARDS_METADATA, WebRegistrationSettingsController) as unknown[];
    assert.ok(controllerGuards?.includes(InternalApiGuard), 'Controller should use InternalApiGuard');
  });

  it('GET registration-toggle route is defined', () => {
    const path = Reflect.getMetadata(PATH_METADATA, WebRegistrationSettingsController.prototype.getRegistrationToggle);
    const method = Reflect.getMetadata(METHOD_METADATA, WebRegistrationSettingsController.prototype.getRegistrationToggle);
    assert.equal(path, 'registration-toggle');
    assert.equal(method, RequestMethod.GET);
  });

  it('PUT registration-toggle route is defined', () => {
    const path = Reflect.getMetadata(PATH_METADATA, WebRegistrationSettingsController.prototype.updateRegistrationToggle);
    const method = Reflect.getMetadata(METHOD_METADATA, WebRegistrationSettingsController.prototype.updateRegistrationToggle);
    assert.equal(path, 'registration-toggle');
    assert.equal(method, RequestMethod.PUT);
  });

  it('delegates getRegistrationToggle to the service', async () => {
    const mockService = {
      getRegistrationToggle: async () => ({ enabled: false }),
    } as unknown as WebRegistrationSettingsService;

    const controller = new WebRegistrationSettingsController(mockService);
    const result = await controller.getRegistrationToggle();
    assert.deepStrictEqual(result, { enabled: false });
  });

  it('delegates updateRegistrationToggle to the service', async () => {
    const mockService = {
      updateRegistrationToggle: async (enabled: boolean) => ({ enabled, updatedAt: new Date('2025-01-01') }),
    } as unknown as WebRegistrationSettingsService;

    const controller = new WebRegistrationSettingsController(mockService);
    const result = await controller.updateRegistrationToggle({ enabled: true });
    assert.equal(result.enabled, true);
  });
});

// ── Service Logic ────────────────────────────────────────────────────────────

describe('WebRegistrationSettingsService', () => {
  it('returns enabled: false when no row exists (fresh installation)', async () => {
    const prisma = buildMockPrismaService(null);
    const service = buildService(prisma);

    const result = await service.getRegistrationToggle();
    assert.deepStrictEqual(result, { enabled: false });
  });

  it('returns enabled: false when row exists with enabled=false', async () => {
    const prisma = buildMockPrismaService({
      id: 1,
      enabled: false,
      recoveryConfirmMode: 'automatic',
      updatedAt: new Date(),
    });
    const service = buildService(prisma);

    const result = await service.getRegistrationToggle();
    assert.deepStrictEqual(result, { enabled: false });
  });

  it('returns enabled: true when row exists with enabled=true', async () => {
    const prisma = buildMockPrismaService({
      id: 1,
      enabled: true,
      recoveryConfirmMode: 'automatic',
      updatedAt: new Date(),
    });
    const service = buildService(prisma);

    const result = await service.getRegistrationToggle();
    assert.deepStrictEqual(result, { enabled: true });
  });

  it('returns enabled: false when database throws an error (corrupted state)', async () => {
    const prisma = {
      webRegistrationSetting: {
        findUnique: async () => { throw new Error('DB connection failed'); },
      },
    };
    const service = buildService(prisma);

    const result = await service.getRegistrationToggle();
    assert.deepStrictEqual(result, { enabled: false });
  });

  it('returns enabled: false when enabled field is not a boolean (corrupted data)', async () => {
    const prisma = {
      webRegistrationSetting: {
        findUnique: async () => ({
          id: 1,
          enabled: 'yes' as any, // corrupted: should be boolean
          recoveryConfirmMode: 'automatic',
          updatedAt: new Date(),
        }),
      },
    };
    const service = buildService(prisma);

    const result = await service.getRegistrationToggle();
    assert.deepStrictEqual(result, { enabled: false });
  });

  it('updateRegistrationToggle upserts the setting with enabled=true', async () => {
    const prisma = buildMockPrismaService(null);
    const service = buildService(prisma);

    const result = await service.updateRegistrationToggle(true);
    assert.equal(result.enabled, true);
    assert.ok(result.updatedAt instanceof Date);
  });

  it('updateRegistrationToggle upserts the setting with enabled=false', async () => {
    const prisma = buildMockPrismaService({
      id: 1,
      enabled: true,
      recoveryConfirmMode: 'automatic',
      updatedAt: new Date(),
    });
    const service = buildService(prisma);

    const result = await service.updateRegistrationToggle(false);
    assert.equal(result.enabled, false);
    assert.ok(result.updatedAt instanceof Date);
  });

  it('getFullSettings returns defaults when no row exists', async () => {
    const prisma = buildMockPrismaService(null);
    const service = buildService(prisma);

    const result = await service.getFullSettings();
    assert.equal(result.enabled, false);
    assert.equal(result.recoveryConfirmMode, 'automatic');
    assert.ok(result.updatedAt instanceof Date);
  });

  it('getFullSettings returns defaults when database throws', async () => {
    const prisma = {
      webRegistrationSetting: {
        findUnique: async () => { throw new Error('connection lost'); },
      },
    };
    const service = buildService(prisma);

    const result = await service.getFullSettings();
    assert.equal(result.enabled, false);
    assert.equal(result.recoveryConfirmMode, 'automatic');
  });

  it('updateRecoveryConfirmMode validates mode and defaults to automatic for invalid values', async () => {
    const prisma = buildMockPrismaService(null);
    const service = buildService(prisma);

    const result = await service.updateRecoveryConfirmMode('invalid_mode');
    assert.equal(result.recoveryConfirmMode, 'automatic');
  });

  it('updateRecoveryConfirmMode accepts "manual" as valid mode', async () => {
    const prisma = buildMockPrismaService(null);
    const service = buildService(prisma);

    const result = await service.updateRecoveryConfirmMode('manual');
    assert.equal(result.recoveryConfirmMode, 'manual');
  });
});
