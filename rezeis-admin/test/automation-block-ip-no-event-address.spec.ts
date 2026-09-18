import 'reflect-metadata';

import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { AutomationTriggerKind, FraudSignalSeverity } from '@prisma/client';

import type { SystemEventsService } from '../src/common/services/system-events.service';
import type { FraudDetectors } from '../src/modules/anti-fraud/detectors/fraud-detectors';
import type { RemnawaveDetectors } from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import type { SharingDetectors } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import type { SubscriptionUaDetectors } from '../src/modules/anti-fraud/detectors/subscription-ua-detectors';
import type { FraudSignalCandidate } from '../src/modules/anti-fraud/interfaces/fraud-signal.interface';
import { AntiFraudService } from '../src/modules/anti-fraud/services/anti-fraud.service';
import { AutomationEventBridgeService } from '../src/modules/automations/automation-event-bridge.service';
import type { RealtimeEventInterface } from '../src/modules/realtime/interfaces/realtime-event.interface';
import { panelDevicesDouble } from './fixtures/anti-fraud-panel-clients';
import { makeAntiFraudStore } from './fixtures/anti-fraud-store';
import {
  createAutomationHarness,
  messagesOf,
  ruleBody,
  type AutomationHarness,
} from './helpers/automation-http-harness';

/**
 * «Антифрод → блок IP + Telegram» could never block anything
 * ══════════════════════════════════════════════════════════
 *
 * The template made a REALTIME rule on `fraud.signal_opened` whose `block_ip`
 * took "the address the event carries". `block_ip` reads `ip` / `ipAddress` at
 * the top of the trigger data, and a realtime job's trigger data is
 * `{ type, category, severity, message, metadata, timestamp }` — so it never
 * found one, and every run failed «no address». Nor is there another key to
 * read it from: `fraud.signal_opened` carries the signal, its score and its
 * customers, never an address — even for an IP-sharing signal, whose addresses
 * stay on the signal row — and no other event the panel or the cabinet emits
 * carries a client address at all.
 *
 * So the template is retired, and a rule that runs on its own with a
 * `block_ip` that has no address of its own is refused at save and at
 * switch-on. The first block proves the premise end to end: a real anti-fraud
 * run emits the event, the real event bridge picks it up, the real executor
 * runs the rule, and the action finds no address.
 */

const RULE_ADMIN = ['automations:view', 'automations:create', 'automations:edit', 'automations:run', 'blocked_ips:create'];

let harness: AutomationHarness;

before(async () => {
  harness = await createAutomationHarness([{ id: 'blocker', role: 'ADMIN', permissions: RULE_ADMIN }]);
});

after(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.db.rules.clear();
  harness.db.executions.length = 0;
  harness.db.blockedIps.clear();
});

const TODAY = new Date().toISOString().slice(0, 10);

/** What `SharingDetectors.detectConcurrentIpSharing` reports for one customer on many networks. */
function ipSharingCandidate(): FraudSignalCandidate {
  return {
    code: 'SUBSCRIPTION_SHARING_IP',
    fingerprint: `${TODAY}|panel-uuid-7`,
    severity: FraudSignalSeverity.HIGH,
    title: 'Subscription used from too many networks',
    description: 'User connected from 6 distinct networks.',
    score: 96,
    confidence: 95,
    affectedUserIds: ['user-7'],
    metadata: {
      kind: 'ip_sharing',
      distinctNetworkCount: 6,
      distinctIpCount: 3,
      observedIpCount: 3,
      deviceLimit: 2,
      remnawaveUuid: 'panel-uuid-7',
      remnawaveUsername: 'user7',
      ips: [
        { ip: '203.0.113.5', lastSeen: new Date().toISOString() },
        { ip: '198.51.100.9', lastSeen: new Date().toISOString() },
        { ip: '192.0.2.44', lastSeen: new Date().toISOString() },
      ],
    },
  };
}

/** The anti-fraud service over its in-memory store, with the IP-sharing detector reporting `candidate`. */
function antiFraud(candidate: FraudSignalCandidate): {
  readonly service: AntiFraudService;
  readonly emitted: RealtimeEventInterface[];
} {
  const store = makeAntiFraudStore({ today: TODAY, users: ['user-7'] });
  const none = () => Promise.resolve([]);
  const emitted: RealtimeEventInterface[] = [];
  // What `SystemEventsService` hands the realtime gateway, field for field
  // (`deliverRealtime`).
  const record =
    (severity: 'INFO' | 'WARNING') =>
    (type: string, category: string, message: string, metadata?: Record<string, unknown>) => {
      emitted.push({
        type,
        category: category as RealtimeEventInterface['category'],
        severity,
        message,
        metadata,
        timestamp: new Date().toISOString(),
      });
    };
  const service = new AntiFraudService(
    store.prisma,
    {
      detectExcessiveFailedPayments: none,
      detectRapidReferralVelocity: none,
      detectPromoAbuse: none,
      detectRapidChurn: none,
    } as unknown as FraudDetectors,
    {
      detectPerUserNodeTrafficAbuse: none,
      collectHwidAverageAlerts: none,
      collectNodeTrafficAlerts: none,
      collectGeoConcentrationAlerts: none,
      collectOfflineNodeAlerts: none,
    } as unknown as RemnawaveDetectors,
    {
      detectHwidOverage: none,
      detectSharedHwidAcrossAccounts: none,
      detectConcurrentIpSharing: () => Promise.resolve([candidate]),
    } as unknown as SharingDetectors,
    { detectSubscriptionUaTunnel: none } as unknown as SubscriptionUaDetectors,
    panelDevicesDouble().client,
    { info: record('INFO'), warn: record('WARNING'), emit: () => undefined } as unknown as SystemEventsService,
  );
  return { service, emitted };
}

