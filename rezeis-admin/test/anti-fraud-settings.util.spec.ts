import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';

import {
  mergeAntiFraudSettings,
  readStoredAntiFraudSettings,
  resolveAntiFraudTunables,
  toAntiFraudSettingsView,
} from '../src/modules/settings/utils/anti-fraud-settings.util';

/** The documented defaults, restated here so a silent retune has to be typed out. */
const SHARING_DEFAULTS = {
  enableHwidOverage: true,
  enableIpSharing: false,
  ipWindowMinutes: 10,
  ipConcurrencyWindowSeconds: 180,
  maxNodesPerRun: 25,
  maxIpsInMetadata: 20,
  ipNetworkGrouping: true,
  ipV4PrefixLength: 24,
  ipV6PrefixLength: 48,
  ipOverageMargin: 1,
  // No env layer under these three — they are new, so nothing can already be
  // setting them and the built-in default is the whole fallback stack.
  enableSharedHwid: true,
  sharedHwidMinAccounts: 2,
  sharedHwidMaxAccounts: 10,
} as const;

const TRAFFIC_DEFAULTS = {
  enabled: true,
  minGb: 200,
  medianMultiplier: 4,
  sharePercent: 35,
  maxNodesPerRun: 25,
} as const;

/** Every numeric range's FLOOR — the shape of the bug this must never re-enter. */
const SHARING_FLOORS = {
  ipWindowMinutes: 1,
  ipConcurrencyWindowSeconds: 15,
  maxNodesPerRun: 1,
  maxIpsInMetadata: 1,
  ipV4PrefixLength: 8,
  ipV6PrefixLength: 16,
  ipOverageMargin: 0,
} as const;

const TRAFFIC_FLOORS = {
  minGb: 1,
  medianMultiplier: 1.5,
  sharePercent: 5,
  maxNodesPerRun: 1,
} as const;

describe('resolveAntiFraudTunables — precedence', () => {
  it('falls back to the documented defaults when nothing is stored and no env is set', () => {
    const tunables = resolveAntiFraudTunables({}, {});
    assert.deepEqual(tunables.sharing, SHARING_DEFAULTS);
    assert.deepEqual(tunables.trafficAbuse, TRAFFIC_DEFAULTS);
  });

  it('still honours the environment when nothing is stored', () => {
    const tunables = resolveAntiFraudTunables(
      {},
      {
        ANTIFRAUD_SHARING_IP_ENABLED: 'true',
        ANTIFRAUD_SHARING_IP_WINDOW_MINUTES: '30',
        ANTIFRAUD_NODE_TRAFFIC_MIN_GB: '500',
        ANTIFRAUD_NODE_TRAFFIC_USER_ENABLED: 'false',
      },
    );
    assert.equal(tunables.sharing.enableIpSharing, true);
    assert.equal(tunables.sharing.ipWindowMinutes, 30);
    assert.equal(tunables.trafficAbuse.minGb, 500);
    assert.equal(tunables.trafficAbuse.enabled, false);
    // Untouched knobs keep their defaults, not their floors.
    assert.equal(tunables.sharing.maxNodesPerRun, SHARING_DEFAULTS.maxNodesPerRun);
    assert.equal(tunables.trafficAbuse.medianMultiplier, TRAFFIC_DEFAULTS.medianMultiplier);
  });

  it('lets a stored panel value beat the environment variable', () => {
    const env = {
      ANTIFRAUD_SHARING_IP_WINDOW_MINUTES: '30',
      ANTIFRAUD_SHARING_HWID_ENABLED: 'true',
      ANTIFRAUD_NODE_TRAFFIC_MIN_GB: '500',
      ANTIFRAUD_NODE_TRAFFIC_USER_ENABLED: 'true',
    };
    const tunables = resolveAntiFraudTunables(
      {
        sharing: { ipWindowMinutes: 45, enableHwidOverage: false },
        trafficAbuse: { minGb: 750, enabled: false },
      },
      env,
    );
    assert.equal(tunables.sharing.ipWindowMinutes, 45, 'panel value wins over env');
    assert.equal(tunables.sharing.enableHwidOverage, false, 'a stored false beats an env true');
    assert.equal(tunables.trafficAbuse.minGb, 750);
    assert.equal(tunables.trafficAbuse.enabled, false);
  });

  it('leaves un-stored siblings on the env value rather than resetting them', () => {
    const tunables = resolveAntiFraudTunables(
      { sharing: { ipWindowMinutes: 45 } },
      { ANTIFRAUD_SHARING_IP_OVERAGE_MARGIN: '3' },
    );
    assert.equal(tunables.sharing.ipWindowMinutes, 45);
    assert.equal(tunables.sharing.ipOverageMargin, 3, 'a partial patch is not a whole-config write');
  });
});

