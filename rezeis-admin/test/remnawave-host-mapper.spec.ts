import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapHost } from '../src/modules/remnawave/services/remnawave-host-mapper';

/**
 * `mapHost` — a raw Remnawave host row → the shape the panel works with.
 *
 * WHY THIS FILE EXISTS, and why it exists HERE. The subscriber server list had
 * twenty-one passing specs and shipped completely broken: every customer saw
 * "no servers for this subscription" on every install. The cause was one line
 * in this mapper reading `configProfileInboundUuid` off the top level of a row
 * that nests it under `inbound`, so the field was null for every host that has
 * ever passed through here.
 *
 * The twenty-one specs could not have caught it. They build hosts from
 * `RemnawaveHostInterface` — the shape AFTER this mapper — so their fixtures
 * asserted the very value the mapper was failing to produce. The boundary where
 * a mistake was possible had no test at all; this is that boundary.
 *
 * So the payloads below are written as Remnawave actually sends them (the shape
 * in `@remnawave/backend-contract`'s `HostsSchema`), never as the interface
 * describes them. A fixture here that is built from the interface would put the
 * file straight back to guarding nothing.
 */

/** A host row shaped the way the panel sends it. */
const rawHost = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  uuid: 'host-de',
  viewPosition: 3,
  remark: 'Frankfurt 🇩🇪',
  address: 'de1.internal.example',
  port: 443,
  isDisabled: false,
  isHidden: false,
  securityLayer: 'TLS',
  tags: ['premium'],
  // Nested. This is the whole point of the file.
  inbound: {
    configProfileUuid: 'profile-1',
    configProfileInboundUuid: 'inbound-de',
  },
  nodes: ['node-de'],
  excludedInternalSquads: [],
  ...over,
});

describe('mapHost', () => {
  it('reads the config profile and inbound out of the nested `inbound` object', () => {
    // THE REGRESSION. Both were null for every host on every panel version, and
    // `buildServers` drops a host whose inbound uuid is null — which was all of
    // them, on every install, for every customer.
    const host = mapHost(rawHost());
    assert.equal(host.configProfileInboundUuid, 'inbound-de');
    assert.equal(host.configProfileUuid, 'profile-1');
  });

  it('still reads the top-level names when a row carries them there', () => {
    // The shape the previous author expected. Tolerating both is this mapper's
    // job, and a value found at the top level is unambiguous.
    const host = mapHost({
      uuid: 'host-flat',
      remark: 'Flat',
      configProfileUuid: 'profile-flat',
      configProfileInboundUuid: 'inbound-flat',
    });
    assert.equal(host.configProfileInboundUuid, 'inbound-flat');
    assert.equal(host.configProfileUuid, 'profile-flat');
  });

  it('prefers the nested value when a row somehow carries both', () => {
    const host = mapHost(
      rawHost({ configProfileInboundUuid: 'inbound-stale', configProfileUuid: 'profile-stale' }),
    );
    assert.equal(host.configProfileInboundUuid, 'inbound-de');
    assert.equal(host.configProfileUuid, 'profile-1');
  });

  it('answers null, not a crash, when the link is absent or unusable', () => {
    for (const inbound of [undefined, null, 'not-an-object', 42, [], {}]) {
      const host = mapHost(rawHost({ inbound }));
      assert.equal(
        host.configProfileInboundUuid,
        null,
        `\`inbound: ${JSON.stringify(inbound) ?? 'undefined'}\` should map to null`,
      );
    }
  });

  it('keeps the squads a host is excluded from', () => {
    // A host reaches a squad through its inbound EXCEPT for these. Listing one
    // of them would tell a customer they can use a server that is not in their
    // config at all.
    const host = mapHost(rawHost({ excludedInternalSquads: ['squad-b', 'squad-c'] }));
    assert.deepEqual(host.excludedInternalSquads, ['squad-b', 'squad-c']);
  });

  it('treats a missing exclusion list as no exclusions', () => {
    // Which is how a panel version that does not send the field behaves.
    for (const value of [undefined, null, 'squad-b', { squad: 'b' }]) {
      assert.deepEqual(mapHost(rawHost({ excludedInternalSquads: value })).excludedInternalSquads, []);
    }
    // And entries that are not usable squad uuids are dropped rather than kept,
    // because a non-string in that set would never match a squad uuid anyway
    // and only invites a `.has(undefined)` somewhere downstream.
    assert.deepEqual(
      mapHost(rawHost({ excludedInternalSquads: ['squad-b', '', null, 7, 'squad-c'] }))
        .excludedInternalSquads,
      ['squad-b', 'squad-c'],
    );
  });

  it('keeps reading everything else off the top level', () => {
    // The nesting is one pair of fields, not the whole row — a "fix" that moved
    // the rest under `inbound` too would break the host table instead.
    const host = mapHost(rawHost());
    assert.equal(host.uuid, 'host-de');
    assert.equal(host.remark, 'Frankfurt 🇩🇪');
    assert.equal(host.viewPosition, 3);
    assert.equal(host.isHidden, false);
    assert.equal(host.isDisabled, false);
    assert.deepEqual(host.nodes, ['node-de']);
    assert.deepEqual(host.tags, ['premium']);
    assert.equal(host.tag, 'premium');
  });

  it('survives a row that is not a row', () => {
    for (const value of [null, undefined, 'host', 42]) {
      const host = mapHost(value);
      assert.equal(host.uuid, '');
      assert.equal(host.configProfileInboundUuid, null);
      assert.deepEqual(host.excludedInternalSquads, []);
    }
  });
});
