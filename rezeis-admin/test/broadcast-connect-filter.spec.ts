import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { BroadcastAudience, BroadcastMessageStatus, BroadcastStatus } from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { CreateBroadcastDraftDto, UpdateBroadcastDraftDto } from '../src/modules/broadcast/dto/broadcast-payload.dto';
import { BroadcastDeliveryService } from '../src/modules/broadcast/services/broadcast-delivery.service';
import { BroadcastService } from '../src/modules/broadcast/services/broadcast.service';
import {
  buildAudienceWhere,
  normalizeAudienceFilter,
  resolveAudienceWhere,
  type BroadcastConnectFilter,
} from '../src/modules/broadcast/utils/broadcast-audience.util';
import {
  CONNECT_AUDIENCE_TOO_LARGE_MESSAGE,
  ConnectAudienceTooLargeError,
} from '../src/modules/connect-audience/services/connect-audience.service';
import type { ConnectSignalHealth } from '../src/modules/connect-signal/services/connect-signal-health.service';

/**
 * «Подключение VPN» on a broadcast: `audienceFilter.connect = { bucket,
 * withinDays, excludeHelped }` — accepted at the door, kept by the normaliser,
 * resolved into user ids for BOTH the preview and staging, refused before the
 * claim when it cannot be resolved, and written back as the once-marker in the
 * same transaction as the recipient rows. Postgres behaviour is
 * `connect-audience-postgres.spec.ts`; this is everything around it.
 */

/** The last element — `Array.prototype.at` is not in this project's ES2021 lib. */
function last<T>(values: readonly T[]): T | undefined {
  return values[values.length - 1];
}

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

function meta(metatype: unknown): ArgumentMetadata {
  return { type: 'body', metatype: metatype as ArgumentMetadata['metatype'], data: undefined };
}

async function refuses(metatype: unknown, body: Record<string, unknown>): Promise<string> {
  try {
    await pipe.transform(body, meta(metatype));
  } catch (error) {
    assert.ok(error instanceof BadRequestException, `expected a 400, got ${String(error)}`);
    return JSON.stringify(error.getResponse());
  }
  assert.fail(`accepted ${JSON.stringify(body)}`);
}

const PAID: BroadcastConnectFilter = { bucket: 'paid', withinDays: 7, excludeHelped: true };

const HEALTH: ConnectSignalHealth = {
  state: 'starting',
  checkedCoverage: 0.25,
  lastOkAt: '2026-09-19T09:50:00.000Z',
  lastUserWebhookAt: null,
  coverage: { total: 40, connected: 6, verified: 4, unverified: 30 },
  probe: {
    lastCycleAt: '2026-09-19T09:50:00.000Z',
    lastFailAt: null,
    lastReason: 'secret detail that must not reach the SPA',
    failingSince: null,
    firstPassCompletedAt: null,
    backlog: 300,
    firstPassHours: 1,
  },
};

describe('the connect filter at the door (DTO, forbidNonWhitelisted)', () => {
  const body = (connect: unknown) => ({
    audience: 'ACTIVE_SUBSCRIBERS',
    audienceFilter: { subscription: ['ACTIVE', 'LIMITED'], connect },
  });

  it('accepts a bucket, 1–30 days and an optional excludeHelped', async () => {
    for (const connect of [
      { bucket: 'paid', withinDays: 7, excludeHelped: true },
      { bucket: 'trial', withinDays: 1 },
      { bucket: 'paid', withinDays: 30, excludeHelped: false },
    ]) {
      const dto = (await pipe.transform(body(connect), meta(CreateBroadcastDraftDto))) as CreateBroadcastDraftDto;
      assert.deepStrictEqual({ ...dto.audienceFilter?.connect }, connect);
    }
    const update = (await pipe.transform(
      { audienceFilter: { connect: { bucket: 'trial', withinDays: 14 } } },
      meta(UpdateBroadcastDraftDto),
    )) as UpdateBroadcastDraftDto;
    assert.deepStrictEqual({ ...update.audienceFilter?.connect }, { bucket: 'trial', withinDays: 14 });
  });

  it('answers 400 for anything else — out of bounds, the wrong kind, an unknown key', async () => {
    const cases: Array<[string, unknown]> = [
      ['0 days', { bucket: 'paid', withinDays: 0 }],
      ['31 days', { bucket: 'paid', withinDays: 31 }],
      ['half a day', { bucket: 'paid', withinDays: 7.5 }],
      ['days as a string', { bucket: 'paid', withinDays: '7' }],
      ['no days', { bucket: 'paid' }],
      ['both buckets at once', { bucket: 'all', withinDays: 7 }],
      ['no bucket', { withinDays: 7 }],
      ['excludeHelped as text', { bucket: 'paid', withinDays: 7, excludeHelped: 'yes' }],
      ['an unknown key inside', { bucket: 'paid', withinDays: 7, helpedWithin: 3 }],
      ['an array', [{ bucket: 'paid', withinDays: 7 }]],
      ['a bare string', 'paid'],
    ];
    for (const [label, connect] of cases) {
      const response = await refuses(CreateBroadcastDraftDto, body(connect));
      assert.ok(response.length > 0, label);
    }
    await refuses(UpdateBroadcastDraftDto, { audienceFilter: { connect: { bucket: 'paid', withinDays: 99 } } });
  });
});

