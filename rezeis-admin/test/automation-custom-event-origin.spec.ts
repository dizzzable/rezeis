import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { UserRole } from '@prisma/client';

import type { SystemEventPayload } from '../src/common/services/system-events.service';
import { resolveTelegramDeliveryTarget } from '../src/common/services/telegram-delivery-target.util';
import { AdminNotificationDispatcher } from '../src/modules/push/services/admin-notification-dispatcher.service';
import {
  REALTIME_TOPICS,
  REALTIME_TOPIC_PERMISSION,
  type RealtimeEventInterface,
} from '../src/modules/realtime/interfaces/realtime-event.interface';
import { REALTIME_EVENT } from '../src/modules/realtime/realtime.constants';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { createAutomationHarness, type AutomationHarness } from './helpers/automation-http-harness';

/**
 * A rule's own event never passes as the panel's own alert
 * ═════════════════════════════════════════════════════════
 *
 * `system_event` let a rule pick the category, the severity and the sentence of
 * what it emits. A MANUAL rule raising SYSTEM + ERROR put its author's sentence
 * on every subscribed admin's device, under the title «Система», exactly as the
 * panel's own critical error arrives. Now everything the action emits is filed
 * under AUTOMATION whatever the rule asks for — the severity stays the rule's —
 * and the push about it says where it came from: «Автоматизация «<rule>»».
 *
 * Everything else that routes by category keeps its audience and its place:
 * the realtime topic has the audience SYSTEM had, and a forum with no
 * AUTOMATION topic keeps receiving these cards in SYSTEM's.
 */

const RULE_ADMIN = ['automations:view', 'automations:create', 'automations:edit', 'automations:run'];

let harness: AutomationHarness;

before(async () => {
  harness = await createAutomationHarness([{ id: 'author', role: 'ADMIN', permissions: RULE_ADMIN }]);
});

after(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.db.rules.clear();
  harness.db.executions.length = 0;
  harness.emitted.length = 0;
});

/** Runs a rule with one `system_event` action and returns what it put on the bus. */
async function emittedBy(name: string, params: Record<string, unknown>): Promise<SystemEventPayload> {
  const rule = harness.seedRule({ name, actions: [{ type: 'system_event', params }] });
  const response = await harness.as('author').post(`/rules/${rule.id}/run`, { triggerData: {} });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.actionResults[0].status, 'success', JSON.stringify(response.body));
  assert.equal(harness.emitted.length, 1, JSON.stringify(harness.emitted));
  return harness.emitted[0] as unknown as SystemEventPayload;
}

describe('what a rule’s system_event puts on the bus', () => {
  for (const category of ['SYSTEM', 'PAYMENT', 'FRAUD', 'AUTOMATION', 'system', undefined]) {
    it(`is filed under AUTOMATION when the rule asks for ${String(category)}, with the rule’s severity and words`, async () => {
      const event = await emittedBy('Disk watch', {
        type: 'automation.custom.disk',
        severity: 'ERROR',
        message: 'Disk full',
        ...(category === undefined ? {} : { category }),
      });
      assert.equal(event.category, 'AUTOMATION');
      assert.equal(event.severity, 'ERROR');
      assert.equal(event.type, 'automation.custom.disk');
      assert.equal(event.message, 'Disk full');
      assert.equal(event.metadata?.['ruleName'], 'Disk watch');
    });
  }

  it('keeps every severity a rule may choose, and INFO for anything else', async () => {
    for (const [asked, kept] of [
      ['INFO', 'INFO'],
      ['WARNING', 'WARNING'],
      ['ERROR', 'ERROR'],
      ['CRITICAL', 'INFO'],
      [undefined, 'INFO'],
    ] as const) {
      harness.emitted.length = 0;
      const event = await emittedBy('Severity', { type: 'automation.custom', ...(asked === undefined ? {} : { severity: asked }) });
      assert.equal(event.severity, kept, String(asked));
      assert.equal(event.category, 'AUTOMATION', String(asked));
    }
  });
});