describe('resolveAntiFraudTunables — a bad stored value never becomes a range floor', () => {
  /**
   * This is the regression guard for the defect `traffic-abuse.config.ts` shipped:
   * an unusable value reaching a `< min` clamp and silently retuning the detector
   * to its most aggressive setting. Every unusable shape must land on the
   * FALLBACK, and specifically not on the floor.
   */
  /** Shapes that are unusable for every knob, whatever its range. */
  const unusable: readonly unknown[] = [
    undefined,
    null,
    '',
    '   ',
    'lots',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    {},
    [],
    true,
  ];

  it('discards every unusable sharing value in favour of the default', () => {
    for (const key of Object.keys(SHARING_FLOORS) as (keyof typeof SHARING_FLOORS)[]) {
      // `floor - 1` is below the bound for every knob, so it is the one number
      // that would come back AS the floor under a clamp.
      for (const value of [...unusable, SHARING_FLOORS[key] - 1]) {
        const tunables = resolveAntiFraudTunables({ sharing: { [key]: value } } as never, {});
        assert.equal(
          tunables.sharing[key],
          SHARING_DEFAULTS[key],
          `sharing.${key} = ${JSON.stringify(value)} must fall back to the default`,
        );
        if (SHARING_DEFAULTS[key] !== SHARING_FLOORS[key]) {
          assert.notEqual(
            tunables.sharing[key],
            SHARING_FLOORS[key],
            `sharing.${key} = ${JSON.stringify(value)} collapsed to its range floor`,
          );
        }
      }
    }
  });

  it('discards every unusable traffic-abuse value in favour of the default', () => {
    for (const key of Object.keys(TRAFFIC_FLOORS) as (keyof typeof TRAFFIC_FLOORS)[]) {
      for (const value of [...unusable, TRAFFIC_FLOORS[key] - 1]) {
        const tunables = resolveAntiFraudTunables({ trafficAbuse: { [key]: value } } as never, {});
        assert.equal(
          tunables.trafficAbuse[key],
          TRAFFIC_DEFAULTS[key],
          `trafficAbuse.${key} = ${JSON.stringify(value)} must fall back to the default`,
        );
        assert.notEqual(
          tunables.trafficAbuse[key],
          TRAFFIC_FLOORS[key],
          `trafficAbuse.${key} = ${JSON.stringify(value)} collapsed to its range floor`,
        );
      }
    }
  });

  it('discards an out-of-range stored value rather than clamping it to the bound', () => {
    const tunables = resolveAntiFraudTunables(
      { sharing: { ipWindowMinutes: 99_999 }, trafficAbuse: { medianMultiplier: 0.1 } },
      {},
    );
    assert.equal(tunables.sharing.ipWindowMinutes, 10, 'not clamped to the 1440 ceiling');
    assert.equal(tunables.trafficAbuse.medianMultiplier, 4, 'not clamped to the 1.5 floor');
  });

  it('discards a fraction where the environment path could only produce an integer', () => {
    const tunables = resolveAntiFraudTunables({ sharing: { maxNodesPerRun: 12.5 } }, {});
    assert.equal(tunables.sharing.maxNodesPerRun, 25);
  });

  it('keeps a stored value that sits exactly on a bound', () => {
    const tunables = resolveAntiFraudTunables(
      { sharing: { ipOverageMargin: 0, ipWindowMinutes: 1440 }, trafficAbuse: { minGb: 1 } },
      {},
    );
    assert.equal(tunables.sharing.ipOverageMargin, 0, '0 is a legitimate margin, not "unset"');
    assert.equal(tunables.sharing.ipWindowMinutes, 1440);
    assert.equal(tunables.trafficAbuse.minGb, 1);
  });
});

