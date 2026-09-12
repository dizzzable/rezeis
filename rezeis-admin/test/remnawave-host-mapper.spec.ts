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

  it('keeps the squads a host is excluded from, the way panels before 3.4 say it', () => {
    // A host reaches a squad through its inbound EXCEPT for these. Listing one
    // of them would tell a customer they can use a server that is not in their
    // config at all.
    const host = mapHost(rawHost({ excludedInternalSquads: ['squad-b', 'squad-c'] }));
    assert.deepEqual(host.internalSquads, { mode: 'exclude', squads: ['squad-b', 'squad-c'] });
  });

  it('reads the 3.4 shape, in both of its directions', () => {
    // 3.4 renamed the field and gave it a mode. `ALLOW_ONLY` is the direction
    // that did not exist before: the listed squads are the ONLY ones served,
    // so reading it as the old array would show the host to everyone else.
    assert.deepEqual(
      mapHost(rawHost({ internalSquads: { mode: 'ALLOW_ONLY', squads: ['squad-vip'] } }))
        .internalSquads,
      { mode: 'allow-only', squads: ['squad-vip'] },
    );
    assert.deepEqual(
      mapHost(rawHost({ internalSquads: { mode: 'EXCLUDE', squads: ['squad-b'] } })).internalSquads,
      { mode: 'exclude', squads: ['squad-b'] },
    );
    // Junk inside the object is dropped exactly as it is in the flat array.
    assert.deepEqual(
      mapHost(rawHost({ internalSquads: { mode: 'ALLOW_ONLY', squads: ['a', '', null, 7, 'b'] } }))
        .internalSquads,
      { mode: 'allow-only', squads: ['a', 'b'] },
    );
  });

  it('prefers the 3.4 shape when a row carries both, and reads an unknown mode as an exclusion', () => {
    // Both at once is not a panel we ship against, but the newer field is what
    // a newer panel means, so it wins.
    assert.deepEqual(
      mapHost(
        rawHost({
          internalSquads: { mode: 'ALLOW_ONLY', squads: ['squad-vip'] },
          excludedInternalSquads: ['squad-b'],
        }),
      ).internalSquads,
      { mode: 'allow-only', squads: ['squad-vip'] },
    );
    // A direction Remnawave has not shipped yet can only be guessed at, and
    // the two guesses are not equally safe: read as an exclusion it may show a
    // server to a squad that should not have it, read as an allow list it
    // hides a working server from everyone else.
    assert.deepEqual(
      mapHost(rawHost({ internalSquads: { mode: 'SOMETHING_NEW', squads: ['squad-b'] } }))
        .internalSquads,
      { mode: 'exclude', squads: ['squad-b'] },
    );
  });

  it('reads an ALLOW_ONLY with an empty list as "nobody", not as "no restriction"', () => {
    // THE FRIENDLY GUESS THIS FILE EXISTS TO FORBID. Collapsing an empty allow
    // list to `exclude` is the reading that looks kind and is wrong: the host
    // would then be shown to every customer, when its operator listed nobody.
    // Remnawave's own query answers false for every squad here. Note the
    // fixture also carries `excludedInternalSquads: []`, so a mapper that let
    // this fall through to the legacy branch would produce the same `squads`
    // and differ only in `mode` — which is exactly what is asserted.
    assert.deepEqual(
      mapHost(rawHost({ internalSquads: { mode: 'ALLOW_ONLY', squads: [] } })).internalSquads,
      { mode: 'allow-only', squads: [] },
    );
  });

  it('falls back to the legacy array when the 3.4 rule arrives in half', () => {
    // 3.4 marks BOTH keys required, so half a rule is not something a newer
    // panel sent — it is a proxy that dropped a key, or a row edited by hand.
    // The legacy array is then the only rule we actually received, and keeping
    // it beats inventing one. The direction matters most for the first case:
    // `ALLOW_ONLY` paired with a list we cannot read would otherwise mean
    // "allowed to nobody" and hide a working server from EVERY customer.
    const legacy = ['squad-b'];
    for (const internalSquads of [
      { mode: 'ALLOW_ONLY' },
      { mode: 'ALLOW_ONLY', squads: null },
      { mode: 'ALLOW_ONLY', squads: 'squad-vip' },
      { squads: ['squad-vip'] },
      {},
      [],
      null,
      'ALLOW_ONLY',
    ]) {
      assert.deepEqual(
        mapHost(rawHost({ internalSquads, excludedInternalSquads: legacy })).internalSquads,
        { mode: 'exclude', squads: legacy },
        `\`internalSquads: ${JSON.stringify(internalSquads) ?? 'undefined'}\` is not a rule`,
      );
    }
  });

  it('treats a missing rule as no restriction', () => {
    // Which is how a panel version that sends neither shape behaves, and what
    // Remnawave's own column defaults to: EXCLUDE with nothing listed.
    for (const value of [undefined, null, 'squad-b', { squad: 'b' }]) {
      assert.deepEqual(mapHost(rawHost({ excludedInternalSquads: value })).internalSquads, {
        mode: 'exclude',
        squads: [],
      });
    }
    // And entries that are not usable squad uuids are dropped rather than kept,
    // because a non-string in that set would never match a squad uuid anyway
    // and only invites a `.has(undefined)` somewhere downstream.
    assert.deepEqual(
      mapHost(rawHost({ excludedInternalSquads: ['squad-b', '', null, 7, 'squad-c'] }))
        .internalSquads.squads,
      ['squad-b', 'squad-c'],
    );
  });

  it('keeps the subscription formats a host is kept out of', () => {
    // Out of all six, the host reaches no app and leaves the customer's list;
    // a panel version that does not send the field excludes nothing.
    const host = mapHost(rawHost({ excludeFromSubscriptionTypes: ['SINGBOX', 'CLASH'] }));
    assert.deepEqual(host.excludeFromSubscriptionTypes, ['SINGBOX', 'CLASH']);
    for (const value of [undefined, null, 'SINGBOX', { SINGBOX: true }]) {
      assert.deepEqual(
        mapHost(rawHost({ excludeFromSubscriptionTypes: value })).excludeFromSubscriptionTypes,
        [],
      );
    }
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
      assert.deepEqual(host.internalSquads, { mode: 'exclude', squads: [] });
    }
  });
});

describe('mapHost — the customer-facing description', () => {
  it('reads the line the operator wrote for customers', () => {
    const host = mapHost({ uuid: 'h', remark: 'Germany 07 D', serverDescription: 'Германия' });
    assert.equal(host.serverDescription, 'Германия');
    assert.equal(host.remark, 'Germany 07 D');
  });

  it('maps a missing or non-string description to null rather than inventing one', () => {
    assert.equal(mapHost({ uuid: 'h', remark: 'x' }).serverDescription, null);
    assert.equal(mapHost({ uuid: 'h', remark: 'x', serverDescription: 42 }).serverDescription, null);
  });
});
