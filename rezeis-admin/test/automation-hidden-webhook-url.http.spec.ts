import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { isHiddenUrlForm, maskWebhookUrl } from '../src/modules/automations/automations.service';
import {
  createAutomationHarness,
  messagesOf,
  ruleBody,
  type AutomationHarness,
} from './helpers/automation-http-harness';

/**
 * A hidden webhook URL is kept by reference, never saved as its mask
 * ════════════════════════════════════════════════════════════════════
 *
 * A reader who may not edit a `webhook_post` action reads its URL as the origin
 * and "…", with `urlHidden` beside it. That read could be sent straight back:
 * the mask is a valid URL, so it replaced the real one and every run posted to
 * `<origin>/…`. Proven by PUTting a viewer's read as an editor who holds both
 * rights. Now `urlHidden` is a reference, the way a saved header is — the
 * action's place in the saved list — and a save keeps the saved URL for that
 * action and no other, or refuses. A URL that IS the mask is refused either way,
 * which also stops a rule already damaged from being switched on.
 */

const REAL_URL = 'https://hooks.example.com/services/T0/B0/PATH-SECRET?token=QUERY-SECRET';
const OTHER_URL = 'https://hooks.example.com/services/T0/B0/OTHER-SECRET';
const MASK = 'https://hooks.example.com/…';
const HEADER = 'Bearer kept-value';

const REFUSED = {
  notReference:
    '"urlHidden" does not name a saved URL — read the rule again, or send the URL itself without "urlHidden"',
  newRule: '"urlHidden" keeps the URL saved on a rule, and a new rule has none — enter the URL itself',
  shifted: 'the saved URL "urlHidden" refers to belongs to another action — enter the URL again',
  gone: 'the saved URL "urlHidden" refers to is no longer on the rule — enter the URL again',
  disagree: '"url" and "urlHidden" disagree — send a new URL without "urlHidden", or "urlHidden" without a URL',
  maskForm: 'the URL is the shortened form the panel shows in place of a hidden one — enter the full URL',
} as const;

let harness: AutomationHarness;

before(async () => {
  harness = await createAutomationHarness([
    { id: 'viewer', role: 'ADMIN', permissions: ['automations:view'] },
    {
      id: 'editor',
      role: 'ADMIN',
      permissions: ['automations:view', 'automations:create', 'automations:edit', 'webhooks:create'],
    },
  ]);
});

after(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.db.rules.clear();
});

type StoredAction = { type: string; params: Record<string, unknown> };

function seed(actions: readonly StoredAction[], isEnabled = false) {
  return harness.seedRule({ name: 'Relay', isEnabled, actions: structuredClone(actions) });
}

/** The actions the row holds, as the JSON column would hold them. */
function stored(ruleId: string): StoredAction[] {
  return JSON.parse(JSON.stringify(harness.db.rules.get(ruleId)?.actions)) as StoredAction[];
}

