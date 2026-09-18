import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  createAutomationHarness,
  messagesOf,
  ruleBody,
  type AutomationHarness,
} from './helpers/automation-http-harness';

/**
 * What a rule may be when it is saved — and when it is switched on
 * ═════════════════════════════════════════════════════════════════
 *
 * Three holes, one shape: the rule was accepted and the problem surfaced only
 * when it ran, if at all.
 *
 *   CONDITIONS took any JSON. The evaluator is total — whatever it does not
 *   understand collapses to `false` without a word — so a typo made a rule that
 *   is skipped "conditions did not match" on every run, for ever.
 *
 *   A WEBHOOK URL was not looked at: loopback, the compose network and the
 *   cloud metadata address were all fine to save and then fetch, from inside
 *   the network, on every event.
 *
 *   An ADDRESS written into a block_ip action was not looked at either.
 *
 * And the switch in the list skipped every check there was.
 *
 * All through HTTP, the production pipe and the safe exception filter: the
 * sentences asserted here are the ones the operator reads.
 */

const RULE_ADMIN = ['automations:view', 'automations:create', 'automations:edit', 'automations:delete', 'automations:run'];

let harness: AutomationHarness;

before(async () => {
  harness = await createAutomationHarness([
    { id: 'rules-only', role: 'ADMIN', permissions: RULE_ADMIN },
    { id: 'hooks', role: 'ADMIN', permissions: [...RULE_ADMIN, 'webhooks:create'] },
    { id: 'blocks', role: 'ADMIN', permissions: [...RULE_ADMIN, 'blocked_ips:create'] },
  ]);
});

after(async () => {
  await harness.close();
});

function reset(): void {
  harness.db.rules.clear();
  harness.db.audit.length = 0;
  harness.db.admins.length = 0;
  harness.db.loginAttempts.length = 0;
  harness.db.allowlist.length = 0;
  harness.db.failAdminReads = false;
}

async function refusal(adminId: string, body: Record<string, unknown>, ip?: string): Promise<string[]> {
  reset();
  const response = await harness.as(adminId, ip).post('/rules', body);
  assert.equal(response.status, 400, `expected a 400, got ${response.status}: ${JSON.stringify(response.body)}`);
  assert.equal(harness.db.rules.size, 0, 'refused, but the rule was written anyway');
  return messagesOf(response.body);
}