// ── The admin push ───────────────────────────────────────────────────────────

interface SentPush {
  readonly adminId: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

function dispatcherFor(options: {
  readonly permitted: ReadonlySet<string>;
  readonly disabled?: ReadonlySet<string>;
}): { sent: SentPush[]; handle: (event: SystemEventPayload) => Promise<void> } {
  const sent: SentPush[] = [];
  const dispatcher = new AdminNotificationDispatcher(
    {
      adminWebPushSubscription: { findMany: async () => [{ adminId: 'a1' }] },
      adminUser: { findMany: async () => [{ id: 'a1', role: 'ADMIN', rbacRoleId: 'r' }] },
    } as never,
    {
      sendToAdmin: async (input: SentPush) => {
        sent.push({ adminId: input.adminId, title: input.title, body: input.body, url: input.url });
      },
    } as never,
    {
      hasPermission: async (_admin: unknown, resource: string, action: string) =>
        options.permitted.has(`${resource}:${action}`),
    } as never,
    { registerHook: () => () => undefined } as never,
    { isEnabled: async (_adminId: string, category: string) => !(options.disabled?.has(category) ?? false) } as never,
  );
  const handle = (event: SystemEventPayload): Promise<void> =>
    (dispatcher as unknown as { handleEvent: (e: SystemEventPayload) => Promise<void> }).handleEvent(event);
  return { sent, handle };
}

const DASHBOARD = new Set(['dashboard:view']);

function busEvent(over: Partial<SystemEventPayload>): SystemEventPayload {
  return {
    type: 'automation.custom',
    category: 'AUTOMATION',
    severity: 'ERROR',
    message: 'Payment gateway down',
    metadata: { ruleId: 'rule-1', ruleName: 'Gateway watch' },
    ...over,
  } as SystemEventPayload;
}

describe('the push about a rule’s ERROR event', () => {
  it('says which rule raised it — «Автоматизация «<rule>»», never «Система» — and still carries its words', async () => {
    const event = await emittedBy('Disk watch', {
      type: 'automation.custom.disk',
      category: 'SYSTEM',
      severity: 'ERROR',
      message: 'Disk full',
    });
    const push = dispatcherFor({ permitted: DASHBOARD });

    await push.handle(event);

    assert.deepStrictEqual(push.sent, [{ adminId: 'a1', title: 'Автоматизация «Disk watch»', body: 'Disk full', url: '/' }]);
  });

  it('is never titled «Система» for anything in the rules’ namespace, whatever category it arrives under', async () => {
    for (const [type, category] of [
      ['automation.custom', 'SYSTEM'],
      ['automation.custom.gateway', 'SYSTEM'],
      ['automation.telegram_notify', 'SYSTEM'],
      ['automation.custom', 'PAYMENT'],
    ] as const) {
      const push = dispatcherFor({ permitted: DASHBOARD });
      await push.handle(busEvent({ type, category: category as SystemEventPayload['category'] }));
      assert.deepStrictEqual(
        push.sent.map((sent) => sent.title),
        ['Автоматизация «Gateway watch»'],
        `${type} as ${category}`,
      );
    }
  });

  it('is never given a title of the panel’s own either: filed under AUTOMATION, a type the panel routes is still the rule’s', async () => {
    const push = dispatcherFor({ permitted: new Set(['dashboard:view', 'payments:view']) });
    await push.handle(busEvent({ type: 'payment.failed' }));
    assert.deepStrictEqual(push.sent.map((sent) => sent.title), ['Автоматизация «Gateway watch»']);
  });

  it('is sent at ERROR only, as a SYSTEM alert was', async () => {
    for (const severity of ['INFO', 'WARNING'] as const) {
      const push = dispatcherFor({ permitted: DASHBOARD });
      await push.handle(busEvent({ severity }));
      assert.deepStrictEqual(push.sent, [], severity);
    }
  });

  it('asks what a SYSTEM alert asks: dashboard:view, and the admin’s «Система» notifications left on', async () => {
    const withoutGate = dispatcherFor({ permitted: new Set(['automations:view']) });
    await withoutGate.handle(busEvent({}));
    assert.deepStrictEqual(withoutGate.sent, []);

    const switchedOff = dispatcherFor({ permitted: DASHBOARD, disabled: new Set(['system']) });
    await switchedOff.handle(busEvent({}));
    assert.deepStrictEqual(switchedOff.sent, []);
  });

  it('says «Автоматизация» alone when no rule is named, and keeps a rule name to one short line', async () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [undefined, 'Автоматизация'],
      ['', 'Автоматизация'],
      ['   ', 'Автоматизация'],
      [42, 'Автоматизация'],
      ['Line one\nline\ttwo   three', 'Автоматизация «Line one line two three»'],
      [`Bell${String.fromCharCode(7)}here`, 'Автоматизация «Bell here»'],
      ['x'.repeat(48), `Автоматизация «${'x'.repeat(48)}»`],
      ['y'.repeat(49), `Автоматизация «${'y'.repeat(47)}…»`],
      [`${'z'.repeat(46)}${String.fromCodePoint(0x1f511)}${String.fromCodePoint(0x1f511)}tail`, `Автоматизация «${'z'.repeat(46)}${String.fromCodePoint(0x1f511)}…»`],
    ];
    for (const [ruleName, title] of cases) {
      const push = dispatcherFor({ permitted: DASHBOARD });
      await push.handle(busEvent({ metadata: ruleName === undefined ? { ruleId: 'r' } : { ruleId: 'r', ruleName } }));
      assert.deepStrictEqual(push.sent.map((sent) => sent.title), [title], JSON.stringify(ruleName));
    }
  });

