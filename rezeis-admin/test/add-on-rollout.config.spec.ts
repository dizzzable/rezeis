import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';

import {
  ADD_ON_ROLLOUT_FLAG_DEFAULTS,
  type AddOnRolloutFlagDefaults,
  type AddOnRolloutFlagName,
  parseFlag,
  resolveAddOnRolloutFlags,
  resolveResetCapabilities,
} from '../src/modules/add-on-entitlements/add-on-rollout.config';

/**
 * The defaults table with every stage ON, and with every stage OFF. Passed to
 * the REAL resolver, so what is proved here is what `resolveAddOnRolloutFlags`
 * does with an ON or an OFF default, whatever the shipped table holds — not
 * what `parseFlag` does on its own.
 */
const ALL_ON = Object.fromEntries(
  Object.keys(ADD_ON_ROLLOUT_FLAG_DEFAULTS).map((name) => [name, true]),
) as AddOnRolloutFlagDefaults;
const ALL_OFF = Object.fromEntries(
  Object.keys(ADD_ON_ROLLOUT_FLAG_DEFAULTS).map((name) => [name, false]),
) as AddOnRolloutFlagDefaults;

/** The owner's decision of 24.09.2026: stages 1, 2 and 6 ON, 3, 4 and 5 OFF. */
const SHIPPED: AddOnRolloutFlagDefaults = {
  ADDON_ENTITLEMENT_SHADOW: true,
  ADDON_ENTITLEMENT_DIRECT_PURCHASE: true,
  ADDON_PROJECTION_SYNC: false,
  ADDON_RENEWAL_ADDONS: false,
  ADDON_DEVICE_CLEANUP_AUTO: true,
  ADDON_RESET_EXPIRY_DAY: false,
  ADDON_RESET_EXPIRY_WEEK: false,
  ADDON_RESET_EXPIRY_MONTH: false,
  ADDON_RESET_EXPIRY_MONTH_ROLLING: false,
};