/** Every string anywhere in `value` that is an IP address. */
function addressesIn(value: unknown): string[] {
  if (typeof value === 'string') return isIP(value.trim()) !== 0 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(addressesIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(addressesIn);
  return [];
}

describe('the anti-fraud event the template listened to', () => {
  it('carries no address, so the rule it made blocks nothing — from the detector run to the action', async () => {
    const rule = harness.seedRule({
      name: 'Антифрод → блок IP + Telegram',
      isEnabled: true,
      triggerKind: AutomationTriggerKind.REALTIME,
      triggerSpec: 'fraud.signal_opened',
      actions: [
        { type: 'block_ip', params: {} },
        { type: 'notify_telegram', params: { text: 'Anti-fraud: IP blocked by signal.' } },
      ],
    });

    // A real detector run. An observational code opens on sustained evidence,
    // so it is run until the signal opens — twice, as the gate is written.
    const fraud = antiFraud(ipSharingCandidate());
    for (let run = 0; run < 3 && !fraud.emitted.some((event) => event.type === 'fraud.signal_opened'); run += 1) {
      await fraud.service.runDetectors();
    }
    const opened = fraud.emitted.find((event) => event.type === 'fraud.signal_opened');
    assert.ok(opened !== undefined, `no fraud.signal_opened was emitted: ${JSON.stringify(fraud.emitted.map((e) => e.type))}`);
    // The premise: the signal row knows three addresses, the event none.
    assert.deepStrictEqual(addressesIn(opened.metadata), [], 'fraud.signal_opened carried an address');

    // The real bridge, on a stand-in gateway, running each job it queues on the
    // real executor the way the automation worker does.
    const gateway = { broadcast: (_event: RealtimeEventInterface): void => undefined };
    const runs: Array<Awaited<ReturnType<AutomationHarness['executor']['executeJob']>>> = [];
    const bridge = new AutomationEventBridgeService(
      { get: () => gateway } as never,
      harness.prisma as never,
      {
        enqueueExecution: async (job: Parameters<AutomationHarness['executor']['executeJob']>[0]) => {
          runs.push(await harness.executor.executeJob(job));
        },
      } as never,
    );
    bridge.onModuleInit();
    gateway.broadcast(opened);

    for (let waited = 0; runs.length === 0 && waited < 2_000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(runs.length, 1, 'the rule did not fire on the event');
    const result = runs[0]!;
    assert.equal(harness.db.executions.length, 1);
    assert.equal(harness.db.executions[0]!['ruleId'], rule.id);
    const [block, notify] = result.actionResults;
    assert.equal(block?.type, 'block_ip');
    assert.equal(block?.status, 'failed');
    assert.equal(block?.code, 'block_address_missing');
    assert.equal(notify?.status, 'success', 'the rule did fire: the rest of it ran');
    assert.deepStrictEqual([...harness.db.blockedIps.keys()], [], 'something was blocked');
  });
});

describe('a rule that runs on its own needs the address written into the action', () => {
  const NEEDED =
    'Action 1 (block_ip): no event or schedule carries an IP address, so a rule that runs on its own needs the address written into the action';

  it('refuses such a rule on an event and on a schedule, and writes nothing', async () => {
    for (const trigger of [
      { triggerKind: 'REALTIME', triggerSpec: 'fraud.signal_opened' },
      { triggerKind: 'CRON', triggerSpec: '0 3 * * *' },
    ]) {
      harness.db.rules.clear();
      const response = await harness
        .as('blocker')
        .post('/rules', ruleBody({ ...trigger, actions: [{ type: 'block_ip', params: {} }] }));
      assert.equal(response.status, 400, `${trigger.triggerKind}: ${JSON.stringify(response.body)}`);
      assert.deepStrictEqual(messagesOf(response.body), [NEEDED]);
      assert.equal(harness.db.rules.size, 0);
    }
  });

  it('saves one with an address of its own, and a manual one that takes its address from the run', async () => {
    const pinned = await harness.as('blocker').post(
      '/rules',
      ruleBody({
        triggerKind: 'REALTIME',
        triggerSpec: 'fraud.signal_opened',
        actions: [{ type: 'block_ip', params: { address: '203.0.113.99' } }],
      }),
    );
    assert.equal(pinned.status, 201, JSON.stringify(pinned.body));
    const manual = await harness.as('blocker').post('/rules', ruleBody({ actions: [{ type: 'block_ip', params: {} }] }));
    assert.equal(manual.status, 201, JSON.stringify(manual.body));
  });

  it('refuses to switch one on, and still lets it be switched off', async () => {
    const rule = harness.seedRule({
      isEnabled: false,
      triggerKind: AutomationTriggerKind.REALTIME,
      triggerSpec: 'fraud.signal_opened',
      actions: [{ type: 'block_ip', params: {} }],
    });
    const on = await harness.as('blocker').patch(`/rules/${rule.id}/toggle`, { isEnabled: true });
    assert.equal(on.status, 400, JSON.stringify(on.body));
    assert.deepStrictEqual(messagesOf(on.body), [NEEDED]);
    assert.equal(harness.db.rules.get(rule.id)?.isEnabled, false);

    harness.db.rules.get(rule.id)!.isEnabled = true;
    const off = await harness.as('blocker').patch(`/rules/${rule.id}/toggle`, { isEnabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
  });
});
