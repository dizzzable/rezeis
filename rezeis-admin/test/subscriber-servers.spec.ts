import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RemnawaveHostInterface } from '../src/modules/remnawave/interfaces/remnawave-host.interface';
import { RemnawaveNodeInterface } from '../src/modules/remnawave/interfaces/remnawave-node.interface';
import { RemnawaveInternalSquadDetailInterface } from '../src/modules/remnawave/interfaces/remnawave-squad-detail.interface';
import { mapInternalSquadDetails } from '../src/modules/remnawave/services/remnawave-squad-mappers';
import {
  buildServers,
  explainEmpty,
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
  excludedInternalSquads: [],
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

  it('drops a host that is excluded from the only squad that reaches it', () => {
    // Remnawave leaves such a host out of that squad's config entirely, so the
    // customer cannot connect to it. Reaching its inbound is not the whole
    // question -- which is why the filter carries the squads, not just a set
    // of inbound uuids.
    const servers = buildServers(['squad-eu'], {
      hosts: [
        host({ uuid: 'open' }),
        host({ uuid: 'opted-out', excludedInternalSquads: ['squad-eu'] }),
      ],
      nodes: [node()],
      squads: [squad()],
    });
    assert.deepEqual(servers.map((s) => s.id), ['open']);
  });

  it('keeps a host excluded from one squad when another of the customer’s squads carries it', () => {
    // Two squads, one inbound, one exclusion. The host is in the second
    // squad's config, the customer is in both, so they can use it -- and a
    // filter that only asked "is this host excluded anywhere" would take it
    // away from them.
    const servers = buildServers(['squad-eu', 'squad-eu-2'], {
      hosts: [host({ uuid: 'shared', excludedInternalSquads: ['squad-eu'] })],
      nodes: [node()],
      squads: [squad(), squad({ uuid: 'squad-eu-2' })],
    });
    assert.deepEqual(servers.map((s) => s.id), ['shared']);
  });

  it('ignores an exclusion aimed at a squad the customer is not in', () => {
    const servers = buildServers(['squad-eu'], {
      hosts: [host({ uuid: 'mine', excludedInternalSquads: ['squad-someone-else'] })],
      nodes: [node()],
      squads: [squad()],
    });
    assert.deepEqual(servers.map((s) => s.id), ['mine']);
  });

  it('drops a host with no inbound at all', () => {
    // What every host looked like until the mapper was fixed: see
    // `remnawave-host-mapper.spec.ts`, which guards the cause. This guards the
    // consequence -- an unlinked host is not a server anybody can reach, and
    // must not be listed as one just because the field is empty.
    const servers = buildServers(['squad-eu'], {
      hosts: [host({ uuid: 'linked' }), host({ uuid: 'unlinked', configProfileInboundUuid: null })],
      nodes: [node()],
      squads: [squad()],
    });
    assert.deepEqual(servers.map((s) => s.id), ['linked']);
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

  it('drops a host kept out of every subscription format — and only then', () => {
    // Remnawave builds each format without the hosts the operator unticked it
    // on. Out of all six, no app receives the host: hidden in all but name.
    // Out of all but one, that one format's apps still do — and nothing here
    // knows which app a customer uses — so it stays. One host per format, so
    // a format missing from the list goes red by name.
    const ALL = ['XRAY_JSON', 'XRAY_BASE64', 'MIHOMO', 'STASH', 'CLASH', 'SINGBOX'];
    const hosts = [
      host({ uuid: 'everywhere' }),
      host({ uuid: 'nowhere', excludeFromSubscriptionTypes: ALL }),
      ...ALL.map((kept) =>
        host({ uuid: `only-${kept}`, excludeFromSubscriptionTypes: ALL.filter((f) => f !== kept) }),
      ),
      // A format this panel has never heard of excludes nothing it knows about.
      host({ uuid: 'unknown-format', excludeFromSubscriptionTypes: ['OUTLINE'] }),
    ];
    const servers = buildServers(['squad-eu'], { hosts, nodes: [node()], squads: [squad()] });
    assert.deepEqual(
      servers.map((s) => s.id),
      ['everywhere', ...ALL.map((kept) => `only-${kept}`), 'unknown-format'],
    );
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

  // ── A host whose explicit node link is empty or points nowhere ────────────
  //
  // The owner's case, from production: a restored server whose VPN client
  // connected at 101 ms while this list said "no data". The client connects to
  // `host.address` and never reads `host.nodes`, so that link is free to be
  // empty or stale — and after a node is recreated it names a UUID that no
  // longer exists. Nodes come and go routinely; the list has to find the one
  // actually serving the host.

  it('finds the serving node by address when the host names none', () => {
    const [server] = buildServers(['squad-eu'], {
      hosts: [host({ nodes: [], address: '2.26.199.173' })],
      nodes: [node({ uuid: 'node-restored', address: '2.26.199.173', xrayUptime: 3_600 })],
      squads: [squad()],
    });
    assert.equal(server.status, 'online');
    assert.equal(server.uptimeSeconds, 3_600);
  });

  it('finds it when the host still names the UUID of a node that was recreated', () => {
    const [server] = buildServers(['squad-eu'], {
      hosts: [host({ nodes: ['node-deleted-long-ago'], address: '2.26.199.173' })],
      nodes: [node({ uuid: 'node-recreated', address: '2.26.199.173' })],
      squads: [squad()],
    });
    assert.equal(server.status, 'online');
  });

  it('matches the host address against the node IPs too, not only its address', () => {
    const [server] = buildServers(['squad-eu'], {
      hosts: [host({ nodes: [], address: '203.0.113.10' })],
      nodes: [
        node({ uuid: 'n', address: 'node.internal', ips: [{ ip: '203.0.113.10', status: 'ACTIVE' }] }),
      ],
      squads: [squad()],
    });
    assert.equal(server.status, 'online');
  });

  it('does not guess when two nodes share the address', () => {
    // Reporting the state of the wrong server would be worse than saying
    // nothing, so the ambiguous case stays unknown.
    const [server] = buildServers(['squad-eu'], {
      hosts: [host({ nodes: [], address: '2.26.199.173' })],
      nodes: [
        node({ uuid: 'a', address: '2.26.199.173' }),
        node({ uuid: 'b', address: '2.26.199.173' }),
      ],
      squads: [squad()],
    });
    assert.equal(server.status, 'unknown');
  });

  it('keeps an explicit link to a node that exists, even a disabled one', () => {
    // Pointing a host at a switched-off node is a deliberate act; the address
    // must not overrule it with some other node that happens to live there.
    const [server] = buildServers(['squad-eu'], {
      hosts: [host({ nodes: ['switched-off'], address: '2.26.199.173' })],
      nodes: [
        node({ uuid: 'switched-off', isDisabled: true, isConnected: false, address: '10.9.9.9' }),
        node({ uuid: 'other', address: '2.26.199.173' }),
      ],
      squads: [squad()],
    });
    assert.equal(server.status, 'unknown');
  });

  it('resolves no DNS, so a host addressed by name stays apart from a node addressed by IP', () => {
    const [server] = buildServers(['squad-eu'], {
      hosts: [host({ nodes: [], address: 'de1.example.com' })],
      nodes: [node({ uuid: 'n', address: '2.26.199.173', ips: [] })],
      squads: [squad()],
    });
    assert.equal(server.status, 'unknown');
  });

  it('never sends the address it matched on', () => {
    // The match reads addresses; the answer must still carry none of them.
    const [server] = buildServers(['squad-eu'], {
      hosts: [host({ nodes: [], address: '2.26.199.173' })],
      nodes: [node({ uuid: 'n', address: '2.26.199.173', name: 'Germany NUXT CLOUDE' })],
      squads: [squad()],
    });
    const serialized = JSON.stringify(server);
    assert.equal(serialized.includes('2.26.199.173'), false);
    assert.equal(serialized.includes('NUXT'), false);
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

describe('why the list came back empty', () => {
  // Seven causes, one sentence on the customer's screen. Until this existed an
  // operator reporting "no servers" handed us nothing, which is exactly how a
  // mapper reading the wrong field survived a release.
  const snapshot = (over: {
    hosts?: RemnawaveHostInterface[];
    nodes?: RemnawaveNodeInterface[];
    squads?: RemnawaveInternalSquadDetailInterface[];
  } = {}) => ({
    hosts: over.hosts ?? [host()],
    nodes: over.nodes ?? [node()],
    squads: over.squads ?? [squad()],
  });

  it('blames the plan when the subscription carries no squads, quietly', () => {
    const { level, reason } = explainEmpty([], snapshot());
    assert.match(reason, /no squads/);
    // A choice, not a fault: warning here on every double tap would teach the
    // operator to ignore the channel.
    assert.equal(level, 'debug');
  });

  it('blames the panel when it returned no squads at all', () => {
    assert.deepEqual(explainEmpty(['squad-eu'], snapshot({ squads: [] })).level, 'warn');
    assert.match(explainEmpty(['squad-eu'], snapshot({ squads: [] })).reason, /no internal squads/);
  });

  it('says so when the subscription names squads the panel does not have', () => {
    const { level, reason } = explainEmpty(['squad-gone'], snapshot());
    assert.match(reason, /none of the 1 squad/);
    assert.equal(level, 'warn');
  });

  it('says so when the matched squads carry no inbounds', () => {
    const { level, reason } = explainEmpty(
      ['squad-eu'],
      snapshot({ squads: [squad({ inboundUuids: [] })] }),
    );
    assert.match(reason, /carry no inbounds/);
    assert.equal(level, 'warn');
  });

  it('names the case that shipped: hosts that name no inbound', () => {
    // The regression itself. Had this sentence existed, the report would have
    // been a five-second read instead of a bisect through seven candidates.
    const { level, reason } = explainEmpty(['squad-eu'], snapshot({
      hosts: [host({ configProfileInboundUuid: null }), host({ configProfileInboundUuid: null })],
    }));
    assert.match(reason, /none of the 2 host\(s\) name an inbound/);
    // And it must be loud. `SystemLogsService` floors at `log` in production,
    // so a `debug` here would be discarded on exactly the install that needed
    // it -- which is the whole reason this line exists.
    assert.equal(level, 'warn');
  });

  it('distinguishes linked hosts that simply sit elsewhere', () => {
    const { level, reason } = explainEmpty(['squad-eu'], snapshot({
      hosts: [host({ configProfileInboundUuid: 'inbound-us' })],
    }));
    assert.match(reason, /none on the 1 inbound/);
    assert.equal(level, 'warn');
  });

  it('distinguishes hidden from excluded, because the fix differs', () => {
    const hidden = explainEmpty(['squad-eu'], snapshot({ hosts: [host({ isHidden: true })] }));
    assert.match(hidden.reason, /all hidden or disabled/);
    const excluded = explainEmpty(['squad-eu'], snapshot({
      hosts: [host({ excludedInternalSquads: ['squad-eu'] })],
    }));
    assert.match(excluded.reason, /all excluded/);
    // Both are buttons the operator pressed, so neither shouts.
    assert.equal(hidden.level, 'debug');
    assert.equal(excluded.level, 'debug');
  });

  it('names a host kept out of every subscription format as its own reason', () => {
    // Otherwise the empty list would be blamed on squad exclusions, which the
    // operator would go and check, and find nothing.
    const { level, reason } = explainEmpty(['squad-eu'], snapshot({
      hosts: [
        host({
          excludeFromSubscriptionTypes: ['XRAY_JSON', 'XRAY_BASE64', 'MIHOMO', 'STASH', 'CLASH', 'SINGBOX'],
        }),
      ],
    }));
    assert.match(reason, /all kept out of every subscription format/);
    assert.equal(level, 'debug');
  });
});

describe('the name a customer reads', () => {
  // The owner's call, 11.09.2026: take it from the Remnawave host. The host
  // carries two strings — `remark`, the operator's own naming ("Germany 07 D"),
  // and `serverDescription`, the line written for customers (what Happ shows).
  const nameOf = (hostOver: Partial<RemnawaveHostInterface>): string | undefined =>
    buildServers(['squad-eu'], { hosts: [host(hostOver)], nodes: [node()], squads: [squad()] })[0]
      ?.name;

  it('is the description the operator wrote for customers, when there is one', () => {
    assert.equal(nameOf({ remark: 'Germany 07 D', serverDescription: 'Германия' }), 'Германия');
  });

  it('falls back to the remark when the description is absent, empty or blank', () => {
    // An operator who never filled the field in must see no change at all.
    assert.equal(nameOf({ remark: 'Germany 07 D' }), 'Germany 07 D');
    for (const serverDescription of [null, '', '   ']) {
      assert.equal(
        nameOf({ remark: 'Germany 07 D', serverDescription }),
        'Germany 07 D',
        `serverDescription = ${JSON.stringify(serverDescription)}`,
      );
    }
  });

  it('trims the description rather than showing its padding', () => {
    assert.equal(nameOf({ remark: 'x', serverDescription: '  Германия  ' }), 'Германия');
  });

  it('still takes the flag from the remark, where operators put it', () => {
    const [server] = buildServers(['squad-eu'], {
      hosts: [host({ remark: 'Frankfurt 🇩🇪', serverDescription: 'Франкфурт' })],
      nodes: [node({ countryCode: '' })],
      squads: [squad()],
    });
    assert.equal(server.name, 'Франкфурт');
    assert.equal(server.flag, '🇩🇪');
  });

  // ── and the other way round ───────────────────────────────────────
  //
  // The cabinet draws the flag from `countryCode` and strips it back out of
  // `name` so that it is not shown twice (`nameWithoutFlag`). So an operator
  // who writes the flag into the line meant FOR customers — now that the line
  // meant for customers is the one they read — used to lose it twice over: cut
  // off the name, and redrawn from whatever the internal remark or a node said
  // instead.

  it('takes the flag from the description when that is where the operator put it', () => {
    const [server] = buildServers(['squad-eu'], {
      hosts: [host({ remark: 'ams-03', serverDescription: '🇳🇱 Амстердам', nodes: ['node-nl'] })],
      nodes: [node({ uuid: 'node-nl', countryCode: 'DE' })],
      squads: [squad()],
    });
    assert.equal(server.name, '🇳🇱 Амстердам');
    assert.equal(server.flag, '🇳🇱');
    assert.equal(server.countryCode, 'NL');
  });

  it('still does, for a host that resolves to no node at all', () => {
    // Nothing in the remark and nothing from a node: the flag the operator
    // wrote was the only one there was, and the customer read a bare name
    // beside an empty badge.
    const [server] = buildServers(['squad-eu'], {
      hosts: [host({ remark: 'ams-03', serverDescription: '🇳🇱 Амстердам', nodes: [], address: '' })],
      nodes: [],
      squads: [squad()],
    });
    assert.equal(server.flag, '🇳🇱');
    assert.equal(server.countryCode, 'NL');
  });
});