async function accepted(adminId: string, body: Record<string, unknown>, ip?: string): Promise<void> {
  reset();
  const response = await harness.as(adminId, ip).post('/rules', body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
}

const KNOWN = 'known: ==, !=, >, >=, <, <=, in, and, or, not';

describe('conditions are checked against what the evaluator reads', () => {
  it('accepts every form the evaluator understands', async () => {
    const forms: unknown[] = [
      null,
      {},
      { '==': ['$type', 'payment.failed'] },
      { and: [{ '==': ['$severity', 'HIGH'] }, { '>': ['$metadata.score', 70] }] },
      { in: ['$metadata.plan', ['pro', 'max', 3, true, null]] },
      { in: ['fraud', '$message'] },
      { not: { '==': ['$metadata.userId', null] } },
      { not: [{ '!=': ['$a', 1] }] },
      { or: ['$metadata.isTrial', false] },
      { and: { '<=': ['$metadata.amount', 100] } },
      { '==': [{ in: ['$a', ['x']] }, true] },
      '$metadata.isTrial',
      true,
    ];
    for (const conditions of forms) {
      await accepted('rules-only', ruleBody({ conditions }));
    }
  });

  const refusals: ReadonlyArray<readonly [string, unknown, string]> = [
    [
      'an operator the evaluator does not know',
      { equals: ['$type', 'payment.failed'] },
      `Conditions: at the top level, unknown operator "equals" (${KNOWN})`,
    ],
    [
      'an object with two operators',
      { '==': ['$a', 1], '!=': ['$b', 2] },
      'Conditions: at the top level, expected an object with exactly one operator',
    ],
    ['a comparison with one operand', { '==': ['$a'] }, 'Conditions: at /==, "==" takes exactly 2 operands, in a list'],
    ['a comparison with a bare operand', { '>': 5 }, 'Conditions: at />, ">" takes exactly 2 operands, in a list'],
    ['an empty "and"', { and: [] }, 'Conditions: at /and, "and" needs a list of at least one condition'],
    [
      '"{}" inside an expression',
      { and: [{ '==': ['$a', 1] }, {}] },
      'Conditions: at /and/1, expected an object with exactly one operator',
    ],
    [
      'a plain value where a condition goes',
      { and: ['payment.failed'] },
      'Conditions: at /and/0, a plain value cannot stand for a condition: it is always true or always false; compare it, for example with "=="',
    ],
    [
      'a plain value as the whole of the conditions',
      'payment.failed',
      'Conditions: at the top level, a plain value cannot stand for a condition: it is always true or always false; compare it, for example with "=="',
    ],
    [
      'a list where a comparison expects a value',
      { '==': [['a'], 'b'] },
      'Conditions: at /==/0, a list is allowed only as the second operand of "in"',
    ],
    [
      'something other than plain values in a list for "in"',
      { in: ['$a', [{ x: 1 }]] },
      'Conditions: at /in/1/0, a list for "in" may hold only plain values',
    ],
    [
      'a variable with an empty segment',
      { '==': ['$metadata..userId', 1] },
      'Conditions: at /==/0, the variable is not a usable path: "$" and names separated by dots',
    ],
    [
      'a variable that reaches into prototypes',
      { '==': ['$__proto__.polluted', 1] },
      'Conditions: at /==/0, the variable is not a usable path: "$" and names separated by dots',
    ],
    [
      'a "not" with two conditions',
      { not: [{ '==': ['$a', 1] }, { '==': ['$b', 2] }] },
      'Conditions: at /not, "not" takes exactly one condition',
    ],
  ];

  for (const [what, conditions, sentence] of refusals) {
    it(`refuses ${what}, naming where and what`, async () => {
      assert.deepStrictEqual(await refusal('rules-only', ruleBody({ conditions })), [sentence]);
    });
  }

  it('refuses nesting past 16 levels, and accepts 16 exactly', async () => {
    const nested = (levels: number): unknown => {
      let condition: unknown = { '==': ['$a', 1] };
      for (let index = 1; index < levels; index += 1) condition = { not: condition };
      return condition;
    };
    await accepted('rules-only', ruleBody({ conditions: nested(16) }));
    const sentences = await refusal('rules-only', ruleBody({ conditions: nested(17) }));
    assert.equal(sentences.length, 1);
    assert.match(sentences[0] ?? '', /^Conditions: at \/not(\/not)*, conditions are nested more than 16 levels deep$/);
  });

  it('accepts the long conditions a rule is written with on purpose: two thousand ids for "in", three hundred comparisons', async () => {
    // The ceiling below bounds what a pasted blob costs on every event. It
    // must not refuse what an operator writes deliberately, and a list of
    // customer ids is the long condition that exists in practice.
    const ids = Array.from({ length: 2_000 }, (_, index) => 1_000_000_000 + index);
    await accepted('rules-only', ruleBody({ conditions: { in: ['$metadata.telegramId', ids] } }));
    const comparisons = Array.from({ length: 300 }, (_, index) => ({ '==': ['$metadata.plan', `plan-${index}`] }));
    await accepted('rules-only', ruleBody({ conditions: { or: comparisons } }));
  });

  it('refuses a tree of more than 10000 parts', async () => {
    const conditions = { and: Array.from({ length: 2_600 }, () => ({ '==': ['$a', 1] })) };
    const sentences = await refusal('rules-only', ruleBody({ conditions }));
    assert.equal(sentences.length, 1);
    assert.match(sentences[0] ?? '', /^Conditions: at \/and\/\d+(\/==(\/\d)?)?, conditions have more than 10000 parts$/);
  });
});

describe('a webhook URL is checked at save', () => {
  // The outbound policy (`common/net/outbound-url.ts`): the machine itself and
  // the cloud metadata services are refused; private networks and internal
  // names are a normal place for a receiver to live.
  const refused: ReadonlyArray<readonly [string, string]> = [
    ['http://127.0.0.1/hook', 'a loopback address (127.0.0.0/8)'],
    ['http://127.0.0.1:2375/containers/json', 'a loopback address (127.0.0.0/8)'],
    ['http://[::1]:8000/', 'a loopback address (::1/128)'],
    ['http://[::ffff:127.0.0.1]/', 'a loopback address (127.0.0.0/8)'],
    ['http://2130706433/', 'a loopback address (127.0.0.0/8)'],
    ['http://0x7f.1/', 'a loopback address (127.0.0.0/8)'],
    ['http://0.0.0.0/', 'an unspecified address (0.0.0.0/8)'],
    ['http://[::]/', 'an unspecified address (::/128)'],
    ['http://169.254.169.254/latest/meta-data/', 'a link-local address, where cloud metadata services answer (169.254.0.0/16)'],
    ['http://[fe80::1]/', 'a link-local address, where cloud metadata services answer (fe80::/10)'],
    ['http://224.0.0.1/', 'a multicast address (224.0.0.0/4)'],
    ['http://[ff02::1]/', 'a multicast address (ff00::/8)'],
    ['http://255.255.255.255/', 'a reserved address (240.0.0.0/4)'],
    ['http://[fd00:ec2::254]/latest/', 'a cloud metadata address (fd00:ec2::254/128)'],
    ['http://[fd00:ec2::23]/v1/credentials', 'a cloud metadata address (fd00:ec2::23/128)'],
    ['http://[fd20:ce::254]/computeMetadata/v1/', 'a cloud metadata address (fd20:ce::254/128)'],
    ['http://100.100.100.200/latest/meta-data/', 'a cloud metadata address (100.100.100.200/32)'],
    // IPv4 carried inside IPv6: compatible, SIIT, NAT64, local-use NAT64, 6to4
    // and Teredo (whose client address is stored inverted: 80ff:fffe is
    // 127.0.0.1).
    ['http://[::7f00:1]/', 'a loopback address (127.0.0.0/8)'],
    ['http://[::ffff:0:7f00:1]/', 'a loopback address (127.0.0.0/8)'],
    ['http://[64:ff9b::7f00:1]/', 'a loopback address (127.0.0.0/8)'],
    ['http://[64:ff9b:1::7f00:1]/', 'a loopback address (127.0.0.0/8)'],
    ['http://[2002:7f00:1::1]/', 'a loopback address (127.0.0.0/8)'],
    ['http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/', 'a loopback address (127.0.0.0/8)'],
    ['http://[2002:a9fe:a9fe::1]/', 'a link-local address, where cloud metadata services answer (169.254.0.0/16)'],
  ];
  for (const [url, range] of refused) {
    it(`refuses ${url}`, async () => {
      assert.deepStrictEqual(
        await refusal('hooks', ruleBody({ actions: [{ type: 'webhook_post', params: { url } }] })),
        [`Action 1 (webhook_post): the URL points at ${range}`],
      );
    });
  }

  for (const url of ['http://localhost:3000/hook', 'http://LOCALHOST./hook', 'http://api.localhost/', 'http://localhost.localdomain/']) {
    it(`refuses ${url}, a name that always means this machine`, async () => {
      assert.deepStrictEqual(
        await refusal('hooks', ruleBody({ actions: [{ type: 'webhook_post', params: { url } }] })),
        ['Action 1 (webhook_post): the URL names this machine itself (localhost)'],
      );
    });
  }

  for (const url of ['http://metadata.google.internal/computeMetadata/v1/', 'http://METADATA.TENCENTYUN.COM./latest/meta-data/']) {
    it(`refuses ${url}, a cloud metadata service by name`, async () => {
      assert.deepStrictEqual(
        await refusal('hooks', ruleBody({ actions: [{ type: 'webhook_post', params: { url } }] })),
        ['Action 1 (webhook_post): the URL names a cloud metadata service'],
      );
    });
  }

  it('saves a receiver on the compose network, a private address and an internal name', async () => {
    // Every one of these was refused before the policy was narrowed, and every
    // one is a real setup: n8n beside the panel, a LAN host, Tailscale, a ULA,
    // mDNS, an internal zone, and an IPv4 private address in its IPv6 forms.
    for (const url of [
      'http://n8n:5678/webhook/rezeis',
      'http://reiwa:5000/api/v1/webhooks/rezeis',
      'http://10.0.0.5:8080/in',
      'http://172.20.0.3/in',
      'http://192.168.1.20/hook',
      'http://100.101.102.103/hook',
      'http://[fd12:3456::1]/hook',
      'http://printer.local/',
      'http://hooks.corp.internal/in',
      'http://[64:ff9b::a00:1]/',
      'http://[::ffff:10.0.0.1]/',
    ]) {
      await accepted('hooks', ruleBody({ actions: [{ type: 'webhook_post', params: { url } }] }));
    }
  });

  it('refuses what the panel’s own webhooks refuse: scheme, shape and length', async () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      ['ftp://files.example.com/in', 'the URL must use the http or https scheme'],
      ['javascript:alert(1)', 'the URL must use the http or https scheme'],
      ['https://', 'the URL is not a valid address'],
      [`https://hooks.example.com/${'a'.repeat(2_048)}`, 'the URL is longer than 2048 characters'],
      ['', 'needs a URL'],
      [42, 'needs a URL'],
    ];
    for (const [url, problem] of cases) {
      assert.deepStrictEqual(
        await refusal('hooks', ruleBody({ actions: [{ type: 'webhook_post', params: { url } }] })),
        [`Action 1 (webhook_post): ${problem}`],
        String(url).slice(0, 40),
      );
    }
    assert.deepStrictEqual(
      await refusal('hooks', ruleBody({ actions: [{ type: 'webhook_post', params: {} }] })),
      ['Action 1 (webhook_post): needs a URL'],
    );
  });

  it('refuses an authorizationHeader that would break the request line', async () => {
    const params = { url: 'https://hooks.example.com/in', authorizationHeader: 'Bearer x\x0d\x0aX-Injected: 1' };
    assert.deepStrictEqual(await refusal('hooks', ruleBody({ actions: [{ type: 'webhook_post', params }] })), [
      'Action 1 (webhook_post): "authorizationHeader" may hold only what an HTTP header can carry: printable ASCII and Latin-1 characters on one line — no line breaks, no Cyrillic',
    ]);
  });

  it('saves a public URL, by name or by address', async () => {
    await accepted('hooks', ruleBody({ actions: [{ type: 'webhook_post', params: { url: 'https://hooks.example.com/in?x=1' } }] }));
    await accepted(
      'hooks',
      ruleBody({ actions: [{ type: 'webhook_post', params: { url: 'http://93.184.215.14:8443/in', authorizationHeader: 'Bearer abc' } }] }),
    );
  });

  it('names the action by its place in the list', async () => {
    const actions = [
      { type: 'notify_telegram', params: {} },
      { type: 'webhook_post', params: { url: 'http://127.0.0.1/x' } },
    ];
    assert.deepStrictEqual(await refusal('hooks', ruleBody({ actions })), [
      'Action 2 (webhook_post): the URL points at a loopback address (127.0.0.0/8)',
    ]);
  });
});

