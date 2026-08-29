import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserIpObservationService } from '../src/modules/device-intelligence/services/user-ip-observation.service';

/**
 * Where an account has been seen from — on a product that moves people's traffic
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The usual reasoning about addresses is inverted here. A customer browsing the
 * cabinet WHILE CONNECTED arrives from one of our own exit nodes, and so does
 * every other customer behind it. Record those and group on them and the result
 * is a map of who was on which node, presented as a map of people — the kind of
 * confident-looking output somebody then acts on.
 *
 * Mobile carriers do the same through CGNAT: thousands of subscribers behind
 * one address, so a match there links strangers.
 *
 * Everything below is about what must NOT be recorded. `classifyCascadeIp` —
 * the block cascade's own function — makes every one of those calls, because
 * asking the question a second way here would eventually disagree with it.
 */

const CUSTOMER_IP = '198.51.100.7';
const NODE_IP = '203.0.113.10';

function build(options: {
  /** `null` means the panel could not be asked — not "we have no nodes". */
  readonly nodes?: readonly (readonly string[])[] | null;
  readonly blockedRows?: ReadonlyArray<{ userId: string; hits: number; lastSeenAt: Date }>;
  /** Rows the card query returns for the account being viewed. */
  readonly ownRows?: ReadonlyArray<Record<string, unknown>>;
  /** Rows the "who else was here" query returns. */
  readonly sharedRows?: ReadonlyArray<{ address: string; userId: string }>;
} = {}) {
  const upserts: Array<Record<string, unknown>> = [];
  const queries: Array<Record<string, unknown>> = [];
  const prisma = {
    userIpObservation: {
      upsert: async (args: Record<string, unknown>) => {
        upserts.push(args);
        return {};
      },
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        const where = args.where as Record<string, unknown>;
        // Three different callers share this stub. `listForUser` asks twice —
        // once for the account's own rows, once for everybody else at those
        // addresses — and telling them apart on the `where` is what keeps this
        // fake from answering one question with another's data.
        if (options.ownRows !== undefined && typeof where.userId === 'string') {
          return options.ownRows;
        }
        if (options.sharedRows !== undefined && where.userId !== undefined) {
          return options.sharedRows;
        }
        return options.blockedRows ?? [];
      },
      deleteMany: async (args: Record<string, unknown>) => {
        queries.push(args);
        return { count: 3 };
      },
    },
  };
  const nodeAddresses = {
    read: async () => (options.nodes === undefined ? [] : options.nodes),
  };
  return {
    service: new UserIpObservationService(prisma as never, nodeAddresses as never),
    upserts,
    queries,
  };
}

describe('what must never be recorded', () => {
  it('refuses one of our own exit nodes', async () => {
    // THE case this whole file is about. Every customer behind that node
    // arrives from it; filing them under one address would make a node's worth
    // of strangers look like one person.
    const { service, upserts } = build({ nodes: [[NODE_IP]] });

    assert.equal(await service.record('u-1', NODE_IP), false);
    assert.deepStrictEqual(upserts, []);
  });

  it('refuses carrier-grade NAT', async () => {
    // 100.64.0.0/10 pools thousands of mobile subscribers behind one address.
    const { service, upserts } = build({ nodes: [[NODE_IP]] });

    assert.equal(await service.record('u-1', '100.64.12.9'), false);
    assert.deepStrictEqual(upserts, []);
  });

  it('refuses a private address', async () => {
    const { service } = build({ nodes: [[NODE_IP]] });

    assert.equal(await service.record('u-1', '192.168.1.5'), false);
  });

  it('refuses everything when the node list could not be read', async () => {
    // `getAllNodes()` answers `[]` on ANY failure, so "we have no nodes" and
    // "we could not ask" arrive as one value. Treating the second as the first
    // records every node's exit address as though it belonged to whoever
    // happened to be behind it — during an outage, which is exactly when
    // nobody is watching.
    const { service, upserts } = build({ nodes: null });

    assert.equal(await service.record('u-1', CUSTOMER_IP), false);
    assert.deepStrictEqual(upserts, []);
  });

  it('refuses when the node list came back empty', async () => {
    // Same value, same treatment. An install genuinely without nodes is not a
    // running VPN service, so the reading that costs nothing is the safe one.
    const { service, upserts } = build({ nodes: [] });

    assert.equal(await service.record('u-1', CUSTOMER_IP), false);
    assert.deepStrictEqual(upserts, []);
  });
});

