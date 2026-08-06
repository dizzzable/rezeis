import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserRole } from '@prisma/client';
import { Request } from 'express';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import { SettingsController } from '../src/modules/settings/controllers/settings.controller';
import { UpdateAntiFraudSettingsDto } from '../src/modules/settings/dto/update-anti-fraud-settings.dto';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { BrandingAssetUploadService } from '../src/modules/settings/services/branding-asset-upload.service';

const CURRENT_ADMIN: CurrentAdminInterface = {
  id: 'admin-1',
  login: 'admin',
  email: 'admin@example.com',
  name: 'Admin',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-04-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};

function buildRequest(): Request {
  return {
    headers: { 'user-agent': 'anti-fraud-controller-spec', 'x-request-id': 'req-af' },
    ip: '203.0.113.11',
  } as unknown as Request;
}

function createController(settingsService: object): SettingsController {
  return new SettingsController(
    settingsService as unknown as SettingsService,
    {} as unknown as IconUploadService,
    {} as unknown as BrandingAssetUploadService,
  );
}

function routeOf(name: keyof SettingsController) {
  const handler = SettingsController.prototype[name] as object;
  return {
    path: Reflect.getMetadata(PATH_METADATA, handler) as string,
    method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
    permissions: Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler) as
      | readonly { resource: string; action: string }[]
      | undefined,
  };
}

describe('SettingsController — anti-fraud tunables route contract', () => {
  it('serves GET/PATCH under the same controller guards as its neighbours', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, SettingsController), 'admin/settings');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, SettingsController), [
      AdminJwtAuthGuard,
      RbacGuard,
    ]);
    const read = routeOf('getAntiFraudSettings');
    const write = routeOf('updateAntiFraudSettings');
    assert.deepStrictEqual(
      { path: read.path, method: read.method },
      { path: 'anti-fraud', method: RequestMethod.GET },
    );
    assert.deepStrictEqual(
      { path: write.path, method: write.method },
      { path: 'anti-fraud', method: RequestMethod.PATCH },
    );
  });

  it('gates the write on settings:edit — the same permission as every other write here', () => {
    assert.deepStrictEqual(routeOf('updateAntiFraudSettings').permissions, [
      { resource: 'settings', action: 'edit' },
    ]);
    // Reads inherit the controller-level `settings:view`; a handler-level
    // permission here would silently narrow it.
    assert.equal(
      routeOf('getAntiFraudSettings').permissions,
      undefined,
      'the read must inherit settings:view, not declare its own',
    );
    assert.deepStrictEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, SettingsController), [
      { resource: 'settings', action: 'view' },
    ]);
    // And it must match the neighbour it was modelled on.
    assert.deepStrictEqual(
      routeOf('updateAntiFraudSettings').permissions,
      routeOf('updateRemnawaveCleanupSettings').permissions,
    );
  });

  it('forwards the patch with the acting admin and the extracted request metadata', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const controller = createController({
      getAntiFraudSettings: async () => ({ marker: 'read' }),
      updateAntiFraudSettings: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { marker: 'written' };
      },
    });

    assert.deepStrictEqual(await controller.getAntiFraudSettings(), { marker: 'read' });

    const dto = { sharing: { ipWindowMinutes: 45 } } as UpdateAntiFraudSettingsDto;
    const result = await controller.updateAntiFraudSettings(dto, CURRENT_ADMIN, buildRequest());
    assert.deepStrictEqual(result, { marker: 'written' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].patch, dto);
    assert.equal((calls[0].currentAdmin as CurrentAdminInterface).id, 'admin-1');
    assert.equal(
      (calls[0].requestMetadata as { userAgent: string | null }).userAgent,
      'anti-fraud-controller-spec',
    );
  });
});

