import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminPlansController } from '../src/modules/plans/controllers/admin-plans.controller';
import { PlansAdminService } from '../src/modules/plans/services/plans-admin.service';

describe('AdminPlansController', () => {
  it('exposes the shipped admin plans route contract', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPlansController), 'admin/plans');
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPlansController.prototype.listPlans),
      '/',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminPlansController.prototype.listPlans),
      RequestMethod.GET,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPlansController.prototype.createPlan),
      '/',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminPlansController.prototype.createPlan),
      RequestMethod.POST,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPlansController.prototype.getInternalSquadOptions),
      'options/internal-squads',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminPlansController.prototype.getInternalSquadOptions),
      RequestMethod.GET,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPlansController.prototype.getExternalSquadOptions),
      'options/external-squads',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminPlansController.prototype.getExternalSquadOptions),
      RequestMethod.GET,
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminPlansController),
      [AdminJwtAuthGuard],
    );
  });

  it('delegates listPlans to the admin service unchanged', async () => {
    let listCallsCount = 0;
    const expectedPlans = [{ id: 'plan-1', name: 'Starter' }];
    const controller = new AdminPlansController({
      listPlans: async () => {
        listCallsCount += 1;
        return expectedPlans;
      },
    } as never as PlansAdminService);

    const actualPlans = await controller.listPlans();

    assert.equal(listCallsCount, 1);
    assert.deepStrictEqual(actualPlans, expectedPlans);
  });

  it('delegates remnawave squad option reads unchanged', async () => {
    let internalCallsCount = 0;
    let externalCallsCount = 0;
    const expectedInternal = [{ uuid: '11111111-1111-1111-1111-111111111111', name: 'Core' }];
    const expectedExternal = [{ uuid: '22222222-2222-2222-2222-222222222222', name: 'Public' }];
    const controller = new AdminPlansController({
      listPlans: async () => [],
      getInternalSquadOptions: async () => {
        internalCallsCount += 1;
        return expectedInternal;
      },
      getExternalSquadOptions: async () => {
        externalCallsCount += 1;
        return expectedExternal;
      },
    } as never as PlansAdminService);

    const actualInternal = await controller.getInternalSquadOptions();
    const actualExternal = await controller.getExternalSquadOptions();

    assert.equal(internalCallsCount, 1);
    assert.equal(externalCallsCount, 1);
    assert.deepStrictEqual(actualInternal, expectedInternal);
    assert.deepStrictEqual(actualExternal, expectedExternal);
  });
});
