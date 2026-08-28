import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import { FraudSignalSeverity } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { SubscriptionUaDetectors } from '../src/modules/anti-fraud/detectors/subscription-ua-detectors';
import {
  PanelInfraClient,
  type PanelReadOutcome,
  type PanelSubscriptionRequestHistoryPage,
} from '../src/modules/remnawave/services/panel-infra.client';
import type { StoredAntiFraudSettings } from '../src/modules/settings/utils/anti-fraud-settings.util';
import { tunablesFromEnv, tunablesThatFail } from './fixtures/anti-fraud-tunables';
import { panelOk } from './fixtures/anti-fraud-panel-clients';
import {
  subscriptionFindManyDouble,
  type SubscriptionQuery,
} from './fixtures/subscription-where';

const NOW = new Date('2026-08-06T12:00:00.000Z');

/**
 * The detector ships OFF. Every case below that is about the *detection* rather
 * than about the switch therefore has to turn it on first, and does so through
 * the real settings overlay — a stub that returned a hand-built config could
 * agree with a default the panel no longer has.
 */
const ENABLED: StoredAntiFraudSettings = {
  subscriptionUa: { enableSubscriptionUaTunnel: true },
};

/** `minutesAgo` before {@link NOW}, as the ISO string the panel sends. */
function ago(minutesAgo: number): string {
  return new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
}

/** A vless config URI carrying a credential, as a re-hoster's UA presents it. */
const CONFIG_UA = 'vless://b7f1e0c2-1111-2222-3333-444455556666@10.0.0.9:443?type=tcp';

/**
 * THE OWNER FIELD IS ONE NUMBER NOW.
 *
 * A 3.x request-log row is `{ id, userId, srrResponseType, srrRuleName,
 * requestIp, userAgent, requestAt }`, and `userId` is the panel's own integer —
 * the only identity a row carries. The nullable PAIR this replaces (`userUuid`
 * on 2.7.4, `panelUserId` on 2.8.0, exactly one of them ever populated) went
 * with the versions that spelled it that way, and so did the whole-panel user
 * walk the detector used to run to turn the second into the first.
 */
const DEFAULT_USER_ID = 4471;
/** What `Subscription.remnawaveId` holds for that profile on a 3.x panel. */
const DEFAULT_IDENTITY = String(DEFAULT_USER_ID);

type PanelRequestRecord = PanelSubscriptionRequestHistoryPage['records'][number];

function record(
  over: {
    id?: number;
    userId?: number | string;
    userAgent?: string | null;
    ipAddress?: string | null;
    /** ISO-8601. An unparseable literal is passed through verbatim — see below. */
    requestedAt?: string;
  } = {},
): PanelRequestRecord {
  const requestedAt = over.requestedAt ?? ago(5);
  return {
    id: over.id ?? 1,
    userId: over.userId ?? DEFAULT_USER_ID,
    srrResponseType: 'OK',
    srrRuleName: null,
    requestIp: over.ipAddress === undefined ? '203.0.113.1' : over.ipAddress,
    userAgent: over.userAgent === undefined ? 'v2rayNG/1.8.5' : over.userAgent,
    // The contract turns `requestAt` into a `Date`, so a validated response
    // hands the detector a Date. A literal the schema would have REJECTED can
    // only reach it on the executor's drift path, where the raw wire string
    // comes through instead — so that is what an unparseable one is sent as.
    requestAt: Number.isFinite(Date.parse(requestedAt)) ? new Date(requestedAt) : requestedAt,
  } as unknown as PanelRequestRecord;
}

