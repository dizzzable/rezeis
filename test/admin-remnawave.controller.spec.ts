import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminRemnawaveController } from '../src/modules/remnawave/controllers/admin-remnawave.controller';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

describe('AdminRemnawaveController', () => {
  it('exposes the admin remnawave status route contract', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminRemnawaveController), 'admin/remnawave');
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminRemnawaveController.prototype.getStatus),
      'status',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminRemnawaveController.prototype.getStatus),
      RequestMethod.GET,
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminRemnawaveController),
      [AdminJwtAuthGuard],
    );
  });

  it('delegates status reads to the remnawave service unchanged', async () => {
    let statusCallsCount = 0;
    const expectedStatus = {
      isConfigured: true,
      isReachable: true,
      isLoginAllowed: true,
      isRegisterAllowed: false,
      authentication: null,
      branding: null,
    };
    const controller = new AdminRemnawaveController({
      getStatus: async () => {
        statusCallsCount += 1;
        return expectedStatus;
      },
    } as never as RemnawaveApiService);

    const actualStatus = await controller.getStatus();

    assert.equal(statusCallsCount, 1);
    assert.deepStrictEqual(actualStatus, expectedStatus);
  });
});