/** The rule as the viewer reads it: what a replayed body starts from. */
async function viewerRead(ruleId: string): Promise<{ name: string; actions: StoredAction[] }> {
  const response = await harness.as('viewer').get(`/rules/${ruleId}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body as { name: string; actions: StoredAction[] };
}

/** A save of `actions` over the rule, by the editor who holds both rights. */
function save(ruleId: string, actions: unknown) {
  return harness.as('editor').put(`/rules/${ruleId}`, ruleBody({ name: 'Relay', actions }));
}

function assertRefused(response: { status: number; body: unknown }, sentence: string, index = 1): void {
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.deepStrictEqual(messagesOf(response.body), [`Action ${index} (webhook_post): ${sentence}`]);
}

const hook = (params: Record<string, unknown>): StoredAction => ({ type: 'webhook_post', params });
const reference = (index: number) => ({ stored: true, index });

describe('what a reader who may not see the URL reads', () => {
  it('is its origin and a reference to the saved action — not `true`, and nothing of the path', async () => {
    const rule = seed([hook({ url: REAL_URL })]);
    const read = await viewerRead(rule.id);
    assert.deepStrictEqual(read.actions[0]?.params, { url: MASK, urlHidden: reference(0) });
    assert.ok(!JSON.stringify(read).includes('SECRET'));
  });

  it('never includes a flag the old overwrite stored: only a read writes one', async () => {
    const rule = seed([hook({ url: MASK, urlHidden: true })]);

    const editor = await harness.as('editor').get(`/rules/${rule.id}`);
    assert.equal(editor.status, 200, JSON.stringify(editor.body));
    assert.deepStrictEqual(editor.body.actions[0].params, { url: MASK });

    const viewer = await viewerRead(rule.id);
    assert.deepStrictEqual(viewer.actions[0]?.params, { url: MASK, urlHidden: reference(0) });
  });
});

describe('a save that sends the hidden URL back keeps the saved one', () => {
  it('keeps the real URL when an editor saves a viewer’s read unchanged — the overwrite that was proven', async () => {
    const rule = seed([hook({ url: REAL_URL })]);
    const read = await viewerRead(rule.id);

    const response = await save(rule.id, read.actions);

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepStrictEqual(stored(rule.id), [hook({ url: REAL_URL })]);
    // The editor may read it whole, and the answer is in the editor's view.
    assert.deepStrictEqual(response.body.actions[0].params, { url: REAL_URL });
  });

  it('keeps it when the reference comes back without any URL — what the editor screen sends', async () => {
    const rule = seed([hook({ url: REAL_URL })]);
    const response = await save(rule.id, [hook({ urlHidden: reference(0) })]);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepStrictEqual(stored(rule.id), [hook({ url: REAL_URL })]);
  });

  it('keeps it when the reference comes with the URL whole, or with null for a URL', async () => {
    for (const url of [REAL_URL, `  ${REAL_URL}  `, null]) {
      const rule = seed([hook({ url: REAL_URL })]);
      const response = await save(rule.id, [hook({ url, urlHidden: reference(0) })]);
      assert.equal(response.status, 200, `${String(url)}: ${JSON.stringify(response.body)}`);
      assert.deepStrictEqual(stored(rule.id), [hook({ url: REAL_URL })], String(url));
    }
  });

  it('keeps a saved header on the same action as well: both references resolve, the header against the kept URL', async () => {
    const rule = seed([hook({ url: REAL_URL, authorizationHeader: HEADER })]);
    const read = await viewerRead(rule.id);
    assert.deepStrictEqual(read.actions[0]?.params, {
      url: MASK,
      authorizationHeader: reference(0),
      urlHidden: reference(0),
    });

    const response = await save(rule.id, read.actions);

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepStrictEqual(stored(rule.id), [hook({ url: REAL_URL, authorizationHeader: HEADER })]);
  });

  it('keeps each URL on its own action when there are several, and a changed one is saved as typed', async () => {
    const rule = seed([
      { type: 'notify_telegram', params: { text: 'fired' } },
      hook({ url: REAL_URL }),
      hook({ url: OTHER_URL }),
    ]);
    const read = await viewerRead(rule.id);
    const typed = 'https://collector.example.net/in';

    const response = await save(rule.id, [read.actions[0], read.actions[1], hook({ url: typed })]);

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepStrictEqual(stored(rule.id), [
      { type: 'notify_telegram', params: { text: 'fired' } },
      hook({ url: REAL_URL }),
      hook({ url: typed }),
    ]);
  });

  it('takes false or null for "not hidden": the URL sent is the URL, and the flag is not stored', async () => {
    for (const flag of [false, null]) {
      const rule = seed([hook({ url: REAL_URL })]);
      const response = await save(rule.id, [hook({ url: OTHER_URL, urlHidden: flag })]);
      assert.equal(response.status, 200, `${String(flag)}: ${JSON.stringify(response.body)}`);
      assert.deepStrictEqual(stored(rule.id), [hook({ url: OTHER_URL })], String(flag));
    }
  });
});

describe('a reference that cannot be kept is refused, and nothing is written', () => {
  it('on a new rule, which has no saved URL', async () => {
    const response = await harness
      .as('editor')
      .post('/rules', ruleBody({ actions: [hook({ url: MASK, urlHidden: reference(0) })] }));
    assertRefused(response, REFUSED.newRule);
    assert.equal(harness.db.rules.size, 0);
  });

  it('when an action above it was removed: the URL of another action is never handed over', async () => {
    const actions = [hook({ url: REAL_URL }), hook({ url: OTHER_URL })];
    const rule = seed(actions);
    const read = await viewerRead(rule.id);

    // The second webhook, now first. Both are on the same host, so their masks
    // are the same: only the place tells them apart.
    const response = await save(rule.id, [read.actions[1]]);

    assertRefused(response, REFUSED.shifted);
    assert.deepStrictEqual(stored(rule.id), actions);
  });

  it('when the action at its place is no longer a webhook', async () => {
    const actions = [hook({ url: REAL_URL })];
    const rule = seed(actions);
    const response = await save(rule.id, [
      { type: 'notify_telegram', params: { text: 'hello', url: MASK, urlHidden: reference(0) } },
    ]);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.deepStrictEqual(messagesOf(response.body), [`Action 1 (notify_telegram): ${REFUSED.shifted}`]);
    assert.deepStrictEqual(stored(rule.id), actions);
  });

  it('when either side is not a webhook, even one whose params happen to hold a URL', async () => {
    const notify: StoredAction = { type: 'notify_telegram', params: { text: 'hello', url: REAL_URL } };
    for (const [sent, label] of [
      [{ type: 'notify_telegram', params: { text: 'hello', urlHidden: reference(0) } }, 'Action 1 (notify_telegram)'],
      [hook({ urlHidden: reference(0) }), 'Action 1 (webhook_post)'],
    ] as const) {
      const rule = seed([notify]);
      const response = await save(rule.id, [sent]);
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.deepStrictEqual(messagesOf(response.body), [`${label}: ${REFUSED.shifted}`]);
      assert.deepStrictEqual(stored(rule.id), [notify]);
    }
  });

  it('when it names a place past the end of the saved list', async () => {
    const actions = [hook({ url: REAL_URL })];
    const rule = seed(actions);
    const response = await save(rule.id, [hook({ url: REAL_URL }), hook({ urlHidden: reference(1) })]);
    assertRefused(response, REFUSED.shifted, 2);
    assert.deepStrictEqual(stored(rule.id), actions);
  });

  it('when the saved action at that place has no URL any more', async () => {
    for (const params of [{}, { url: '' }, { url: 42 }]) {
      const rule = seed([hook(params)]);
      const response = await save(rule.id, [hook({ urlHidden: reference(0) })]);
      assertRefused(response, REFUSED.gone);
      assert.deepStrictEqual(stored(rule.id), [hook(params)]);
    }
  });

  it('when the URL sent disagrees with the one it would keep', async () => {
    const actions = [hook({ url: REAL_URL })];
    for (const url of [OTHER_URL, '', 'https://other.example.org/…', 7]) {
      const rule = seed(actions);
      const response = await save(rule.id, [hook({ url, urlHidden: reference(0) })]);
      assertRefused(response, REFUSED.disagree);
      assert.deepStrictEqual(stored(rule.id), actions, String(url));
    }
  });

  it('when it is not a reference at all — `true` from a screen loaded before this change, or anything else', async () => {
    const actions = [hook({ url: REAL_URL })];
    for (const flag of [true, 'yes', 1, {}, { stored: true }, { stored: true, index: -1 }, { stored: true, index: 0.5 }, { index: 0 }]) {
      const rule = seed(actions);
      const response = await save(rule.id, [hook({ url: MASK, urlHidden: flag })]);
      assertRefused(response, REFUSED.notReference);
      assert.deepStrictEqual(stored(rule.id), actions, JSON.stringify(flag));
    }
  });
});

describe('a URL that is itself the mask', () => {
  it('is refused on a save without the flag, however it is written', async () => {
    const actions = [hook({ url: REAL_URL })];
    for (const url of [MASK, `  ${MASK}  `, 'https://hooks.example.com/%E2%80%A6', 'https://HOOKS.example.com:443/…']) {
      const rule = seed(actions);
      const response = await save(rule.id, [hook({ url })]);
      assertRefused(response, REFUSED.maskForm);
      assert.deepStrictEqual(stored(rule.id), actions, url);
    }
  });

  it('is refused on a new rule', async () => {
    const response = await harness.as('editor').post('/rules', ruleBody({ actions: [hook({ url: MASK })] }));
    assertRefused(response, REFUSED.maskForm);
    assert.equal(harness.db.rules.size, 0);
  });

  it('keeps a rule already saved with one from being switched on', async () => {
    const rule = seed([hook({ url: MASK })]);
    const response = await harness.as('editor').patch(`/rules/${rule.id}/toggle`, { isEnabled: true });
    assertRefused(response, REFUSED.maskForm);
    assert.equal(harness.db.rules.get(rule.id)?.isEnabled, false);
  });

  it('is only the mask: a real path that happens to hold "…" is a URL like any other', async () => {
    for (const url of ['https://hooks.example.com/a/…', 'https://hooks.example.com/…?x=1', 'https://hooks.example.com/…#top']) {
      const rule = seed([hook({ url: REAL_URL })]);
      const response = await save(rule.id, [hook({ url })]);
      assert.equal(response.status, 200, `${url}: ${JSON.stringify(response.body)}`);
      assert.deepStrictEqual(stored(rule.id), [hook({ url })]);
    }
  });

  it('is exactly what a read writes, for every URL shape a read can hide', () => {
    for (const url of [
      REAL_URL,
      'http://hooks.example.com:8080/path?q=1',
      'https://user:pass@hooks.example.com/p',
      'https://пример.рф/hook',
      'https://[2001:db8::1]:8443/x',
    ]) {
      assert.equal(isHiddenUrlForm(maskWebhookUrl(url)), true, url);
      assert.equal(isHiddenUrlForm(url), false, url);
    }
    for (const value of ['…', '', 'not a url', 42, null, undefined]) {
      assert.equal(isHiddenUrlForm(value), false, String(value));
    }
  });
});
