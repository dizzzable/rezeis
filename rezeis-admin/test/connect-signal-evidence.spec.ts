import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import {
  connectEvidenceOf,
  connectHelpFlags,
  connectHelpOptedOut,
  FIRST_TRAFFIC_EVENT_MAX_AGE_MS,
  firstTrafficEventDue,
} from '../src/modules/connect-signal/connect-evidence.util';
import { readConnectHelpSettings } from '../src/modules/connect-signal/connect-help-settings';
import { firstPassHours } from '../src/modules/connect-signal/connect-probe.sql';
import {
  CONNECT_HORIZON_MS,
  CONNECT_PROBE_BATCH,
  CONNECT_PROBE_CONCURRENCY,
  CONNECT_PROBE_CRON,
  CONNECT_PROBE_READ_DEADLINE_MS,
  CONNECT_PROBE_STATUS_KEY,
} from '../src/modules/connect-signal/connect-signal.constants';
import {
  CONNECT_VERIFICATION_MAX_AGE_MS,
  moneyForSubscriptionSql,
  paidMoneySql,
  pendingHelpSql,
  PENDING_HELP_OUTCOMES,
  trialBucketSql,
  verifiedNotConnectedSql,
} from '../src/modules/connect-signal/connect-sql';
import {
  connectSignalStateOf,
  type ConnectSignalState,
} from '../src/modules/connect-signal/services/connect-signal-health.service';
import type { ConnectProbeStatus } from '../src/modules/connect-signal/services/connect-signal-probe.service';
import { decodePanelUserTraffic } from '../src/modules/remnawave/services/remnawave-api.service';