describe('normalizeAudienceFilter learns connect', () => {
  it('keeps a readable one, filling excludeHelped and clamping the days — narrowing, never widening', () => {
    assert.deepStrictEqual(normalizeAudienceFilter({ connect: { bucket: 'paid', withinDays: 7 } }), {
      connect: { bucket: 'paid', withinDays: 7, excludeHelped: true },
    });
    assert.deepStrictEqual(
      normalizeAudienceFilter({ subscription: ['ACTIVE', 'LIMITED'], connect: { bucket: 'trial', withinDays: 30, excludeHelped: false } }),
      { subscription: ['ACTIVE', 'LIMITED'], connect: { bucket: 'trial', withinDays: 30, excludeHelped: false } },
    );
    assert.equal((normalizeAudienceFilter({ connect: { bucket: 'paid', withinDays: 45 } })?.connect as BroadcastConnectFilter).withinDays, 30);
    assert.equal((normalizeAudienceFilter({ connect: { bucket: 'paid', withinDays: 0.4 } })?.connect as BroadcastConnectFilter).withinDays, 1);
    assert.equal((normalizeAudienceFilter({ connect: { bucket: 'paid' } })?.connect as BroadcastConnectFilter).withinDays, 7);
  });

  it('a filter holding ONLY connect is a filter, not "nothing usable" (which would fall back to the preset)', () => {
    assert.notEqual(normalizeAudienceFilter({ connect: { bucket: 'paid', withinDays: 7 } }), null);
  });

  it('absent or null is no connect filter at all', () => {
    assert.equal(normalizeAudienceFilter({ connect: null }), null);
    assert.deepStrictEqual(normalizeAudienceFilter({ platforms: ['web'], connect: null }), { platforms: ['web'] });
  });

  it('anything it cannot read is kept as UNREADABLE, never dropped', () => {
    for (const connect of [
      { bucket: 'all', withinDays: 7 },
      { bucket: 'paid', withinDays: '7' },
      { bucket: 'paid', withinDays: 7, platform: 'tma' },
      'paid',
      [],
      42,
    ]) {
      assert.deepStrictEqual(normalizeAudienceFilter({ connect }), { connect: { unreadable: true } }, JSON.stringify(connect));
    }
  });
});

