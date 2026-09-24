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
 * `/api/hwid/devices/stats` nests `byApp` inside every `byPlatform` entry and
 * has no top-level list (the 3.3.2 and 3.4.3 OpenAPI documents, and every 3.x
 * contract through 3.4.4). The 3.x case below is held to those documents'
 * `required` arrays, so the shape it proves is the panel's and not one invented
 * to fit the reader.
 */

const STATS = { totalUniqueDevices: 0, totalHwidDevices: 0, averageHwidDevicesPerUser: 0 };

/** `required`, in the spec's order, at each level — identical in 3.3.2 and 3.4.3. */
const STATS_REQUIRED = ['byPlatform', 'stats'] as const;
const PLATFORM_REQUIRED = ['platform', 'count', 'byApp'] as const;
const APP_REQUIRED = ['app', 'count'] as const;

describe('summariseHwidApps', () => {
  it('sums one app across every platform, where every supported panel nests byApp', () => {
    const answer = {
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
      stats: { totalUniqueDevices: 12, totalHwidDevices: 12, averageHwidDevicesPerUser: 1.2 },
    };
    assert.deepEqual(Object.keys(answer), [...STATS_REQUIRED]);
    for (const platform of answer.byPlatform) {
      assert.deepEqual(Object.keys(platform), [...PLATFORM_REQUIRED]);
      for (const app of platform.byApp) assert.deepEqual(Object.keys(app), [...APP_REQUIRED]);
    }

    assert.deepEqual(summariseHwidApps(answer), [
      { app: 'Happ', count: 8 },
      { app: 'v2rayNG', count: 4 },
    ]);
  });

  it('reads no top-level byApp — 2.7.x sent one, no supported panel does', () => {
    const apps = summariseHwidApps({
      byPlatform: [{ platform: 'Android', count: 6 }],
      byApp: [
        { app: 'Streisand', count: 2 },
        { app: 'Happ', count: 4 },
      ],
      stats: STATS,
    });

    assert.deepEqual(apps, []);
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