describe('add-on rollout flags', () => {
  it('ships stages 1, 2 and 6 ON and every other stage OFF', () => {
    // The whole table, keys included: a missing or an extra variable fails
    // here as surely as a flipped value.
    assert.deepEqual({ ...ADD_ON_ROLLOUT_FLAG_DEFAULTS }, SHIPPED);
  });

  it('resolves an empty environment to exactly that', () => {
    const flags = resolveAddOnRolloutFlags({});
    assert.equal(flags.entitlementShadow, true);
    assert.equal(flags.directPurchase, true);
    assert.equal(flags.projectionSync, false);
    assert.equal(flags.renewalAddOns, false);
    assert.equal(flags.deviceCleanupAuto, true);
    assert.deepEqual(flags.resetExpiry, { DAY: false, WEEK: false, MONTH: false, MONTH_ROLLING: false });
  });

  it('switches the shipped ON stages off with one explicit line each', () => {
    const flags = resolveAddOnRolloutFlags({
      ADDON_ENTITLEMENT_SHADOW: 'false',
      ADDON_ENTITLEMENT_DIRECT_PURCHASE: '0',
      ADDON_DEVICE_CLEANUP_AUTO: 'off',
    });
    assert.equal(flags.entitlementShadow, false);
    assert.equal(flags.directPurchase, false);
    assert.equal(flags.deviceCleanupAuto, false);
  });

  it('states every default where an operator reads it: .env.example and docs/environment.md', () => {
    // `.env.example` is copied into every install's `.env`, so each variable
    // is there COMMENTED OUT, spelled with its default — an uncommented line
    // would pin the value and the install would never see a later default.
    const example = readFileSync(join(__dirname, '..', '.env.example'), 'utf8');
    const environment = readFileSync(join(__dirname, '..', 'docs', 'environment.md'), 'utf8');
    for (const [name, value] of Object.entries(ADD_ON_ROLLOUT_FLAG_DEFAULTS) as Array<[AddOnRolloutFlagName, boolean]>) {
      assert.match(example, new RegExp(`^# ${name}=${value}\\r?$`, 'm'), `.env.example: # ${name}=${value}`);
      assert.doesNotMatch(example, new RegExp(`^${name}=`, 'm'), `.env.example must not set ${name}`);
      // The reference table names the stage flags one per row with the default
      // in the next cell; the reset strategies share one row.
      const row = name.startsWith('ADDON_RESET_EXPIRY_')
        ? /^\| `ADDON_RESET_EXPIRY_DAY` \/ `_WEEK` \/ `_MONTH` \/ `_MONTH_ROLLING` \| `(true|false)` \|/m
        : new RegExp(`^\\| \`${name}\` \\| \`(true|false)\` \\|`, 'm');
      assert.equal(environment.match(row)?.[1], String(value), `docs/environment.md: ${name} defaults to ${value}`);
    }
  });

  it('turns an OFF default ON for "true", "1", "on" or "yes", whatever the case or padding', () => {
    const flags = resolveAddOnRolloutFlags(
      {
        ADDON_ENTITLEMENT_SHADOW: 'true',
        ADDON_ENTITLEMENT_DIRECT_PURCHASE: '1',
        ADDON_PROJECTION_SYNC: 'yes',
        ADDON_RENEWAL_ADDONS: 'false',
        ADDON_DEVICE_CLEANUP_AUTO: '',
        ADDON_RESET_EXPIRY_DAY: ' TRUE ',
        ADDON_RESET_EXPIRY_WEEK: 'On',
        ADDON_RESET_EXPIRY_MONTH: 'enabled',
      },
      ALL_OFF,
    );
    assert.equal(flags.entitlementShadow, true);
    assert.equal(flags.directPurchase, true);
    assert.equal(flags.projectionSync, true, '"yes" is ON');
    assert.equal(flags.renewalAddOns, false);
    assert.equal(flags.deviceCleanupAuto, false);
    assert.equal(flags.resetExpiry.DAY, true);
    assert.equal(flags.resetExpiry.WEEK, true, '"On" is ON');
    assert.equal(flags.resetExpiry.MONTH, false, 'an unrecognised "enabled" keeps the OFF default');
  });

  it('turns an ON default OFF for an explicit "false", "0", "off" or "no", whatever the case or padding', () => {
    // Non-vacuity first: with nothing set, the ON defaults really are in force.
    const untouched = resolveAddOnRolloutFlags({}, ALL_ON);
    assert.equal(untouched.entitlementShadow, true);
    assert.equal(untouched.directPurchase, true);
    assert.equal(untouched.deviceCleanupAuto, true);
    assert.equal(untouched.resetExpiry.MONTH, true);

    // `off` and `no` too: after the flip, an operator who writes the stage off
    // in their own words must get it OFF, not the ON default.
    for (const off of ['false', '0', 'FALSE', ' False ', '0\t', 'off', ' OFF ', 'no', 'No']) {
      const flags = resolveAddOnRolloutFlags(
        {
          ADDON_ENTITLEMENT_SHADOW: off,
          ADDON_ENTITLEMENT_DIRECT_PURCHASE: off,
          ADDON_DEVICE_CLEANUP_AUTO: off,
          ADDON_RESET_EXPIRY_MONTH: off,
        },
        ALL_ON,
      );
      assert.equal(flags.entitlementShadow, false, JSON.stringify(off));
      assert.equal(flags.directPurchase, false, JSON.stringify(off));
      assert.equal(flags.deviceCleanupAuto, false, JSON.stringify(off));
      assert.equal(flags.resetExpiry.MONTH, false, JSON.stringify(off));
      // The variables left unset keep their ON default: the explicit value
      // turned off exactly what it named.
      assert.equal(flags.projectionSync, true);
      assert.equal(flags.renewalAddOns, true);
    }
  });

  it('keeps an ON default ON for unset, empty and unrecognised values', () => {
    for (const value of [undefined, '', '   ', 'enabled', 'disabled', 'offf', 'nope']) {
      const flags = resolveAddOnRolloutFlags({ ADDON_ENTITLEMENT_SHADOW: value }, ALL_ON);
      assert.equal(flags.entitlementShadow, true, JSON.stringify(value));
    }
  });

  it('warns once for each unrecognised value, and never for one it knows', () => {
    const warned: string[] = [];
    mock.method(Logger.prototype, 'warn', (message: unknown) => void warned.push(String(message)));
    try {
      // A value no other test reads: the "once" is kept per process.
      const odd = `maybe-${process.pid}-${Date.now()}`;
      for (let read = 0; read < 3; read += 1) {
        resolveAddOnRolloutFlags({ ADDON_ENTITLEMENT_SHADOW: odd, ADDON_DEVICE_CLEANUP_AUTO: 'off' }, ALL_ON);
      }
      assert.equal(warned.length, 1, warned.join('\n'));
      assert.match(warned[0]!, new RegExp(`ADDON_ENTITLEMENT_SHADOW="${odd}" is not a recognised value`));
      assert.match(warned[0]!, /using the default, ON/);
    } finally {
      mock.restoreAll();
    }
  });

  it('parseFlag answers against the default it is given', () => {
    assert.equal(parseFlag(undefined, true), true);
    assert.equal(parseFlag(undefined, false), false);
    assert.equal(parseFlag('0', true), false);
    assert.equal(parseFlag('1', false), true);
    assert.equal(parseFlag('maybe', true), true);
    assert.equal(parseFlag('maybe', false), false);
    assert.equal(parseFlag('yes', false), true);
    assert.equal(parseFlag('no', true), false);
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
