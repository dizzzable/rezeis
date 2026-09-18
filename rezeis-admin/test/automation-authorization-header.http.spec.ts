import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  createAutomationHarness,
  messagesOf,
  ruleBody,
  type AutomationHarness,
} from './helpers/automation-http-harness';

/**
 * A webhook action's Authorization header is write-only
 * ═════════════════════════════════════════════════════
 *
 * `authorizationHeader` is a credential for somebody else's system, and every
 * rule read handed it to anyone holding `automations:view`: the list, the rule,
 * the answer to a save or a switch. Now no read returns it; a reference stands
 * in its place, and a save reads the reference back as "keep", a string as
 * "replace", and null as "remove". A kept header is bound to the exact saved
 * URL and to the action it came from — or whoever may edit the rule could read
 * it out through a receiver of their own, on another host or merely on another
 * path of the same one.
 *
 * Every read here goes through the real routes, filter and pipe; every
 * assertion about what is stored reads the database double directly.
 */

const SECRET = 'Bearer WRITE-ONLY-SECRET-7f3a';
const HOOK_URL = 'https://hooks.example.com/in/rezeis';

const VIEWER = ['automations:view'];
const EDITOR = ['automations:view', 'automations:create', 'automations:edit', 'automations:run', 'webhooks:create'];

let harness: AutomationHarness;

before(async () => {
  harness = await createAutomationHarness([
    { id: 'viewer', role: 'ADMIN', permissions: VIEWER },
    { id: 'editor', role: 'ADMIN', permissions: EDITOR },
  ]);
});

after(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.db.rules.clear();
  harness.db.audit.length = 0;
});

function seedHookRule(header: string = SECRET, url: string = HOOK_URL) {
  return harness.seedRule({
    name: 'Relay',
    actions: [
      { type: 'notify_telegram', params: { text: 'fired' } },
      { type: 'webhook_post', params: { url, authorizationHeader: header } },
    ],
  });
}

/** The header the database holds for the action at `index` of `ruleId`, or undefined. */
function storedHeader(ruleId: string, index: number): unknown {
  const actions = harness.db.rules.get(ruleId)?.actions as Array<{ params: Record<string, unknown> }>;
  return actions[index]?.params['authorizationHeader'];
}