describe('an address written into a block_ip action is checked at save', () => {
  const block = (address: unknown, extra: Record<string, unknown> = {}) =>
    ruleBody({ actions: [{ type: 'block_ip', params: { address, ...extra } }] });

  it('refuses one that covers the address of the admin saving it — the manual screen’s own check', async () => {
    assert.deepStrictEqual(await refusal('blocks', block('203.0.113.0/24'), '203.0.113.40'), [
      'Action 1 (block_ip): the address 203.0.113.0/24 covers your own address',
    ]);
  });

  it('refuses the panel’s internal network, and a range that swallows it', async () => {
    assert.deepStrictEqual(await refusal('blocks', block('10.0.0.0/8')), [
      "Action 1 (block_ip): the address 10.0.0.0/8 covers the panel's internal network (10.0.0.0/8), where the panel itself, its reverse proxy and the services beside it connect from",
    ]);
    assert.deepStrictEqual(await refusal('blocks', block('0.0.0.0/1')), [
      "Action 1 (block_ip): the address 0.0.0.0/1 covers the panel's internal network (0.0.0.0/8), where the panel itself, its reverse proxy and the services beside it connect from",
    ]);
  });

  it('refuses the address an administrator signed in from', async () => {
    reset();
    harness.db.admins.push({ lastLoginIp: '198.51.100.60', isActive: true });
    const response = await harness.as('blocks').post('/rules', block('198.51.100.60'));
    assert.equal(response.status, 400);
    assert.deepStrictEqual(messagesOf(response.body), [
      'Action 1 (block_ip): the address 198.51.100.60 covers an address an administrator signed in or worked from in the last 24 hours',
    ]);
  });

  it('answers 503 and saves nothing when the administrators’ addresses cannot be read', async () => {
    reset();
    harness.db.failAdminReads = true;
    const response = await harness.as('blocks').post('/rules', block('203.0.113.99'));
    assert.equal(response.status, 503, JSON.stringify(response.body));
    assert.equal(harness.db.rules.size, 0);
  });

  it('refuses what is not an address, and an expiry that is not a date', async () => {
    assert.deepStrictEqual(await refusal('blocks', block('not-an-ip')), [
      'Action 1 (block_ip): "address" is not an IP address or CIDR range',
    ]);
    assert.deepStrictEqual(await refusal('blocks', block(12345)), [
      'Action 1 (block_ip): "address" is not an IP address or CIDR range',
    ]);
    assert.deepStrictEqual(await refusal('blocks', block('203.0.113.99', { expiresAt: 'tomorrow' })), [
      'Action 1 (block_ip): "expiresAt" is not a valid date',
    ]);
  });

  it('saves a stranger’s address, and a block_ip that takes its address from the trigger', async () => {
    await accepted('blocks', block('203.0.113.99', { expiresAt: '2030-01-01T00:00:00.000Z' }));
    await accepted('blocks', ruleBody({ actions: [{ type: 'block_ip', params: {} }] }));
  });
});

