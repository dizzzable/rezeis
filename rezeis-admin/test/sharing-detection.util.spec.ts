import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countDistinctNetworks,
  expandIpv6,
  ipNetworkKey,
  ipv4NetworkKey,
  ipv6NetworkKey,
  isNetworkSharingOffender,
  parsePanelId,
  selectConcurrentSamples,
} from '../src/modules/anti-fraud/sharing-detection.util';

const GROUP = { grouping: true, v4Prefix: 24, v6Prefix: 48 };

describe('ipv4NetworkKey', () => {
  it('masks to /24 by default', () => {
    assert.equal(ipv4NetworkKey('192.168.1.42', 24), '192.168.1.0/24');
    assert.equal(ipv4NetworkKey('192.168.1.200', 24), '192.168.1.0/24');
  });

  it('supports other prefix lengths', () => {
    assert.equal(ipv4NetworkKey('10.20.30.40', 16), '10.20.0.0/16');
    assert.equal(ipv4NetworkKey('10.20.30.40', 8), '10.0.0.0/8');
    assert.equal(ipv4NetworkKey('10.20.30.40', 32), '10.20.30.40/32');
  });

  it('returns the raw string for malformed IPv4', () => {
    assert.equal(ipv4NetworkKey('not-an-ip', 24), 'not-an-ip');
    assert.equal(ipv4NetworkKey('1.2.3.999', 24), '1.2.3.999');
  });
});

describe('expandIpv6 / ipv6NetworkKey', () => {
  it('expands :: shorthand', () => {
    assert.deepEqual(expandIpv6('2001:db8::1'), ['2001', 'db8', '0', '0', '0', '0', '0', '1']);
    assert.deepEqual(expandIpv6('::1'), ['0', '0', '0', '0', '0', '0', '0', '1']);
  });

  it('groups two privacy addresses in the same /48 site into one network', () => {
    // IPv6 privacy extensions rotate the host portion — same site, same /48.
    const a = ipv6NetworkKey('2001:db8:abcd:1::dead:beef', 48);
    const b = ipv6NetworkKey('2001:db8:abcd:9::1234:5678', 48);
    assert.equal(a, b);
  });

  it('returns raw for unparseable IPv6', () => {
    assert.equal(ipv6NetworkKey('xyz', 48), 'xyz');
  });
});

describe('ipNetworkKey dispatch', () => {
  it('routes v4 and v6 correctly', () => {
    assert.equal(ipNetworkKey('1.2.3.4', 24, 48), '1.2.3.0/24');
    assert.equal(ipNetworkKey('2001:db8:abcd:1::1', 24, 48), '2001:db8:abcd::/48');
  });
});

describe('countDistinctNetworks', () => {
  it('collapses a single mobile carrier hopping CGNAT IPs in one /24 to one network', () => {
    const ips = ['100.64.10.1', '100.64.10.55', '100.64.10.200'];
    assert.equal(countDistinctNetworks(ips, GROUP), 1);
  });

  it('counts home Wi-Fi + mobile as two networks (legitimate dual-network)', () => {
    const ips = ['85.10.20.5', '100.64.10.1'];
    assert.equal(countDistinctNetworks(ips, GROUP), 2);
  });

  it('falls back to raw distinct-IP count when grouping is off', () => {
    const ips = ['100.64.10.1', '100.64.10.55', '100.64.10.200'];
    assert.equal(countDistinctNetworks(ips, { ...GROUP, grouping: false }), 3);
  });

  it('ignores empty / non-string entries', () => {
    assert.equal(countDistinctNetworks(['1.2.3.4', ''], GROUP), 1);
  });

  // ── dual-stack ─────────────────────────────────────────────────────────
  // One device on one connection presents BOTH families. Summing the two key
  // sets made it two networks, so a legitimate two-device household reached 4
  // against a tolerance of `deviceLimit + 1 = 3` and was flagged for having
  // IPv6 enabled.

  it('counts one dual-stack device as ONE network, not two', () => {
    assert.equal(countDistinctNetworks(['203.0.113.10', '2001:db8:1:2::5'], GROUP), 1);
  });

  it('counts two dual-stack devices as TWO networks (the household that used to be flagged)', () => {
    const ips = [
      '203.0.113.10',
      '2001:db8:1:2::5', // device A, v4 + v6
      '198.51.100.7',
      '2001:db8:9:9::a', // device B, v4 + v6
    ];
    assert.equal(countDistinctNetworks(ips, GROUP), 2);
  });

  it('still counts four genuinely distinct v4 networks as four', () => {
    const ips = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'];
    assert.equal(countDistinctNetworks(ips, GROUP), 4);
  });

  it('takes the larger family, so v6-only sharing is not hidden by a single v4', () => {
    const ips = ['203.0.113.10', '2001:db8:1::1', '2001:db8:2::1', '2001:db8:3::1'];
    assert.equal(countDistinctNetworks(ips, GROUP), 3);
  });
});