describe('no read returns it', () => {
  it('shows an automations:view role a reference in its place — in the list and in the rule', async () => {
    const rule = seedHookRule();

    const list = await harness.as('viewer').get('/rules');
    const one = await harness.as('viewer').get(`/rules/${rule.id}`);

    assert.equal(list.status, 200);
    assert.equal(one.status, 200);
    for (const body of [list.body, one.body]) {
      assert.ok(!JSON.stringify(body).includes('WRITE-ONLY-SECRET'), 'the header reached a reader');
    }
    // The URL, too, is only the origin for a reader who may not edit the action
    // (`automation-webhook-url-visibility.http.spec.ts` has the rest of that).
    assert.deepStrictEqual(one.body.actions[1].params, {
      url: 'https://hooks.example.com/…',
      urlHidden: true,
      authorizationHeader: { stored: true, index: 1 },
    });
    assert.deepStrictEqual(one.body.actions[0].params, { text: 'fired' }, 'an action without a header gains nothing');
  });

  it('is not in a run’s answer, in the run log or in the audit row, though the request carried it', async () => {
    const rule = seedHookRule();

    const run = await harness.as('editor').post(`/rules/${rule.id}/run`, { triggerData: {} });
    const log = await harness.as('viewer').get(`/rules/${rule.id}/executions`);

    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(log.status, 200, JSON.stringify(log.body));
    assert.equal(log.body.items.length, 1, 'the run was not logged');
    // The control: the header did go out, on the request it is for.
    const sent = harness.posts[harness.posts.length - 1]?.config['headers'] as Record<string, string> | undefined;
    assert.equal(sent?.['Authorization'], SECRET);
    for (const body of [run.body, log.body, harness.db.audit]) {
      assert.ok(!JSON.stringify(body).includes('WRITE-ONLY-SECRET'), 'the header reached a reader');
    }
  });

  it('leaves it out of the answer to a save and to a switch as well', async () => {
    const created = await harness.as('editor').post(
      '/rules',
      ruleBody({ actions: [{ type: 'webhook_post', params: { url: HOOK_URL, authorizationHeader: SECRET } }] }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(!JSON.stringify(created.body).includes('WRITE-ONLY-SECRET'));
    assert.equal(storedHeader(created.body.id as string, 0), SECRET, 'the create did not store the header');

    const toggled = await harness.as('editor').patch(`/rules/${created.body.id as string}/toggle`, { isEnabled: true });
    assert.equal(toggled.status, 200, JSON.stringify(toggled.body));
    assert.ok(!JSON.stringify(toggled.body).includes('WRITE-ONLY-SECRET'));
  });
});

describe('a save reads what the editor sends back', () => {
  it('keeps the header on an edit that sends the rule back as it was read', async () => {
    const rule = seedHookRule();
    const read = await harness.as('editor').get(`/rules/${rule.id}`);

    const body = { ...ruleBody(), name: 'Relay, renamed', actions: read.body.actions };
    const saved = await harness.as('editor').put(`/rules/${rule.id}`, body);

    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(harness.db.rules.get(rule.id)?.name, 'Relay, renamed');
    assert.equal(storedHeader(rule.id, 1), SECRET, 'the round trip lost the header');
    assert.ok(!JSON.stringify(saved.body).includes('WRITE-ONLY-SECRET'));
  });

  it('keeps each header when the other actions change around it, in place', async () => {
    const rule = harness.seedRule({
      actions: [
        { type: 'webhook_post', params: { url: 'https://a.example.com/in', authorizationHeader: 'Bearer A-SECRET' } },
        { type: 'notify_telegram', params: { text: 'fired' } },
        { type: 'webhook_post', params: { url: 'https://b.example.com/in', authorizationHeader: 'Bearer B-SECRET' } },
      ],
    });
    const read = await harness.as('editor').get(`/rules/${rule.id}`);
    const [first, , third] = read.body.actions as unknown[];

    // The notification's text changes; each webhook stays where it was.
    const saved = await harness.as('editor').put(`/rules/${rule.id}`, {
      ...ruleBody(),
      actions: [first, { type: 'notify_telegram', params: { text: 'fired, reworded' } }, third],
    });

    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(storedHeader(rule.id, 0), 'Bearer A-SECRET');
    assert.equal(storedHeader(rule.id, 2), 'Bearer B-SECRET');
  });

  it('removes it on an explicit null, and on an empty string', async () => {
    for (const cleared of [null, '']) {
      const rule = seedHookRule();
      const saved = await harness.as('editor').put(`/rules/${rule.id}`, {
        ...ruleBody(),
        actions: [
          { type: 'notify_telegram', params: { text: 'fired' } },
          { type: 'webhook_post', params: { url: HOOK_URL, authorizationHeader: cleared } },
        ],
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const params = (harness.db.rules.get(rule.id)?.actions as Array<{ params: Record<string, unknown> }>)[1]!.params;
      assert.deepStrictEqual(params, { url: HOOK_URL }, `${JSON.stringify(cleared)} did not remove the header`);
    }
  });

  it('replaces it with a new value', async () => {
    const rule = seedHookRule();
    const saved = await harness.as('editor').put(`/rules/${rule.id}`, {
      ...ruleBody(),
      actions: [
        { type: 'notify_telegram', params: { text: 'fired' } },
        { type: 'webhook_post', params: { url: HOOK_URL, authorizationHeader: 'Bearer NEW-VALUE' } },
      ],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(storedHeader(rule.id, 1), 'Bearer NEW-VALUE');
  });
});

describe('what a reference may not do', () => {
  it('does not carry a kept header to another path on the same host — webhook.site keys a receiver by it', async () => {
    const rule = seedHookRule(SECRET, 'https://webhook.site/VICTIM');
    const read = await harness.as('editor').get(`/rules/${rule.id}`);
    const retargeted = (read.body.actions as Array<{ type: string; params: Record<string, unknown> }>).map((action) =>
      action.type === 'webhook_post' ? { ...action, params: { ...action.params, url: 'https://webhook.site/ATTACKER' } } : action,
    );

    const saved = await harness.as('editor').put(`/rules/${rule.id}`, { ...ruleBody(), actions: retargeted });

    assert.equal(saved.status, 400, JSON.stringify(saved.body));
    assert.deepStrictEqual(messagesOf(saved.body), [
      'Action 2 (webhook_post): the URL changed, so the saved "authorizationHeader" was not carried over — enter it again or remove it',
    ]);
    assert.equal(storedHeader(rule.id, 1), SECRET);
    assert.equal(
      (harness.db.rules.get(rule.id)?.actions as Array<{ params: Record<string, unknown> }>)[1]!.params['url'],
      'https://webhook.site/VICTIM',
    );
  });

  it('does not carry it to a new query either', async () => {
    const rule = seedHookRule();
    const saved = await harness.as('editor').put(`/rules/${rule.id}`, {
      ...ruleBody(),
      actions: [
        { type: 'notify_telegram', params: { text: 'fired' } },
        { type: 'webhook_post', params: { url: `${HOOK_URL}?to=elsewhere`, authorizationHeader: { stored: true, index: 1 } } },
      ],
    });
    assert.equal(saved.status, 400, JSON.stringify(saved.body));
    assert.equal(storedHeader(rule.id, 1), SECRET);
  });

  it('does not carry a kept header to another host, and changes nothing', async () => {
    const rule = seedHookRule();
    const read = await harness.as('editor').get(`/rules/${rule.id}`);
    const moved = (read.body.actions as Array<{ type: string; params: Record<string, unknown> }>).map((action) =>
      action.type === 'webhook_post' ? { ...action, params: { ...action.params, url: 'https://collector.example.net/grab' } } : action,
    );

    const saved = await harness.as('editor').put(`/rules/${rule.id}`, { ...ruleBody(), actions: moved });

    assert.equal(saved.status, 400, JSON.stringify(saved.body));
    assert.deepStrictEqual(messagesOf(saved.body), [
      'Action 2 (webhook_post): the URL changed, so the saved "authorizationHeader" was not carried over — enter it again or remove it',
    ]);
    assert.equal(storedHeader(rule.id, 1), SECRET);
    assert.equal(
      (harness.db.rules.get(rule.id)?.actions as Array<{ params: Record<string, unknown> }>)[1]!.params['url'],
      HOOK_URL,
      'the refused save moved the URL anyway',
    );
  });

  it('is good only for the action it came from: not at another place in the list, and not twice', async () => {
    const rule = harness.seedRule({
      actions: [
        { type: 'webhook_post', params: { url: 'https://a.example.com/in', authorizationHeader: 'Bearer A-SECRET' } },
        { type: 'webhook_post', params: { url: 'https://b.example.com/in', authorizationHeader: 'Bearer B-SECRET' } },
      ],
    });
    const read = await harness.as('editor').get(`/rules/${rule.id}`);
    const [first, second] = read.body.actions as unknown[];
    const BELONGS_ELSEWHERE = (n: number) =>
      `Action ${n} (webhook_post): the saved "authorizationHeader" it refers to belongs to another action — enter it again or remove it`;

    // Swapped: each reference now sits at the other one's place.
    const swapped = await harness.as('editor').put(`/rules/${rule.id}`, { ...ruleBody(), actions: [second, first] });
    assert.equal(swapped.status, 400, JSON.stringify(swapped.body));
    assert.deepStrictEqual(messagesOf(swapped.body), [BELONGS_ELSEWHERE(1)]);

    // Fanned out: the first action's reference copied onto a new action.
    const fanned = await harness.as('editor').put(`/rules/${rule.id}`, { ...ruleBody(), actions: [first, first] });
    assert.equal(fanned.status, 400, JSON.stringify(fanned.body));
    assert.deepStrictEqual(messagesOf(fanned.body), [BELONGS_ELSEWHERE(2)]);

    assert.equal(storedHeader(rule.id, 0), 'Bearer A-SECRET');
    assert.equal(storedHeader(rule.id, 1), 'Bearer B-SECRET');
  });

  it('is good only for an action of the same type at that place', async () => {
    const rule = seedHookRule();
    const saved = await harness.as('editor').put(`/rules/${rule.id}`, {
      ...ruleBody(),
      actions: [
        { type: 'notify_telegram', params: { text: 'fired' } },
        { type: 'system_event', params: { authorizationHeader: { stored: true, index: 1 } } },
      ],
    });
    assert.equal(saved.status, 400, JSON.stringify(saved.body));
    assert.deepStrictEqual(messagesOf(saved.body), [
      'Action 2 (system_event): the saved "authorizationHeader" it refers to belongs to another action — enter it again or remove it',
    ]);
    assert.equal(storedHeader(rule.id, 1), SECRET);
  });

  it('names nothing on a new rule, and nothing that is not a header of the same action type', async () => {
    const created = await harness.as('editor').post(
      '/rules',
      ruleBody({ actions: [{ type: 'webhook_post', params: { url: HOOK_URL, authorizationHeader: { stored: true, index: 0 } } }] }),
    );
    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.deepStrictEqual(messagesOf(created.body), [
      'Action 1 (webhook_post): "authorizationHeader" refers to a saved rule, and a new rule has none — enter the header itself',
    ]);
    assert.equal(harness.db.rules.size, 0);

    const rule = seedHookRule();
    // In place and of the right type, but the saved action there holds no header.
    const bare = harness.seedRule({
      actions: [{ type: 'webhook_post', params: { url: HOOK_URL } }],
    });
    const pointsAtNothing = await harness.as('editor').put(`/rules/${bare.id}`, {
      ...ruleBody(),
      actions: [{ type: 'webhook_post', params: { url: HOOK_URL, authorizationHeader: { stored: true, index: 0 } } }],
    });
    assert.equal(pointsAtNothing.status, 400, JSON.stringify(pointsAtNothing.body));
    assert.deepStrictEqual(messagesOf(pointsAtNothing.body), [
      'Action 1 (webhook_post): the saved "authorizationHeader" it refers to is no longer on the rule — enter it again or remove it',
    ]);
    assert.equal(storedHeader(rule.id, 1), SECRET);
  });

  it('refuses anything else in the header place, rather than storing it', async () => {
    const rule = seedHookRule();
    const saved = await harness.as('editor').put(`/rules/${rule.id}`, {
      ...ruleBody(),
      actions: [{ type: 'webhook_post', params: { url: HOOK_URL, authorizationHeader: { stored: false, index: 1 } } }],
    });
    assert.equal(saved.status, 400, JSON.stringify(saved.body));
    assert.deepStrictEqual(messagesOf(saved.body), [
      'Action 1 (webhook_post): "authorizationHeader" may hold only what an HTTP header can carry: printable ASCII and Latin-1 characters on one line — no line breaks, no Cyrillic',
    ]);
    assert.equal(storedHeader(rule.id, 1), SECRET);
  });
});
