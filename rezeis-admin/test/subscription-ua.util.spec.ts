import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findProxyConfigUri,
  redactUserAgentForEvidence,
} from '../src/modules/anti-fraud/subscription-ua.util';

/**
 * The classifier behind `SUBSCRIPTION_UA_TUNNEL`.
 *
 * Half of these tests assert what the classifier REFUSES to call evidence.
 * That half is the point: the upstream idea this came from scores empty UAs,
 * HTTP libraries, browsers and "a mix of clients", and every one of those
 * fires on ordinary customers of this service. A regression that starts
 * flagging `okhttp` would not fail a test that only checks `vless://` is
 * caught, so the refusals are pinned as hard as the catches.
 */
describe('findProxyConfigUri — what counts as evidence', () => {
  it('flags a User-Agent carrying a vless config URI', () => {
    const finding = findProxyConfigUri('vless://b7f1e0c2-1111-2222-3333-444455556666@1.2.3.4:443');
    assert.notEqual(finding, null);
    assert.equal(finding?.scheme, 'vless');
    assert.equal(finding?.percentEncoded, false);
  });

  it('flags a config URI embedded mid-string, not only at the start', () => {
    const finding = findProxyConfigUri('SomeClient/1.0 (sub=trojan://pass@example.org:443)');
    assert.equal(finding?.scheme, 'trojan');
  });

  it('reports the specific scheme when one is a prefix of another', () => {
    // `hysteria2` must not be reported as `hysteria`.
    assert.equal(findProxyConfigUri('x hysteria2://a@b:443')?.scheme, 'hysteria2');
  });

  it('sees through percent-encoding and says that it did', () => {
    const finding = findProxyConfigUri('Agent/1.0 vmess%3A%2F%2Fdeadbeef%40host%3A443');
    assert.equal(finding?.scheme, 'vmess');
    assert.equal(finding?.percentEncoded, true);
  });

  it('survives a malformed percent escape instead of throwing', () => {
    // `decodeURIComponent` throws on a lone `%`; a detector run must not die
    // because one request had a broken UA.
    assert.doesNotThrow(() => findProxyConfigUri('100%'));
    assert.equal(findProxyConfigUri('100%'), null);
  });
});

describe('findProxyConfigUri — refusals that protect ordinary customers', () => {
  it('does not flag an absent or empty User-Agent', () => {
    // Plenty of legitimate clients send no UA at all.
    assert.equal(findProxyConfigUri(null), null);
    assert.equal(findProxyConfigUri(undefined), null);
    assert.equal(findProxyConfigUri(''), null);
    assert.equal(findProxyConfigUri('   '), null);
  });

  it('does not flag ordinary VPN client User-Agents', () => {
    for (const ua of [
      'v2rayNG/1.8.5',
      'Streisand/1.6.6',
      'Happ/1.9.0 (iOS)',
      'clash-verge/1.5.1',
      'sing-box 1.8.0',
      'Shadowrocket/2.2.30 CFNetwork/1490 Darwin/23.1.0',
      'Hiddify/2.0.5',
    ]) {
      assert.equal(findProxyConfigUri(ua), null, `must not flag ${ua}`);
    }
  });

  it('does not flag generic HTTP libraries', () => {
    // okhttp IS the Android HTTP stack — scoring it means scoring Android.
    for (const ua of ['okhttp/4.9.0', 'Go-http-client/2.0', 'curl/8.4.0', 'python-requests/2.31.0']) {
      assert.equal(findProxyConfigUri(ua), null, `must not flag ${ua}`);
    }
  });

  it('does not flag a browser opening the subscription page', () => {
    // Remnawave serves a human-readable subscription page at the same URL, so
    // this is the most normal thing a customer can do.
    assert.equal(
      findProxyConfigUri(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      ),
      null,
    );
  });

  it('does not flag a crawler or link-preview bot advertising its policy URL', () => {
    // Our own bot posting a subscription link into a chat invites exactly this
    // fetch. `https://` inside a UA is therefore NOT evidence.
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'TelegramBot (like TwitterBot)',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    ]) {
      assert.equal(findProxyConfigUri(ua), null, `must not flag ${ua}`);
    }
  });

  it('requires a real scheme boundary, so a longer word ending in a scheme is not a match', () => {
    // `ss` is two characters, and without a leading scheme boundary ANY token
    // ending in those characters followed by `://` matches it — `bypass://`,
    // `compress://`, `express://`. A substring search would turn each of those
    // into a Shadowsocks config and file a signal on it.
    for (const ua of [
      'MyApp/1.0 (cache=compress://local)',
      'Router/2 bypass://direct',
      'Gateway/1 express://internal',
    ]) {
      assert.equal(findProxyConfigUri(ua), null, `must not flag ${ua}`);
    }
    // The genuine scheme, standing on its own, still matches.
    assert.equal(findProxyConfigUri('Client/1 ss://creds@host:8388')?.scheme, 'ss');
  });
});

describe('redactUserAgentForEvidence', () => {
  it('strips the credential out of a config URI before it reaches metadata', () => {
    // A vless uuid and a trojan password ARE the credentials. Signal metadata
    // is rendered in the admin UI; copying live secrets into it is not on.
    const redacted = redactUserAgentForEvidence(
      'vless://b7f1e0c2-1111-2222-3333-444455556666@1.2.3.4:443?type=tcp',
    );
    assert.ok(!redacted.includes('b7f1e0c2-1111-2222-3333-444455556666'), redacted);
    assert.ok(redacted.includes('<redacted>@'), redacted);
    // The host is the evidence — which upstream is being carried — and stays.
    assert.ok(redacted.includes('1.2.3.4'), redacted);
  });

  it('redacts every config URI when the UA carries more than one', () => {
    const redacted = redactUserAgentForEvidence('vless://aaa@h1:443 trojan://bbb@h2:443');
    assert.ok(!redacted.includes('aaa'), redacted);
    assert.ok(!redacted.includes('bbb'), redacted);
  });

  it('caps the length so one UA cannot flood a signal row', () => {
    const redacted = redactUserAgentForEvidence(`vless://u@h:443/${'x'.repeat(500)}`, 60);
    assert.ok(redacted.length <= 61, `length ${redacted.length}`);
  });
});
