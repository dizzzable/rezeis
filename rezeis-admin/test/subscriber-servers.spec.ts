import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as contractPanel321 from '@remnawave/contract-panel-3.2.1';
import * as contractPanel323 from '@remnawave/contract-panel-3.2.3';
import * as contractPanel33 from '@remnawave/contract-panel-3.3';
import * as contractPanel343 from '@remnawave/contract-panel-3.4.3';
import * as contractPanel344 from '@remnawave/contract-panel-3.4.4';

import {
  RemnawaveExternalSquadHostOverrideInterface,
  RemnawaveHostInterface,
} from '../src/modules/remnawave/interfaces/remnawave-host.interface';
import { RemnawaveNodeInterface } from '../src/modules/remnawave/interfaces/remnawave-node.interface';
import { RemnawaveInternalSquadDetailInterface } from '../src/modules/remnawave/interfaces/remnawave-squad-detail.interface';
import { SubscriberServerInterface } from '../src/modules/remnawave/interfaces/subscriber-server.interface';
import {
  mapExternalSquadHostOverrides,
  mapInternalSquadDetails,
} from '../src/modules/remnawave/services/remnawave-squad-mappers';
import {
  buildServers,
  explainEmpty,
  pickRecommended,
  SubscriberView,
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
  internalSquads: { mode: 'exclude', squads: [] },
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

/** The moment every rendered list below is built at, so day counts are exact. */
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const DAY_MS = 86_400_000;

/** One subscriber, twelve and a half days from expiry, in no external squad. */
const subscriber = (over: Partial<SubscriberView> = {}): SubscriberView => ({
  externalSquad: null,
  status: 'ACTIVE',
  expiresAt: new Date(NOW + 12.5 * DAY_MS),
  panelUsername: 'rz_4815',
  now: NOW,
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
        host({ uuid: 'opted-out', internalSquads: { mode: 'exclude', squads: ['squad-eu'] } }),
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
      hosts: [host({ uuid: 'shared', internalSquads: { mode: 'exclude', squads: ['squad-eu'] } })],
      nodes: [node()],
      squads: [squad(), squad({ uuid: 'squad-eu-2' })],
    });
    assert.deepEqual(servers.map((s) => s.id), ['shared']);
  });

  it('ignores an exclusion aimed at a squad the customer is not in', () => {
    const servers = buildServers(['squad-eu'], {
      hosts: [host({ uuid: 'mine', internalSquads: { mode: 'exclude', squads: ['squad-someone-else'] } })],
      nodes: [node()],
      squads: [squad()],
    });
    assert.deepEqual(servers.map((s) => s.id), ['mine']);
  });

  it('drops a host that allows only squads the customer is not in', () => {
    // Remnawave 3.4 added this direction, and until it was read the host was
    // shown to EVERY subscriber whose squad reached its inbound — the operator
    // had restricted it to one squad and the rest saw a server they are not in
    // the config of. The rule is Remnawave's own: in this mode being listed is
    // what grants the squad, not what takes it away.
    const servers = buildServers(['squad-eu'], {
      hosts: [
        host({ uuid: 'open' }),
        host({ uuid: 'vip-only', internalSquads: { mode: 'allow-only', squads: ['squad-vip'] } }),
      ],
      nodes: [node()],
      squads: [squad()],
    });
    assert.deepEqual(servers.map((s) => s.id), ['open']);
  });

  it('keeps a host that allows only a squad the customer IS in', () => {
    const servers = buildServers(['squad-eu'], {
      hosts: [host({ uuid: 'vip-only', internalSquads: { mode: 'allow-only', squads: ['squad-eu'] } })],
      nodes: [node()],
      squads: [squad()],
    });
    assert.deepEqual(servers.map((s) => s.id), ['vip-only']);
  });

  it('keeps a host allowed to the second of the customer’s two squads', () => {
    // The mirror of the exclusion case above: one squad is enough, and a
    // filter that asked "is this host allowed to ALL of them" would take it
    // away from someone who can plainly use it.
    const servers = buildServers(['squad-eu', 'squad-eu-2'], {
      hosts: [host({ uuid: 'shared', internalSquads: { mode: 'allow-only', squads: ['squad-eu-2'] } })],
      nodes: [node()],
      squads: [squad(), squad({ uuid: 'squad-eu-2' })],
    });
    assert.deepEqual(servers.map((s) => s.id), ['shared']);
  });

  it('drops a host that allows nobody', () => {
    // `ALLOW_ONLY` with an empty list: Remnawave's create schema refuses one
    // and its query serves it to no squad, so a row like this is read
    // literally rather than as "no restriction". The `open` host is the
    // control — without it this case would also pass if `buildServers` were
    // broken outright and returned nothing at all.
    const servers = buildServers(['squad-eu'], {
      hosts: [
        host({ uuid: 'nobody', internalSquads: { mode: 'allow-only', squads: [] } }),
        host({ uuid: 'open' }),
      ],
      nodes: [node()],
      squads: [squad()],
    });
    assert.deepEqual(servers.map((s) => s.id), ['open']);
  });

  it('survives a host from a snapshot written before this panel version', () => {
    // NOT a hypothetical. The snapshot is cached in Redis as JSON and the Redis
    // container outlives the panel container, so for one TTL after an upgrade
    // this code reads rows the PREVIOUS version wrote — rows with no
    // `internalSquads` at all. An unguarded destructure answers
    // `TypeError: Cannot destructure property 'mode' of 'host.internalSquads'`,
    // which is a 500 on the one screen that exists to say which servers you
    // have, for every subscriber at once. The cache key carries a shape version
    // so this should be unreachable; belt and braces, because the cost of the
    // belt is one `??` and the cost of being wrong is an outage.
    const stale = { ...host({ uuid: 'stale' }) } as Record<string, unknown>;
    delete stale['internalSquads'];
    const servers = buildServers(['squad-eu'], {
      hosts: [stale as unknown as RemnawaveHostInterface],
      nodes: [node()],
      squads: [squad()],
    });
    // Absent means unrestricted — Remnawave's own default, and how every panel
    // before 3.4 behaved. Hiding it instead would take a working server away
    // from a paying customer on the strength of a missing field.
    assert.deepEqual(servers.map((s) => s.id), ['stale']);
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

describe('section headers the operator tagged', () => {
  // Remnawave has no separator. Operators fake one with an ordinary host whose
  // remark is a heading, and tag it `REZEIS:SEPARATOR` so this list can tell.
  // The header below is a whole host on purpose: the default `host()` links
  // the online `node-de` and carries a badge, so a header built like a server
  // would come out with a state, a flag and a badge — the rows these tests
  // exist to refuse.
  const TAG = 'REZEIS:SEPARATOR';
  const ALL_FORMATS = ['XRAY_JSON', 'XRAY_BASE64', 'MIHOMO', 'STASH', 'CLASH', 'SINGBOX'];
  const header = (over: Partial<RemnawaveHostInterface> = {}): RemnawaveHostInterface =>
    host({
      remark: '⬇️ Все | Локации ⬇️',
      serverDescription: 'РАЗДЕЛИТЕЛЬ | НЕ СЕРВЕР',
      tags: ['PREMIUM', TAG],
      ...over,
    });
  const listOf = (
    hosts: RemnawaveHostInterface[],
    nodes: RemnawaveNodeInterface[] = [node()],
  ): readonly SubscriberServerInterface[] =>
    buildServers(['squad-eu'], { hosts, nodes, squads: [squad()] });

  it('makes a header of the tagged host, and leaves its untagged twin a server', () => {
    // Identical but for the tag, so nothing but the tag can tell them apart.
    const servers = listOf([
      header({ uuid: 'sep', viewPosition: 1 }),
      header({ uuid: 'twin', viewPosition: 2, tags: ['PREMIUM'] }),
    ]);
    // The whole row, so a field the header must not have fails by name.
    assert.deepEqual(servers[0], {
      id: 'sep',
      kind: 'separator',
      name: '⬇️ Все | Локации ⬇️',
      description: null,
      flag: null,
      countryCode: null,
      status: 'unknown',
      uptimeSeconds: null,
      usersOnline: null,
    });
    // What the header would have been: the twin gets all of it.
    assert.equal(servers[1]?.kind, 'server');
    assert.equal(servers[1]?.status, 'online');
    assert.equal(servers[1]?.countryCode, 'DE');
    assert.equal(servers[1]?.description, 'РАЗДЕЛИТЕЛЬ | НЕ СЕРВЕР');
  });

  it('reads the tag exactly as Remnawave stores it — no case folding, no near misses', () => {
    // Remnawave accepts `^[A-Z0-9_:]+$` only, so any other spelling is not the
    // operator following the instructions, and a guess costs a working server
    // its status. Each host is alone in its list: read as a header, it would
    // have nothing under it and vanish, and `row` would be undefined.
    for (const tag of ['rezeis:separator', 'Rezeis:Separator', 'REZEIS:SEPARATORS', 'REZEIS_SEPARATOR', 'SEPARATOR']) {
      const [row] = listOf([header({ tags: [tag] })]);
      assert.equal(row?.kind, 'server', `the tag ${JSON.stringify(tag)} made a header`);
      assert.equal(row?.status, 'online', `the tag ${JSON.stringify(tag)}`);
    }
  });

  it('never takes a header’s state from a node — linked by its node list, or found at its address', () => {
    // The latent defect this closes. A header is an ordinary host: it has an
    // address and may list nodes, and one copied from a working host keeps
    // both. Sitting on the quietest node, it used to read as online and be the
    // recommended server — a heading, recommended as the place to connect.
    const quiet = node({ uuid: 'node-quiet', address: '2.26.199.173', usersOnline: 0, xrayUptime: 999, countryCode: 'NL' });
    const busy = node({ uuid: 'node-busy', address: '10.9.9.9', ips: [], usersOnline: 40 });
    const linkages: [string, Partial<RemnawaveHostInterface>][] = [
      ['by its node list', { nodes: ['node-quiet'] }],
      ['by its address', { nodes: [], address: '2.26.199.173' }],
    ];
    for (const [how, linkage] of linkages) {
      const servers = listOf(
        [
          header({ uuid: 'sep', viewPosition: 1, ...linkage }),
          host({ uuid: 'de', viewPosition: 2, nodes: ['node-busy'] }),
        ],
        [quiet, busy],
      );
      assert.equal(servers[0]?.kind, 'separator', how);
      assert.equal(servers[0]?.status, 'unknown', how);
      assert.equal(servers[0]?.uptimeSeconds, null, how);
      assert.equal(servers[0]?.usersOnline, null, how);
      assert.equal(servers[0]?.countryCode, null, how);
      assert.equal(pickRecommended(servers), 'de', how);
    }
  });

  it('never recommends a header, even one that says it is up', () => {
    // The rule, not the data feeding it: a header is built as `unknown`, so the
    // status check alone would skip one today. This keeps the recommendation
    // from depending on how another function fills in a field.
    const row = (over: Partial<SubscriberServerInterface>): SubscriberServerInterface => ({
      id: 'x',
      kind: 'server',
      name: 'x',
      description: null,
      flag: null,
      countryCode: null,
      status: 'online',
      uptimeSeconds: 60,
      usersOnline: 10,
      ...over,
    });
    assert.equal(
      pickRecommended([row({ id: 'sep', kind: 'separator', usersOnline: 0 }), row({ id: 'de' })]),
      'de',
    );
  });

  it('puts a tagged host through every filter first', () => {
    // A tag does not make a host visible. Each dropped header sits directly
    // over a server, so the rule that drops a header with nothing under it
    // cannot be what removes it here — and `shown` is the control proving a
    // header survives this fixture at all.
    const drops: [string, Partial<RemnawaveHostInterface>][] = [
      ['hidden', { isHidden: true }],
      ['disabled', { isDisabled: true }],
      ['squad-excluded', { internalSquads: { mode: 'exclude', squads: ['squad-eu'] } }],
      ['allowed-elsewhere', { internalSquads: { mode: 'allow-only', squads: ['squad-vip'] } }],
      ['every-format', { excludeFromSubscriptionTypes: ALL_FORMATS }],
      ['other-inbound', { configProfileInboundUuid: 'inbound-us' }],
      ['no-inbound', { configProfileInboundUuid: null }],
    ];
    const hosts = drops.flatMap(([id, over], index) => [
      header({ uuid: id, viewPosition: index * 2 + 1, ...over }),
      host({ uuid: `under-${id}`, viewPosition: index * 2 + 2 }),
    ]);
    hosts.push(
      header({ uuid: 'shown', viewPosition: 100 }),
      host({ uuid: 'under-shown', viewPosition: 101 }),
    );
    assert.deepEqual(
      listOf(hosts).map((server) => server.id),
      [...drops.map(([id]) => `under-${id}`), 'shown', 'under-shown'],
    );
  });

  it('keeps a header exactly where the operator ordered it', () => {
    // Positions scrambled, as the snapshot is free to send them.
    const servers = listOf([
      host({ uuid: 'lv', viewPosition: 4 }),
      header({ uuid: 'sep-locations', viewPosition: 3 }),
      host({ uuid: 'auto', viewPosition: 2 }),
      header({ uuid: 'sep-auto', viewPosition: 1 }),
    ]);
    assert.deepEqual(servers.map((server) => server.id), ['sep-auto', 'auto', 'sep-locations', 'lv']);
  });

  it('drops a header left at the end with nothing under it', () => {
    // And leaves a server above the first header where it was, unlabelled.
    const servers = listOf([
      host({ uuid: 'auto', viewPosition: 1 }),
      header({ uuid: 'sep-top', viewPosition: 2 }),
      host({ uuid: 'de', viewPosition: 3 }),
      header({ uuid: 'sep-trailing', viewPosition: 4 }),
    ]);
    assert.deepEqual(servers.map((server) => server.id), ['auto', 'sep-top', 'de']);
  });

  it('keeps only the last of consecutive headers — the one over the servers', () => {
    // How a run happens: a section whose only host this customer may not see.
    // Its header passes every filter and lands directly on the next header,
    // labelling nothing. The last header of the run is the one naming the
    // servers really below it; the first would name a section that is gone.
    const servers = listOf([
      header({ uuid: 'sep-vip', remark: 'VIP', viewPosition: 1 }),
      host({ uuid: 'vip-only', viewPosition: 2, internalSquads: { mode: 'allow-only', squads: ['squad-vip'] } }),
      header({ uuid: 'sep-soon', remark: 'Скоро', viewPosition: 3 }),
      header({ uuid: 'sep-locations', viewPosition: 4 }),
      host({ uuid: 'de', viewPosition: 5 }),
      host({ uuid: 'lv', viewPosition: 6 }),
    ]);
    assert.deepEqual(servers.map((server) => server.id), ['sep-locations', 'de', 'lv']);
  });

  it('comes back empty when nothing but headers reaches the customer', () => {
    assert.deepEqual(
      listOf([header({ uuid: 'a', viewPosition: 1 }), header({ uuid: 'b', viewPosition: 2 })]),
      [],
    );
  });

  it('reads a host row with no tags at all as a server rather than failing', () => {
    // Belt and braces, as with `internalSquads` above: the snapshot comes back
    // out of Redis unchecked. `tags` has been in every snapshot this list has
    // cached, but a row without it must not empty the list with a TypeError.
    const stale = { ...host({ uuid: 'stale' }) } as Record<string, unknown>;
    delete stale['tags'];
    const [row] = listOf([stale as unknown as RemnawaveHostInterface]);
    assert.equal(row?.kind, 'server');
    assert.equal(row?.status, 'online');
  });
});

describe('what must never reach a customer', () => {
  // A section header rides along on purpose. It is an ordinary host in
  // Remnawave — address, port, a node list — and its row is built on a
  // different path from a server's, so the boundary has to hold on both.
  const servers = buildServers(['squad-eu'], {
    hosts: [
      host({
        uuid: 'host-sep',
        viewPosition: 0,
        remark: '⬇️ Локации ⬇️',
        address: 'sep.internal.example',
        port: 8443,
        tags: ['REZEIS:SEPARATOR'],
      }),
      host(),
    ],
    nodes: [node()],
    squads: [squad()],
  });

  it('carries no address, port, node name or IP', () => {
    // Both rows present, or the header's path is not being checked at all.
    assert.deepEqual(servers.map((server) => server.kind), ['separator', 'server']);
    const serialized = JSON.stringify(servers);
    for (const secret of [
      'de1.internal.example', // host address
      'sep.internal.example', // the header's host address
      '8443', // the header's port
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
    // accident: the response shape is a boundary, so it is stated exactly —
    // for a header row as much as a server row, because the two are built
    // apart. `kind` joined deliberately: it tells the cabinet to draw a header,
    // and it is one of two fixed words, nothing read off the host.
    assert.equal(servers.length, 2);
    for (const server of servers) {
      assert.deepEqual(
        Object.keys(server).sort(),
        [
          'countryCode',
          'description',
          'flag',
          'id',
          'kind',
          'name',
          'status',
          'uptimeSeconds',
          'usersOnline',
        ],
        server.kind,
      );
    }
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
      hosts: [host({ internalSquads: { mode: 'exclude', squads: ['squad-eu'] } })],
    }));
    assert.match(excluded.reason, /none of them served to these squads/);
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

  it('blames the subscription formats before the squads when a host is both', () => {
    // The two reasons are checked in an order, and the order is a decision:
    // "kept out of every format" is one checkbox the operator can see on the
    // host, while "served to no squad of this customer" sends them off to
    // compare squad membership. The specific cause wins. Swap the two blocks
    // in `explainEmpty` and this goes red; nothing else notices.
    const { reason } = explainEmpty(['squad-eu'], snapshot({
      hosts: [
        host({
          internalSquads: { mode: 'exclude', squads: ['squad-eu'] },
          excludeFromSubscriptionTypes: ['XRAY_JSON', 'XRAY_BASE64', 'MIHOMO', 'STASH', 'CLASH', 'SINGBOX'],
        }),
      ],
    }));
    assert.match(reason, /all kept out of every subscription format/);
    assert.doesNotMatch(reason, /served to these squads/);
  });

  it('names a list of nothing but section headers as its own reason, quietly', () => {
    // Every filter passed and there is still nothing to show: each host that
    // reached the customer is a header, and a header with no server under it
    // is not listed. Blaming the squads would send the operator to settings
    // that are fine. The tags are theirs, so it stays below the Logs page.
    const hosts = [
      host({ uuid: 'a', viewPosition: 1, tags: ['REZEIS:SEPARATOR'] }),
      host({ uuid: 'b', viewPosition: 2, tags: ['REZEIS:SEPARATOR'] }),
    ];
    assert.deepEqual(buildServers(['squad-eu'], snapshot({ hosts })), []);
    const { level, reason } = explainEmpty(['squad-eu'], snapshot({ hosts }));
    assert.match(reason, /2 host\(s\) served to these squads, all of them separators tagged REZEIS:SEPARATOR/);
    assert.equal(level, 'debug');
  });

  it('reports a break earlier in the chain before it blames the headers', () => {
    // The header reason is the last link, past every filter. A tagged host that
    // is also hidden, unticked or not served to these squads is missing for
    // THAT reason, and naming the tag instead would point at the wrong fix.
    const cases: [RegExp, Partial<RemnawaveHostInterface>][] = [
      [/all hidden or disabled/, { isHidden: true }],
      [
        /all kept out of every subscription format/,
        { excludeFromSubscriptionTypes: ['XRAY_JSON', 'XRAY_BASE64', 'MIHOMO', 'STASH', 'CLASH', 'SINGBOX'] },
      ],
      [/none of them served to these squads/, { internalSquads: { mode: 'exclude', squads: ['squad-eu'] } }],
    ];
    for (const [expected, over] of cases) {
      const { reason } = explainEmpty(['squad-eu'], snapshot({
        hosts: [host({ tags: ['REZEIS:SEPARATOR'], ...over })],
      }));
      assert.match(reason, expected);
      assert.doesNotMatch(reason, /separator/);
    }
  });

  it('reports a break on the servers, not the header that passed above them', () => {
    // The mirror of the case above, and the one that went wrong: a header that
    // passes every filter kept every count above zero, so a server broken
    // under it read as "all of them separators" — at debug, below the Logs
    // page — while the same panel without the header warned. The header is
    // dropped either way (nothing is under it), so it explains nothing.
    const header = host({ uuid: 'sep', viewPosition: 1, tags: ['REZEIS:SEPARATOR'] });
    const cases: [RegExp, 'warn' | 'debug', Partial<RemnawaveHostInterface>][] = [
      [/^1 linked host\(s\), none on the 1 inbound\(s\) these squads reach$/, 'warn', { configProfileInboundUuid: 'inbound-us' }],
      [/^none of the 1 host\(s\) name an inbound$/, 'warn', { configProfileInboundUuid: null }],
      [/all hidden or disabled/, 'debug', { isHidden: true }],
      [
        /all kept out of every subscription format/,
        'debug',
        { excludeFromSubscriptionTypes: ['XRAY_JSON', 'XRAY_BASE64', 'MIHOMO', 'STASH', 'CLASH', 'SINGBOX'] },
      ],
      [/none of them served to these squads/, 'debug', { internalSquads: { mode: 'exclude', squads: ['squad-eu'] } }],
    ];
    for (const [expected, level, over] of cases) {
      const hosts = [header, host({ uuid: 'de', viewPosition: 2, ...over })];
      // The premise: this customer really does see an empty list.
      assert.deepEqual(buildServers(['squad-eu'], snapshot({ hosts })), [], String(expected));
      const reason = explainEmpty(['squad-eu'], snapshot({ hosts }));
      assert.match(reason.reason, expected);
      assert.doesNotMatch(reason.reason, /separator/, String(expected));
      assert.equal(reason.level, level, String(expected));
    }
  });
});

describe('the name a customer reads', () => {
  // A host carries two strings a customer sees, and they are a TITLE and a
  // LABEL. Checked against a client, not reasoned about: Incy draws the remark
  // in large type ("Germany - 1") over the serverDescription in a chip
  // ("ОСНОВНОЙ | СЕРВЕР"). The cabinet must read the same way, because the
  // customer holds both screens in the same hand.
  const serverOf = (hostOver: Partial<RemnawaveHostInterface>) =>
    buildServers(['squad-eu'], { hosts: [host(hostOver)], nodes: [node()], squads: [squad()] })[0];

  it('does not print one category five times over five countries', () => {
    // THE SUBSCRIBER'S SCREENSHOT, as data. A real operator's list, where the
    // description is a category repeated on purpose. With the description used
    // as the name, all five rows read "ОСНОВНОЙ | СЕРВЕР" and nothing told the
    // customer which of them was Latvia.
    const remarks = ['Germany - 1', 'Germany - 2', 'Netherlands - 1', 'Latvia - 1', 'Finland - 1'];
    const servers = buildServers(['squad-eu'], {
      hosts: remarks.map((remark, index) =>
        host({ uuid: 'host-' + index, remark, serverDescription: 'ОСНОВНОЙ | СЕРВЕР' }),
      ),
      nodes: [node()],
      squads: [squad()],
    });
    assert.deepEqual(servers.map((server) => server.name), remarks);
    assert.equal(new Set(servers.map((server) => server.name)).size, remarks.length);
    for (const server of servers) assert.equal(server.description, 'ОСНОВНОЙ | СЕРВЕР');
  });

  it('is the remark, whether or not there is a description', () => {
    assert.equal(serverOf({ remark: 'Poland- 1 | Fast', serverDescription: 'БЫСТРЫЙ | СЕРВЕР' })?.name, 'Poland- 1 | Fast');
    assert.equal(serverOf({ remark: 'Poland- 1 | Fast' })?.name, 'Poland- 1 | Fast');
  });

  it('carries the description separately, for the badge', () => {
    const server = serverOf({ remark: 'test-bs-cdn', serverDescription: 'LTE | СЕРВЕР' });
    assert.equal(server?.name, 'test-bs-cdn');
    assert.equal(server?.description, 'LTE | СЕРВЕР');
  });

  it('has no badge when the description is absent, empty or blank', () => {
    assert.equal(serverOf({ remark: 'Germany - 1' })?.description, null);
    for (const serverDescription of [null, '', '   ']) {
      assert.equal(
        serverOf({ remark: 'Germany - 1', serverDescription })?.description,
        null,
        'serverDescription = ' + JSON.stringify(serverDescription),
      );
    }
  });

  it('trims the badge rather than showing its padding', () => {
    assert.equal(serverOf({ remark: 'x', serverDescription: '  AUTO | СЕРВЕР  ' })?.description, 'AUTO | СЕРВЕР');
  });

  it('has no badge that only repeats the name', () => {
    // An operator who copied one field into the other would otherwise see every
    // name twice. Compared as a person reads it: the cabinet draws the flag
    // separately, and a chip in capitals is still the same word.
    for (const [remark, serverDescription] of [
      ['Germany - 1', 'Germany - 1'],
      ['Germany - 1', 'GERMANY - 1'],
      ['🇩🇪 Germany - 1', 'Germany - 1'],
      ['Germany  -  1', ' germany - 1 '],
    ]) {
      assert.equal(
        serverOf({ remark, serverDescription })?.description,
        null,
        JSON.stringify(remark) + ' / ' + JSON.stringify(serverDescription),
      );
    }
  });

  it('keeps a badge that merely resembles the name', () => {
    // Not a similarity measure: anything that is not the same words is a
    // different label, and the operator wrote it for a reason.
    assert.equal(serverOf({ remark: 'Germany - 1', serverDescription: 'Germany' })?.description, 'Germany');
  });

  it('takes the flag from the remark, and then from the nodes', () => {
    const [flagged] = buildServers(['squad-eu'], {
      hosts: [host({ remark: 'Frankfurt 🇩🇪', serverDescription: 'ОСНОВНОЙ | СЕРВЕР' })],
      nodes: [node({ countryCode: '' })],
      squads: [squad()],
    });
    assert.equal(flagged.flag, '🇩🇪');
    assert.equal(serverOf({ remark: 'Germany - 1' })?.countryCode, 'DE');
  });

  it('does not promote a flag out of the badge into the flag slot', () => {
    // The description is a category. A chip reading "🇪🇺 AUTO" on a host whose
    // node is German must not relabel that server as EU; the flag stays inside
    // the chip, exactly where the client shows it.
    const [server] = buildServers(['squad-eu'], {
      hosts: [host({ remark: 'Auto | Germany', serverDescription: '🇪🇺 AUTO' })],
      nodes: [node({ countryCode: 'DE' })],
      squads: [squad()],
    });
    assert.equal(server.countryCode, 'DE');
    assert.equal(server.description, '🇪🇺 AUTO');
  });
});

describe('the name as this subscriber’s VPN client renders it', () => {
  // Remnawave never hands a client the remark as stored. Before a config goes
  // out it runs the remark through its template engine for that one user —
  // `TemplateEngine.replace(inputHost.remark, userValueMap)` in
  // `resolve-proxy-config.service.ts`, the same from 3.2 through 3.4.4 — so an
  // info row reading "Осталось {{DAYS_LEFT}} дн." is "Осталось 12 дн." in Happ
  // and Incy, and the cabinet printed the braces.
  const listFor = (hosts: RemnawaveHostInterface[], over: Partial<SubscriberView> = {}) =>
    buildServers(['squad-eu'], { hosts, nodes: [node()], squads: [squad()] }, subscriber(over));
  const nameOf = (remark: string, over: Partial<SubscriberView> = {}): string | undefined =>
    listFor([host({ remark })], over)[0]?.name;

  it('fills in what the panel knows about this subscription', () => {
    assert.equal(nameOf('Осталось {{DAYS_LEFT}} дн.'), 'Осталось 12 дн.');
    assert.equal(nameOf('{{USERNAME}} · Germany'), 'rz_4815 · Germany');
    assert.equal(nameOf('Статус: {{STATUS}}'), 'Статус: Active');
    assert.equal(nameOf('до {{EXPIRE_UNIX}}'), `до ${Math.floor((NOW + 12.5 * DAY_MS) / 1000)}`);
  });

  it('counts whole days the way Remnawave does, and never below zero', () => {
    // `dayjs(expireAt).diff(dayjs(), 'day')`: whole days, rounded down.
    assert.equal(nameOf('{{DAYS_LEFT}}', { expiresAt: new Date(NOW + 12 * DAY_MS - 1) }), '11');
    assert.equal(nameOf('{{DAYS_LEFT}}', { expiresAt: new Date(NOW + 12 * DAY_MS) }), '12');
    assert.equal(nameOf('{{DAYS_LEFT}}', { expiresAt: new Date(NOW - 3 * DAY_MS) }), '0');
  });

  it('uses the operator’s own word for a status when the token gives one', () => {
    // `{{STATUS:ACTIVE=…|EXPIRED=…}}` — the args Remnawave reads, falling back
    // to its own label for a status the token has no word for.
    const remark = '{{STATUS:ACTIVE=✅ Активна|EXPIRED=⛔ Истекла}}';
    assert.equal(nameOf(remark), '✅ Активна');
    assert.equal(nameOf(remark, { status: 'EXPIRED' }), '⛔ Истекла');
    assert.equal(nameOf(remark, { status: 'LIMITED' }), 'Limited');
  });

  it('leaves out a value the panel cannot know, instead of printing the token', () => {
    // Traffic is counted in Remnawave and never stored here. Blank is what the
    // cabinet can say truthfully; the braces are what no client ever shows.
    assert.equal(nameOf('Germany | {{TRAFFIC_LEFT}}'), 'Germany |');
    assert.equal(nameOf('Трафик  {{TRAFFIC_USED}} из {{TOTAL_TRAFFIC}}'), 'Трафик из');
    assert.equal(nameOf('Осталось {{DAYS_LEFT}} дн.', { expiresAt: null }), 'Осталось дн.');
    assert.equal(nameOf('{{USERNAME}} · Germany', { panelUsername: null }), '· Germany');
    assert.equal(nameOf('Статус: {{STATUS}}', { status: null }), 'Статус:');
  });

  it('renders every variable any 3.x panel knows, and no other', () => {
    // The oracles, not a copy of the list: each release's own `TEMPLATE_KEYS`.
    // A key missing on this side would reach the customer in braces.
    const eras = [contractPanel321, contractPanel323, contractPanel33, contractPanel343, contractPanel344];
    const keys = new Set(eras.flatMap((contract) => [...contract.TEMPLATE_KEYS]));
    assert.equal(keys.size, 25, 'the 3.4.4 list, which every earlier 3.x list is inside');
    for (const key of keys) {
      for (const remark of [`x {{${key}}}`, `x {{${key}:ACTIVE=y}}`]) {
        const name = nameOf(remark, { expiresAt: null, panelUsername: null, status: null }) ?? '';
        assert.equal(name.includes('{{'), false, `${remark} → ${JSON.stringify(name)}`);
      }
    }
    // Remnawave keeps a token it does not know exactly as written — spelling,
    // case and args — and so does this. Nothing is collapsed around it.
    for (const remark of ['{{NOT_A_KEY}}  Germany', '{{days_left}} дн.', '{{ DAYS_LEFT }} дн.', '{{STATUS:{x}}}']) {
      assert.equal(nameOf(remark), remark);
    }
  });

  it('leaves a remark with no token exactly as the operator wrote it', () => {
    assert.equal(nameOf('  Germany  -  1 🇩🇪 '), '  Germany  -  1 🇩🇪 ');
  });

  it('renders a section header’s remark the same way', () => {
    const [header] = listFor([
      host({ uuid: 'sep', viewPosition: 1, remark: '⏳ Осталось {{DAYS_LEFT}} дн. {{TRAFFIC_LEFT}}', tags: ['REZEIS:SEPARATOR'] }),
      host({ uuid: 'de', viewPosition: 2 }),
    ]);
    assert.equal(header?.kind, 'separator');
    assert.equal(header?.name, '⏳ Осталось 12 дн.');
  });

  it('compares the badge with the name as rendered, not as stored', () => {
    // "Germany {{TRAFFIC_LEFT}}" reads "Germany" here, so a badge reading
    // "GERMANY" only repeats it.
    const [server] = listFor([host({ remark: 'Germany {{TRAFFIC_LEFT}}', serverDescription: 'GERMANY' })]);
    assert.equal(server?.name, 'Germany');
    assert.equal(server?.description, null);
  });

  it('takes the flag from the name as rendered', () => {
    // The cabinet strips the flag back out of `name`, so it has to be the flag
    // that `name` carries — here the one for this subscriber's status.
    const remark = '{{STATUS:ACTIVE=🇩🇪 Germany|EXPIRED=🇳🇱 Netherlands}}';
    const [server] = listFor([host({ remark })], { status: 'EXPIRED' });
    assert.equal(server?.name, '🇳🇱 Netherlands');
    assert.equal(server?.flag, '🇳🇱');
    assert.equal(server?.countryCode, 'NL');
  });

  it('drops the rwEncodeBase64: marker, which no app ever shows', () => {
    // A remark that STARTS with `rwEncodeBase64:` asks the panel to encode it:
    // every 3.x panel cuts the marker off, renders the rest, and sends
    // `base64:` + the Base64 of that (`parseTransform` and `renderTemplate` in
    // `template-parser.ts`, the same transform in 3.0–3.2.0's engine). An app
    // that reads `base64:` shows the rendered text, and that is the name here.
    assert.equal(nameOf('rwEncodeBase64:🇩🇪 Germany - 1 · {{DAYS_LEFT}} дн.'), '🇩🇪 Germany - 1 · 12 дн.');
    assert.equal(nameOf('rwEncodeBase64:Germany | {{TRAFFIC_LEFT}}'), 'Germany |');
    // Nothing else changes: with no token left out, the rest is as written.
    assert.equal(nameOf('rwEncodeBase64:  Germany  -  1 '), '  Germany  -  1 ');
    // And the badge and the flag read the name without it.
    const [server] = listFor([host({ remark: 'rwEncodeBase64:🇩🇪 Germany - 1', serverDescription: 'GERMANY - 1' })]);
    assert.equal(server?.name, '🇩🇪 Germany - 1');
    assert.equal(server?.description, null, 'a badge that only repeats the name');
    assert.equal(server?.flag, '🇩🇪');
    assert.equal(server?.countryCode, 'DE');
  });

  it('drops the marker only where the panel does, and decodes nothing', () => {
    // `startsWith`, exactly as spelled, and once: anywhere else the panel sends
    // the marker as text. Nor does the panel ever DECODE a remark — one the
    // operator stored as `base64:…` goes out as it is — so neither does this.
    const cases: ReadonlyArray<readonly [remark: string, name: string]> = [
      [' rwEncodeBase64:Germany', ' rwEncodeBase64:Germany'],
      ['Germany rwEncodeBase64:', 'Germany rwEncodeBase64:'],
      ['rwencodebase64:Germany', 'rwencodebase64:Germany'],
      ['rwEncodeBase64:rwEncodeBase64:Germany', 'rwEncodeBase64:Germany'],
      ['base64:R2VybWFueQ==', 'base64:R2VybWFueQ=='],
      ['rwEncodeBase64:base64:R2VybWFueQ==', 'base64:R2VybWFueQ=='],
    ];
    for (const [remark, name] of cases) {
      assert.equal(nameOf(remark), name, remark);
    }
  });

  it('drops the marker from a section header’s heading as well', () => {
    const [header] = listFor([
      host({ uuid: 'sep', viewPosition: 1, remark: 'rwEncodeBase64:⏳ Осталось {{DAYS_LEFT}} дн.', tags: ['REZEIS:SEPARATOR'] }),
      host({ uuid: 'de', viewPosition: 2 }),
    ]);
    assert.equal(header?.kind, 'separator');
    assert.equal(header?.name, '⏳ Осталось 12 дн.');
  });
});

describe('the badge a subscriber’s external squad overrides', () => {
  // Remnawave applies the user's external squad `hostOverrides` to every host
  // it serves them (`applyHostOverrides` in `resolve-proxy-config.service.ts`,
  // 3.2 through 3.4.4): a `serverDescription` there replaces each host's own,
  // and `null` removes it, so Happ and Incy draw that chip — or none. The
  // cabinet read only the host's own.
  const BASE = 'ОСНОВНОЙ | СЕРВЕР';
  const badgeFor = (
    externalSquad: string | null,
    externalSquads: RemnawaveExternalSquadHostOverrideInterface[] | undefined,
    serverDescription: string | null = BASE,
  ): string | null | undefined =>
    buildServers(
      ['squad-eu'],
      {
        hosts: [host({ remark: 'Germany - 1', serverDescription })],
        nodes: [node()],
        squads: [squad()],
        ...(externalSquads === undefined ? {} : { externalSquads }),
      },
      subscriber({ externalSquad }),
    )[0]?.description;
  const PREMIUM: RemnawaveExternalSquadHostOverrideInterface = { uuid: 'ext-premium', serverDescription: 'PREMIUM' };
  const BARE: RemnawaveExternalSquadHostOverrideInterface = { uuid: 'ext-bare', serverDescription: null };

  it('shows the squad’s badge instead of the host’s', () => {
    assert.equal(badgeFor('ext-premium', [BARE, PREMIUM]), 'PREMIUM');
    // Also over a host that had none of its own.
    assert.equal(badgeFor('ext-premium', [PREMIUM], null), 'PREMIUM');
  });

  it('shows no badge when the squad overrides it with null', () => {
    assert.equal(badgeFor('ext-bare', [PREMIUM, BARE]), null);
  });

  it('keeps the host’s own badge when no squad of this subscriber overrides it', () => {
    assert.equal(badgeFor(null, [PREMIUM, BARE]), BASE, 'in no external squad');
    assert.equal(badgeFor('ext-other', [PREMIUM, BARE]), BASE, 'in a squad that overrides nothing');
    assert.equal(badgeFor('ext-premium', []), BASE, 'no squad overrides anything');
    // A snapshot written before this field existed overrides nothing.
    assert.equal(badgeFor('ext-premium', undefined), BASE, 'a snapshot without the field');
  });

  it('holds the squad’s badge to the same rules as the host’s', () => {
    assert.equal(badgeFor('ext-pad', [{ uuid: 'ext-pad', serverDescription: '  VIP  ' }]), 'VIP');
    assert.equal(badgeFor('ext-empty', [{ uuid: 'ext-empty', serverDescription: '' }]), null);
    assert.equal(badgeFor('ext-echo', [{ uuid: 'ext-echo', serverDescription: 'GERMANY - 1' }]), null);
  });

  it('takes from each external squad only the badge Remnawave would apply', () => {
    // Remnawave applies `hostOverrides` only when it is an object with a key in
    // it (`hasContent`), and then `serverDescription` only when it is present —
    // `null` included, which removes the chip. Everything else on the squad is
    // routing, headers, templates and settings, and none of it is a label.
    const squadRow = (uuid: string, hostOverrides: unknown) => ({
      uuid,
      viewPosition: 1,
      name: `name-${uuid}`,
      tags: ['PAID'],
      info: { membersCount: 3 },
      templates: [{ templateUuid: 'tpl-uuid-secret', templateType: 'XRAY_JSON' }],
      subscriptionSettings: { profileTitle: 'profile-title-secret' },
      hostOverrides,
      responseHeadersAdd: { 'x-secret-header': 'secret-value' },
      responseHeadersRemove: [],
      hwidSettings: null,
      customRemarks: null,
      subpageConfigUuid: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const mapped = mapExternalSquadHostOverrides({
      response: {
        total: 8,
        externalSquads: [
          squadRow('premium', { serverDescription: 'PREMIUM', vlessRouteId: 7 }),
          squadRow('bare', { serverDescription: null }),
          squadRow('empty-object', {}),
          squadRow('null-overrides', null),
          squadRow('route-only', { vlessRouteId: 3 }),
          squadRow('junk-value', { serverDescription: 42 }),
          squadRow('array-overrides', ['PREMIUM']),
          { uuid: 'no-field', name: 'x' },
          null,
        ],
      },
    });
    assert.deepEqual(mapped, [
      { uuid: 'premium', serverDescription: 'PREMIUM' },
      { uuid: 'bare', serverDescription: null },
    ]);
    const serialized = JSON.stringify(mapped);
    for (const secret of ['vlessRouteId', 'tpl-uuid-secret', 'profile-title-secret', 'x-secret-header', 'name-premium', 'PAID']) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    // Not a list: nothing to override with, and no throw.
    assert.deepEqual(mapExternalSquadHostOverrides({ response: { externalSquads: { premium: {} } } }), []);
    assert.deepEqual(mapExternalSquadHostOverrides(null), []);
  });
});
