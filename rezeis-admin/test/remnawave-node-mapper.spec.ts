import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapNode } from '../src/modules/remnawave/services/remnawave-node-mapper';

/**
 * The `required` array of a `GET /api/nodes` row, in the spec's own order —
 * identical in the 3.3.2 and 3.4.3 OpenAPI documents. The fixture below is held
 * to it, so a field the panel does not send cannot creep in to make the mapper
 * look right.
 */
const NODE_REQUIRED = [
  'uuid', 'id', 'name', 'address', 'port', 'proxyUrl', 'isConnected', 'isDisabled',
  'isConnecting', 'lastStatusChange', 'lastStatusMessage', 'isTrafficTrackingActive',
  'trafficResetDay', 'trafficLimitBytes', 'trafficUsedBytes', 'notifyPercent', 'viewPosition',
  'countryCode', 'consumptionMultiplier', 'nodeConsumptionMultiplier', 'tags', 'integrationUuids',
  'ips', 'createdAt', 'updatedAt', 'configProfile', 'providerUuid', 'provider', 'activePluginUuid',
  'system', 'versions', 'xrayUptime', 'usersOnline', 'note',
] as const;

/** A node row as a 3.3.2 / 3.4.3 panel sends it. */
const NODE_3X = {
  uuid: '6d1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
  id: 21,
  name: 'Latvia 03 MLCloud',
  address: '193.124.254.226',
  port: 41000,
  proxyUrl: null,
  isConnected: true,
  isDisabled: false,
  isConnecting: false,
  lastStatusChange: '2026-09-20T17:53:56.302Z',
  lastStatusMessage: null,
  isTrafficTrackingActive: false,
  trafficResetDay: 1,
  trafficLimitBytes: 0,
  trafficUsedBytes: 4219629121402,
  notifyPercent: 0,
  viewPosition: 21,
  countryCode: 'LV',
  consumptionMultiplier: 1,
  nodeConsumptionMultiplier: 1,
  tags: ['EU'],
  integrationUuids: [],
  ips: [{ ip: '193.124.254.226', status: 'INBOUND' }],
  createdAt: '2026-02-02T18:38:38.497Z',
  updatedAt: '2026-09-20T20:08:30.075Z',
  // NESTED, on every version the specs describe. Nothing puts it on the row.
  configProfile: {
    activeConfigProfileUuid: '4181b6ce-50c6-4d64-ad77-aac16ce0d2cb',
    activeInbounds: [
      {
        uuid: '8e2d1c0b-9a8f-4e7d-a6c5-b4a3928170f6',
        profileUuid: '4181b6ce-50c6-4d64-ad77-aac16ce0d2cb',
        tag: 'VLESS_REALITY',
        type: 'vless',
        network: 'tcp',
        security: 'reality',
        port: 443,
        rawInbound: null,
      },
    ],
  },
  providerUuid: null,
  provider: null,
  activePluginUuid: null,
  system: null,
  versions: { xray: '25.3.6', node: '2.1.4' },
  xrayUptime: 918273,
  usersOnline: 87,
  note: null,
};

describe('mapNode', () => {
  it('reads a node row as every supported panel sends it', () => {
    // The fixture is the panel's, not the mapper's: exactly the declared keys.
    assert.deepStrictEqual(Object.keys(NODE_3X), [...NODE_REQUIRED]);

    const result = mapNode(NODE_3X);

    assert.equal(result.uuid, '6d1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b');
    // The config profile the node serves lives in the `configProfile` block.
    assert.equal(result.activeConfigProfileUuid, '4181b6ce-50c6-4d64-ad77-aac16ce0d2cb');
    // The counters are on the row itself.
    assert.equal(result.xrayUptime, 918273);
    assert.equal(result.usersOnline, 87);
    assert.equal(result.trafficUsedBytes, 4219629121402);
    assert.deepEqual(result.tags, ['EU']);
    assert.deepEqual(result.ips, [{ ip: '193.124.254.226', status: 'INBOUND' }]);
  });

  it('reads no activeConfigProfileUuid off the row itself — no spec puts it there', () => {
    // An earlier reader preferred a top-level copy "on newer panels". No panel
    // sends one; the nested value is the answer, and a row with only a
    // top-level copy has none.
    const both = mapNode({
      uuid: 'node-2',
      activeConfigProfileUuid: 'top-level-uuid',
      configProfile: { activeConfigProfileUuid: 'nested-uuid' },
    });
    assert.equal(both.activeConfigProfileUuid, 'nested-uuid');
    assert.equal(mapNode({ uuid: 'node-2', activeConfigProfileUuid: 'top-level-uuid' }).activeConfigProfileUuid, null);
  });

  it('returns null for activeConfigProfileUuid when neither layout has it', () => {
    const result = mapNode({ uuid: 'node-3' });
    assert.equal(result.activeConfigProfileUuid, null);
    assert.deepEqual(result.ips, []);
  });

  it('maps the node IP status rows and drops one with no usable address', () => {
    const result = mapNode({
      uuid: 'node-323',
      ips: [
        { ip: '203.0.113.10', status: 'INBOUND' },
        { ip: '2001:db8::10', status: 'MANAGEMENT' },
        { ip: 123, status: 'BLOCKED' },
      ],
    });

    assert.deepEqual(result.ips, [
      { ip: '203.0.113.10', status: 'INBOUND' },
      { ip: '2001:db8::10', status: 'MANAGEMENT' },
    ]);
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
