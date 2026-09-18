import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { authConfig } from '../src/common/config/auth.config';
import { AutomationActionRegistry } from '../src/modules/automations/actions/action-registry';
import {
  ADMIN_ADDRESS_READ_CAP,
  ADMIN_SESSION_WINDOW_MS,
} from '../src/modules/automations/services/block-ip-safety.service';
import {
  createAutomationHarness,
  DEFAULT_REQUEST_IP,
  type AutomationHarness,
} from './helpers/automation-http-harness';

/**
 * `block_ip` must never lock the panel out of itself
 * ═══════════════════════════════════════════════════
 *
 * `BlockedIpGuard` runs before the admin allowlist and before sign-in, so an
 * address on the blocklist cannot reach the panel at all — and the way back is
 * an UPDATE against the database. The manual screen refuses one thing: an
 * entry covering the caller's own address. The rule action refused nothing, and
 * it runs at 03:00 with nobody watching: it could list the reverse proxy, the
 * cabinet's container (every customer request comes from it), or the address
 * every admin signs in from.
 *
 * Each case runs a real rule through «Запустить сейчас» over HTTP, so the
 * requester's address is resolved by the route exactly as behind the proxy,
 * and asserts both halves: the refusal, and that nothing reached the blocklist.
 */

const BLOCKER = ['automations:view', 'automations:run', 'blocked_ips:create'];

let harness: AutomationHarness;

before(async () => {
  harness = await createAutomationHarness([{ id: 'blocker', role: 'ADMIN', permissions: BLOCKER }]);
});

after(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.db.rules.clear();
  harness.db.audit.length = 0;
  harness.db.executions.length = 0;
  harness.db.blockedIps.clear();
  harness.db.admins.length = 0;
  harness.db.loginAttempts.length = 0;
  harness.db.allowlist.length = 0;
  harness.db.failAdminReads = false;
  harness.network.localAddresses = [];
  harness.network.serviceHosts = [];
  harness.network.dns.clear();
});

interface ActionResult {
  readonly status: string;
  readonly code?: string;
  readonly message?: string;
  readonly details?: Record<string, unknown>;
}

/** Runs a one-action block_ip rule by hand and answers what the action did. */
async function runBlock(
  triggerIp: string | undefined,
  options: { readonly from?: string; readonly pinned?: string } = {},
): Promise<ActionResult> {
  const rule = harness.seedRule({
    actions: [{ type: 'block_ip', params: options.pinned === undefined ? {} : { address: options.pinned } }],
  });
  const response = await harness
    .as('blocker', options.from ?? DEFAULT_REQUEST_IP)
    .post(`/rules/${rule.id}/run`, { triggerData: triggerIp === undefined ? {} : { ip: triggerIp } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const result = response.body.actionResults[0] as ActionResult | undefined;
  assert.ok(result !== undefined, `no action ran: ${JSON.stringify(response.body)}`);
  return result;
}

function assertRefused(result: ActionResult, protection: string, extra: Record<string, unknown> = {}): void {
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.equal(result.code, 'block_address_protected', JSON.stringify(result));
  assert.equal(result.details?.['protection'], protection, JSON.stringify(result));
  for (const [key, value] of Object.entries(extra)) {
    assert.equal(result.details?.[key], value, `${key}: ${JSON.stringify(result)}`);
  }
  assert.deepStrictEqual([...harness.db.blockedIps.keys()], [], 'refused, but the address was blocked');
}

function assertBlocked(result: ActionResult, stored: string): void {
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.deepStrictEqual([...harness.db.blockedIps.keys()], [stored]);
  assert.equal(harness.db.blockedIps.get(stored)?.['source'], 'automation');
}

describe('the manual screen’s own check, carried to a manual run', () => {
  it('refuses to block the address the run was requested from', async () => {
    assertRefused(await runBlock('203.0.113.50', { from: '203.0.113.50' }), 'your_address');
  });

  it('recognises the requester through the IPv4-mapped spelling', async () => {
    assertRefused(await runBlock('::ffff:203.0.113.50', { from: '203.0.113.50' }), 'your_address');
  });

  it('refuses a range written into the rule that contains the requester', async () => {
    assertRefused(await runBlock(undefined, { from: '203.0.113.50', pinned: '203.0.113.0/24' }), 'your_address');
  });
});

describe('the panel’s own network, which no rule may list', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['127.0.0.1', '127.0.0.0/8'],
    ['10.1.2.3', '10.0.0.0/8'],
    ['172.18.0.4', '172.16.0.0/12'],
    ['192.168.1.10', '192.168.0.0/16'],
    ['169.254.169.254', '169.254.0.0/16'],
    ['100.64.1.1', '100.64.0.0/10'],
    ['0.0.0.0', '0.0.0.0/8'],
    ['::1', '::1/128'],
    ['fd12::1', 'fc00::/7'],
    ['fe80::1', 'fe80::/10'],
    ['::ffff:192.168.1.10', '192.168.0.0/16'],
  ];
  for (const [address, range] of cases) {
    it(`refuses ${address}`, async () => {
      assertRefused(await runBlock(address), 'internal_network', { range });
    });
  }

  it('refuses a range written into the rule that swallows it', async () => {
    assertRefused(await runBlock(undefined, { pinned: '::/0' }), 'internal_network', { range: '::/128' });
    harness.db.blockedIps.clear();
    assertRefused(await runBlock(undefined, { pinned: '::ffff:0:0/96' }), 'internal_network', { range: '::ffff:0:0/96' });
  });
});