interface Mock {
  readonly records?: readonly PanelRequestRecord[];
  /** Overrides `records` to simulate a log read that did not come back. */
  readonly pageOutcome?: PanelReadOutcome<PanelSubscriptionRequestHistoryPage>;
  readonly total?: number;
  /**
   * The page size the detector will be configured to ASK for.
   *
   * The panel does not echo the requested size back — the caller is the only
   * one that knows it — so a test that wants a FULL page sets this to the
   * record count. It reaches the detector through the stored tunable, which is
   * where the number really comes from.
   */
  readonly requestedSize?: number;
  /**
   * `remnawavePanelId` absent === the column is NULL, which is what most rows
   * look like — and why a lookup that ever asks for `remnawavePanelId: null`
   * selects the whole table rather than one customer.
   */
  readonly subs?: readonly SubRow[];
  /** Stored anti-fraud settings; defaults to "the operator switched it on". */
  readonly stored?: StoredAntiFraudSettings;
}

/** A `subscriptions` row as the detector selects it. */
interface SubRow {
  remnawaveId: string;
  remnawavePanelId?: number | null;
  userId: string;
}

interface Harness {
  readonly detectors: SubscriptionUaDetectors;
  /** The `size` every subscription-request-log read asked the panel for. */
  readonly pageSizesRequested: () => readonly number[];
  /** Every panel method the detector called, in order. */
  readonly panelCalls: readonly string[];
  /** Every `subscription.findMany`: the `where` sent and the rows it selected. */
  readonly subscriptionQueries: readonly SubscriptionQuery<SubRow>[];
}

function makeHarness(mock: Mock): Harness {
  const pageSizes: number[] = [];
  const panelCalls: string[] = [];
  const records = mock.records ?? [];
  // The `where` is HONOURED, not ignored — see `test/fixtures/subscription-where.ts`.
  const subscriptions = subscriptionFindManyDouble(mock.subs ?? []);

  const prismaMock = {
    subscription: { findMany: subscriptions.findMany },
  } as unknown as PrismaService;

  // Only the request-log read is stubbed, because after the migration it is the
  // ONLY panel surface this detector touches. There is no whole-panel user walk
  // left to fake: a 3.x row's numeric owner is already the identity rezeis
  // stores, so nothing needs translating.
  const infraMock = {
    getSubscriptionRequestHistory: (input: { start?: number; size?: number } = {}) => {
      panelCalls.push('getSubscriptionRequestHistory');
      pageSizes.push(input.size ?? -1);
      return Promise.resolve(
        mock.pageOutcome ??
          panelOk({
            records,
            total: mock.total ?? records.length,
          } as unknown as PanelSubscriptionRequestHistoryPage),
      );
    },
  } as unknown as PanelInfraClient;

  const stored =
    mock.stored ??
    (mock.requestedSize === undefined
      ? ENABLED
      : {
          subscriptionUa: {
            enableSubscriptionUaTunnel: true,
            uaRequestPageSize: mock.requestedSize,
          },
        });

  return {
    detectors: new SubscriptionUaDetectors(prismaMock, infraMock, tunablesFromEnv(stored)),
    pageSizesRequested: () => pageSizes,
    panelCalls,
    subscriptionQueries: subscriptions.queries,
  };
}

/**
 * Capture `Logger` output. A detector that returns `[]` for "clean" and `[]`
 * for "could not read the log" is only honest if the second case says so, so
 * the WARN line IS part of the contract here rather than decoration.
 */
function captureLogs(): { readonly warns: string[]; restore(): void } {
  const warns: string[] = [];
  const originalWarn = Logger.prototype.warn;
  const originalDebug = Logger.prototype.debug;
  Logger.prototype.warn = function patched(message: unknown): void {
    warns.push(String(message));
  } as typeof Logger.prototype.warn;
  Logger.prototype.debug = function patched(): void {} as typeof Logger.prototype.debug;
  return {
    warns,
    restore(): void {
      Logger.prototype.warn = originalWarn;
      Logger.prototype.debug = originalDebug;
    },
  };
}