describe('the where: synchronous narrows connect to nobody, async resolves it', () => {
  it('buildAudienceWhere cannot resolve connect, so it matches nobody — never "the other chips"', () => {
    assert.deepStrictEqual(buildAudienceWhere(BroadcastAudience.ALL, { connect: PAID }), {
      isBlocked: false,
      AND: [{ id: { in: [] } }],
    });
    const withCompanion = buildAudienceWhere(BroadcastAudience.ACTIVE_SUBSCRIBERS, {
      subscription: ['ACTIVE', 'LIMITED'],
      connect: PAID,
    });
    assert.deepStrictEqual(last(withCompanion.AND as unknown[]), { id: { in: [] } });
  });

  it('resolveAudienceWhere adds the people as one more AND next to the other chips, asking once', async () => {
    const asked: BroadcastConnectFilter[] = [];
    const where = await resolveAudienceWhere(
      BroadcastAudience.ACTIVE_SUBSCRIBERS,
      { subscription: ['ACTIVE', 'LIMITED'], contact: ['hasTelegram'], connect: PAID },
      async (connect) => {
        asked.push(connect);
        return ['u-1', 'u-2'];
      },
      new Date('2026-09-19T12:00:00.000Z'),
    );
    assert.deepStrictEqual(asked, [PAID]);
    assert.deepStrictEqual(where, {
      isBlocked: false,
      AND: [
        { OR: [{ subscriptions: { some: { status: 'ACTIVE' } } }, { subscriptions: { some: { status: 'LIMITED' } } }] },
        { OR: [{ telegramId: { not: null } }] },
        { id: { in: ['u-1', 'u-2'] } },
      ],
    });
  });

  it('never asks without connect, and matches the synchronous builder exactly', async () => {
    const filter = { subscription: ['ACTIVE' as const], inactiveDays: 30 };
    const now = new Date('2026-09-19T12:00:00.000Z');
    const where = await resolveAudienceWhere(
      BroadcastAudience.ALL,
      filter,
      async () => assert.fail('asked for connect people without a connect filter'),
      now,
    );
    assert.deepStrictEqual(where, buildAudienceWhere(BroadcastAudience.ALL, filter, now));
    assert.deepStrictEqual(
      await resolveAudienceWhere(BroadcastAudience.TRIAL, null, async () => assert.fail('asked'), now),
      buildAudienceWhere(BroadcastAudience.TRIAL, null, now),
    );
  });

  it('an unreadable connect is nobody, and is not even asked about', async () => {
    const where = await resolveAudienceWhere(
      BroadcastAudience.ALL,
      { connect: { unreadable: true } },
      async () => assert.fail('asked'),
    );
    assert.deepStrictEqual(where, { isBlocked: false, AND: [{ id: { in: [] } }] });
  });
});

/** A `BroadcastService` over one stored broadcast, recording what it asks. */
function previewHarness(input: {
  readonly audienceFilter: unknown;
  readonly resolve?: () => Promise<unknown>;
  /** What `health()` answers — the signal as the preview first reads it. */
  readonly health?: ConnectSignalHealth;
}) {
  const counted: unknown[] = [];
  const asked: unknown[] = [];
  const connectAudience = {
    resolve: async (query: unknown) => {
      asked.push(query);
      if (input.resolve === undefined) throw new Error('resolve was not expected');
      return input.resolve();
    },
    userIds: async () => assert.fail('the preview resolves ONCE, through resolve()'),
    counts: async () => assert.fail('the preview resolves ONCE, through resolve()'),
    health: async () => input.health ?? HEALTH,
    markHelpedByBroadcast: async () => assert.fail('a preview never marks'),
    stageBroadcast: async () => assert.fail('a preview never stages'),
  };
  const service = new BroadcastService(
    {
      broadcast: {
        findUnique: async () => ({
          id: 'bc-1',
          audience: BroadcastAudience.ACTIVE_SUBSCRIBERS,
          audiencePlanId: null,
          audienceFilter: input.audienceFilter,
        }),
      },
      user: {
        count: async (args: unknown) => {
          counted.push(args);
          return 17;
        },
      },
    } as never,
    connectAudience as never,
  );
  return { service, counted, asked };
}

const CONNECT_FILTER = { subscription: ['ACTIVE', 'LIMITED'], connect: { bucket: 'paid', withinDays: 7, excludeHelped: true } };

