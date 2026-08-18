import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';

import { RELAY_DIRECT_DELIVERY_EXCEPTIONS } from '../src/modules/notifications/reiwa-relay.constants';

/**
 * Nothing reaches the cabinet without the queue except by name
 * ════════════════════════════════════════════════════════════
 * The durable relay queue only helps the events that actually go through it.
 * `BotNotifierClient` still exposes every one-shot delivery method the queue is
 * built on, they are all `public`, and a caller that reaches for one gets the
 * pre-queue behaviour back with no warning of any kind: one attempt, and — for
 * the four methods that return `Promise<void>` — an outcome that is discarded
 * before the caller could look at it.
 *
 * That is not a hypothetical. `BroadcastDeliveryService.postToChannelIfConfigured`
 * posted the operator-channel copy of every broadcast through `notifyBroadcast`
 * while the other two producers of the same `durable` event went through the
 * queue. It survived review, a type-checker and twenty-odd green tests, because
 * nothing in any of them is capable of noticing the difference: `deliver()`
 * never throws, so even the `try/catch` wrapped around it could not fire on a
 * failed delivery. A refused channel post and a delivered one left identical
 * traces.
 *
 * So the guard is structural. Enumerate the callers from the tree and require
 * each one to be named, with a reason, in `RELAY_DIRECT_DELIVERY_EXCEPTIONS`.
 *
 * The anchors matter as much as the check
 * ───────────────────────────────────────
 * A scan that finds nothing agrees with a clean tree forever, and a typo in a
 * method name or a wrong root directory produces exactly that: an empty result
 * set, zero offenders, permanent green. Three things are asserted before the
 * verdict is trusted — that the method list was really read off the client,
 * that the matcher can find a call it is shown, and that the tree scan still
 * finds the call sites we know exist. Each of those is a way this test could
 * quietly stop working, and each one fails loudly instead.
 */

