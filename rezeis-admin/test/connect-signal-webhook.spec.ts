import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RemnawaveWebhookService } from '../src/modules/remnawave/services/remnawave-webhook.service';

/**
 * The webhook as a writer of the connection signal, driven through the real
 * `handleEvent`.
 *
 * The Prisma double HONOURS its arguments: `subscription.findMany` evaluates
 * the `where` it is given against the rows below, so "which subscriptions did
 * the write land on" is decided by the service's own `panelIdentityWhere`, not
 * by a stub that answers everything. What the upsert does to the rows is
 * proven against PostgreSQL in `connect-signal-postgres.spec.ts`; here the
 * question is WHICH statement, on WHICH rows, with WHICH times.
 */

interface Row {
  readonly id: string;
  readonly remnawaveId: string | null;
  readonly remnawavePanelId: number | null;
  readonly status: string;
}

type Where = Record<string, unknown>;

/** Enough of Prisma's `where` language for the shapes these writers send. */
function matches(where: Where | undefined, row: Row): boolean {
  if (where === undefined) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (condition as Where[]).every((part) => matches(part, row));
    if (key === 'OR') return (condition as Where[]).some((part) => matches(part, row));
    const value = (row as unknown as Record<string, unknown>)[key];
    if (condition !== null && typeof condition === 'object') {
      const operators = condition as Record<string, unknown>;
      if ('not' in operators) return value !== operators['not'];
      if ('in' in operators) return (operators['in'] as unknown[]).includes(value);
      throw new Error(`the double does not know ${JSON.stringify(condition)}`);
    }
    return value === condition;
  });
}

interface RawCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function harness(rows: readonly Row[], options: { readonly failWrites?: boolean } = {}) {
  const raw: RawCall[] = [];
  const emitted: Array<{ type: string; metadata?: Record<string, unknown> }> = [];
  const prisma = {
    remnawaveWebhookEvent: { create: async () => ({}) },
    subscription: {
      updateMany: async () => ({ count: 0 }),
      findMany: async (args: { where?: Where; select?: Record<string, boolean> }) =>
        rows.filter((row) => matches(args.where, row)).map((row) => (args.select?.['id'] ? { id: row.id } : row)),
      findFirst: async () => null,
    },
    user: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
    },
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      if (options.failWrites === true) throw new Error('database unavailable');
      raw.push({ sql: query.sql, values: query.values });
      return [];
    },
  };
  const service = new RemnawaveWebhookService(
    prisma as never,
    { webhookSecret: null } as never,
    {
      emit: (event: { type: string; metadata?: Record<string, unknown> }) => emitted.push(event),
      info: () => undefined,
    } as never,
    { getPanelUserUsage: async () => null } as never,
    { build: async () => ({}) } as never,
    { create: async () => undefined } as never,
  );
  return { service, raw, emitted };
}