describe('SubscriptionUaDetectors — the signal', () => {
  it('flags a fetch whose User-Agent carries a proxy config, and resolves the rezeis user', async () => {
    const { detectors } = makeHarness({
      records: [record({ userAgent: CONFIG_UA })],
      subs: [{ remnawaveId: DEFAULT_IDENTITY, userId: 'user-1' }],
    });

    const candidates = await detectors.detectSubscriptionUaTunnel(NOW);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].code, 'SUBSCRIPTION_UA_TUNNEL');
    assert.deepEqual(candidates[0].affectedUserIds, ['user-1']);
    assert.equal(candidates[0].fingerprint, `2026-08-06|${DEFAULT_IDENTITY}`);
    assert.deepEqual((candidates[0].metadata as { schemes: string[] }).schemes, ['vless']);
  });

  it('deep-links a 3.x identity to the uuid-era row it belongs to', async () => {
    // On a 3.x panel the log row identifies its owner by the numeric `id` and
    // there is no uuid left anywhere on the panel. The subscription was linked
    // during the 2.x era, so `remnawaveId` still holds the uuid and always
    // will. Matching on that one column alone finds nothing, `affectedUserIds`
    // comes back empty, and the operator gets a signal that opens onto nobody.
    const { detectors } = makeHarness({
      records: [record({ userId: 4471, userAgent: CONFIG_UA })],
      subs: [
        { remnawaveId: '9e7c1a54-0000-4000-8000-000000000001', userId: 'stranger-1' },
        { remnawaveId: '330f2b38-1362-46ab-b5c0-dea32167eff9', remnawavePanelId: 4471, userId: 'user-42' },
      ],
    });

    const candidates = await detectors.detectSubscriptionUaTunnel(NOW);

    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].affectedUserIds, ['user-42']);
    // The signal is still filed under the identity the PANEL used, which is
    // what the fingerprint dedupes on across runs.
    assert.equal(candidates[0].fingerprint, '2026-08-06|4471');
  });

  it('selects that row and no other — a null panel id must never be asked for', async () => {
    // `remnawave_panel_id` has no unique constraint and is null on most rows
    // (migration `20260810160000`), so asking `remnawavePanelId: null`, or
    // putting a null in the `in` list, would sweep up every one of these
    // strangers and file one customer's evidence against another.
    const { detectors, subscriptionQueries } = makeHarness({
      records: [record({ userId: 4471, userAgent: CONFIG_UA })],
      subs: [
        { remnawaveId: '9e7c1a54-0000-4000-8000-000000000001', userId: 'stranger-1' },
        { remnawaveId: '9e7c1a54-0000-4000-8000-000000000002', userId: 'stranger-2' },
        { remnawaveId: '330f2b38-1362-46ab-b5c0-dea32167eff9', remnawavePanelId: 4471, userId: 'user-42' },
      ],
    });

    await detectors.detectSubscriptionUaTunnel(NOW);

    assert.equal(subscriptionQueries.length, 1, 'the detector did not query subscriptions at all');
    assert.deepEqual(
      subscriptionQueries[0].matched.map((row) => row.userId),
      ['user-42'],
    );
  });

  // REMOVED: "asks one column only when the batch holds no numeric identity".
  // It described a 2.x panel, whose log rows carried a uuid and no numeric
  // angle at all, so `panelIdentityLookup` emitted the string arm alone. Every
  // identity this detector can produce on a 3.x panel is a decimal id, so the
  // condition the test set up is unreachable from here. The rule itself is
  // still pinned where it remains reachable — `sharing-detectors.spec.ts`,
  // whose identities come from the panel user list and can still be 2.x-era
  // uuids.

  it('files a single sighting at LOW and never above MEDIUM when it repeats', async () => {
    // A UA heuristic is weaker evidence than a device count. The concurrent-IP
    // detector — a stronger, count-based signal — tops out at MEDIUM, so this
    // one must not outrank it.
    const single = await makeHarness({
      records: [record({ userAgent: CONFIG_UA })],
    }).detectors.detectSubscriptionUaTunnel(NOW);
    assert.equal(single[0].severity, FraudSignalSeverity.LOW);

    const repeated = await makeHarness({
      records: [
        record({ id: 1, userAgent: CONFIG_UA, requestedAt: ago(1) }),
        record({ id: 2, userAgent: CONFIG_UA, requestedAt: ago(2) }),
        record({ id: 3, userAgent: CONFIG_UA, requestedAt: ago(3) }),
      ],
    }).detectors.detectSubscriptionUaTunnel(NOW);
    assert.equal(repeated[0].severity, FraudSignalSeverity.MEDIUM);
    assert.equal(repeated[0].confidence, 65);
    assert.ok(repeated[0].confidence < 100);
  });

  it('redacts the credential before it reaches signal metadata', async () => {
    const { detectors } = makeHarness({ records: [record({ userAgent: CONFIG_UA })] });

    const candidates = await detectors.detectSubscriptionUaTunnel(NOW);

    const serialized = JSON.stringify(candidates[0].metadata);
    assert.ok(
      !serialized.includes('b7f1e0c2-1111-2222-3333-444455556666'),
      `metadata leaked the client uuid: ${serialized}`,
    );
    assert.ok(serialized.includes('<redacted>'), serialized);
  });

  it('ignores ordinary client User-Agents, and costs exactly one panel call', async () => {
    const harness = makeHarness({
      records: [
        record({ id: 1, userAgent: 'v2rayNG/1.8.5' }),
        record({ id: 2, userAgent: 'okhttp/4.9.0' }),
        record({ id: 3, userAgent: null }),
        record({ id: 4, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0' }),
      ],
    });

    const candidates = await harness.detectors.detectSubscriptionUaTunnel(NOW);

    assert.deepEqual(candidates, []);
    // ONE request, not two, and not a 50-page walk of the whole panel. The user
    // walk that used to be conditional on seeing a 2.8.0 record is gone
    // outright: the identity is on the row.
    assert.deepEqual(harness.panelCalls, ['getSubscriptionRequestHistory']);
  });

  it('names a hit without reading the panel user list at all', async () => {
    // The counterpart to the case above, and the one that would have paid for
    // the walk on a 2.8.0 panel. A row's numeric owner IS the identity, so a
    // detection costs the same single request a clean run does.
    const harness = makeHarness({
      records: [record({ userAgent: CONFIG_UA })],
      subs: [{ remnawaveId: DEFAULT_IDENTITY, userId: 'user-1' }],
    });

    const candidates = await harness.detectors.detectSubscriptionUaTunnel(NOW);

    assert.equal(candidates.length, 1);
    assert.deepEqual(harness.panelCalls, ['getSubscriptionRequestHistory']);
  });

  it('ignores fetches older than the evidence window', async () => {
    const { detectors } = makeHarness({
      records: [record({ userAgent: CONFIG_UA, requestedAt: ago(120) })],
    });

    assert.deepEqual(await detectors.detectSubscriptionUaTunnel(NOW), []);
  });
});