describe('readStoredAntiFraudSettings', () => {
  it('returns an empty patch for a null / non-object column', () => {
    assert.deepEqual(readStoredAntiFraudSettings(null), {});
    assert.deepEqual(readStoredAntiFraudSettings('nope'), {});
    assert.deepEqual(readStoredAntiFraudSettings([1, 2]), {});
    assert.deepEqual(readStoredAntiFraudSettings({}), {});
  });

  it('keeps only the known keys, of the right primitive type', () => {
    const stored = readStoredAntiFraudSettings({
      sharing: { ipWindowMinutes: 45, enableIpSharing: true, bogus: 7, maxNodesPerRun: 'ten' },
      trafficAbuse: { minGb: 750 },
      somethingElse: { a: 1 },
    });
    assert.deepEqual(stored, {
      sharing: { enableIpSharing: true, ipWindowMinutes: 45 },
      trafficAbuse: { minGb: 750 },
    });
  });

  it('never invents a section that is not in the column', () => {
    const stored = readStoredAntiFraudSettings({ sharing: { ipWindowMinutes: 45 } });
    assert.equal(stored.trafficAbuse, undefined);
  });
});

describe('mergeAntiFraudSettings — rejects, never clamps', () => {
  it('stores a valid value', () => {
    const next = mergeAntiFraudSettings({}, { sharing: { ipWindowMinutes: 45 } });
    assert.deepEqual(next, { sharing: { ipWindowMinutes: 45 } });
  });

  it('rejects an out-of-range number with a message naming the field and its range', () => {
    assert.throws(
      () => mergeAntiFraudSettings({}, { sharing: { ipWindowMinutes: 0 } }),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        const message = (error as BadRequestException).message;
        assert.match(message, /antiFraudSettings\.sharing\.ipWindowMinutes/);
        assert.match(message, /between 1 and 1440/);
        assert.match(message, /received 0/);
        return true;
      },
      'an out-of-range value must 400, not silently become the floor',
    );
  });

  it('rejects a fraction for an integer-only knob', () => {
    assert.throws(
      () => mergeAntiFraudSettings({}, { sharing: { maxNodesPerRun: 12.5 } }),
      /must be an integer between 1 and 500/,
    );
  });

  it('rejects a non-number and a non-boolean', () => {
    assert.throws(
      () => mergeAntiFraudSettings({}, { trafficAbuse: { minGb: 'lots' as never } }),
      /antiFraudSettings\.trafficAbuse\.minGb must be a number between 1 and 100000/,
    );
    assert.throws(
      () => mergeAntiFraudSettings({}, { sharing: { enableIpSharing: 'yes' as never } }),
      /antiFraudSettings\.sharing\.enableIpSharing must be a boolean/,
    );
  });

  it('rejects a value the reader would have discarded, so the two can never disagree', () => {
    // Everything the overlay refuses must also be refused at the door — otherwise
    // an operator could save a number, see it accepted, and have it quietly ignored.
    for (const bad of [0, -1, 1441, 12.5, Number.NaN]) {
      assert.throws(
        () => mergeAntiFraudSettings({}, { sharing: { ipWindowMinutes: bad } }),
        BadRequestException,
        `ipWindowMinutes=${bad} was accepted by the writer but is ignored by the reader`,
      );
    }
  });

  it('holds the subscription-UA section to the same rules as its neighbours', () => {
    assert.deepEqual(
      mergeAntiFraudSettings(
        {},
        { subscriptionUa: { enableSubscriptionUaTunnel: true, uaRequestPageSize: 1200 } },
      ),
      { subscriptionUa: { enableSubscriptionUaTunnel: true, uaRequestPageSize: 1200 } },
    );
    assert.throws(
      () => mergeAntiFraudSettings({}, { subscriptionUa: { uaRequestPageSize: 50 } }),
      /antiFraudSettings\.subscriptionUa\.uaRequestPageSize must be an integer between 100 and 2000/,
    );
    assert.throws(
      () => mergeAntiFraudSettings({}, { subscriptionUa: { uaEvidenceWindowMinutes: 361 } }),
      /antiFraudSettings\.subscriptionUa\.uaEvidenceWindowMinutes must be an integer between 15 and 360/,
    );
    assert.throws(
      () =>
        mergeAntiFraudSettings(
          {},
          { subscriptionUa: { enableSubscriptionUaTunnel: 'on' as never } },
        ),
      /antiFraudSettings\.subscriptionUa\.enableSubscriptionUaTunnel must be a boolean/,
    );
    // Cleared → back to the built-in default, which is OFF. Nothing about
    // clearing a stored value may leave the detector running.
    const cleared = mergeAntiFraudSettings(
      { subscriptionUa: { enableSubscriptionUaTunnel: true } },
      { subscriptionUa: { enableSubscriptionUaTunnel: null } },
    );
    assert.deepEqual(cleared, {});
    assert.equal(
      resolveAntiFraudTunables(cleared, {}).subscriptionUa.enableSubscriptionUaTunnel,
      false,
    );
  });

  it('clears a field back to the environment when the patch sends null', () => {
    const previous = { sharing: { ipWindowMinutes: 45, enableIpSharing: true } };
    const next = mergeAntiFraudSettings(previous, { sharing: { ipWindowMinutes: null } });
    assert.deepEqual(next, { sharing: { enableIpSharing: true } });
    assert.equal(
      resolveAntiFraudTunables(next, { ANTIFRAUD_SHARING_IP_WINDOW_MINUTES: '30' }).sharing
        .ipWindowMinutes,
      30,
      'a cleared field falls back to the env variable',
    );
  });

  it('drops the whole section once its last field is cleared', () => {
    const next = mergeAntiFraudSettings(
      { sharing: { ipWindowMinutes: 45 } },
      { sharing: { ipWindowMinutes: null } },
    );
    assert.deepEqual(next, {});
  });

  it('leaves untouched fields and the other section alone', () => {
    const previous = { sharing: { ipWindowMinutes: 45 }, trafficAbuse: { minGb: 750 } };
    const next = mergeAntiFraudSettings(previous, { sharing: { ipOverageMargin: 2 } });
    assert.deepEqual(next, {
      sharing: { ipWindowMinutes: 45, ipOverageMargin: 2 },
      trafficAbuse: { minGb: 750 },
    });
    assert.deepEqual(previous, { sharing: { ipWindowMinutes: 45 }, trafficAbuse: { minGb: 750 } });
  });
});