/**
 * The connection signal's pure decisions: the evidence rule every writer
 * shares, the cabinet's `connectHelp` flags, the stored settings, the health
 * state, and the numbers the design fixes. Each of them is also reached through
 * its real caller in the other `connect-signal-*` specs; here the TABLES are
 * complete, so a changed branch cannot hide behind a caller that happens not to
 * exercise it.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');

function block(overrides: Partial<{
  usedTrafficBytes: number | null;
  lifetimeUsedTrafficBytes: number | null;
  onlineAt: string | null;
  firstConnectedAt: string | null;
}> = {}) {
  return {
    usedTrafficBytes: 0,
    lifetimeUsedTrafficBytes: 0,
    onlineAt: null,
    firstConnectedAt: null,
    ...overrides,
  };
}

describe('connectEvidenceOf — the one evidence rule', () => {
  it('each of the four facts alone means connected', () => {
    for (const [name, traffic] of [
      ['firstConnectedAt', block({ firstConnectedAt: '2026-09-01T00:00:00.000Z' })],
      ['onlineAt', block({ onlineAt: '2026-09-02T00:00:00.000Z' })],
      ['lifetimeUsedTrafficBytes', block({ lifetimeUsedTrafficBytes: 1 })],
      ['usedTrafficBytes', block({ usedTrafficBytes: 1 })],
    ] as const) {
      assert.equal(connectEvidenceOf(traffic, NOW).kind, 'connected', `${name} alone`);
    }
  });

  it('a present block with all four empty is NOT connected — nulls and zeros alike', () => {
    assert.deepStrictEqual(connectEvidenceOf(block(), NOW), { kind: 'not_connected' });
    assert.deepStrictEqual(
      connectEvidenceOf(block({ usedTrafficBytes: null, lifetimeUsedTrafficBytes: null }), NOW),
      { kind: 'not_connected' },
    );
  });

  it('a missing block is UNKNOWN, never "not connected"', () => {
    assert.deepStrictEqual(connectEvidenceOf(null, NOW), { kind: 'unknown' });
    assert.deepStrictEqual(connectEvidenceOf(undefined, NOW), { kind: 'unknown' });
  });

  it('dates the connection by firstConnectedAt, then onlineAt, then now', () => {
    assert.deepStrictEqual(
      connectEvidenceOf(
        block({ firstConnectedAt: '2026-08-01T00:00:00.000Z', onlineAt: '2026-09-10T00:00:00.000Z' }),
        NOW,
      ),
      { kind: 'connected', at: new Date('2026-08-01T00:00:00.000Z') },
    );
    assert.deepStrictEqual(connectEvidenceOf(block({ onlineAt: '2026-09-10T00:00:00.000Z' }), NOW), {
      kind: 'connected',
      at: new Date('2026-09-10T00:00:00.000Z'),
    });
    assert.deepStrictEqual(connectEvidenceOf(block({ lifetimeUsedTrafficBytes: 5 }), NOW), {
      kind: 'connected',
      at: NOW,
    });
  });

  it('never dates a connection in the future (a panel clock running ahead)', () => {
    const evidence = connectEvidenceOf(block({ firstConnectedAt: '2026-09-20T00:00:00.000Z' }), NOW);
    assert.deepStrictEqual(evidence, { kind: 'connected', at: NOW });
  });
});

describe('decodePanelUserTraffic — what counts as a readable block', () => {
  it('reads numbers, numeric strings and safe bigints, and ISO instants', () => {
    assert.deepStrictEqual(
      decodePanelUserTraffic({
        usedTrafficBytes: '2048',
        lifetimeUsedTrafficBytes: 4096n,
        onlineAt: '2026-09-01T10:00:00Z',
        firstConnectedAt: null,
        lastConnectedNodeUuid: null,
      }),
      {
        usedTrafficBytes: 2048,
        lifetimeUsedTrafficBytes: 4096,
        onlineAt: '2026-09-01T10:00:00.000Z',
        firstConnectedAt: null,
      },
    );
  });

  it('reads an absent key as null — the other three still answer', () => {
    assert.deepStrictEqual(decodePanelUserTraffic({ lifetimeUsedTrafficBytes: 7 }), {
      usedTrafficBytes: null,
      lifetimeUsedTrafficBytes: 7,
      onlineAt: null,
      firstConnectedAt: null,
    });
  });

  it('refuses a block it cannot vouch for: wrong kinds, no known key, not an object', () => {
    for (const [label, raw] of [
      ['a date that is not one', { usedTrafficBytes: 0, lifetimeUsedTrafficBytes: 0, onlineAt: 'soon', firstConnectedAt: null }],
      ['a counter that is not one', { usedTrafficBytes: 'lots', lifetimeUsedTrafficBytes: 0, onlineAt: null, firstConnectedAt: null }],
      ['an object for a counter', { usedTrafficBytes: {}, lifetimeUsedTrafficBytes: 0, onlineAt: null, firstConnectedAt: null }],
      ['a number for an instant', { usedTrafficBytes: 0, lifetimeUsedTrafficBytes: 0, onlineAt: 1726000000, firstConnectedAt: null }],
      ['a bigint past 2^53', { usedTrafficBytes: 2n ** 60n, lifetimeUsedTrafficBytes: 0, onlineAt: null, firstConnectedAt: null }],
      ['no known key', { lastConnectedNodeUuid: null }],
      ['an array', []],
      ['a string', 'userTraffic'],
      ['null', null],
      ['undefined', undefined],
    ] as const) {
      assert.equal(decodePanelUserTraffic(raw), null, label);
    }
  });
});

describe('connectHelpFlags — the cabinet payload', () => {
  const pendingState = { firstConnectedAt: null, helpOutcome: 'banner', bannerDismissedAt: null };

  it('is null without a state row, without help, and after help that did not reach anyone', () => {
    const base = { connectedNow: false, status: SubscriptionStatus.ACTIVE, optedOut: false };
    assert.equal(connectHelpFlags({ ...base, state: null }), null);
    for (const outcome of [null, 'opted_out', 'merged', 'skipped_unverifiable', 'skipped_template_off', 'weird']) {
      assert.equal(
        connectHelpFlags({ ...base, state: { ...pendingState, helpOutcome: outcome } }),
        null,
        `outcome ${String(outcome)}`,
      );
    }
  });

  it('is pending after every outcome that GAVE help, and shows the banner only for the banner', () => {
    const base = { connectedNow: false, status: SubscriptionStatus.ACTIVE, optedOut: false };
    // Pinned by name, not read back from the constant: the list IS the contract.
    assert.deepStrictEqual([...PENDING_HELP_OUTCOMES], ['bot', 'push', 'email', 'banner', 'broadcast']);
    for (const outcome of ['bot', 'push', 'email', 'broadcast']) {
      assert.deepStrictEqual(connectHelpFlags({ ...base, state: { ...pendingState, helpOutcome: outcome } }), {
        pending: true,
        banner: false,
      });
    }
    assert.deepStrictEqual(connectHelpFlags({ ...base, state: pendingState }), { pending: true, banner: true });
  });

  it('hides the banner once dismissed, or when the customer switched the help off — still pending', () => {
    const base = { connectedNow: false, status: SubscriptionStatus.LIMITED };
    assert.deepStrictEqual(
      connectHelpFlags({ ...base, optedOut: false, state: { ...pendingState, bannerDismissedAt: NOW } }),
      { pending: true, banner: false },
    );
    assert.deepStrictEqual(connectHelpFlags({ ...base, optedOut: true, state: pendingState }), {
      pending: true,
      banner: false,
    });
  });

  it('is null once connected — by the stored row or by this very read', () => {
    const base = { status: SubscriptionStatus.ACTIVE, optedOut: false };
    assert.equal(connectHelpFlags({ ...base, connectedNow: true, state: pendingState }), null);
    assert.equal(
      connectHelpFlags({ ...base, connectedNow: false, state: { ...pendingState, firstConnectedAt: NOW } }),
      null,
    );
  });

  it('is null for a subscription that is not live', () => {
    for (const status of [SubscriptionStatus.EXPIRED, SubscriptionStatus.DISABLED, SubscriptionStatus.DELETED]) {
      assert.equal(connectHelpFlags({ connectedNow: false, optedOut: false, status, state: pendingState }), null);
    }
  });

  it('reads the opt-out from the customer’s own switch, and only an explicit false', () => {
    assert.equal(connectHelpOptedOut({ connect_help: false }), true);
    for (const prefs of [{ connect_help: true }, {}, null, undefined, [], 'x', { expired: false }]) {
      assert.equal(connectHelpOptedOut(prefs), false, JSON.stringify(prefs));
    }
  });
});

describe('the stored «Помощь с подключением» switches', () => {
  it('read as OFF / 24 / OFF when absent or damaged', () => {
    const off = { enabled: false, delayHours: 24, includeTrials: false };
    for (const raw of [{}, null, undefined, [], 'on', { enabled: 'true', delayHours: '48', includeTrials: 1 }]) {
      assert.deepStrictEqual(readConnectHelpSettings(raw), off, JSON.stringify(raw));
    }
  });

  it('keep hours within 1–168, whole', () => {
    assert.equal(readConnectHelpSettings({ delayHours: 1 }).delayHours, 1);
    assert.equal(readConnectHelpSettings({ delayHours: 168 }).delayHours, 168);
    for (const bad of [0, 169, 12.5, -3, Number.NaN]) {
      assert.equal(readConnectHelpSettings({ delayHours: bad }).delayHours, 24, String(bad));
    }
    assert.deepStrictEqual(readConnectHelpSettings({ enabled: true, delayHours: 6, includeTrials: true }), {
      enabled: true,
      delayHours: 6,
      includeTrials: true,
    });
  });
});

describe('connectSignalStateOf — what the operator is told', () => {
  const MIN = 60_000;
  function probe(overrides: Partial<ConnectProbeStatus>): ConnectProbeStatus {
    return {
      lastCycleAt: NOW.toISOString(),
      lastOkAt: new Date(NOW.getTime() - 5 * MIN).toISOString(),
      lastFailAt: null,
      lastReason: null,
      failingSince: null,
      firstPassCompletedAt: '2026-09-18T00:00:00.000Z',
      candidates: 0,
      connected: 0,
      notConnected: 0,
      missing: 0,
      failed: 0,
      unaddressable: 0,
      backlog: 0,
      durationMs: 10,
      ...overrides,
    };
  }
  const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN).toISOString();

  const table: ReadonlyArray<[string, ConnectProbeStatus | null, string | null, ConnectSignalState]> = [
    ['nothing has run yet', null, null, 'starting'],
    ['a fresh read, first pass done', probe({}), null, 'live'],
    ['a fresh read, first pass not done', probe({ firstPassCompletedAt: null }), null, 'starting'],
    ['last read 29 min ago', probe({ lastOkAt: ago(29) }), null, 'live'],
    ['last read 30 min ago, a webhook an hour ago', probe({ lastOkAt: ago(30) }), ago(60), 'webhooks_only'],
    ['last read 30 min ago, the last webhook 25 h ago', probe({ lastOkAt: ago(30) }), ago(25 * 60), 'blind'],
    ['last read 2 h ago, no webhook at all', probe({ lastOkAt: ago(120) }), null, 'blind'],
    [
      'never read, failing for 10 min',
      probe({ lastOkAt: null, failingSince: ago(10), firstPassCompletedAt: null }),
      null,
      'starting',
    ],
    [
      'never read, failing for 30 min, webhooks arriving',
      probe({ lastOkAt: null, failingSince: ago(30), firstPassCompletedAt: null }),
      ago(5),
      'webhooks_only',
    ],
  ];

  for (const [label, status, webhook, expected] of table) {
    it(`${label} → ${expected}`, () => {
      assert.equal(connectSignalStateOf({ probe: status, lastUserWebhookAt: webhook, now: NOW }), expected);
    });
  }

  it('estimates the first pass in whole hours at 100 reads per 10 minutes', () => {
    assert.equal(firstPassHours(0, 100, 10 * MIN), 0);
    assert.equal(firstPassHours(1, 100, 10 * MIN), 1);
    assert.equal(firstPassHours(600, 100, 10 * MIN), 1);
    assert.equal(firstPassHours(5_000, 100, 10 * MIN), 9);
  });
});

describe('the numbers the design fixes', () => {
  it('announces a first connection up to exactly 24 hours old', () => {
    assert.equal(FIRST_TRAFFIC_EVENT_MAX_AGE_MS, 24 * 60 * 60 * 1000);
    assert.equal(firstTrafficEventDue(new Date(NOW.getTime() - 24 * 60 * 60 * 1000), NOW), true);
    assert.equal(firstTrafficEventDue(new Date(NOW.getTime() - 24 * 60 * 60 * 1000 - 1), NOW), false);
  });

  it('pins the probe’s budget and its Redis key', () => {
    // Literals, not the constants read back: a test that took its expectation
    // from the constant it guards would move with it.
    assert.equal(CONNECT_PROBE_BATCH, 100);
    assert.equal(CONNECT_PROBE_CONCURRENCY, 4);
    assert.equal(CONNECT_PROBE_READ_DEADLINE_MS, 3_000);
    assert.equal(CONNECT_PROBE_CRON, '*/10 * * * *');
    assert.equal(CONNECT_PROBE_STATUS_KEY, 'rezeis:connect-signal:probe');
    assert.equal(CONNECT_HORIZON_MS, 30 * 24 * 60 * 60 * 1000);
    assert.equal(CONNECT_VERIFICATION_MAX_AGE_MS, 24 * 60 * 60 * 1000);
  });
});

describe('connect-sql refuses an alias it would splice unsafely', () => {
  it('takes plain lower-case identifiers and nothing else', () => {
    for (const bad of ['S', 's; DROP TABLE users', 's"', 'wp4_s', '', '1s', 'a'.repeat(32)]) {
      assert.throws(() => paidMoneySql(bad), /not a table alias/, bad);
      assert.throws(() => moneyForSubscriptionSql(bad), /not a table alias/, bad);
      assert.throws(() => trialBucketSql(bad), /not a table alias/, bad);
      assert.throws(() => pendingHelpSql(bad), /not a table alias/, bad);
      assert.throws(() => verifiedNotConnectedSql(bad, NOW), /not a table alias/, bad);
    }
    assert.doesNotThrow(() => paidMoneySql('t'));
    assert.doesNotThrow(() => verifiedNotConnectedSql('connect_state', NOW));
  });
});