describe('switching a rule on runs the same checks as saving it', () => {
  async function enable(adminId: string, rule: { id: string }): Promise<{ status: number; body: unknown }> {
    const response = await harness.as(adminId).patch(`/rules/${rule.id}/toggle`, { isEnabled: true });
    return { status: response.status, body: response.body };
  }

  it('refuses a rule whose conditions the evaluator cannot read, and leaves it off', async () => {
    reset();
    const rule = harness.seedRule({ conditions: { equals: ['$type', 'x'] }, actions: [{ type: 'notify_telegram', params: {} }] });

    const answer = await enable('rules-only', rule);

    assert.equal(answer.status, 400);
    assert.deepStrictEqual(messagesOf(answer.body), [`Conditions: at the top level, unknown operator "equals" (${KNOWN})`]);
    assert.equal(harness.db.rules.get(rule.id)?.isEnabled, false);

    const off = await harness.as('rules-only').patch(`/rules/${rule.id}/toggle`, { isEnabled: false });
    assert.equal(off.status, 200, 'switching off must never be refused over what the rule contains');
  });

  it('refuses a webhook aimed at the loopback', async () => {
    reset();
    const rule = harness.seedRule({ actions: [{ type: 'webhook_post', params: { url: 'http://127.0.0.1:9000/x' } }] });

    const answer = await enable('hooks', rule);

    assert.equal(answer.status, 400);
    assert.deepStrictEqual(messagesOf(answer.body), ['Action 1 (webhook_post): the URL points at a loopback address (127.0.0.0/8)']);
    assert.equal(harness.db.rules.get(rule.id)?.isEnabled, false);
  });

  it('refuses a rule the existing save checks refuse — a pop-up on a schedule', async () => {
    reset();
    const rule = harness.seedRule({
      triggerKind: 'CRON',
      triggerSpec: '0 3 * * *',
      actions: [{ type: 'show_hint', params: { hintKey: 'welcome' } }],
    });

    const answer = await enable('rules-only', rule);

    assert.equal(answer.status, 400);
    assert.match(messagesOf(answer.body)[0] ?? '', /^A pop-up needs somebody to show it to/);
  });

  it('refuses a block that would cover an administrator’s session', async () => {
    reset();
    harness.db.loginAttempts.push({ ipAddress: '192.0.2.61', success: true, createdAt: new Date() });
    const rule = harness.seedRule({ actions: [{ type: 'block_ip', params: { address: '192.0.2.0/24' } }] });

    const answer = await enable('blocks', rule);

    assert.equal(answer.status, 400);
    assert.deepStrictEqual(messagesOf(answer.body), [
      'Action 1 (block_ip): the address 192.0.2.0/24 covers an address an administrator signed in or worked from in the last 24 hours',
    ]);
  });

  it('refuses a rule whose actions are not a list at all', async () => {
    reset();
    const rule = harness.seedRule({ actions: { 0: { type: 'notify_telegram', params: {} }, length: 1 } });

    const answer = await enable('rules-only', rule);

    assert.equal(answer.status, 400);
    assert.deepStrictEqual(messagesOf(answer.body), ['Actions must be a list']);
  });

  it('switches on a rule that passes', async () => {
    reset();
    const rule = harness.seedRule({ conditions: { '==': ['$type', 'x'] }, actions: [{ type: 'notify_telegram', params: {} }] });

    const answer = await enable('rules-only', rule);

    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(harness.db.rules.get(rule.id)?.isEnabled, true);
  });
});
