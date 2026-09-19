import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { ConnectAudienceModule } from '../src/modules/connect-audience/connect-audience.module';
import { HELPED_OUTCOMES } from '../src/modules/connect-audience/connect-audience.sql';
import {
  CONNECT_AUDIENCE_MAX_USERS,
  CONNECT_AUDIENCE_TOO_LARGE_MESSAGE,
  CONNECT_AUDIENCE_TRANSACTION_OPTIONS,
  ConnectAudienceService,
  ConnectAudienceTooLargeError,
  connectAudienceHealthView,
  connectAudienceUsable,
  connectAudienceWindowOf,
  isStatementTimeout,
} from '../src/modules/connect-audience/services/connect-audience.service';
import { HELP_OUTCOMES } from '../src/modules/connect-signal/connect-sql';
import { BroadcastModule } from '../src/modules/broadcast/broadcast.module';
import { BroadcastService } from '../src/modules/broadcast/services/broadcast.service';
import { ConnectSignalModule } from '../src/modules/connect-signal/connect-signal.module';
import {
  ConnectSignalHealthService,
  type ConnectSignalHealth,
} from '../src/modules/connect-signal/services/connect-signal-health.service';

/**
 * `ConnectAudienceService` without a database: what it asks PostgreSQL, in
 * what envelope, and what it makes of the answer. The answers themselves —
 * who is in which bucket — are `connect-audience-postgres.spec.ts`.
 */

const HEALTH: ConnectSignalHealth = {
  state: 'webhooks_only',
  checkedCoverage: 0.5,
  lastOkAt: '2026-09-18T10:00:00.000Z',
  lastUserWebhookAt: '2026-09-19T08:00:00.000Z',
  coverage: { total: 10, connected: 3, verified: 2, unverified: 5 },
  probe: {
    lastCycleAt: '2026-09-19T09:00:00.000Z',
    lastFailAt: '2026-09-19T09:00:00.000Z',
    lastReason: 'connect ECONNREFUSED 10.0.0.5:3000',
    failingSince: '2026-09-18T10:10:00.000Z',
    firstPassCompletedAt: '2026-09-17T00:00:00.000Z',
    backlog: 0,
    firstPassHours: 0,
  },
};

interface Recorded {
  readonly transactions: Array<{ readonly options: unknown; readonly statements: string[]; readonly values: unknown[][] }>;
  readonly healthCalls: number;
}

/**
 * A Prisma stand-in that records every statement in the transaction it ran in.
 * `rows` answers the audience statement; a statement outside a transaction is
 * a failure, not a silent success.
 */
function harness(rows: ReadonlyArray<Record<string, unknown>>): {
  readonly service: ConnectAudienceService;
  readonly recorded: Recorded;
} {
  const recorded = { transactions: [] as Recorded['transactions'], healthCalls: 0 };
  const client = (statements: string[], values: unknown[][]) => ({
    $executeRaw: async (sql: Prisma.Sql) => {
      statements.push(sql.sql);
      values.push(sql.values);
      return 0;
    },
    $queryRaw: async (sql: Prisma.Sql) => {
      statements.push(sql.sql);
      values.push(sql.values);
      return rows;
    },
  });
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, options: unknown) => {
      const entry = { options, statements: [] as string[], values: [] as unknown[][] };
      recorded.transactions.push(entry);
      return fn(client(entry.statements, entry.values));
    },
    $queryRaw: async () => {
      throw new Error('a statement ran outside the bounded transaction');
    },
    $executeRaw: async () => {
      throw new Error('a statement ran outside the bounded transaction');
    },
  };
  const health = {
    current: async () => {
      recorded.healthCalls += 1;
      return HEALTH;
    },
  };
  return {
    service: new ConnectAudienceService(prisma as never, health as never),
    get recorded() {
      return recorded;
    },
  };
}

function idRows(count: number, summary: { verified: number; unverified: number }) {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= count; i += 1) {
    rows.push({ userId: `user-${i}`, ord: i, verified: null, unverified: null });
  }
  rows.push({ userId: null, ord: null, verified: summary.verified, unverified: summary.unverified });
  return rows;
}

const NOW = new Date('2026-09-19T12:00:00.000Z');