  it('leaves the panel’s own SYSTEM error titled «Система»', async () => {
    const push = dispatcherFor({ permitted: DASHBOARD });
    await push.handle({ type: 'system.error', category: 'SYSTEM', severity: 'ERROR', message: 'boom' });
    assert.deepStrictEqual(push.sent.map((sent) => sent.title), ['Система']);
  });
});

// ── The panel's screens: the realtime topic ──────────────────────────────────

/** The topics the SPA subscribes with, read from its own source. */
function spaTopics(): string[] {
  const source = readFileSync(join(__dirname, '..', 'web', 'src', 'lib', 'realtime', 'realtime-types.ts'), 'utf8');
  const start = source.indexOf('export const REALTIME_TOPICS');
  const end = source.indexOf('] as const', start);
  assert.ok(start >= 0 && end > start, 'REALTIME_TOPICS is gone from the SPA');
  return [...source.slice(start, end).matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
}

interface FakeSocket {
  readonly id: string;
  data?: unknown;
  readonly emitted: Array<{ event: string; payload: unknown }>;
  emit(event: string, payload: unknown): void;
  disconnect(): void;
  readonly handshake: { auth: { token: string }; headers: Record<string, string>; query: Record<string, string> };
}

async function screenFor(granted: ReadonlySet<string>): Promise<{ gateway: RealtimeGateway; socket: FakeSocket }> {
  const gateway = new RealtimeGateway(
    { verifyAsync: async () => ({ sub: 'op-1', tokenVersion: 1 }) } as never,
    {
      adminUser: {
        findUnique: async () => ({ id: 'op-1', login: 'op', isActive: true, tokenVersion: 1, role: UserRole.ADMIN, rbacRoleId: 'r' }),
      },
    } as never,
    { jwtSecret: 'x' } as never,
    { hasPermission: async (_admin: unknown, resource: string, action: string) => granted.has(`${resource}:${action}`) } as never,
  );
  const socket: FakeSocket = {
    id: 's1',
    emitted: [],
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
    disconnect() {},
    handshake: { auth: { token: 'jwt' }, headers: {}, query: {} },
  };
  await gateway.handleConnection(socket as never);
  // What `use-realtime-updates.ts` does on connect: subscribe with its own list.
  gateway.handleSubscribe(socket as never, spaTopics());
  socket.emitted.length = 0;
  return { gateway, socket };
}

const AUTOMATION_EVENT: RealtimeEventInterface = {
  type: 'automation.custom.disk',
  category: 'AUTOMATION',
  severity: 'ERROR',
  message: 'Disk full',
  metadata: { ruleId: 'rule-1', ruleName: 'Disk watch' },
  timestamp: '2026-09-19T10:00:00.000Z',
};

describe('the realtime topic', () => {
  it('exists, with the audience SYSTEM had — where a rule’s events were filed until now', () => {
    assert.ok((REALTIME_TOPICS as readonly string[]).includes('AUTOMATION'));
    const permissions = REALTIME_TOPIC_PERMISSION as Readonly<Record<string, unknown>>;
    assert.deepStrictEqual(permissions['AUTOMATION'], permissions['SYSTEM']);
  });

  it('is one the SPA subscribes to: the two lists are the same', () => {
    assert.deepStrictEqual([...spaTopics()].sort(), [...REALTIME_TOPICS].sort());
  });

  it('brings a rule’s event to a screen that may see SYSTEM, subscribed the way the SPA subscribes', async () => {
    const { gateway, socket } = await screenFor(new Set(['dashboard:view']));
    gateway.broadcast(AUTOMATION_EVENT);
    assert.deepStrictEqual(
      socket.emitted.filter((entry) => entry.event === REALTIME_EVENT).map((entry) => entry.payload),
      [AUTOMATION_EVENT],
    );
  });

  it('keeps it from a screen that may not', async () => {
    const { gateway, socket } = await screenFor(new Set(['support_tickets:view']));
    gateway.broadcast(AUTOMATION_EVENT);
    assert.deepStrictEqual(socket.emitted.filter((entry) => entry.event === REALTIME_EVENT), []);
  });
});

// ── The Telegram forum topic ─────────────────────────────────────────────────

describe('the Telegram forum topic', () => {
  const forum = (topicMap: Record<string, number | null>, errorTopicId: number | null = null) => ({
    enabled: true,
    chatId: '-100123',
    devChatId: null,
    topicMap,
    defaultTopicId: 3,
    errorTopicId,
  });
  const card = (severity: 'INFO' | 'WARNING' | 'ERROR' = 'WARNING') => ({
    type: 'automation.custom.disk',
    category: 'AUTOMATION',
    severity,
  });

  it('is SYSTEM’s when there is no AUTOMATION topic — where these cards have always gone', () => {
    assert.equal(resolveTelegramDeliveryTarget(forum({ SYSTEM: 7, PAYMENT: 9 }), card())?.topicId, 7);
    assert.equal(resolveTelegramDeliveryTarget(forum({ SYSTEM: 7, AUTOMATION: null }), card())?.topicId, 7);
  });

  it('is AUTOMATION’s own when one is set', () => {
    assert.equal(resolveTelegramDeliveryTarget(forum({ SYSTEM: 7, AUTOMATION: 11 }), card())?.topicId, 11);
  });

  it('is the error topic at ERROR when one is set, as for every error report', () => {
    assert.equal(resolveTelegramDeliveryTarget(forum({ SYSTEM: 7 }, 5), card('ERROR'))?.topicId, 5);
  });

  it('is the default when neither is set, and nothing else moves: other categories keep their own topic', () => {
    assert.equal(resolveTelegramDeliveryTarget(forum({ PAYMENT: 9 }), card())?.topicId, 3);
    assert.equal(
      resolveTelegramDeliveryTarget(forum({ SYSTEM: 7, PAYMENT: 9 }), { type: 'payment.completed', category: 'PAYMENT' })?.topicId,
      9,
    );
    assert.equal(
      resolveTelegramDeliveryTarget(forum({ SYSTEM: 7 }), { type: 'payment.completed', category: 'PAYMENT' })?.topicId,
      3,
    );
  });
});