describe('the audience preview with connect', () => {
  it('answers the recipients over the SAME list, plus verified / unverified / health', async () => {
    const { service, counted, asked } = previewHarness({
      audienceFilter: CONNECT_FILTER,
      resolve: async () => ({ userIds: ['u-1', 'u-2'], verified: 2, unverified: 5, health: HEALTH, limit: 20_000 }),
    });
    const preview = await service.previewAudience('bc-1');
    assert.equal(preview.totalRecipients, 17);
    assert.deepStrictEqual(preview.connect, {
      verified: 2,
      unverified: 5,
      health: {
        state: 'starting',
        checkedCoverage: 0.25,
        lastOkAt: '2026-09-19T09:50:00.000Z',
        lastUserWebhookAt: null,
        failingSince: null,
        coverage: { total: 40, connected: 6, verified: 4, unverified: 30 },
        firstPassHours: 1,
      },
      refusal: null,
      limit: 20_000,
    });
    assert.ok(!JSON.stringify(preview).includes('secret detail'), 'no free text from the probe');
    assert.equal(asked.length, 1);
    const query = asked[0] as { bucket: string; withinDays: number; excludeHelped: boolean; now: Date };
    assert.deepStrictEqual([query.bucket, query.withinDays, query.excludeHelped], ['paid', 7, true]);
    assert.ok(query.now instanceof Date);
    assert.deepStrictEqual(last((counted[0] as { where: { AND: unknown[] } }).where.AND), { id: { in: ['u-1', 'u-2'] } });
  });

  it('over 20 000: no count, the refusal, and the exact numbers', async () => {
    const { service, counted } = previewHarness({
      audienceFilter: CONNECT_FILTER,
      resolve: async () => ({ userIds: null, verified: 23_456, unverified: 9, health: HEALTH, limit: 20_000 }),
    });
    const preview = await service.previewAudience('bc-1');
    assert.equal(preview.totalRecipients, null);
    assert.equal(preview.connect?.refusal, 'too_many');
    assert.deepStrictEqual([preview.connect?.verified, preview.connect?.unverified, preview.connect?.limit], [23_456, 9, 20_000]);
    assert.equal(counted.length, 0, 'nothing is counted without a list');
  });

  it('a count cut at 10 s is an answer, not a 500 — and not a number', async () => {
    const { service, counted } = previewHarness({
      audienceFilter: CONNECT_FILTER,
      resolve: async () => {
        throw Object.assign(new Error('Raw query failed. Code: `57014`'), {
          code: 'P2010',
          meta: { driverAdapterError: { cause: { originalCode: '57014' } } },
        });
      },
    });
    const preview = await service.previewAudience('bc-1');
    assert.equal(preview.totalRecipients, null);
    assert.deepStrictEqual(
      [preview.connect?.refusal, preview.connect?.verified, preview.connect?.unverified, preview.connect?.health.state],
      ['timeout', null, null, 'starting'],
    );
    assert.equal(counted.length, 0);
  });

  it('any other failure is thrown, never dressed up as a refusal', async () => {
    const { service } = previewHarness({
      audienceFilter: CONNECT_FILTER,
      resolve: async () => {
        throw new Error('connection refused');
      },
    });
    await assert.rejects(service.previewAudience('bc-1'), /connection refused/);
  });

  it('an unreadable stored filter previews as nobody, and says why', async () => {
    const { service, counted, asked } = previewHarness({ audienceFilter: { connect: { bucket: 'all', withinDays: 7 } } });
    const preview = await service.previewAudience('bc-1');
    assert.equal(asked.length, 0);
    assert.equal(preview.connect?.refusal, 'unreadable');
    // `anonymizedAt: null` rides on every audience count: a full deletion keeps
    // the money history on a row that is nobody, and promising the operator one
    // more recipient than exists is the whole reason a preview is shown.
    assert.deepStrictEqual((counted[0] as { where: unknown }).where, {
      isBlocked: false,
      AND: [{ id: { in: [] } }],
      anonymizedAt: null,
    });
  });

  it('without connect the preview is what it was: no connect block, the audience untouched', async () => {
    const { service, asked } = previewHarness({ audienceFilter: { subscription: ['ACTIVE'] } });
    const preview = await service.previewAudience('bc-1');
    assert.equal(preview.totalRecipients, 17);
    assert.equal('connect' in preview, false);
    assert.equal(asked.length, 0);
  });

  for (const state of ['webhooks_only', 'blind'] as const) {
    it(`a signal that cannot tell (${state}) is a refusal, not a number — and the audience is not even asked`, async () => {
      const down: ConnectSignalHealth = {
        ...HEALTH,
        state,
        lastUserWebhookAt: state === 'webhooks_only' ? '2026-09-19T09:40:00.000Z' : null,
        probe: { ...HEALTH.probe, failingSince: '2026-09-19T09:00:00.000Z' },
      };
      const { service, counted, asked } = previewHarness({
        audienceFilter: CONNECT_FILTER,
        health: down,
        resolve: async () => assert.fail('resolved on a signal that cannot tell'),
      });
      const preview = await service.previewAudience('bc-1');
      assert.equal(preview.totalRecipients, null);
      assert.deepStrictEqual(
        [preview.connect?.refusal, preview.connect?.verified, preview.connect?.unverified],
        ['signal_down', null, null],
      );
      assert.equal(preview.connect?.health.state, state, 'the health says which, for the sentence under the refusal');
      assert.equal(preview.connect?.health.failingSince, '2026-09-19T09:00:00.000Z');
      assert.equal(asked.length, 0);
      assert.equal(counted.length, 0);
    });
  }

  it('a signal that went down between the two reads is a refusal too', async () => {
    const { service, counted } = previewHarness({
      audienceFilter: CONNECT_FILTER,
      resolve: async () => ({
        userIds: ['u-1'],
        verified: 1,
        unverified: 0,
        health: { ...HEALTH, state: 'webhooks_only' },
        limit: 20_000,
      }),
    });
    const preview = await service.previewAudience('bc-1');
    assert.equal(preview.totalRecipients, null);
    assert.equal(preview.connect?.refusal, 'signal_down');
    assert.equal(counted.length, 0);
  });
});