describe('ConnectAudienceService', () => {
  it('runs the audience statement bounded: a transaction with 10 s/20 s, and SET LOCAL statement_timeout first', async () => {
    const { service, recorded } = harness(idRows(2, { verified: 2, unverified: 1 }));
    await service.userIds({ bucket: 'paid', withinDays: 7, now: NOW });
    assert.equal(recorded.transactions.length, 1);
    const [transaction] = recorded.transactions;
    assert.deepStrictEqual(transaction?.options, { maxWait: 10_000, timeout: 20_000 });
    assert.deepStrictEqual(CONNECT_AUDIENCE_TRANSACTION_OPTIONS, { maxWait: 10_000, timeout: 20_000 });
    assert.equal(transaction?.statements[0], "SET LOCAL statement_timeout = '10s'");
    assert.equal(transaction?.statements.length, 2, 'the timeout, then the one audience statement');
    assert.match(transaction?.statements[1] ?? '', /"wp4b_people"/);
  });

  it('asks for one more than the cap, hands out the ids in the order the statement gave them', async () => {
    const { service, recorded } = harness(idRows(3, { verified: 3, unverified: 0 }));
    assert.deepStrictEqual(await service.userIds({ bucket: 'trial', withinDays: 1, now: NOW }), [
      'user-1',
      'user-2',
      'user-3',
    ]);
    const values = recorded.transactions[0]?.values[1] ?? [];
    assert.ok(values.includes(CONNECT_AUDIENCE_MAX_USERS + 1), `LIMIT ${CONNECT_AUDIENCE_MAX_USERS + 1} is bound`);
  });

  it('refuses above 20 000 with the design’s sentence instead of handing out a slice', async () => {
    const { service } = harness(idRows(CONNECT_AUDIENCE_MAX_USERS + 1, { verified: 25_000, unverified: 7 }));
    await assert.rejects(
      service.userIds({ bucket: 'paid', withinDays: 30, now: NOW }),
      (error: unknown) =>
        error instanceof ConnectAudienceTooLargeError &&
        error.message === 'Слишком много получателей для фильтра «не подключился» — уменьшите срок' &&
        error.message === CONNECT_AUDIENCE_TOO_LARGE_MESSAGE &&
        error.verified === 25_000 &&
        error.limit === 20_000,
    );
  });

  it('hands out exactly 20 000 without refusing', async () => {
    const { service } = harness(idRows(CONNECT_AUDIENCE_MAX_USERS, { verified: 20_000, unverified: 0 }));
    assert.equal((await service.userIds({ bucket: 'paid', withinDays: 30, now: NOW })).length, 20_000);
  });

  it('resolve: over the cap the list is null and the counts stay exact; the health is handed through', async () => {
    const { service, recorded } = harness(idRows(CONNECT_AUDIENCE_MAX_USERS + 1, { verified: 21_000, unverified: 40 }));
    const resolution = await service.resolve({ bucket: 'paid', withinDays: 30, now: NOW });
    assert.equal(resolution.userIds, null);
    assert.deepStrictEqual([resolution.verified, resolution.unverified, resolution.limit], [21_000, 40, 20_000]);
    assert.equal(resolution.health, HEALTH);
    assert.equal(recorded.healthCalls, 1);
    assert.equal(recorded.transactions.length, 1, 'ONE pass gives the list, the counts and nothing else');
  });

  it('counts: no list is asked for (LIMIT 0), the health comes from ConnectSignalHealthService', async () => {
    const { service, recorded } = harness(idRows(0, { verified: 12, unverified: 30 }));
    const counts = await service.counts({ bucket: 'trial', withinDays: 7, now: NOW });
    assert.deepStrictEqual({ verified: counts.verified, unverified: counts.unverified }, { verified: 12, unverified: 30 });
    assert.equal(counts.health, HEALTH);
    const values = recorded.transactions[0]?.values[1] ?? [];
    assert.ok(values.includes(0), 'LIMIT 0 is bound');
    assert.ok(!values.includes(CONNECT_AUDIENCE_MAX_USERS + 1));
  });

  it('drops the helped unless told not to', async () => {
    // The HELPED predicate (`helpedSql`), negated — not "any decision".
    const helped = /AND NOT COALESCE\(\("c"\."help_outcome" IN \(/;
    const byDefault = harness(idRows(0, { verified: 0, unverified: 0 }));
    await byDefault.service.counts({ bucket: 'paid', withinDays: 7, now: NOW });
    assert.match(byDefault.recorded.transactions[0]?.statements[1] ?? '', helped);
    const explicit = harness(idRows(0, { verified: 0, unverified: 0 }));
    await explicit.service.counts({ bucket: 'paid', withinDays: 7, excludeHelped: true, now: NOW });
    assert.match(explicit.recorded.transactions[0]?.statements[1] ?? '', helped);
    const kept = harness(idRows(0, { verified: 0, unverified: 0 }));
    await kept.service.counts({ bucket: 'paid', withinDays: 7, excludeHelped: false, now: NOW });
    assert.doesNotMatch(kept.recorded.transactions[0]?.statements[1] ?? '', helped);
  });

  it('binds the clock and never reads SQL now()', async () => {
    const { service, recorded } = harness(idRows(0, { verified: 0, unverified: 0 }));
    await service.counts({ bucket: 'paid', withinDays: 7, now: NOW });
    const statement = recorded.transactions[0]?.statements[1] ?? '';
    assert.doesNotMatch(statement, /\bnow\(\)|current_timestamp|localtimestamp/i);
    const bound = (recorded.transactions[0]?.values[1] ?? []).filter((value) => value instanceof Date) as Date[];
    const times = bound.map((date) => date.toISOString());
    assert.ok(times.includes(new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()), 'from = now − 7 days');
    assert.ok(times.includes(NOW.toISOString()), 'to = now');
    assert.ok(times.includes(new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString()), 'the 24 h freshness');
  });

  it('refuses a window it cannot mean — a programming error, before any SQL', async () => {
    for (const withinDays of [0, 31, 1.5, Number.NaN]) {
      assert.throws(() => connectAudienceWindowOf({ bucket: 'paid', withinDays }, NOW), RangeError, String(withinDays));
    }
    assert.throws(
      () => connectAudienceWindowOf({ bucket: 'paid', window: { from: NOW, to: new Date(NOW.getTime() - 1) } }, NOW),
      RangeError,
    );
    assert.deepStrictEqual(connectAudienceWindowOf({ bucket: 'paid' }, NOW), {
      from: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000),
      to: NOW,
    });
    const hours = { from: new Date(NOW.getTime() - 72 * 3_600_000), to: new Date(NOW.getTime() - 24 * 3_600_000) };
    assert.deepStrictEqual(connectAudienceWindowOf({ bucket: 'trial', withinDays: 3, window: hours }, NOW), hours);
    const { service, recorded } = harness(idRows(0, { verified: 0, unverified: 0 }));
    await assert.rejects(service.counts({ bucket: 'all' as never, withinDays: 7, now: NOW }), RangeError);
    assert.equal(recorded.transactions.length, 0);
  });

  it('marks nothing and asks nothing for no recipients', async () => {
    const { service, recorded } = harness([]);
    assert.equal(await service.markHelpedByBroadcast('bc-1', { bucket: 'paid', withinDays: 7, now: NOW }, { userIds: [] }), 0);
    assert.equal(recorded.transactions.length, 0);
  });

  it('marks inside the caller’s transaction when given one, bounded, guarded, with the recipients bound as one array', async () => {
    const { service, recorded } = harness([]);
    const statements: string[] = [];
    const values: unknown[][] = [];
    const tx = {
      $executeRaw: async (sql: Prisma.Sql) => {
        statements.push(sql.sql);
        values.push(sql.values);
        return 0;
      },
      $queryRaw: async (sql: Prisma.Sql) => {
        statements.push(sql.sql);
        values.push(sql.values);
        return [{ subscriptionId: 's-1' }, { subscriptionId: 's-2' }];
      },
    };
    const marked = await service.markHelpedByBroadcast(
      'bc-9',
      { bucket: 'trial', withinDays: 3, now: NOW },
      { userIds: ['u-1', 'u-2'], client: tx as never },
    );
    assert.equal(marked, 2);
    assert.equal(recorded.transactions.length, 0, 'no second transaction of its own');
    assert.equal(statements[0], "SET LOCAL statement_timeout = '10s'");
    const update = statements[1] ?? '';
    // Guarded twice on NOT helped — the locking read and the write itself.
    assert.match(update, /WHERE "st"\."subscription_id" = "t"\."subscription_id"\s+AND NOT COALESCE\(\("st"\."help_outcome" IN \(/);
    assert.match(update, /AND NOT COALESCE\(\("c"\."help_outcome" IN \(/);
    assert.match(update, /"st"\."help_decided_at" IS NOT NULL AND "st"\."help_outcome" IS NULL/, 'a ladder in flight is helped');
    assert.match(update, /FOR UPDATE OF "c"/);
    assert.match(update, /"help_outcome" = 'broadcast'/);
    assert.match(update, /"help_attempts" = '\[\]'::jsonb/, 'a skipped row it takes over loses the ladder it did not run');
    assert.match(update, /\("u"\."notification_prefs" -> 'connect_help'\) IS DISTINCT FROM 'false'::jsonb/);
    assert.doesNotMatch(update, /\bnow\(\)/i);
    const bound = values[1] ?? [];
    assert.ok(bound.some((value) => Array.isArray(value) && value.join(',') === 'u-1,u-2'), 'recipients as one array');
    assert.ok(bound.includes('broadcast:bc-9'));
    assert.ok(bound.includes('trial'));
    assert.ok(bound.some((value) => value instanceof Date && value.getTime() === NOW.getTime()), 'help_decided_at = the bound now');
    for (const outcome of HELPED_OUTCOMES) assert.ok(bound.includes(outcome), `${outcome} is bound as helped`);
    assert.ok(!bound.includes('skipped_template_off') && !bound.includes('skipped_unverifiable'), 'a skip is not help');
  });

  it('HELPED is an allowlist: exactly the contract’s seven, and every other outcome — later ones included — is not helped', () => {
    assert.deepStrictEqual(
      [...HELPED_OUTCOMES].sort(),
      ['banner', 'bot', 'broadcast', 'email', 'merged', 'opted_out', 'push'],
    );
    // Every helped value is a real outcome; everything else the column may hold is not helped.
    for (const outcome of HELPED_OUTCOMES) assert.ok((HELP_OUTCOMES as readonly string[]).includes(outcome), outcome);
    const notHelped = HELP_OUTCOMES.filter((outcome) => !(HELPED_OUTCOMES as readonly string[]).includes(outcome));
    assert.ok(notHelped.includes('skipped_template_off') && notHelped.includes('skipped_unverifiable'), notHelped.join(', '));
  });

  it('acts on a list only while the signal can tell: live and starting, never webhooks_only or blind', () => {
    assert.deepStrictEqual(
      (['live', 'starting', 'webhooks_only', 'blind'] as const).map((state) => [state, connectAudienceUsable(state)]),
      [
        ['live', true],
        ['starting', true],
        ['webhooks_only', false],
        ['blind', false],
      ],
    );
  });

  it('never names somebody who switched the help off, in the audience statement too', async () => {
    const { service, recorded } = harness(idRows(0, { verified: 0, unverified: 0 }));
    await service.counts({ bucket: 'trial', withinDays: 7, now: NOW });
    const statement = recorded.transactions[0]?.statements[1] ?? '';
    assert.match(
      statement,
      /JOIN "users" "u" ON "u"\."id" = "b"\."user_id" AND "u"\."is_blocked" = false\s+AND \("u"\."notification_prefs" -> 'connect_help'\) IS DISTINCT FROM 'false'::jsonb/,
    );
  });

  it('stages in the caller’s transaction: the timeout, the marker, THEN who is still reachable — in the list’s own order', async () => {
    const { service, recorded } = harness([]);
    const statements: string[] = [];
    const values: unknown[][] = [];
    const tx = {
      $executeRaw: async (sql: Prisma.Sql) => {
        statements.push(sql.sql);
        values.push(sql.values);
        return 0;
      },
      $queryRaw: async (sql: Prisma.Sql) => {
        statements.push(sql.sql);
        values.push(sql.values);
        // The marker answers the subscriptions it marked; the narrowing, the people.
        return /UPDATE "subscription_connect_states"/.test(sql.sql)
          ? [{ subscriptionId: 's-3' }]
          : [{ userId: 'u-3' }, { userId: 'u-1' }];
      },
    };
    const staged = await service.stageBroadcast(
      'bc-7',
      { bucket: 'paid', withinDays: 7, now: NOW },
      { userIds: ['u-1', 'u-2', 'u-3'], client: tx as never },
    );
    assert.deepStrictEqual(staged, { recipients: ['u-1', 'u-3'], marked: 1 }, 'u-2 is gone; the order is the list’s');
    assert.equal(recorded.transactions.length, 0, 'no transaction of its own');
    assert.equal(statements[0], "SET LOCAL statement_timeout = '10s'");
    assert.match(statements[1] ?? '', /UPDATE "subscription_connect_states"/, 'the marker first');
    const narrowing = statements[2] ?? '';
    assert.match(narrowing, /SELECT DISTINCT "b"\."user_id" AS "userId"/, 'then the narrowing, as a statement of its own');
    assert.match(narrowing, /AND "c"\."help_source" = /, 'excludeHelped (the default): only this broadcast’s marker');
    assert.match(narrowing, /\("u"\."notification_prefs" -> 'connect_help'\) IS DISTINCT FROM 'false'::jsonb/);
    assert.doesNotMatch(narrowing, /\bnow\(\)/i);
    assert.ok((values[2] ?? []).includes('broadcast:bc-7'));
    assert.ok((values[2] ?? []).some((value) => Array.isArray(value) && value.join(',') === 'u-1,u-2,u-3'));
    assert.equal(statements.length, 3);
  });

  it('stages without the marker condition when the helped are kept, and asks nothing for nobody', async () => {
    const kept: string[] = [];
    const tx = {
      $executeRaw: async () => 0,
      $queryRaw: async (sql: Prisma.Sql) => {
        kept.push(sql.sql);
        return [];
      },
    };
    const staged = await harness([]).service.stageBroadcast(
      'bc-8',
      { bucket: 'trial', withinDays: 3, excludeHelped: false, now: NOW },
      { userIds: ['u-1'], client: tx as never },
    );
    assert.deepStrictEqual(staged, { recipients: [], marked: 0 });
    assert.doesNotMatch(kept[1] ?? '', /"help_source" = /, 'still verified is all it asks');

    const { service, recorded } = harness([]);
    assert.deepStrictEqual(
      await service.stageBroadcast('bc-9', { bucket: 'paid', withinDays: 7, now: NOW }, { userIds: [] }),
      { recipients: [], marked: 0 },
    );
    assert.equal(recorded.transactions.length, 0);
  });

  it('marks in a bounded transaction of its own when not given one', async () => {
    const { service, recorded } = harness([{ subscriptionId: 's-1' }]);
    assert.equal(
      await service.markHelpedByBroadcast('bc-2', { bucket: 'paid', withinDays: 7, now: NOW }, { userIds: ['u-1'] }),
      1,
    );
    assert.deepStrictEqual(recorded.transactions[0]?.options, CONNECT_AUDIENCE_TRANSACTION_OPTIONS);
    assert.equal(recorded.transactions[0]?.statements[0], "SET LOCAL statement_timeout = '10s'");
  });

  it('recognises PostgreSQL’s statement timeout the way Prisma 7’s pg adapter reports it', () => {
    const reported = Object.assign(new Error('Raw query failed. Code: `57014`. Message: `canceling statement due to statement timeout`'), {
      code: 'P2010',
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { originalCode: '57014', code: '57014', kind: 'postgres', message: 'canceling statement due to statement timeout' },
        },
      },
    });
    assert.equal(isStatementTimeout(reported), true);
    assert.equal(
      isStatementTimeout({ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '57014' } } } }),
      true,
      'by the cause alone',
    );
    assert.equal(isStatementTimeout(new Error('Transaction API error: Transaction already closed')), false);
    assert.equal(
      isStatementTimeout({ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } }),
      false,
      'a deadlock is not a timeout',
    );
    assert.equal(isStatementTimeout(null), false);
  });

  it('shows an operator codes, instants and numbers — never the probe’s free-text reason', () => {
    const view = connectAudienceHealthView(HEALTH);
    assert.deepStrictEqual(view, {
      state: 'webhooks_only',
      checkedCoverage: 0.5,
      lastOkAt: '2026-09-18T10:00:00.000Z',
      lastUserWebhookAt: '2026-09-19T08:00:00.000Z',
      failingSince: '2026-09-18T10:10:00.000Z',
      coverage: { total: 10, connected: 3, verified: 2, unverified: 5 },
      firstPassHours: 0,
    });
    assert.ok(!JSON.stringify(view).includes('ECONNREFUSED'));
  });
});

describe('wiring', () => {
  it('BroadcastModule reaches ConnectAudienceService, which reaches the signal’s health', () => {
    const imports = (Reflect.getMetadata('imports', BroadcastModule) ?? []) as unknown[];
    assert.ok(imports.includes(ConnectAudienceModule));
    assert.ok(((Reflect.getMetadata('exports', ConnectAudienceModule) ?? []) as unknown[]).includes(ConnectAudienceService));
    assert.ok(((Reflect.getMetadata('imports', ConnectAudienceModule) ?? []) as unknown[]).includes(ConnectSignalModule));
    assert.ok(((Reflect.getMetadata('exports', ConnectSignalModule) ?? []) as unknown[]).includes(ConnectSignalHealthService));
  });

  it('Nest builds BroadcastService with the real ConnectAudienceService, and refuses to build it without one', async () => {
    const built = await Test.createTestingModule({ providers: [BroadcastService, ConnectAudienceService] })
      .useMocker((token) => {
        if (token === PrismaService) return {};
        if (token === ConnectSignalHealthService) return { current: async () => HEALTH };
        return {};
      })
      .compile();
    const broadcastService = built.get(BroadcastService);
    const connect = (broadcastService as unknown as { connectAudience?: unknown }).connectAudience;
    assert.ok(connect instanceof ConnectAudienceService);
    await built.close();

    await assert.rejects(
      Test.createTestingModule({ providers: [BroadcastService] })
        .useMocker((token) => (token === ConnectAudienceService ? undefined : {}))
        .compile(),
    );
  });
});
