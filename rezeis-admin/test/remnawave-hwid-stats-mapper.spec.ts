import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  summariseHwidApps,
  withHwidApps,
} from '../src/modules/remnawave/services/remnawave-hwid-stats-mapper';

/**
 * Devices per client app, for the dashboard's "which apps do our customers use"
 * ring.
 *
 * `/api/hwid/devices/stats` has sent `byApp` in two places: at the top level on
 * 2.7.x, nested inside every `byPlatform` entry on 2.8, 3.2, 3.4.2 and 3.4.3
 * (read off the vendored contracts and the 3.4.3 OpenAPI document). This
 * project serves both at once, so both are exercised here — and the case that
 * matters most is the one where a reader handles each shape correctly on its
 * own and still double-counts when it meets both.
 */

const STATS = { totalUniqueDevices: 0, totalHwidDevices: 0, averageHwidDevicesPerUser: 0 };

describe('summariseHwidApps', () => {
  it('sums one app across every platform on 2.8 and later, where byApp is nested', () => {
    const apps = summariseHwidApps({
      byPlatform: [
        {
          platform: 'Android',
          count: 7,
          byApp: [
            { app: 'v2rayNG', count: 4 },
            { app: 'Happ', count: 3 },
          ],
        },
        { platform: 'iOS', count: 5, byApp: [{ app: 'Happ', count: 5 }] },
      ],
      stats: STATS,
    });

    assert.deepEqual(apps, [
      { app: 'Happ', count: 8 },
      { app: 'v2rayNG', count: 4 },
    ]);
  });

  it('reads the top-level list that 2.7.x sends instead', () => {
    const apps = summariseHwidApps({
      byPlatform: [{ platform: 'Android', count: 6 }],
      byApp: [
        { app: 'Streisand', count: 2 },
        { app: 'Happ', count: 4 },
      ],
      stats: STATS,
    });

    assert.deepEqual(apps, [
      { app: 'Happ', count: 4 },
      { app: 'Streisand', count: 2 },
    ]);
  });

  it('never adds the two shapes together when a panel sends both', () => {
    // Four devices, reported twice. Summing both lists would draw eight.
    const apps = summariseHwidApps({
      byPlatform: [{ platform: 'Android', count: 4, byApp: [{ app: 'Happ', count: 4 }] }],
      byApp: [{ app: 'Happ', count: 4 }],
      stats: STATS,
    });

    assert.deepEqual(apps, [{ app: 'Happ', count: 4 }]);
  });

  it('merges spellings that differ only in case, keeping the first one seen', () => {
    const apps = summariseHwidApps({
      byPlatform: [
        { platform: 'Android', count: 2, byApp: [{ app: 'Happ', count: 2 }] },
        { platform: 'iOS', count: 3, byApp: [{ app: 'happ ', count: 3 }] },
      ],
    });

    assert.deepEqual(apps, [{ app: 'Happ', count: 5 }]);
  });

  it('keeps a device whose app has no name, under the empty string, rather than dropping it', () => {
    const apps = summariseHwidApps({
      byPlatform: [
        {
          platform: 'Windows',
          count: 3,
          byApp: [
            { app: '', count: 1 },
            { app: '   ', count: 1 },
            { count: 1 },
          ],
        },
      ],
    });

    assert.deepEqual(apps, [{ app: '', count: 3 }]);
  });

  it('ignores counts it cannot trust', () => {
    const apps = summariseHwidApps({
      byPlatform: [
        {
          platform: 'Android',
          count: 1,
          byApp: [
            { app: 'Happ', count: 1 },
            { app: 'Zero', count: 0 },
            { app: 'Negative', count: -2 },
            { app: 'NotANumber', count: Number.NaN },
            { app: 'Infinite', count: Number.POSITIVE_INFINITY },
            { app: 'AString', count: '3' },
            'not an object',
            null,
          ],
        },
      ],
    });

    assert.deepEqual(apps, [{ app: 'Happ', count: 1 }]);
  });

  it('orders by count and then by name, so two loads draw the same ring', () => {
    const apps = summariseHwidApps({
      byPlatform: [
        {
          platform: 'Android',
          count: 6,
          byApp: [
            { app: 'b-app', count: 2 },
            { app: 'a-app', count: 2 },
            { app: 'top', count: 5 },
          ],
        },
      ],
    });

    assert.deepEqual(
      apps.map((row) => row.app),
      ['top', 'a-app', 'b-app'],
    );
  });

  it('answers nothing for an answer that is not an object', () => {
    for (const raw of [null, undefined, [], 'text', 42]) {
      assert.deepEqual(summariseHwidApps(raw), [], `raw = ${JSON.stringify(raw)}`);
    }
  });
});

describe('withHwidApps', () => {
  it('adds apps beside what Remnawave sent and leaves the rest untouched', () => {
    const raw = {
      byPlatform: [{ platform: 'iOS', count: 2, byApp: [{ app: 'Happ', count: 2 }] }],
      stats: { totalUniqueDevices: 2, totalHwidDevices: 2, averageHwidDevicesPerUser: 1 },
    };

    const result = withHwidApps(raw) as typeof raw & { apps: unknown };

    assert.deepEqual(result.apps, [{ app: 'Happ', count: 2 }]);
    // The fraud detector puts `byPlatform` into its evidence verbatim; the
    // dashboard's addition must not reshape it.
    assert.deepEqual(result.byPlatform, raw.byPlatform);
    assert.deepEqual(result.stats, raw.stats);
  });

  it('passes a null answer through as null, which the screen reads as unavailable', () => {
    assert.equal(withHwidApps(null), null);
  });
});
