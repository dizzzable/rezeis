import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RemnawaveHostInterface } from '../src/modules/remnawave/interfaces/remnawave-host.interface';
import { RemnawaveNodeInterface } from '../src/modules/remnawave/interfaces/remnawave-node.interface';
import { RemnawaveInternalSquadDetailInterface } from '../src/modules/remnawave/interfaces/remnawave-squad-detail.interface';
import { mapInternalSquadDetails } from '../src/modules/remnawave/services/remnawave-squad-mappers';
import {
  buildServers,
  pickRecommended,
} from '../src/modules/remnawave/services/subscriber-servers.service';
import {
  countryCodeFromFlag,
  extractFlag,
  resolveHostCountry,
} from '../src/modules/remnawave/utils/host-flag.util';

/**
 * The subscriber-facing server list: what reaches the customer, and what may
 * never reach them.
 *
 * The list is assembled from three panel-wide arrays and one column of ours,
 * and every interesting decision is a filter. A filter that silently stops
 * filtering still returns a list, still renders, and still looks correct — the
 * failure is that it contains something extra. So the assertions below are
 * mostly about absence, and each of them was written after checking it goes red
 * when the corresponding line is removed.
 *
 * The sharpest of them is the last group. `inbounds[*].rawInbound` carries raw
 * Reality keys and public/private keypairs, and the mapper that now reads an
 * inbound's UUID sits one careless spread away from carrying the rest of the
 * row into a response a customer receives.
 */

const host = (over: Partial<RemnawaveHostInterface> = {}): RemnawaveHostInterface => ({
  uuid: 'host-1',
  viewPosition: 1,
  remark: 'Frankfurt 🇩🇪',
  address: 'de1.internal.example',
  port: 443,
  isDisabled: false,
  isHidden: false,
  securityLayer: 'DEFAULT',
  tag: null,
  tags: [],
  configProfileUuid: 'profile-1',
  configProfileInboundUuid: 'inbound-de',
  nodes: ['node-de'],
  ...over,
});

const node = (over: Partial<RemnawaveNodeInterface> = {}): RemnawaveNodeInterface => ({
  uuid: 'node-de',
  name: 'de-1.hetzner',
  address: '10.0.0.1',
  port: 2222,
  isConnected: true,
  isDisabled: false,
  isConnecting: false,
  isTrafficTrackingActive: false,
  trafficResetDay: null,
  trafficLimitBytes: null,
  trafficUsedBytes: null,
  notifyPercent: null,
  viewPosition: 1,
  countryCode: 'DE',
  consumptionMultiplier: 1,
  tags: [],
  lastStatusChange: null,
  lastStatusMessage: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  xrayUptime: 86_400,
  usersOnline: 7,
  activeConfigProfileUuid: 'profile-1',
  ips: [{ ip: '203.0.113.10', status: 'ACTIVE' }],
  ...over,
});

