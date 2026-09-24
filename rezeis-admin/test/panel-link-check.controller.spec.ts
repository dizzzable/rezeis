import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { AdminPanelLinkCheckController } from '../src/modules/profile-sync/panel-link-reconciliation.controller';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  effectiveRoutePermissions,
} from './helpers/controller-routes';

/**
 * The operator's side of the automatic panel-link check: two lists, and no
 * button. `POST /admin/profile-sync/panel-link-reconciliation` — the manual run
 * behind «Починка привязки к панели» — is gone (owner, 24.09.2026); the check
 * runs by itself.
 */
describe('AdminPanelLinkCheckController', () => {
  it('serves the two lists and nothing that runs or writes', () => {
    assertRouteHandlers(AdminPanelLinkCheckController, ['listExtraProfiles', 'listUnlinked']);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminPanelLinkCheckController), 'admin/profile-sync/panel-links');
    assertRoute(
      AdminPanelLinkCheckController.prototype.listUnlinked,
      { method: RequestMethod.GET, path: 'unlinked' },
      'GET unlinked',
    );
    assertRoute(
      AdminPanelLinkCheckController.prototype.listExtraProfiles,
      { method: RequestMethod.GET, path: 'extra-profiles' },
      'GET extra-profiles',
    );
  });

  it('asks for the permission the single-row link asks for', () => {
    assertEveryRouteGuarded(AdminPanelLinkCheckController);
    for (const handler of [
      AdminPanelLinkCheckController.prototype.listUnlinked,
      AdminPanelLinkCheckController.prototype.listExtraProfiles,
    ]) {
      assert.deepEqual(effectiveRoutePermissions(AdminPanelLinkCheckController, handler), [
        { resource: 'subscriptions', action: 'edit' },
      ]);
    }
  });

  it('answers with what the check service lists', async () => {
    const unlinked = { check: {}, total: 0, rows: [], truncated: false };
    const extra = { check: {}, customers: [] };
    const controller = new AdminPanelLinkCheckController({
      listUnlinked: async () => unlinked,
      listExtraProfiles: async () => extra,
    } as never);

    assert.equal(await controller.listUnlinked(), unlinked);
    assert.equal(await controller.listExtraProfiles(), extra);
  });
});