describe('toAntiFraudSettingsView', () => {
  it('shows the effective value, the env fallback behind it, and which fields the panel owns', () => {
    const view = toAntiFraudSettingsView(
      { sharing: { ipWindowMinutes: 45 } },
      { ANTIFRAUD_SHARING_IP_WINDOW_MINUTES: '30', ANTIFRAUD_NODE_TRAFFIC_MIN_GB: '500' },
    );
    assert.equal(view.effective.sharing.ipWindowMinutes, 45);
    assert.equal(view.fallback.sharing.ipWindowMinutes, 30, 'the env value stays visible');
    assert.deepEqual(view.overridden.sharing, ['ipWindowMinutes']);
    assert.deepEqual(view.overridden.trafficAbuse, []);
    assert.equal(view.effective.trafficAbuse.minGb, 500, 'not overridden → env value is effective');
  });

  it('does not report a field as overridden when its stored value is unusable', () => {
    const view = toAntiFraudSettingsView(
      { sharing: { ipWindowMinutes: 99_999 } },
      { ANTIFRAUD_SHARING_IP_WINDOW_MINUTES: '30' },
    );
    assert.deepEqual(view.overridden.sharing, [], 'a discarded value is not "in force"');
    assert.equal(view.effective.sharing.ipWindowMinutes, 30);
  });

  it('reports nothing as overridden on a fresh install', () => {
    const view = toAntiFraudSettingsView({}, {});
    assert.deepEqual(view.overridden, { sharing: [], trafficAbuse: [], subscriptionUa: [] });
    assert.deepEqual(view.effective, view.fallback);
  });

  it('serves the subscription-UA section from its default, with no env layer under it', () => {
    // The other two sections read the environment; this one has no
    // `ANTIFRAUD_UA_*` variable at all, so its `fallback` is the built-in
    // default whatever the environment says. A future env layer added here
    // without deciding what it means would fail this.
    const view = toAntiFraudSettingsView(
      {},
      { ANTIFRAUD_UA_ENABLED: 'true', ANTIFRAUD_UA_EVIDENCE_WINDOW_MINUTES: '300' },
    );
    assert.deepEqual(view.fallback.subscriptionUa, {
      enableSubscriptionUaTunnel: false,
      uaEvidenceWindowMinutes: 60,
      uaRequestPageSize: 500,
    });
    assert.equal(
      view.effective.subscriptionUa.enableSubscriptionUaTunnel,
      false,
      'a detector that accuses a customer does not switch itself on',
    );

    const stored = toAntiFraudSettingsView(
      { subscriptionUa: { enableSubscriptionUaTunnel: true, uaRequestPageSize: 2000 } },
      {},
    );
    assert.equal(stored.effective.subscriptionUa.enableSubscriptionUaTunnel, true);
    assert.equal(stored.effective.subscriptionUa.uaRequestPageSize, 2000);
    assert.equal(
      stored.effective.subscriptionUa.uaEvidenceWindowMinutes,
      60,
      'an un-stored sibling stays on its default',
    );
    assert.deepEqual(stored.overridden.subscriptionUa, [
      'enableSubscriptionUaTunnel',
      'uaRequestPageSize',
    ]);
  });

  it('ships the documented bounds so the form never restates them', () => {
    const { ranges } = toAntiFraudSettingsView({}, {});
    // Every numeric knob the form renders must arrive with its bounds, and the
    // bounds must be the ones the config files declare — this is the wire that
    // stops the SPA's `min`/`max` from drifting away from the validator's.
    assert.deepEqual(ranges.sharing.ipWindowMinutes, {
      default: 10,
      min: 1,
      max: 1440,
      integer: true,
    });
    assert.deepEqual(ranges.trafficAbuse.medianMultiplier, {
      default: 4,
      min: 1.5,
      max: 100,
      integer: false,
    });
    assert.deepEqual(Object.keys(ranges.sharing).sort(), [
      'ipConcurrencyWindowSeconds',
      'ipOverageMargin',
      'ipV4PrefixLength',
      'ipV6PrefixLength',
      'ipWindowMinutes',
      'maxIpsInMetadata',
      'maxNodesPerRun',
      'sharedHwidMaxAccounts',
      'sharedHwidMinAccounts',
    ]);
    assert.deepEqual(Object.keys(ranges.trafficAbuse).sort(), [
      'maxNodesPerRun',
      'medianMultiplier',
      'minGb',
      'sharePercent',
    ]);
    assert.deepEqual(ranges.subscriptionUa.uaEvidenceWindowMinutes, {
      default: 60,
      min: 15,
      max: 360,
      integer: true,
    });
    assert.deepEqual(ranges.subscriptionUa.uaRequestPageSize, {
      default: 500,
      min: 100,
      max: 2000,
      integer: true,
    });
    assert.deepEqual(Object.keys(ranges.subscriptionUa).sort(), [
      'uaEvidenceWindowMinutes',
      'uaRequestPageSize',
    ]);
  });
});