describe('checkConnectAudience — the verdict staging acts on', () => {
  function withUserIds(userIds: () => Promise<string[]>, health: ConnectSignalHealth = HEALTH): BroadcastService {
    return new BroadcastService({} as never, { userIds, health: async () => health } as never);
  }
  const now = new Date('2026-09-19T12:00:00.000Z');

  it('refuses while the signal cannot tell — webhooks_only and blind — before asking for anybody', async () => {
    for (const state of ['webhooks_only', 'blind'] as const) {
      const verdict = await withUserIds(async () => assert.fail('asked on a signal that cannot tell'), {
        ...HEALTH,
        state,
      }).checkConnectAudience(PAID, now);
      assert.equal(verdict.ok, false, state);
      if (verdict.ok) return;
      assert.equal(verdict.refusal, 'signal_down');
      assert.deepStrictEqual(verdict.metadata, { state });
      assert.match(verdict.reason, /не может отличить подключившихся от неподключившихся/);
      assert.match(verdict.reason, /Отправьте рассылку снова, когда проверка заработает/);
    }
    const webhooksOnly = await withUserIds(async () => [], { ...HEALTH, state: 'webhooks_only' }).checkConnectAudience(PAID, now);
    assert.ok(!webhooksOnly.ok && /вебхук не пришёл/.test(webhooksOnly.reason), 'says why webhooks alone are not enough');
    const blind = await withUserIds(async () => [], { ...HEALTH, state: 'blind' }).checkConnectAudience(PAID, now);
    assert.ok(!blind.ok && /ни одного вебхука/.test(blind.reason));
    for (const state of ['live', 'starting'] as const) {
      const verdict = await withUserIds(async () => ['u-1'], { ...HEALTH, state }).checkConnectAudience(PAID, now);
      assert.deepStrictEqual(verdict, { ok: true, userIds: ['u-1'] }, state);
    }
  });

  it('hands the people through', async () => {
    assert.deepStrictEqual(await withUserIds(async () => ['u-1']).checkConnectAudience(PAID, now), {
      ok: true,
      userIds: ['u-1'],
    });
  });

  it('refuses over the cap with the design’s sentence and the numbers', async () => {
    const verdict = await withUserIds(async () => {
      throw new ConnectAudienceTooLargeError(20_001);
    }).checkConnectAudience(PAID, now);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.refusal, 'too_many');
    assert.ok(verdict.reason.startsWith(CONNECT_AUDIENCE_TOO_LARGE_MESSAGE));
    assert.deepStrictEqual(verdict.metadata, { verified: 20_001, limit: 20_000 });
  });

  it('refuses a timeout, an unreadable filter and any other failure — each with its own reason', async () => {
    const timeout = await withUserIds(async () => {
      throw { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '57014' } } } };
    }).checkConnectAudience(PAID, now);
    assert.equal(!timeout.ok && timeout.refusal, 'timeout');
    const unreadable = await withUserIds(async () => assert.fail('asked')).checkConnectAudience({ unreadable: true }, now);
    assert.equal(!unreadable.ok && unreadable.refusal, 'unreadable');
    const failed = await withUserIds(async () => {
      throw new Error('boom');
    }).checkConnectAudience(PAID, now);
    assert.equal(!failed.ok && failed.refusal, 'failed');
    assert.ok(!failed.ok && failed.reason.includes('boom'));
  });
});