describe('UpdateAntiFraudSettingsDto — the first of two gates', () => {
  async function errorsFor(payload: unknown): Promise<string[]> {
    const dto = plainToInstance(UpdateAntiFraudSettingsDto, payload);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    const flat: string[] = [];
    const walk = (list: typeof errors, prefix: string): void => {
      for (const error of list) {
        const path = prefix ? `${prefix}.${error.property}` : error.property;
        for (const message of Object.values(error.constraints ?? {})) flat.push(`${path}: ${message}`);
        if (error.children?.length) walk(error.children, path);
      }
    };
    walk(errors, '');
    return flat;
  }

  it('accepts a valid partial patch', async () => {
    assert.deepEqual(
      await errorsFor({ sharing: { ipWindowMinutes: 45 }, trafficAbuse: { medianMultiplier: 6.5 } }),
      [],
    );
  });

  it('accepts null on any field — that is how a panel value is cleared', async () => {
    assert.deepEqual(
      await errorsFor({
        sharing: { ipWindowMinutes: null, enableIpSharing: null },
        trafficAbuse: { minGb: null, enabled: null },
      }),
      [],
    );
  });

  it('rejects an out-of-range number with a message naming the bound', async () => {
    const below = await errorsFor({ sharing: { ipWindowMinutes: 0 } });
    assert.equal(below.length, 1);
    assert.match(below[0], /sharing\.ipWindowMinutes/);
    assert.match(below[0], /not be less than 1/);

    const above = await errorsFor({ trafficAbuse: { sharePercent: 101 } });
    assert.equal(above.length, 1);
    assert.match(above[0], /trafficAbuse\.sharePercent/);
    assert.match(above[0], /not be greater than 100/);
  });

  it('rejects a fraction where the environment path could only produce an integer', async () => {
    const errors = await errorsFor({ sharing: { maxNodesPerRun: 12.5 } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /sharing\.maxNodesPerRun.*integer/);
  });

  it('rejects a wrong type instead of coercing it', async () => {
    const errors = await errorsFor({ sharing: { enableIpSharing: 'yes' } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /sharing\.enableIpSharing.*boolean/);
  });

  it('rejects a key it does not know', async () => {
    const errors = await errorsFor({ sharing: { ipWindowMinutesss: 45 } });
    assert.ok(
      errors.some((e) => /ipWindowMinutesss/.test(e)),
      'a typo in the form must 400 rather than be silently dropped',
    );
  });

  it('bounds every numeric knob — no field is left unguarded', async () => {
    // Each pair is (field, a value outside its documented range). A knob that
    // gained a range in the config file but not here would show up as a miss.
    const outOfRange: readonly [string, string, number][] = [
      ['sharing', 'ipWindowMinutes', 1441],
      ['sharing', 'ipConcurrencyWindowSeconds', 14],
      ['sharing', 'maxNodesPerRun', 501],
      ['sharing', 'maxIpsInMetadata', 201],
      ['sharing', 'ipV4PrefixLength', 33],
      ['sharing', 'ipV6PrefixLength', 15],
      ['sharing', 'ipOverageMargin', 51],
      ['trafficAbuse', 'minGb', 100_001],
      ['trafficAbuse', 'medianMultiplier', 1.4],
      ['trafficAbuse', 'sharePercent', 4],
      ['trafficAbuse', 'maxNodesPerRun', 501],
      ['subscriptionUa', 'uaEvidenceWindowMinutes', 14],
      ['subscriptionUa', 'uaEvidenceWindowMinutes', 361],
      ['subscriptionUa', 'uaRequestPageSize', 99],
      ['subscriptionUa', 'uaRequestPageSize', 2001],
    ];
    for (const [section, field, value] of outOfRange) {
      const errors = await errorsFor({ [section]: { [field]: value } });
      assert.ok(errors.length > 0, `${section}.${field} = ${value} was accepted but is out of range`);
    }
  });

  it('carries the subscription-UA section through the same three shapes', async () => {
    assert.deepEqual(
      await errorsFor({
        subscriptionUa: {
          enableSubscriptionUaTunnel: true,
          uaEvidenceWindowMinutes: 120,
          uaRequestPageSize: 1500,
        },
      }),
      [],
      'a valid patch for the new section must reach the merge validator',
    );
    // `null` clears — for this section back to the built-in default, since it
    // has no environment variable under it.
    assert.deepEqual(
      await errorsFor({
        subscriptionUa: { enableSubscriptionUaTunnel: null, uaRequestPageSize: null },
      }),
      [],
    );
    const wrongType = await errorsFor({ subscriptionUa: { enableSubscriptionUaTunnel: 'on' } });
    assert.equal(wrongType.length, 1);
    assert.match(wrongType[0], /subscriptionUa\.enableSubscriptionUaTunnel.*boolean/);
    assert.ok(
      (await errorsFor({ subscriptionUa: { uaRequestPageSizee: 500 } })).some((e) =>
        /uaRequestPageSizee/.test(e),
      ),
      'a typo in the new section must 400 like a typo in any other',
    );
  });
});
