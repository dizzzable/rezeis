import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyCascadeIp } from '../src/modules/users/utils/cascade-ip.util';

/**
 * The single decision in the block path that can refuse strangers.
 *
 * Every other cascade reaches only the person being blocked. An IP entry
 * refuses every request from that address, so the two catastrophic mistakes —
 * listing one of our own node addresses, and listing a carrier NAT pool — get
 * their own tests rather than being covered incidentally by a service test.
 */

// One entry PER NODE, each holding that node's addresses. The classifier asks
// "could we compare against this node?", which a flattened list cannot answer.
const NODES = [['203.0.113.10'], ['198.51.100.7']];

describe('classifyCascadeIp — what may never be listed', () => {
  it('refuses one of our own node addresses', () => {
    // The failure this whole function exists to prevent. A customer who opens
    // the cabinet while connected to the VPN arrives from a node exit address;
    // listing it refuses every other customer behind that node, and looks
    // exactly like an outage rather than like a decision somebody made.
    assert.deepStrictEqual(
      classifyCascadeIp({ address: '203.0.113.10', nodes: NODES }),
      { capture: false, reason: 'OUR_NODE' },
    );
  });

  it('refuses everything when the node list could not be read', () => {
    // Fail-closed, and it has to be: we cannot prove the address is not ours,
    // and the cost of being wrong is the whole fleet. A missed ban is
    // recoverable by hand; a blocked node is an outage.
    assert.deepStrictEqual(
      classifyCascadeIp({ address: '192.0.2.55', nodes: null }),
      { capture: false, reason: 'NODES_UNKNOWN' },
    );
  });

  it('treats an EMPTY node list as unknown, not as a deployment with no nodes', () => {
    // `getAllNodes()` answers `[]` on every failure, so the two are
    // indistinguishable upstream — and every real deployment has a node. This
    // is decided here rather than at the call site so no future caller can
    // reintroduce the fleet-wide block by forwarding an empty answer.
    assert.deepStrictEqual(
      classifyCascadeIp({ address: '192.0.2.55', nodes: [] }),
      { capture: false, reason: 'NODES_UNKNOWN' },
    );
  });

  for (const [label, address] of [
    ['loopback', '127.0.0.1'],
    ['private class A', '10.1.2.3'],
    ['private class B', '172.16.4.5'],
    ['private class C', '192.168.1.100'],
    ['link-local', '169.254.10.10'],
    ['carrier-grade NAT', '100.100.50.1'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unique-local', 'fd00::1'],
  ] as const) {
    it(`refuses ${label}`, () => {
      // Loopback is what a reverse proxy reports for EVERY visitor when it
      // forgets the forwarded header — listing it would refuse the whole
      // service. CGNAT is the one that hurts real customers: a mobile operator
      // puts thousands of unrelated subscribers behind one address.
      assert.deepStrictEqual(
        classifyCascadeIp({ address, nodes: NODES }),
        { capture: false, reason: 'NOT_PUBLIC' },
      );
    });
  }

  it('refuses a range, even a public one', () => {
    // A registration snapshot holds a single address. A value with a prefix did
    // not come from where this thinks it did, and a cascade must never widen a
    // ban to a range on its own.
    assert.deepStrictEqual(
      classifyCascadeIp({ address: '192.0.2.0/24', nodes: NODES }),
      { capture: false, reason: 'NOT_AN_ADDRESS' },
    );
  });

  it('refuses a hostname and other junk', () => {
    for (const address of ['node1.example.com', 'not-an-ip', '999.1.1.1']) {
      assert.deepStrictEqual(
        classifyCascadeIp({ address, nodes: NODES }),
        { capture: false, reason: 'NOT_AN_ADDRESS' },
      );
    }
  });

  for (const address of [null, undefined, '', '   ']) {
    it(`reports the commonest case plainly for ${JSON.stringify(address)}`, () => {
      // Most accounts have no registration address at all — bot-first users
      // never touch a browser edge. It is a distinct reason from the refusals
      // so the report can stay quiet about it.
      assert.deepStrictEqual(
        classifyCascadeIp({ address, nodes: NODES }),
        { capture: false, reason: 'NO_ADDRESS' },
      );
    });
  }
});

describe('classifyCascadeIp — what may be listed', () => {
  it('captures an ordinary public address', () => {
    // The positive control. A refusal that fired for everybody would satisfy
    // every assertion above perfectly, and would make the whole cascade inert.
    assert.deepStrictEqual(
      classifyCascadeIp({ address: '192.0.2.55', nodes: NODES }),
      { capture: true, value: '192.0.2.55' },
    );
  });

  it('captures a public IPv6 address', () => {
    assert.deepStrictEqual(
      classifyCascadeIp({ address: '2001:db8::1234', nodes: NODES }),
      { capture: true, value: '2001:db8::1234' },
    );
  });

  it('normalises before deciding, so the stored value matches what the guard reads', () => {
    // The guard canonicalises the same way. A stored value that differs in case
    // or whitespace from the canonical form is an entry that matches nothing —
    // a blocklist that silently does not block.
    assert.deepStrictEqual(
      classifyCascadeIp({ address: '  2001:DB8::1234  ', nodes: NODES }),
      { capture: true, value: '2001:db8::1234' },
    );
  });

  it('still compares against a node named by hostname when it reports its own address', () => {
    // The 3.2.3+ shape: the configured address is a name we refuse to resolve,
    // and the node tells us its address itself. That node IS comparable, and a
    // match on the reported address is conclusive.
    assert.deepStrictEqual(
      classifyCascadeIp({
        address: '198.51.100.7',
        nodes: [['node1.example.com', '198.51.100.7']],
      }),
      { capture: false, reason: 'OUR_NODE' },
    );
  });

  it('refuses to capture when a node yields no address it could be compared against', () => {
    // THE test, and it pins a defect that would have shipped.
    //
    // The first version counted the ENTRIES it was handed rather than the ones
    // it could compare. A node configured by hostname made the list non-empty,
    // satisfied the "we enumerated the nodes" guard, and then contributed
    // nothing — the name does not parse, the loop skipped it, and the address
    // was captured as "not one of ours" without one comparison having been
    // made. The panel only began reporting per-node addresses in 3.2.3, so on
    // an older install every node looks like this and the guard was decorative:
    // one ban could list a node's exit address and refuse every customer
    // behind it.
    assert.deepStrictEqual(
      classifyCascadeIp({ address: '192.0.2.55', nodes: [['node1.example.com']] }),
      { capture: false, reason: 'NODES_UNKNOWN' },
    );
  });

  it('refuses when only SOME nodes are comparable, because the customer may be behind the other one', () => {
    // A partial answer is the dangerous one: the fleet-wide block happens
    // precisely when the address belongs to the node nobody could check.
    assert.deepStrictEqual(
      classifyCascadeIp({
        address: '192.0.2.55',
        nodes: [['203.0.113.10'], ['de2.example.net']],
      }),
      { capture: false, reason: 'NODES_UNKNOWN' },
    );
  });

  it('captures once every node has been ruled out', () => {
    // The other half of the guard: fail-closed must not mean never-closed.
    // A fleet we could compare against in full still yields a capture, or the
    // IP cascade would be a feature that can never fire.
    assert.deepStrictEqual(
      classifyCascadeIp({
        address: '192.0.2.55',
        nodes: [['de1.example.net', '203.0.113.10'], ['198.51.100.7']],
      }),
      { capture: true, value: '192.0.2.55' },
    );
  });
});