interface StagingRecord {
  readonly updateMany: unknown[];
  readonly updates: unknown[];
  readonly findManyUsers: unknown[];
  readonly createMany: Array<{ readonly via: 'root' | 'tx'; readonly args: unknown }>;
  readonly transactions: unknown[];
  readonly marks: Array<Record<string, unknown>>;
  readonly checks: Array<{ readonly connect: unknown; readonly now: Date }>;
  readonly events: Array<{ readonly severity: string; readonly type: string; readonly message: string; readonly metadata: unknown }>;
}

/** Staging over one stored broadcast; `verdict` is what `checkConnectAudience` answers. */
function stagingHarness(input: {
  readonly audienceFilter: unknown;
  readonly verdict?: unknown;
  readonly recipients?: readonly string[];
  /** Who `stageConnectRecipients` finds still reachable; default: every recipient it is handed. */
  readonly reachable?: readonly string[];
}): { readonly service: BroadcastDeliveryService; readonly record: StagingRecord } {
  const record: StagingRecord = {
    updateMany: [],
    updates: [],
    findManyUsers: [],
    createMany: [],
    transactions: [],
    marks: [],
    checks: [],
    events: [],
  };
  const tx = {
    broadcastMessage: {
      createMany: async (args: unknown) => {
        record.createMany.push({ via: 'tx', args });
      },
    },
  };
  const prisma = {
    broadcast: {
      findUnique: async () => ({
        id: 'bc-1',
        status: BroadcastStatus.DRAFT,
        audience: BroadcastAudience.ACTIVE_SUBSCRIBERS,
        audienceFilter: input.audienceFilter,
        payload: { text: 'Не получилось подключиться?' },
        promoCode: null,
      }),
      updateMany: async (args: unknown) => {
        record.updateMany.push(args);
        return { count: 1 };
      },
      update: async (args: unknown) => {
        record.updates.push(args);
      },
    },
    user: {
      findMany: async (args: unknown) => {
        record.findManyUsers.push(args);
        return (input.recipients ?? []).map((id) => ({ id }));
      },
    },
    broadcastMessage: {
      createMany: async (args: unknown) => {
        record.createMany.push({ via: 'root', args });
      },
      // The rows staging wrote, whichever client wrote them.
      findMany: async () =>
        record.createMany.flatMap((entry) =>
          (entry.args as { data: Array<{ userId: string }> }).data.map((row) => ({ id: `msg-${row.userId}` })),
        ),
    },
    $transaction: async (fn: (client: unknown) => Promise<unknown>, options: unknown) => {
      record.transactions.push(options);
      return fn(tx);
    },
  };
  const broadcastService = {
    checkPromoCodeDispatchable: async () => ({ ok: true }),
    checkConnectAudience: async (connect: unknown, now: Date) => {
      record.checks.push({ connect, now });
      if (input.verdict === undefined) throw new Error('checkConnectAudience was not expected');
      return input.verdict;
    },
    stageConnectRecipients: async (args: Record<string, unknown>) => {
      record.marks.push(args);
      const handed = args['userIds'] as readonly string[];
      return input.reachable === undefined ? handed : handed.filter((id) => input.reachable!.includes(id));
    },
  };
  const events = (severity: string) => (type: string, _source: string, message: string, metadata: unknown) => {
    record.events.push({ severity, type, message, metadata });
  };
  const service = new BroadcastDeliveryService(
    prisma as never,
    { get: () => undefined } as never,
    { info: events('info'), warn: events('warn'), error: events('error') } as never,
    {} as never,
    {} as never,
    { isEnabled: false } as never,
    { isEnabled: false } as never,
    broadcastService as never,
  );
  return { service, record };
}