describe('SubscriptionUaDetectors — the operator switch', () => {
  it('ships OFF: with nothing stored it reads no panel surface at all', async () => {
    // The default is the thing under test, so nothing is stored — this is the
    // configuration a fresh install runs. A detector that is registered in the
    // run plan but cannot be switched off is what this default exists to avoid,
    // and the proof that it IS off is that the panel was never touched.
    const harness = makeHarness({ stored: {}, records: [record({ userAgent: CONFIG_UA })] });

    assert.deepEqual(await harness.detectors.detectSubscriptionUaTunnel(NOW), []);
    assert.deepEqual(
      harness.pageSizesRequested(),
      [],
      'a switched-off detector must not cost a request',
    );
  });

  it('a stored OFF switch silences a run that would otherwise have named somebody', async () => {
    const on = makeHarness({
      records: [record({ userAgent: CONFIG_UA })],
      subs: [{ remnawaveId: DEFAULT_IDENTITY, userId: 'user-1' }],
    });
    assert.equal(
      (await on.detectors.detectSubscriptionUaTunnel(NOW)).length,
      1,
      'precondition: switched on, this run names the user',
    );

    const off = makeHarness({
      stored: { subscriptionUa: { enableSubscriptionUaTunnel: false } },
      records: [record({ userAgent: CONFIG_UA })],
      subs: [{ remnawaveId: DEFAULT_IDENTITY, userId: 'user-1' }],
    });
    assert.deepEqual(await off.detectors.detectSubscriptionUaTunnel(NOW), []);
    assert.deepEqual(off.pageSizesRequested(), []);
  });

  it('reads its page size and evidence window from the panel, not from a constant', async () => {
    // Both knobs at once, and both away from their defaults: the page size is
    // observable in the request the panel receives, and the window is observable
    // in which records survive it.
    const harness = makeHarness({
      stored: {
        subscriptionUa: {
          enableSubscriptionUaTunnel: true,
          uaRequestPageSize: 1200,
          uaEvidenceWindowMinutes: 15,
        },
      },
      records: [
        record({ id: 1, userAgent: CONFIG_UA, requestedAt: ago(5) }),
        record({ id: 2, userAgent: CONFIG_UA, requestedAt: ago(40) }),
      ],
    });

    const candidates = await harness.detectors.detectSubscriptionUaTunnel(NOW);

    assert.deepEqual(harness.pageSizesRequested(), [1200]);
    const metadata = candidates[0].metadata as { occurrences: number; windowMinutes: number };
    assert.equal(metadata.windowMinutes, 15);
    assert.equal(
      metadata.occurrences,
      1,
      'the 40-minute-old fetch falls outside a 15-minute window',
    );
  });

  it('falls back to the documented defaults when only the switch is stored', async () => {
    const harness = makeHarness({ records: [record({ userAgent: CONFIG_UA })] });

    const candidates = await harness.detectors.detectSubscriptionUaTunnel(NOW);

    assert.deepEqual(harness.pageSizesRequested(), [500]);
    assert.equal((candidates[0].metadata as { windowMinutes: number }).windowMinutes, 60);
  });
});