describe('the machine the panel runs on', () => {
  it('refuses an address of its own interfaces', async () => {
    harness.network.localAddresses = ['198.51.100.5'];
    assertRefused(await runBlock('198.51.100.5'), 'this_panel');
  });
});

describe('every administrator’s current sessions', () => {
  it('refuses the last sign-in address of an active admin, and not of a deactivated one', async () => {
    harness.db.admins.push({ lastLoginIp: '203.0.113.60', isActive: true });
    harness.db.admins.push({ lastLoginIp: '203.0.113.70', isActive: false });
    assertRefused(await runBlock('203.0.113.60'), 'admin_session');
    assertBlocked(await runBlock('203.0.113.70'), '203.0.113.70');
  });

  it('refuses an address that signed in within 24 hours, and not one from before', async () => {
    harness.db.loginAttempts.push({ ipAddress: '203.0.113.61', success: true, createdAt: new Date() });
    harness.db.loginAttempts.push({
      ipAddress: '203.0.113.62',
      success: true,
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    assertRefused(await runBlock('203.0.113.61'), 'admin_session');
    assertBlocked(await runBlock('203.0.113.62'), '203.0.113.62');
  });

  it('refuses an address an admin acted from within 24 hours — a session is not bound to where it began', async () => {
    harness.db.audit.push({
      action: 'plans.updated',
      adminUserId: 'admin-9',
      ipAddress: '203.0.113.63',
      userAgent: null,
      metadata: {},
      createdAt: new Date(),
    });
    // A system event is written to the same table with no admin: not a session.
    harness.db.audit.push({
      action: 'event.payment.failed',
      adminUserId: null,
      ipAddress: '203.0.113.64',
      userAgent: null,
      metadata: {},
      createdAt: new Date(),
    });
    assertRefused(await runBlock('203.0.113.63'), 'admin_session');
    assertBlocked(await runBlock('203.0.113.64'), '203.0.113.64');
  });

  it('refuses a successful sign-in, and not a failed one', async () => {
    harness.db.loginAttempts.push({ ipAddress: '203.0.113.71', success: true, createdAt: new Date() });
    // A failed attempt is anybody at the login form, not an administrator's session.
    harness.db.loginAttempts.push({ ipAddress: '203.0.113.72', success: false, createdAt: new Date() });
    assertRefused(await runBlock('203.0.113.71'), 'admin_session');
    assertBlocked(await runBlock('203.0.113.72'), '203.0.113.72');
  });

  it('recognises an admin recorded in the IPv4-mapped spelling a dual-stack socket gives', async () => {
    // Node reports an IPv4 client on a dual-stack socket as `::ffff:a.b.c.d`,
    // and that is what `lastLoginIp` holds; the block names the IPv4 address.
    harness.db.admins.push({ lastLoginIp: '::ffff:203.0.113.73', isActive: true });
    assertRefused(await runBlock('203.0.113.73'), 'admin_session');
  });

  it('refuses a range that contains an admin’s address, without naming the address', async () => {
    harness.db.admins.push({ lastLoginIp: '203.0.113.5', isActive: true });
    const result = await runBlock(undefined, { pinned: '203.0.113.0/28' });
    assertRefused(result, 'admin_session');
    assert.ok(!JSON.stringify(result).includes('203.0.113.5"'), 'an admin’s own address reached the run log');
  });
});

describe('the admin IP allowlist', () => {
  it('refuses an address inside an active entry, and not inside a staged one', async () => {
    harness.db.allowlist.push({ address: '198.51.100.128/25', isActive: true });
    harness.db.allowlist.push({ address: '192.0.2.0/24', isActive: false });
    assertRefused(await runBlock('198.51.100.200'), 'admin_allowlist');
    assertBlocked(await runBlock('192.0.2.7'), '192.0.2.7');
  });
});

describe('the panel’s own services, resolved', () => {
  it('refuses what the panel’s domain resolves to, and carries on past a name that does not resolve', async () => {
    harness.network.serviceHosts = ['panel-a.example.test', 'cabinet-a.example.test'];
    harness.network.dns.set('panel-a.example.test', ['192.0.2.10']);
    assertRefused(await runBlock('192.0.2.10'), 'panel_service');
    assertBlocked(await runBlock('192.0.2.11'), '192.0.2.11');
  });
});

describe('a service name that did not answer', () => {
  it('is asked again on the next block, not remembered as having no address', async () => {
    harness.network.serviceHosts = ['panel-c.example.test'];
    // The panel's domain does not resolve yet: it protects nothing this round.
    assertBlocked(await runBlock('192.0.2.40'), '192.0.2.40');
    harness.db.blockedIps.clear();

    // It answers now, and the very next block asks it.
    harness.network.dns.set('panel-c.example.test', ['192.0.2.41']);
    assertRefused(await runBlock('192.0.2.41'), 'panel_service');
  });
});

describe('failing closed', () => {
  it('blocks nothing when the administrators’ addresses cannot be read, and keeps the reason off the run log', async () => {
    harness.db.failAdminReads = true;
    const result = await runBlock('203.0.113.99');

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'block_address_unverified');
    assert.deepStrictEqual([...harness.db.blockedIps.keys()], []);
    assert.ok(!(result.message ?? '').includes('ECONNREFUSED'), 'the database’s own sentence reached the run log');
  });

  it('blocks nothing when there are more administrator addresses than it reads at once', async () => {
    // A list cut short at the cap would be a list with holes in it.
    const signIns = (count: number) =>
      Array.from({ length: count }, (_, n) => ({
        ipAddress: `10.${Math.floor(n / 250)}.${n % 250}.9`,
        success: true,
        createdAt: new Date(),
      }));
    harness.db.loginAttempts.push(...signIns(ADMIN_ADDRESS_READ_CAP));
    const refused = await runBlock('203.0.113.98');
    assert.equal(refused.code, 'block_address_unverified', JSON.stringify(refused));
    assert.deepStrictEqual([...harness.db.blockedIps.keys()], []);

    // One fewer is a list read whole, and the block goes through.
    harness.db.loginAttempts.length = 0;
    harness.db.loginAttempts.push(...signIns(ADMIN_ADDRESS_READ_CAP - 1));
    assertBlocked(await runBlock('203.0.113.98'), '203.0.113.98');
  });

  it('blocks nothing when the lockout check is not there to ask', async () => {
    const blocked: unknown[] = [];
    const registry = new AutomationActionRegistry(
      {} as never,
      { blockedIp: { upsert: async (args: unknown) => blocked.push(args) } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const result = await registry.execute(
      0,
      { type: 'block_ip', params: { address: '203.0.113.99' } },
      { ruleId: 'r', ruleName: 'r', trigger: 'manual:admin', triggerData: {} },
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'block_address_unverified');
    assert.deepStrictEqual(blocked, []);
  });
});

describe('what is still blocked, and how it is written', () => {
  it('blocks a stranger, in the canonical spelling the guard compares', async () => {
    assertBlocked(await runBlock('203.0.113.99'), '203.0.113.99');
    harness.db.blockedIps.clear();
    assertBlocked(await runBlock('::FFFF:203.0.113.98'), '203.0.113.98');
    harness.db.blockedIps.clear();
    assertBlocked(await runBlock('2001:DB8:ABCD::1'), '2001:db8:abcd::1');
  });

  it('refuses what is not an address, and a range the trigger data names', async () => {
    const junk = await runBlock('not-an-ip');
    assert.equal(junk.code, 'block_address_invalid');
    assert.deepStrictEqual(junk.details, { source: 'trigger' });

    const range = await runBlock('203.0.113.0/24');
    assert.equal(range.code, 'block_address_invalid');
    assert.deepStrictEqual(range.details, { source: 'trigger' });

    const pinned = await runBlock(undefined, { pinned: 'garbage' });
    assert.equal(pinned.code, 'block_address_invalid');
    assert.deepStrictEqual(pinned.details, { source: 'rule' });

    assert.deepStrictEqual([...harness.db.blockedIps.keys()], []);
  });

  it('says so when there is no address at all', async () => {
    const result = await runBlock(undefined);
    assert.equal(result.code, 'block_address_missing');
  });
});

describe('the session window', () => {
  it('is the admin token’s lifetime', () => {
    assert.equal(ADMIN_SESSION_WINDOW_MS, 24 * 60 * 60 * 1000);
    assert.equal(authConfig().jwtExpiresIn, '24h', 'the admin token lifetime moved: move the window with it');
  });
});