describe('what is recorded', () => {
  it('notes an address that can be attributed to a person', async () => {
    const { service, upserts } = build({ nodes: [[NODE_IP]] });

    assert.equal(await service.record('u-1', CUSTOMER_IP), true);
    assert.equal(upserts.length, 1);
    const where = upserts[0].where as { userId_address: { userId: string; address: string } };
    assert.equal(where.userId_address.address, CUSTOMER_IP);
  });

  it('bumps a repeat sighting instead of adding a row', async () => {
    // What keeps the table proportional to PLACES rather than to page views —
    // and what makes `hits` mean something.
    const { service, upserts } = build({ nodes: [[NODE_IP]] });

    await service.record('u-1', CUSTOMER_IP);

    const update = upserts[0].update as { hits: { increment: number } };
    assert.equal(update.hits.increment, 1);
  });

  it('stores the canonical form, so a lookup cannot miss over spelling', async () => {
    const { service, upserts } = build({ nodes: [[NODE_IP]] });

    await service.record('u-1', '2001:DB8::1234');

    const where = upserts[0].where as { userId_address: { address: string } };
    assert.equal(where.userId_address.address, '2001:db8::1234');
  });

  it('records nothing for an empty address', async () => {
    const { service, upserts } = build({ nodes: [[NODE_IP]] });

    assert.equal(await service.record('u-1', '   '), false);
    assert.deepStrictEqual(upserts, []);
  });
});

describe('asking who else was there', () => {
  it('names blocked accounts seen from the same address', async () => {
    const { service } = build({
      nodes: [[NODE_IP]],
      blockedRows: [{ userId: 'banned-1', hits: 12, lastSeenAt: new Date() }],
    });

    const matches = await service.blockedMatches(CUSTOMER_IP);

    assert.equal(matches.length, 1);
    assert.equal(matches[0].userId, 'banned-1');
  });

  it('refuses to match on an address it would not have recorded', async () => {
    // The symmetry matters: matching on a node address would report every
    // blocked customer who ever used that node as a "match" for whoever is
    // behind it now.
    const { service, queries } = build({ nodes: [[NODE_IP]] });

    assert.deepStrictEqual(await service.blockedMatches(NODE_IP), []);
    assert.deepStrictEqual(queries, [], 'and asks the database nothing');
  });

  it('refuses to match when the node list could not be read', async () => {
    const { service, queries } = build({ nodes: null });

    assert.deepStrictEqual(await service.blockedMatches(CUSTOMER_IP), []);
    assert.deepStrictEqual(queries, []);
  });
});

describe('retention', () => {
  it('drops observations older than ninety days', async () => {
    // These are movement traces rather than a browser fingerprint. A table
    // nobody prunes quietly becomes a permanent location history.
    const { service, queries } = build({ nodes: [[NODE_IP]] });
    const now = new Date('2026-08-29T12:00:00.000Z');

    await service.prune(now);

    const where = queries[0].where as { lastSeenAt: { lt: Date } };
    const days = (now.getTime() - where.lastSeenAt.lt.getTime()) / (24 * 60 * 60 * 1000);
    assert.equal(days, 90);
  });
});

describe('the addresses shown on a user card', () => {
  const NOW = new Date('2026-08-30T12:00:00.000Z');

  it('marks the address a blocked account was also seen from', async () => {
    const { service } = build({
      ownRows: [
        { address: '198.51.100.7', hits: 40, firstSeenAt: NOW, lastSeenAt: NOW },
        { address: '198.51.100.8', hits: 2, firstSeenAt: NOW, lastSeenAt: NOW },
      ],
      sharedRows: [{ address: '198.51.100.7', userId: 'banned-1' }],
    });

    const rows = await service.listForUser('u-1');

    assert.equal(rows.length, 2);
    assert.deepStrictEqual(rows[0].sharedWithBlocked, ['banned-1']);
    assert.deepStrictEqual(rows[1].sharedWithBlocked, [], 'and leaves the clean one clean');
  });

  it('asks who else was there in ONE query, not one per address', async () => {
    // A card that costs eight round trips is a card somebody stops opening.
    const { service, queries } = build({
      ownRows: [
        { address: 'a', hits: 1, firstSeenAt: NOW, lastSeenAt: NOW },
        { address: 'b', hits: 1, firstSeenAt: NOW, lastSeenAt: NOW },
        { address: 'c', hits: 1, firstSeenAt: NOW, lastSeenAt: NOW },
      ],
      sharedRows: [],
    });

    await service.listForUser('u-1');

    assert.equal(queries.length, 2);
  });

  it('asks nothing further when the account has no addresses', async () => {
    const { service, queries } = build({ ownRows: [], sharedRows: [] });

    assert.deepStrictEqual(await service.listForUser('u-1'), []);
    assert.equal(queries.length, 1);
  });

  it('excludes the account itself from "who else was here"', async () => {
    // Without it every address would report its own owner as a match.
    const { service, queries } = build({
      ownRows: [{ address: 'a', hits: 1, firstSeenAt: NOW, lastSeenAt: NOW }],
      sharedRows: [],
    });

    await service.listForUser('u-1');

    const where = queries[1].where as { userId: { not: string }; user: { isBlocked: boolean } };
    assert.deepStrictEqual(where.userId, { not: 'u-1' });
    assert.equal(where.user.isBlocked, true);
  });
});