describe('SubscriptionUaDetectors — degrades loudly, never silently', () => {
  it('warns and raises nothing when the request log is unavailable', async () => {
    const capture = captureLogs();
    try {
      const { detectors } = makeHarness({
        pageOutcome: { kind: 'network', detail: 'socket hang up' },
      });
      const candidates = await detectors.detectSubscriptionUaTunnel(NOW);

      assert.deepEqual(candidates, []);
      // An unreadable log must be distinguishable from a clean one.
      assert.ok(
        capture.warns.some((w) => w.includes('not readable') && w.includes('socket hang up')),
        capture.warns.join('\n'),
      );
    } finally {
      capture.restore();
    }
  });

  it('names an unreadable body specifically, so a shape change is not read as a quiet panel', async () => {
    // `unreadable` is the panel answering 2xx with a body carrying no `records`
    // array. Reported as "the panel was briefly down" it sends an operator
    // looking at a healthy panel; reported as an empty log it lets a panel that
    // changed shape read as a panel where nothing happened.
    const capture = captureLogs();
    try {
      const { detectors } = makeHarness({
        pageOutcome: { kind: 'unreadable', detail: '`response.records` is null, not an array' },
      });
      await detectors.detectSubscriptionUaTunnel(NOW);

      assert.ok(
        capture.warns.some(
          (w) => w.includes('could not read') && w.includes('`response.records`'),
        ),
        capture.warns.join('\n'),
      );
    } finally {
      capture.restore();
    }
  });

  // REMOVED: "refuses the run when 2.8.0 numeric ids cannot be resolved to
  // uuids" and "resolves a 2.8.0 numeric id through the panel user list". Both
  // pinned the translation step between a 2.8.0 row's numeric `userId` and the
  // uuid its fingerprint had to be keyed on — a step that needed the whole
  // panel user list and abandoned the run when that list could not be vouched
  // for. On 3.x the numeric id IS the identity, so there is no translation, no
  // second panel read, and no run to abandon. The 3.x path they were guarding
  // is covered by "deep-links a 3.x identity to the uuid-era row it belongs to"
  // and by "names a hit without reading the panel user list at all".

  it('warns and drops records whose timestamp cannot be parsed', async () => {
    const capture = captureLogs();
    try {
      const { detectors } = makeHarness({
        records: [record({ userAgent: CONFIG_UA, requestedAt: 'not-a-date' })],
      });

      const candidates = await detectors.detectSubscriptionUaTunnel(NOW);

      assert.deepEqual(candidates, []);
      assert.ok(
        capture.warns.some((w) => w.includes('unreadable requestAt')),
        capture.warns.join('\n'),
      );
    } finally {
      capture.restore();
    }
  });

  it('says so when the page did not cover the whole evidence window', async () => {
    const capture = captureLogs();
    try {
      // A FULL page whose oldest row is still inside the window proves older
      // requests existed and were never examined. The page has to be full at a
      // size the panel tunable actually permits (min 100), because the size the
      // detector asks for is the size an operator can store — a fabricated
      // smaller one would test arithmetic no deployment can reach.
      const { detectors } = makeHarness({
        records: [
          record({ id: 1, userAgent: CONFIG_UA, requestedAt: ago(1) }),
          ...Array.from({ length: 99 }, (_unused, index) =>
            record({ id: index + 2, userAgent: 'v2rayNG/1.8.5', requestedAt: ago(2) }),
          ),
        ],
        requestedSize: 100,
        total: 50_000,
      });

      const candidates = await detectors.detectSubscriptionUaTunnel(NOW);

      assert.ok(
        capture.warns.some((w) => w.includes('can only under-detect')),
        capture.warns.join('\n'),
      );
      // The limitation travels with the signal, not just the log: an operator
      // reading the row later has to know the run saw part of its window.
      assert.equal(
        (candidates[0].metadata as { windowFullyCovered: boolean }).windowFullyCovered,
        false,
      );
    } finally {
      capture.restore();
    }
  });

  it('does not warn about coverage when the page is short of the requested size', async () => {
    const capture = captureLogs();
    try {
      const { detectors } = makeHarness({
        records: [record({ userAgent: CONFIG_UA })],
        requestedSize: 500,
      });

      const candidates = await detectors.detectSubscriptionUaTunnel(NOW);

      assert.deepEqual(capture.warns, []);
      assert.equal(
        (candidates[0].metadata as { windowFullyCovered: boolean }).windowFullyCovered,
        true,
      );
    } finally {
      capture.restore();
    }
  });

  it('refuses to run at all when the tunables cannot be read', async () => {
    const capture = captureLogs();
    try {
      // NOT a silent `[]`. An unreadable settings row must reject, so
      // `runDetectors` books the detector as having observed nothing and no open
      // signal is auto-resolved on the strength of a guess — and so a row that
      // could not be read can never be mistaken for a switch that was off.
      const detectors = new SubscriptionUaDetectors(
        { subscription: { findMany: () => Promise.resolve([]) } } as unknown as PrismaService,
        {
          getSubscriptionRequestHistory: () => {
            throw new Error('the panel must not be read without effective tunables');
          },
        } as unknown as PanelInfraClient,
        tunablesThatFail(),
      );

      await assert.rejects(
        detectors.detectSubscriptionUaTunnel(NOW),
        /tunables could not be read/,
      );
    } finally {
      capture.restore();
    }
  });

  it('warns and drops a matching record whose owner id is not an integer', async () => {
    // Only reachable on the executor's DRIFT path — the contract declares
    // `userId` as a number — but reachable, and the wrong handling is not a
    // dropped row: `Number.parseInt` reads a LEADING run of digits and stops,
    // so a uuid-shaped value would become panel user #3 and file one customer's
    // evidence under another customer's fingerprint.
    const capture = captureLogs();
    try {
      const { detectors } = makeHarness({
        records: [record({ userId: '3f2a-not-an-id', userAgent: CONFIG_UA })],
      });

      assert.deepEqual(await detectors.detectSubscriptionUaTunnel(NOW), []);
      assert.ok(
        capture.warns.some((w) => w.includes('cannot be attributed')),
        capture.warns.join('\n'),
      );
    } finally {
      capture.restore();
    }
  });
});