const squad = (
  over: Partial<RemnawaveInternalSquadDetailInterface> = {},
): RemnawaveInternalSquadDetailInterface => ({
  uuid: 'squad-eu',
  name: 'EU',
  viewPosition: 1,
  membersCount: 10,
  inboundsCount: 1,
  inboundUuids: ['inbound-de'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('host flags', () => {
  it('reads the flag the operator typed into the name', () => {
    assert.equal(extractFlag('Frankfurt · Основной 🇩🇪'), '🇩🇪');
    assert.equal(extractFlag('Smart-Авто 🇪🇺'), '🇪🇺');
    assert.equal(extractFlag('Frankfurt'), null);
  });

  it('ignores emoji that are not a flag', () => {
    // A lone Regional Indicator renders as a letter tile, and ⚡ is not one at
    // all. Treating either as a flag would put a marker in the wrong place.
    assert.equal(extractFlag('Fast ⚡ node'), null);
    assert.equal(extractFlag('Region 🇩'), null);
  });

  it('decodes a flag back into its country code', () => {
    assert.equal(countryCodeFromFlag('🇩🇪'), 'DE');
    assert.equal(countryCodeFromFlag('🇳🇱'), 'NL');
    // The balancer case. `EU` is a real indicator pair and not a country: the
    // code comes back honestly and the cabinet finds no point for it, which is
    // the intended outcome — a balancer is a choice, not a place.
    assert.equal(countryCodeFromFlag('🇪🇺'), 'EU');
  });

  it('prefers the name over the node, and falls back when the name is bare', () => {
    assert.deepEqual(resolveHostCountry('Frankfurt 🇩🇪', ['NL']), {
      flag: '🇩🇪',
      countryCode: 'DE',
    });
    assert.deepEqual(resolveHostCountry('Frankfurt', ['NL']), {
      flag: '🇳🇱',
      countryCode: 'NL',
    });
    assert.deepEqual(resolveHostCountry('Frankfurt', []), {
      flag: null,
      countryCode: null,
    });
  });

  it('gives two hosts under the same flag the same country and keeps both', () => {
    // The owner's actual setup: several German hosts, each named with 🇩🇪.
    // Nothing here may collapse them into one entry.
    const servers = buildServers(['squad-eu'], {
      hosts: [
        host({ uuid: 'a', remark: 'Frankfurt 🇩🇪', viewPosition: 1 }),
        host({ uuid: 'b', remark: 'Nürnberg 🇩🇪', viewPosition: 2 }),
      ],
      nodes: [node()],
      squads: [squad()],
    });
    assert.deepEqual(servers.map((s) => s.id), ['a', 'b']);
    assert.equal(servers.every((s) => s.countryCode === 'DE'), true);
  });
});

describe('which servers a subscription reaches', () => {
  it('keeps only hosts whose inbound belongs to one of its squads', () => {
    const servers = buildServers(['squad-eu'], {
      hosts: [
        host({ uuid: 'mine', configProfileInboundUuid: 'inbound-de' }),
        host({ uuid: 'theirs', configProfileInboundUuid: 'inbound-us' }),
      ],
      nodes: [node()],
      squads: [
        squad(),
        squad({ uuid: 'squad-us', inboundUuids: ['inbound-us'] }),
      ],
    });
    assert.deepEqual(servers.map((s) => s.id), ['mine']);
  });

  it('returns nothing when the subscription has no squads', () => {
    assert.equal(buildServers([], { hosts: [host()], nodes: [node()], squads: [squad()] }).length, 0);
  });

  it('drops hidden and disabled hosts', () => {
    // Neither is in the customer's generated config, so neither is a server
    // "available to them" — listing one as merely offline is a different claim.
    const servers = buildServers(['squad-eu'], {
      hosts: [
        host({ uuid: 'visible' }),
        host({ uuid: 'hidden', isHidden: true }),
        host({ uuid: 'off', isDisabled: true }),
      ],
      nodes: [node()],
      squads: [squad()],
    });
    assert.deepEqual(servers.map((s) => s.id), ['visible']);
  });

  it('keeps the operator’s own ordering', () => {
    const servers = buildServers(['squad-eu'], {
      hosts: [
        host({ uuid: 'third', viewPosition: 3 }),
        host({ uuid: 'first', viewPosition: 1 }),
        host({ uuid: 'second', viewPosition: 2 }),
      ],
      nodes: [node()],
      squads: [squad()],
    });
    assert.deepEqual(servers.map((s) => s.id), ['first', 'second', 'third']);
  });
});

describe('what each server reports', () => {
  const oneHost = (nodes: RemnawaveNodeInterface[], hostOver = {}) =>
    buildServers(['squad-eu'], {
      hosts: [host({ nodes: nodes.map((n) => n.uuid), ...hostOver })],
      nodes,
      squads: [squad()],
    })[0];

  it('is online when any node is connected, and reports the longest uptime', () => {
    const server = oneHost([
      node({ uuid: 'a', xrayUptime: 100, usersOnline: 3 }),
      node({ uuid: 'b', xrayUptime: 900, usersOnline: 4 }),
    ]);
    assert.equal(server.status, 'online');
    assert.equal(server.uptimeSeconds, 900);
    assert.equal(server.usersOnline, 7);
  });

  it('is connecting while a node is coming up', () => {
    assert.equal(oneHost([node({ isConnected: false, isConnecting: true })]).status, 'connecting');
  });

  it('is offline when every node is down, and reports no uptime', () => {
    // A disconnected node keeps reporting whatever uptime it last managed;
    // passing that on would show a dead server as having run for a day.
    const server = oneHost([node({ isConnected: false, xrayUptime: 86_400 })]);
    assert.equal(server.status, 'offline');
    assert.equal(server.uptimeSeconds, null);
    assert.equal(server.usersOnline, null);
  });

  it('is unknown — not offline — when no node is linked at all', () => {
    // A real state in Remnawave. Calling it `offline` tells the customer their
    // server is broken when what is true is that nothing was linked to it.
    assert.equal(oneHost([], { nodes: [] }).status, 'unknown');
  });

  it('ignores disabled nodes when deciding the state', () => {
    assert.equal(oneHost([node({ isDisabled: true, isConnected: false })]).status, 'unknown');
  });
});

describe('the recommendation', () => {
  const build = (nodes: RemnawaveNodeInterface[], hosts: RemnawaveHostInterface[]) =>
    buildServers(['squad-eu'], { hosts, nodes, squads: [squad()] });

  it('names the least busy server', () => {
    const servers = build(
      [node({ uuid: 'n1', usersOnline: 40 }), node({ uuid: 'n2', usersOnline: 3 })],
      [
        host({ uuid: 'busy', nodes: ['n1'], viewPosition: 1 }),
        host({ uuid: 'quiet', nodes: ['n2'], viewPosition: 2 }),
      ],
    );
    assert.equal(pickRecommended(servers), 'quiet');
  });

  it('never names a server that is down, however empty it is', () => {
    // The emptiest server is the one nobody can reach. Ranking on load alone
    // would recommend exactly that one, every time it broke.
    const servers = build(
      [
        node({ uuid: 'n1', usersOnline: 40 }),
        node({ uuid: 'n2', usersOnline: 0, isConnected: false }),
      ],
      [
        host({ uuid: 'busy', nodes: ['n1'], viewPosition: 1 }),
        host({ uuid: 'down', nodes: ['n2'], viewPosition: 2 }),
      ],
    );
    assert.equal(pickRecommended(servers), 'busy');
  });

  it('keeps the first of equally busy servers, so the badge does not wander', () => {
    const servers = build(
      [node({ uuid: 'n1', usersOnline: 5 }), node({ uuid: 'n2', usersOnline: 5 })],
      [
        host({ uuid: 'first', nodes: ['n1'], viewPosition: 1 }),
        host({ uuid: 'second', nodes: ['n2'], viewPosition: 2 }),
      ],
    );
    assert.equal(pickRecommended(servers), 'first');
  });

  it('names nobody when nothing is up', () => {
    assert.equal(pickRecommended(
        build(
          [node({ uuid: 'n1', isConnected: false })],
          [host({ uuid: 'down', nodes: ['n1'] })],
        ),
      ), null);
  });
});

describe('what must never reach a customer', () => {
  const servers = buildServers(['squad-eu'], {
    hosts: [host()],
    nodes: [node()],
    squads: [squad()],
  });

  it('carries no address, port, node name or IP', () => {
    const serialized = JSON.stringify(servers);
    for (const secret of [
      'de1.internal.example', // host address
      '10.0.0.1', // node address
      '203.0.113.10', // node IP
      'de-1.hetzner', // node name
      '2222', // node port
      'profile-1', // config profile UUID
    ]) {
      assert.ok(!(serialized).includes(secret));
    }
  });

  it('exposes only the agreed fields', () => {
    // A new field added to the host or node mapper must not arrive here by
    // accident: the response shape is a boundary, so it is stated exactly.
    assert.deepEqual(Object.keys(servers[0]).sort(), [
      'countryCode',
      'flag',
      'id',
      'name',
      'status',
      'uptimeSeconds',
      'usersOnline',
    ]);
  });

  it('takes an inbound’s uuid and nothing else from the squad payload', () => {
    // `rawInbound` is several KB of panel internals per squad — Reality keys
    // and public/private keypairs among them. It arrives in the payload we
    // read; the mapper's job is to leave it there.
    const mapped = mapInternalSquadDetails({
      response: {
        internalSquads: [
          {
            uuid: 'squad-eu',
            name: 'EU',
            viewPosition: 1,
            info: { membersCount: 1, inboundsCount: 1 },
            inbounds: [
              {
                uuid: 'inbound-de',
                tag: 'VLESS-DE',
                rawInbound: {
                  privateKey: 'SECRET-PRIVATE-KEY',
                  publicKey: 'SECRET-PUBLIC-KEY',
                  shortIds: ['deadbeef'],
                },
              },
            ],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    });

    assert.deepEqual(mapped[0].inboundUuids, ['inbound-de']);
    const serialized = JSON.stringify(mapped);
    assert.ok(!(serialized).includes('SECRET-PRIVATE-KEY'));
    assert.ok(!(serialized).includes('SECRET-PUBLIC-KEY'));
    assert.ok(!(serialized).includes('rawInbound'));
    assert.ok(!(serialized).includes('VLESS-DE'));
  });
});
