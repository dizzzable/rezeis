import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
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
      [AdminJwtAuthGuard, RbacGuard],
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
    const controller = new AdminRemnawaveController(
      {
        getStatus: async () => {
          statusCallsCount += 1;
          return expectedStatus;
        },
      } as never as RemnawaveApiService,
      {} as never,
      {} as never,
      {} as never,
    );

    const actualStatus = await controller.getStatus();

    assert.equal(statusCallsCount, 1);
    assert.deepStrictEqual(actualStatus, expectedStatus);
  });

  it('reads capabilities from cache — the route takes no cache-bypass argument', async () => {
    const forcedFlags: unknown[] = [];
    const controller = new AdminRemnawaveController(
      {} as never,
      {} as never,
      {} as never,
      {
        getCapabilities: async (force?: boolean) => {
          forcedFlags.push(force);
          return { version: '2.8.0' } as never;
        },
      } as never,
    );

    await controller.getCapabilities();

    // The route must never hand the service a truthy `force`: it inherits the
    // read-only `remnawave:view` permission and has no throttle of its own, so
    // a cache bypass here would let a viewer drive unbounded upstream panel
    // calls and overwrite the shared capability cache. The 15s negative TTL is
    // what bounds a bad cached state.
    assert.deepStrictEqual(forcedFlags, [undefined]);
  });
});
