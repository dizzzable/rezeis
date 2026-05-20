import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PurchaseChannel } from '@prisma/client';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalPlanCatalogController } from '../src/modules/plans/controllers/internal-plan-catalog.controller';
import { PlanCatalogService } from '../src/modules/plans/services/plan-catalog.service';

describe('InternalPlanCatalogController', () => {
  it('exposes the internal catalog route contract', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalPlanCatalogController), 'internal/catalog');
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalPlanCatalogController.prototype.getPlans),
      'plans',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, InternalPlanCatalogController.prototype.getPlans),
      RequestMethod.GET,
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, InternalPlanCatalogController),
      [InternalAdminAuthGuard],
    );
  });

  it('defaults the channel to WEB and forwards query params unchanged', async () => {
    const catalogCalls: object[] = [];
    const expectedPlans = [{ id: 'plan-1' }];
    const controller = new InternalPlanCatalogController({
      getCatalogPlans: async (query: object) => {
        catalogCalls.push(query);
        return expectedPlans;
      },
    } as never as PlanCatalogService);

    const actual = await controller.getPlans({ userId: 'user-1' });

    assert.deepStrictEqual(catalogCalls, [{ channel: PurchaseChannel.WEB, userId: 'user-1' }]);
    assert.deepStrictEqual(actual, expectedPlans);
  });
});
