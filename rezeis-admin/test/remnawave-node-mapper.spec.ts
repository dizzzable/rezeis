import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapNode } from '../src/modules/remnawave/services/remnawave-node-mapper';

describe('mapNode', () => {
  it('extracts activeConfigProfileUuid from the nested configProfile (Remnawave 2.7.x layout)', () => {
    const upstream = {
      uuid: 'node-1',
      name: 'Latvia 03 MLCloud',
      address: '193.124.254.226',
      port: 41000,
      isConnected: true,
      isDisabled: false,
      isConnecting: false,
      isTrafficTrackingActive: false,
      trafficResetDay: 1,
      trafficLimitBytes: 0,
      trafficUsedBytes: 4219629121402,
      notifyPercent: 0,
      viewPosition: 21,
      countryCode: 'LV',
      consumptionMultiplier: 1,
      tags: [],
      lastStatusChange: '2026-05-25T17:53:56.302Z',
      lastStatusMessage: null,
      createdAt: '2026-02-02T18:38:38.497Z',
      updatedAt: '2026-05-25T20:08:30.075Z',
      configProfile: {
        activeConfigProfileUuid: '4181b6ce-50c6-4d64-ad77-aac16ce0d2cb',
      },
    };

    const result = mapNode(upstream);

    assert.equal(result.uuid, 'node-1');
    assert.equal(result.activeConfigProfileUuid, '4181b6ce-50c6-4d64-ad77-aac16ce0d2cb');
    // Counters not exposed on /api/nodes in 2.7.x — defaults to 0.
    assert.equal(result.xrayUptime, 0);
    assert.equal(result.usersOnline, 0);
  });

  it('prefers the top-level activeConfigProfileUuid when present (newer panels)', () => {
    const result = mapNode({
      uuid: 'node-2',
      activeConfigProfileUuid: 'top-level-uuid',
      configProfile: { activeConfigProfileUuid: 'nested-uuid' },
    });
    assert.equal(result.activeConfigProfileUuid, 'top-level-uuid');
  });

  it('returns null for activeConfigProfileUuid when neither layout has it', () => {
    const result = mapNode({ uuid: 'node-3' });
    assert.equal(result.activeConfigProfileUuid, null);
  });

  it('coerces malformed types without throwing', () => {
    const result = mapNode({
      uuid: 123,
      port: '8080',
      tags: 'not-an-array',
      isConnected: 1,
      trafficLimitBytes: 'invalid',
    });
    assert.equal(result.uuid, '');
    assert.equal(result.port, 8080);
    assert.deepStrictEqual(result.tags, []);
    assert.equal(result.isConnected, true);
    assert.equal(result.trafficLimitBytes, null);
  });
});