const CLAIMED = (record: StagingRecord) =>
  record.updateMany.some((args) => JSON.stringify(args).includes(BroadcastStatus.PROCESSING));

describe('staging a broadcast with connect', () => {
  for (const [refusal, reason] of [
    ['too_many', `${CONNECT_AUDIENCE_TOO_LARGE_MESSAGE}. Подходит 20001, предел — 20000.`],
    ['timeout', 'Получателей фильтра «не подключился» не удалось посчитать за 10 секунд.'],
    ['unreadable', 'Фильтр «Подключение VPN» сохранён в виде, который эта версия панели не читает.'],
    ['signal_down', 'Фильтр «Подключение VPN» сейчас не может отличить подключившихся от неподключившихся.'],
  ] as const) {
    it(`refuses BEFORE the claim (${refusal}): back to DRAFT, one error card, nothing staged`, async () => {
      const { service, record } = stagingHarness({
        audienceFilter: CONNECT_FILTER,
        verdict: { ok: false, refusal, reason, metadata: { verified: 20_001 } },
      });
      assert.deepStrictEqual(await service.stageRecipients('bc-1'), []);
      assert.equal(CLAIMED(record), false, 'never claimed: no channel post, no FAILED');
      assert.deepStrictEqual(record.updateMany, [
        {
          where: { id: 'bc-1', status: { in: [BroadcastStatus.DRAFT, BroadcastStatus.SCHEDULED] } },
          data: { status: BroadcastStatus.DRAFT, scheduledAt: null, queueJobId: null },
        },
      ]);
      assert.equal(record.events.length, 1);
      const [event] = record.events;
      assert.equal(event?.severity, 'error');
      assert.equal(event?.type, EVENT_TYPES.BROADCAST_STARTED);
      assert.equal(event?.message, `Рассылка не отправлена. ${reason}`);
      assert.deepStrictEqual(event?.metadata, { broadcastId: 'bc-1', reason: `connect_${refusal}`, verified: 20_001 });
      assert.equal(record.findManyUsers.length, 0);
      assert.equal(record.createMany.length, 0);
      assert.equal(record.marks.length, 0);
    });
  }

  it('stages the resolved people and marks the RECIPIENTS in the same transaction as their rows', async () => {
    const { service, record } = stagingHarness({
      audienceFilter: { ...CONNECT_FILTER, platforms: ['miniapp'] },
      verdict: { ok: true, userIds: ['u-1', 'u-2', 'u-3'] },
      recipients: ['u-1', 'u-3'],
    });
    assert.deepStrictEqual(await service.stageRecipients('bc-1'), ['msg-u-1', 'msg-u-3']);
    assert.equal(CLAIMED(record), true);

    assert.equal(record.checks.length, 1);
    assert.deepStrictEqual(record.checks[0]?.connect, PAID);
    const where = (record.findManyUsers[0] as { where: { AND: unknown[] } }).where;
    assert.deepStrictEqual(last(where.AND), { id: { in: ['u-1', 'u-2', 'u-3'] } }, 'the list checked is the list staged');
    assert.ok(JSON.stringify(where).includes('"lastSurface":"tma"'), 'the other chips still apply');

    assert.equal(record.transactions.length, 1);
    assert.deepStrictEqual(record.createMany, [
      {
        via: 'tx',
        args: {
          data: [
            { broadcastId: 'bc-1', userId: 'u-1', status: BroadcastMessageStatus.PENDING },
            { broadcastId: 'bc-1', userId: 'u-3', status: BroadcastMessageStatus.PENDING },
          ],
        },
      },
    ]);
    assert.equal(record.marks.length, 1);
    const mark = record.marks[0]!;
    assert.equal(mark['broadcastId'], 'bc-1');
    assert.deepStrictEqual(mark['connect'], PAID);
    assert.deepStrictEqual(mark['userIds'], ['u-1', 'u-3'], 'recipients only — u-2 got nothing and stays open to the automatic help');
    assert.equal(mark['now'], record.checks[0]?.now, 'one clock for the check and the marker');
    assert.ok(mark['client'] !== undefined && mark['client'] !== null, 'written through the transaction client');

    assert.ok(record.events.every((event) => event.type !== 'subscription.not_connected'), 'staging emits no «не подключился»');
    assert.ok(record.events.every((event) => event.severity !== 'error'));
    assert.ok(
      record.updates.some((args) => JSON.stringify(args) === JSON.stringify({ where: { id: 'bc-1' }, data: { totalCount: 2 } })),
      JSON.stringify(record.updates),
    );
  });

  it('writes rows for the list NARROWED in the transaction — and the total follows it, not the resolved list', async () => {
    // u-2 was reached by the automatic help, or connected, between the
    // resolution and staging: `stageConnectRecipients` no longer names them.
    const { service, record } = stagingHarness({
      audienceFilter: CONNECT_FILTER,
      verdict: { ok: true, userIds: ['u-1', 'u-2', 'u-3'] },
      recipients: ['u-1', 'u-2', 'u-3'],
      reachable: ['u-3', 'u-1'],
    });
    assert.deepStrictEqual(await service.stageRecipients('bc-1'), ['msg-u-1', 'msg-u-3']);
    assert.deepStrictEqual(record.marks[0]?.['userIds'], ['u-1', 'u-2', 'u-3'], 'narrowed from the whole resolved list');
    assert.deepStrictEqual(record.createMany, [
      {
        via: 'tx',
        args: {
          data: [
            { broadcastId: 'bc-1', userId: 'u-1', status: BroadcastMessageStatus.PENDING },
            { broadcastId: 'bc-1', userId: 'u-3', status: BroadcastMessageStatus.PENDING },
          ],
        },
      },
    ]);
    assert.ok(
      record.updates.some((args) => JSON.stringify(args) === JSON.stringify({ where: { id: 'bc-1' }, data: { totalCount: 2 } })),
      `the total is the narrowed list: ${JSON.stringify(record.updates)}`,
    );
  });

  it('everybody narrowed away: completed with nobody, and not one row written', async () => {
    const { service, record } = stagingHarness({
      audienceFilter: CONNECT_FILTER,
      verdict: { ok: true, userIds: ['u-1'] },
      recipients: ['u-1'],
      reachable: [],
    });
    assert.deepStrictEqual(await service.stageRecipients('bc-1'), []);
    assert.equal(record.transactions.length, 1, 'narrowed inside the staging transaction');
    assert.deepStrictEqual(record.createMany, []);
    const completed = record.updates.find((args) => JSON.stringify(args).includes(BroadcastStatus.COMPLETED)) as
      | { data: { status: string; totalCount: number } }
      | undefined;
    assert.equal(completed?.data.totalCount, 0);
  });

  it('zero people after the other chips: completed with nobody, nothing marked', async () => {
    const { service, record } = stagingHarness({
      audienceFilter: CONNECT_FILTER,
      verdict: { ok: true, userIds: [] },
      recipients: [],
    });
    assert.deepStrictEqual(await service.stageRecipients('bc-1'), []);
    assert.deepStrictEqual(last((record.findManyUsers[0] as { where: { AND: unknown[] } }).where.AND), { id: { in: [] } });
    assert.equal(record.marks.length, 0);
    assert.equal(record.transactions.length, 0);
    assert.ok(JSON.stringify(record.updates).includes(BroadcastStatus.COMPLETED));
  });

  it('without connect staging is what it was: not checked, no transaction, no marker', async () => {
    const { service, record } = stagingHarness({ audienceFilter: { subscription: ['ACTIVE'] }, recipients: ['u-9'] });
    assert.deepStrictEqual(await service.stageRecipients('bc-1'), ['msg-u-9']);
    assert.equal(record.checks.length, 0);
    assert.equal(record.transactions.length, 0);
    assert.equal(record.marks.length, 0);
    assert.deepStrictEqual(record.createMany.map((entry) => entry.via), ['root']);
  });

  it('keeps the design’s refusal sentence word for word', () => {
    assert.equal(CONNECT_AUDIENCE_TOO_LARGE_MESSAGE, 'Слишком много получателей для фильтра «не подключился» — уменьшите срок');
  });
});
