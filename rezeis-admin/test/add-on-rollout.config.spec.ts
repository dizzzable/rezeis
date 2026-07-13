import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  resolveAddOnRolloutFlags,
  resolveResetCapabilities,
} from '../src/modules/add-on-entitlements/add-on-rollout.config';

describe('add-on rollout flags', () => {
  it('defaults every stage to OFF when the environment is empty', () => {
    const flags = resolveAddOnRolloutFlags({});
    assert.equal(flags.entitlementShadow, false);
    assert.equal(flags.directPurchase, false);
    assert.equal(flags.projectionSync, false);
    assert.equal(flags.renewalAddOns, false);
    assert.equal(flags.deviceCleanupAuto, false);
    assert.deepEqual(flags.resetExpiry, { DAY: false, WEEK: false, MONTH: false, MONTH_ROLLING: false });
  });

  it('parses "true" and "1" as enabled, anything else as disabled', () => {
    const flags = resolveAddOnRolloutFlags({
      ADDON_ENTITLEMENT_SHADOW: 'true',
      ADDON_ENTITLEMENT_DIRECT_PURCHASE: '1',
      ADDON_PROJECTION_SYNC: 'yes',
      ADDON_RENEWAL_ADDONS: 'false',
      ADDON_DEVICE_CLEANUP_AUTO: '',
    });
    assert.equal(flags.entitlementShadow, true);
    assert.equal(flags.directPurchase, true);
    assert.equal(flags.projectionSync, false);
    assert.equal(flags.renewalAddOns, false);
    assert.equal(flags.deviceCleanupAuto, false);
  });

  it('derives reset capabilities only for enabled strategies', () => {
    const capabilities = resolveResetCapabilities({
      ADDON_RESET_EXPIRY_MONTH: 'true',
      ADDON_RESET_EXPIRY_DAY: '1',
    });
    assert.equal(capabilities.MONTH, 'ENABLED');
    assert.equal(capabilities.DAY, 'ENABLED');
    assert.equal(capabilities.WEEK, undefined);
    assert.equal(capabilities.MONTH_ROLLING, undefined);
    assert.equal(capabilities.NO_RESET, undefined);
  });

  it('returns an empty capability map by default (all reset expiry disabled)', () => {
    assert.deepEqual(resolveResetCapabilities({}), {});
  });
});