describe('selectConcurrentSamples', () => {
  const NOW = Date.parse('2026-06-18T12:00:00.000Z');
  const at = (secondsAgo: number) => ({ lastSeenMs: NOW - secondsAgo * 1000 });

  it('drops a sighting that is far older than the user\'s own most recent one', () => {
    // The brief's case: IP A at T−9m, IP B at T−1m. One phone, not two networks.
    const kept = selectConcurrentSamples([at(540), at(60)], NOW, 180_000);
    assert.deepEqual(kept, [at(60)]);
  });

  it('keeps sightings that cluster together, however long ago the cluster was', () => {
    // Anchored on the USER's newest sample, not on `now`: a session that ended
    // six minutes ago still had two IPs in use 30 seconds apart.
    const kept = selectConcurrentSamples([at(390), at(360)], NOW, 180_000);
    assert.equal(kept.length, 2);
  });

  it('keeps everything when every sighting is current (genuine concurrency)', () => {
    const kept = selectConcurrentSamples([at(0), at(5), at(20)], NOW, 180_000);
    assert.equal(kept.length, 3);
  });

  it('includes the sample exactly on the window boundary', () => {
    const kept = selectConcurrentSamples([at(180), at(0)], NOW, 180_000);
    assert.equal(kept.length, 2);
  });

  it('clamps the anchor to now, so one fast node clock cannot exclude the others', () => {
    // A node running 10 minutes ahead would otherwise anchor the cluster in the
    // future and drop every correctly-clocked sample — silent under-detection.
    const kept = selectConcurrentSamples([{ lastSeenMs: NOW + 600_000 }, at(0)], NOW, 180_000);
    assert.equal(kept.length, 2);
  });

  it('drops samples with no usable timestamp and returns [] when none are usable', () => {
    assert.deepEqual(selectConcurrentSamples([{ lastSeenMs: Number.NaN }], NOW, 180_000), []);
    assert.deepEqual(selectConcurrentSamples([], NOW, 180_000), []);
  });
});

describe('parsePanelId', () => {
  it('accepts a plain integer id', () => {
    assert.equal(parsePanelId('3'), 3);
    assert.equal(parsePanelId('  42 '), 42);
    assert.equal(parsePanelId('0'), 0);
  });

  it('refuses a value that merely STARTS with digits', () => {
    // `Number.parseInt('3f2a-9c11', 10)` is 3 — one customer's connections
    // filed against panel user #3.
    assert.equal(parsePanelId('3f2a-9c11-4d8e'), null);
    assert.equal(parsePanelId('12abc'), null);
    assert.equal(parsePanelId('7.5'), null);
    assert.equal(parsePanelId('7 8'), null);
  });

  it('refuses non-numeric, empty and out-of-range values', () => {
    assert.equal(parsePanelId(''), null);
    assert.equal(parsePanelId('   '), null);
    assert.equal(parsePanelId('abc'), null);
    assert.equal(parsePanelId('-1'), null);
    assert.equal(parsePanelId('99999999999999999999999'), null);
  });

  it('takes the number the contract actually declares', () => {
    // `userId` is a number on 3.x, so this is the NORMAL path — the string
    // cases above survive only for the executor's drift arm, where a response
    // that fails the pinned schema comes back as raw wire bytes.
    assert.equal(parsePanelId(7), 7);
    assert.equal(parsePanelId(0), 0);
  });

  it('refuses a number that is not a whole, safe id', () => {
    // `4471.5` and `1e21` both pass the vendor's own coercing param schema,
    // and `String()` renders them as `'4471.5'` and `'1e+21'` — neither
    // addresses a profile. A row we cannot attribute is skipped, not rounded
    // onto whoever is nearest.
    assert.equal(parsePanelId(4471.5), null);
    assert.equal(parsePanelId(1e21), null);
    assert.equal(parsePanelId(Number.NaN), null);
    assert.equal(parsePanelId(Number.POSITIVE_INFINITY), null);
  });

  it('refuses everything that is neither a number nor a string', () => {
    for (const value of [null, undefined, {}, [], true]) {
      assert.equal(parsePanelId(value), null, JSON.stringify(value) ?? 'undefined');
    }
  });
});

describe('isNetworkSharingOffender', () => {
  it('does not flag a single user with limit+margin networks (no false positive)', () => {
    // limit 1, margin 1 → tolerate up to 2 networks (home Wi-Fi + mobile).
    assert.equal(isNetworkSharingOffender(2, 1, 1), false);
  });

  it('flags genuine sharing above the tolerated limit', () => {
    assert.equal(isNetworkSharingOffender(3, 1, 1), true);
  });

  it('never flags when the device limit is unknown (<= 0)', () => {
    assert.equal(isNetworkSharingOffender(10, 0, 1), false);
  });

  it('treats a negative margin as zero', () => {
    assert.equal(isNetworkSharingOffender(2, 1, -5), true);
  });
});