const REPO_ROOT = join(__dirname, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const CLIENT = join(SRC_ROOT, 'modules', 'notifications', 'services', 'bot-notifier.client.ts');

/** Repo-relative, POSIX-separated — the key shape the exception list uses. */
function repoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Drop comments, keep string contents.
 *
 * Both halves are load-bearing. Comments must go, because the fix that
 * prompted this test explains itself by naming the method it stopped calling —
 * a scan that counted prose would report the file it just cleaned. String
 * contents must stay, because a call built inside a template literal is still
 * a call.
 *
 * Regex literals are treated as ordinary code, which is safe here for the same
 * reason it is usually unsafe: the only way one could matter is by containing
 * a literal `//` or an unmatched quote, and a slash inside a regex is written
 * `\/`.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * The guarded methods, read off the client rather than typed out here.
 *
 * A hand-kept list is the one thing that cannot cover a method added tomorrow,
 * and the method added tomorrow is the whole population this test exists for.
 */
function guardedMethods(): string[] {
  const source = stripComments(readFileSync(CLIENT, 'utf8'));
  return [...source.matchAll(/public\s+async\s+(\w+)\s*\(/g)].map((m) => m[1]);
}

interface CallSite {
  readonly file: string;
  readonly method: string;
}

function findCallSites(methods: readonly string[]): CallSite[] {
  // The anti-emptiness anchor, placed where it cannot be skipped: a scan with
  // no method names to look for finds no callers, reports no offenders and
  // passes forever. (It would also build a regex matching every call in the
  // tree, which is merely noisy — the silent direction is the dangerous one.)
  assert.ok(
    methods.length > 0,
    'the guarded method list came back empty — the scan below would prove nothing',
  );
  const pattern = new RegExp(`\\.\\s*(${methods.join('|')})\\s*\\(`, 'g');
  const sites: CallSite[] = [];
  for (const file of walk(SRC_ROOT)) {
    if (file === CLIENT) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(pattern)) {
      sites.push({ file: repoPath(file), method: match[1] });
    }
  }
  return sites;
}

describe('the panel reaches the cabinet through the relay queue, or by name', () => {
  it('reads the guarded methods off BotNotifierClient itself', () => {
    const methods = guardedMethods();
    // The four that return `Promise<void>` — the ones that cannot report a
    // failure even to a caller who wanted to know.
    for (const required of [
      'notifyBroadcast',
      'notifyBroadcastDocument',
      'notifyDev',
      'notifyDevDocument',
    ]) {
      assert.ok(
        methods.includes(required),
        `${required} must be detected on the client; found ${methods.join(', ')}`,
      );
    }
    // The two that DO return an outcome are guarded as well: returning one is
    // not the same as a caller reading it, and both are direct hops past the
    // queue either way.
    assert.ok(methods.includes('deliverRelayEvent'), 'the generic one-shot entry point');
    assert.ok(methods.includes('notifyUser'), 'the per-recipient entry point');
    assert.ok(
      methods.length >= 6,
      `expected the client's public delivery surface, found ${methods.length}: ${methods.join(', ')}`,
    );
  });

  it('finds a call when it is shown one, and ignores a call that is only mentioned', () => {
    // Anchor against the empty scan. If the matcher silently stopped matching,
    // every assertion below would pass by finding nothing at all — which is
    // precisely how a bypass would slip through unnoticed.
    const fixture = [
      '// await this.botNotifier.notifyDevDocument({ filename });',
      '/* this.botNotifier.notifyBroadcast({ chatId }); */',
      "const doc = 'notifyBroadcastDocument';",
      'await this.botNotifier.notifyDev({ text });',
    ].join('\n');
    const stripped = stripComments(fixture);
    const pattern = /\.\s*(notifyBroadcast|notifyBroadcastDocument|notifyDev|notifyDevDocument)\s*\(/g;
    const hits = [...stripped.matchAll(pattern)].map((m) => m[1]);
    assert.deepStrictEqual(
      hits,
      ['notifyDev'],
      'the matcher must see the real call and only the real call',
    );
  });

  it('still finds the call sites that are known to exist', () => {
    const sites = findCallSites(guardedMethods());
    // Zero call sites is not a clean codebase, it is a broken scan: the queue's
    // own consumer has to make one, and so does its Redis fallback.
    assert.ok(sites.length >= 5, `expected the known direct callers, found ${sites.length}`);
    const files = new Set(sites.map((s) => s.file));
    for (const known of [
      'src/modules/notifications/reiwa-relay.processor.ts',
      'src/modules/notifications/services/reiwa-relay-queue.service.ts',
      'src/common/services/system-events.service.ts',
    ]) {
      assert.ok(files.has(known), `${known} must still be detected as a direct caller`);
    }
  });

  it('fails on any direct caller that is not a documented exception', () => {
    const sites = findCallSites(guardedMethods());
    const offenders = sites
      .filter((s) => !(s.file in RELAY_DIRECT_DELIVERY_EXCEPTIONS))
      .map((s) => `${s.file} calls BotNotifierClient.${s.method} without going through the queue`);
    assert.deepStrictEqual(
      [...new Set(offenders)],
      [],
      'a new direct caller must either use ReiwaRelayQueueService or be added to ' +
        'RELAY_DIRECT_DELIVERY_EXCEPTIONS with the reason it cannot',
    );
  });

  it('keeps the exception list from outliving its entries', () => {
    // An allowlist naming files that stopped calling anything is an allowlist
    // nobody has read. Every entry has to still be earning its place.
    const callers = new Set(findCallSites(guardedMethods()).map((s) => s.file));
    const stale = Object.keys(RELAY_DIRECT_DELIVERY_EXCEPTIONS).filter((f) => !callers.has(f));
    assert.deepStrictEqual(
      stale,
      [],
      'these files no longer call the client directly and should leave the exception list',
    );
  });

  it('states a reason for every exception', () => {
    const entries = Object.entries(RELAY_DIRECT_DELIVERY_EXCEPTIONS);
    assert.ok(entries.length >= 4, `expected the documented exceptions, found ${entries.length}`);
    for (const [file, reason] of entries) {
      assert.ok(
        reason.trim().length >= 40,
        `${file}: an exception without a reason is a silenced test, not a decision`,
      );
    }
  });
});