/** The evidence upsert (`recordConnectEvidence`) rather than the check (`recordCheck`). */
function isEvidenceWrite(call: RawCall): boolean {
  return /"connected_source"/.test(call.sql) && /LEAST\(/.test(call.sql);
}

function isCheckWrite(call: RawCall): boolean {
  return !/"connected_source"/.test(call.sql) && /WHERE "st"\."first_connected_at" IS NULL/.test(call.sql);
}

/** The subscription ids a write was aimed at — the `IN (…)` list, as bound. */
function targetedIds(call: RawCall, universe: readonly Row[]): string[] {
  return universe.map((row) => row.id).filter((id) => call.values.includes(id));
}

const STALE_2X_ROW: Row = {
  id: 'sub-2x',
  remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  remnawavePanelId: 17,
  status: 'ACTIVE',
};
const THREE_X_ROW: Row = { id: 'sub-3x', remnawaveId: '17', remnawavePanelId: 17, status: 'ACTIVE' };
const STRANGER: Row = { id: 'sub-other', remnawaveId: '18', remnawavePanelId: 18, status: 'ACTIVE' };
const DELETED_TWIN: Row = { id: 'sub-deleted', remnawaveId: '17', remnawavePanelId: null, status: 'DELETED' };
const ROWS = [STALE_2X_ROW, THREE_X_ROW, STRANGER, DELETED_TWIN];

function threeXEvent(event: string, userTraffic: Record<string, unknown> | undefined, timestamp?: string) {
  return {
    scope: 'user',
    event,
    timestamp: timestamp ?? new Date(Date.now() - 30_000).toISOString(),
    data: {
      id: 17,
      username: 'rz_anna_1',
      status: 'ACTIVE',
      ...(userTraffic === undefined ? {} : { userTraffic }),
    },
    meta: { notConnectedAfterHours: event === 'user.not_connected' ? 24 : null },
  };
}

const CONNECTED = {
  usedTrafficBytes: 0,
  lifetimeUsedTrafficBytes: 9_000_000,
  onlineAt: '2026-09-18T20:00:00.000Z',
  firstConnectedAt: '2026-09-18T19:00:00.000Z',
  lastConnectedNodeUuid: null,
};
const NEVER = {
  usedTrafficBytes: 0,
  lifetimeUsedTrafficBytes: 0,
  onlineAt: null,
  firstConnectedAt: null,
  lastConnectedNodeUuid: null,
};

describe('the webhook writes the connection signal', () => {
  it('a 3.x event (numeric id) lands on BOTH rows of a duplicate pair, and on nothing else', async () => {
    const { service, raw } = harness(ROWS);

    await service.handleEvent('user.modified', threeXEvent('user.modified', CONNECTED), null);

    const writes = raw.filter(isEvidenceWrite);
    assert.equal(writes.length, 1, 'exactly one evidence upsert');
    assert.deepStrictEqual(targetedIds(writes[0]!, ROWS), ['sub-2x', 'sub-3x']);
    // Dated by the panel's own first connection, source webhook, verified at
    // the event's time.
    assert.ok(writes[0]!.values.some((v) => v instanceof Date && v.toISOString() === '2026-09-18T19:00:00.000Z'));
    assert.ok(writes[0]!.values.includes('webhook'));
  });

  it('a present, empty block stamps the verification clock — never evidence', async () => {
    const { service, raw } = harness(ROWS);

    await service.handleEvent('user.modified', threeXEvent('user.modified', NEVER), null);

    assert.equal(raw.filter(isEvidenceWrite).length, 0);
    const checks = raw.filter(isCheckWrite);
    assert.equal(checks.length, 1);
    assert.deepStrictEqual(targetedIds(checks[0]!, ROWS), ['sub-2x', 'sub-3x']);
  });

  it('user.not_connected only confirms: a check on rows with no evidence, even when its block says more', async () => {
    const { service, raw } = harness(ROWS);

    // A contradictory block must not turn Remnawave's "still not connected"
    // into evidence — the event is a confirmation, never a source.
    await service.handleEvent('user.not_connected', threeXEvent('user.not_connected', CONNECTED), null);
    await service.handleEvent('user.not_connected', threeXEvent('user.not_connected', undefined), null);

    assert.equal(raw.filter(isEvidenceWrite).length, 0);
    assert.equal(raw.filter(isCheckWrite).length, 2);
    for (const call of raw) {
      assert.match(call.sql, /WHERE "st"\."first_connected_at" IS NULL/, 'the check skips rows with evidence');
    }
  });

  it('user.first_connected counts as connected even without a block — unverified, dated by the event', async () => {
    const { service, raw } = harness(ROWS);
    const timestamp = new Date(Date.now() - 45_000).toISOString();

    await service.handleEvent('user.first_connected', threeXEvent('user.first_connected', undefined, timestamp), null);

    const writes = raw.filter(isEvidenceWrite);
    assert.equal(writes.length, 1);
    const dates = writes[0]!.values.filter((v): v is Date => v instanceof Date).map((d) => d.toISOString());
    assert.ok(dates.includes(timestamp), 'dated by the event');
    // `checked_at` is bound as null: no block, so nothing was verified.
    assert.ok(writes[0]!.values.includes(null), 'no verification without a block');
  });

  it('an event without a block writes nothing at all — unknown is not "not connected"', async () => {
    const { service, raw } = harness(ROWS);

    await service.handleEvent('user.modified', threeXEvent('user.modified', undefined), null);
    await service.handleEvent('user.expired', threeXEvent('user.expired', undefined), null);

    assert.deepStrictEqual(raw, []);
  });

  it('a profile no local row names writes nothing and throws nothing', async () => {
    const { service, raw } = harness([STRANGER]);

    await service.handleEvent('user.modified', threeXEvent('user.modified', CONNECTED), null);

    assert.deepStrictEqual(raw, []);
  });

  it('dates the check by the envelope, and never in the future', async () => {
    const earlier = new Date(Date.now() - 10 * 60_000).toISOString();
    const { service, raw } = harness(ROWS);
    await service.handleEvent('user.modified', threeXEvent('user.modified', NEVER, earlier), null);
    const stamped = raw[0]!.values.filter((v): v is Date => v instanceof Date).map((d) => d.toISOString());
    assert.ok(stamped.includes(earlier), 'a re-delivered event keeps the time the panel looked');

    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const second = harness(ROWS);
    const before = Date.now();
    await second.service.handleEvent('user.modified', threeXEvent('user.modified', NEVER, future), null);
    const checkedAt = second.raw[0]!.values.find((v): v is Date => v instanceof Date);
    assert.ok(checkedAt !== undefined && checkedAt.getTime() <= Date.now() && checkedAt.getTime() >= before - 5);
  });

  it('a failed state write does not cost the operator the card', async () => {
    const { service, emitted } = harness(ROWS, { failWrites: true });

    await service.handleEvent('user.expired', threeXEvent('user.expired', NEVER), null);

    assert.equal(emitted.filter((event) => event.type === 'remnawave.user.expired').length, 1);
  });
});
