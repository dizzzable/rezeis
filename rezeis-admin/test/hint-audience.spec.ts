import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONNECT_AUDIENCE_MAX_USERS,
  ConnectAudienceTooLargeError,
} from '../src/modules/connect-audience/services/connect-audience.service';
import {
  HINT_AUDIENCES,
  HintAudienceService,
  LEGACY_HINT_AUDIENCE,
} from '../src/modules/user-hints/services/hint-audience.service';

/**
 * Hinting the people something did NOT happen to
 * ══════════════════════════════════════════════
 *
 * Every other hint follows an event. This one follows a non-event — the
 * customer paid a day ago and has still never connected — so it is a query,
 * run on a schedule, and the query is `ConnectAudienceService`'s: a person is
 * named only when a fresh read of their profile, made after the purchase or
 * the grant, found it never connected.
 *
 * The audience service is a recording stub here — what it MEANS is proved on
 * PostgreSQL (`connect-audience-postgres.spec.ts`, and the hint audiences end
 * to end in `user-hint-delivery-postgres.spec.ts`). This file checks what the
 * hint audiences ASK it: which bucket, which window, which switches, and what
 * they do with the answer.
 */

const NOW = new Date('2026-08-29T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

interface Asked {
  readonly bucket: string;
  readonly window: { readonly from: Date; readonly to: Date };
  readonly excludeHelped?: boolean;
  readonly now?: Date;
}

function build(options: {
  readonly state?: 'live' | 'starting' | 'webhooks_only' | 'blind';
  readonly paid?: readonly string[];
  readonly trial?: readonly string[];
  readonly throws?: unknown;
} = {}) {
  const asked: Asked[] = [];
  const healthAsked: Array<Date | undefined> = [];
  const connectAudience = {
    health: async (now?: Date) => {
      healthAsked.push(now);
      return { state: options.state ?? 'live' };
    },
    userIds: async (query: Asked) => {
      asked.push(query);
      if (options.throws !== undefined) throw options.throws;
      return [...(query.bucket === 'paid' ? (options.paid ?? []) : (options.trial ?? []))];
    },
  };
  return { service: new HintAudienceService(connectAudience as never), asked, healthAsked };
}

/** A statement PostgreSQL cancelled at `statement_timeout`, as Prisma 7's pg adapter reports it. */
function statementTimeout(): Error {
  return Object.assign(new Error('Raw query failed. Code: `57014`. canceling statement due to statement timeout'), {
    code: 'P2010',
    meta: { driverAdapterError: { cause: { originalCode: '57014', kind: 'postgres' } } },
  });
}

describe('the three audiences', () => {
  it('are the two buckets and the name every stored rule holds', () => {
    assert.deepStrictEqual([...HINT_AUDIENCES].sort(), [
      'paid-not-connected',
      'purchase-not-connected',
      'trial-not-connected',
    ]);
    assert.equal(LEGACY_HINT_AUDIENCE, 'paid-not-connected');
  });

  it('«Оплатил и не подключился» reads the paid bucket alone', async () => {
    const { service, asked } = build({ paid: ['p-1'], trial: ['t-1'] });

    const outcome = await service.resolve({ audience: 'purchase-not-connected', now: NOW });

    assert.deepStrictEqual(asked.map((query) => query.bucket), ['paid']);
    assert.deepStrictEqual(outcome, { kind: 'ok', userIds: ['p-1'], truncated: false });
  });

  it('«Пробный период или подарок» reads the trial bucket alone', async () => {
    const { service, asked } = build({ paid: ['p-1'], trial: ['t-1'] });

    const outcome = await service.resolve({ audience: 'trial-not-connected', now: NOW });

    assert.deepStrictEqual(asked.map((query) => query.bucket), ['trial']);
    assert.deepStrictEqual(outcome, { kind: 'ok', userIds: ['t-1'], truncated: false });
  });

  it('the legacy name still runs, as BOTH buckets, each person once', async () => {
    // A rule saved before the split holds `paid-not-connected`, and it always
    // included trials. It must keep running — and keep meaning everybody.
    const { service, asked } = build({ paid: ['a', 'both', 'c'], trial: ['both', 'd'] });

    const outcome = await service.resolve({ audience: 'paid-not-connected', now: NOW });

    assert.deepStrictEqual(asked.map((query) => query.bucket).sort(), ['paid', 'trial']);
    assert.equal(outcome.kind, 'ok');
    const ids = (outcome as { userIds: readonly string[] }).userIds;
    assert.deepStrictEqual([...ids].sort(), ['a', 'both', 'c', 'd']);
    assert.equal(new Set(ids).size, ids.length, 'somebody in both buckets was named twice');
  });

  it('takes the longest-waiting of EACH bucket first, so a capped legacy run is not all one bucket', async () => {
    const paid = Array.from({ length: 400 }, (_, index) => `p-${index}`);
    const trial = Array.from({ length: 400 }, (_, index) => `t-${index}`);
    const { service } = build({ paid, trial });

    const outcome = await service.resolve({ audience: 'paid-not-connected', now: NOW });

    assert.equal(outcome.kind, 'ok');
    const taken = (outcome as { userIds: readonly string[]; truncated: boolean }).userIds;
    assert.equal(taken.length, 500);
    assert.equal((outcome as { truncated: boolean }).truncated, true);
    assert.deepStrictEqual(taken.slice(0, 4), ['p-0', 't-0', 'p-1', 't-1']);
    assert.equal(taken.filter((id) => id.startsWith('t-')).length, 250);
  });
});

describe('what it asks the audience service', () => {
  it('asks for the rule’s own window: from now − beforeHours to now − afterHours', async () => {
    const { service, asked } = build();

    await service.resolve({ audience: 'paid-not-connected', afterHours: 24, beforeHours: 72, now: NOW });

    assert.equal(asked.length, 2);
    for (const query of asked) {
      assert.equal(query.window.from.getTime(), NOW.getTime() - 72 * HOUR, `${query.bucket}: from`);
      assert.equal(query.window.to.getTime(), NOW.getTime() - 24 * HOUR, `${query.bucket}: to`);
      assert.equal(query.now?.getTime(), NOW.getTime(), `${query.bucket}: the clock`);
    }
  });

  it('defaults the window to one to three days', async () => {
    const { service, asked } = build();

    await service.resolve({ audience: 'purchase-not-connected', now: NOW });

    assert.equal(asked[0]?.window.from.getTime(), NOW.getTime() - 72 * HOUR);
    assert.equal(asked[0]?.window.to.getTime(), NOW.getTime() - 24 * HOUR);
  });

  it('does not leave out the people the automatic help or a broadcast already reached', async () => {
    // The pop-up is its own channel and is shown after the message on purpose;
    // the hint's once-only rule and group are what keep it from repeating.
    const { service, asked } = build();

    await service.resolve({ audience: 'paid-not-connected', now: NOW });

    assert.deepStrictEqual(asked.map((query) => query.excludeHelped), [false, false]);
  });
});

describe('standing down when the signal cannot tell', () => {
  it('names nobody while the connect signal is blind, and does not even ask', async () => {
    const { service, asked } = build({ state: 'blind', paid: ['p-1'] });

    const outcome = await service.resolve({ audience: 'purchase-not-connected', now: NOW });

    assert.equal(outcome.kind, 'blind');
    assert.deepStrictEqual(asked, [], 'the audience was resolved on a blind signal');
    assert.match((outcome as { reason: string }).reason, /Remnawave/);
    assert.match((outcome as { reason: string }).reason, /webhook/);
  });

  it('stands down on webhooks alone too — a lost webhook would name somebody who connected — and says so', async () => {
    const { service, asked } = build({ state: 'webhooks_only', paid: ['p-1'] });

    const outcome = await service.resolve({ audience: 'paid-not-connected', now: NOW });

    assert.equal(outcome.kind, 'blind', 'hinted on webhooks alone');
    assert.deepStrictEqual(asked, [], 'the audience was resolved on webhooks alone');
    const reason = (outcome as { reason: string }).reason;
    assert.match(reason, /read nothing from Remnawave for 30 minutes/);
    assert.match(reason, /webhooks alone do not say it/);
    assert.doesNotMatch(reason, /no Remnawave user webhook arrived/, 'the blind sentence, where webhooks DO arrive');
  });

  it('proceeds while the probe reads Remnawave: live and starting', async () => {
    for (const state of ['live', 'starting'] as const) {
      const { service } = build({ state, paid: ['p-1'] });

      const outcome = await service.resolve({ audience: 'purchase-not-connected', now: NOW });

      assert.deepStrictEqual(outcome, { kind: 'ok', userIds: ['p-1'], truncated: false }, state);
    }
  });

  it('asks the signal at the run’s own clock', async () => {
    const { service, healthAsked } = build();

    await service.resolve({ audience: 'trial-not-connected', now: NOW });

    assert.deepStrictEqual(healthAsked, [NOW]);
  });

  it('refuses a backwards window from its arguments, asking nothing', async () => {
    // Silently matching nobody would look exactly like "nobody qualifies".
    const { service, asked, healthAsked } = build({ paid: ['p-1'] });

    const outcome = await service.resolve({
      audience: 'purchase-not-connected',
      afterHours: 72,
      beforeHours: 24,
      now: NOW,
    });

    assert.equal(outcome.kind, 'blind');
    assert.match((outcome as { reason: string }).reason, /window is empty/);
    assert.deepStrictEqual(asked, []);
    assert.deepStrictEqual(healthAsked, []);
  });

  it('refuses an audience nobody defined before asking anything', async () => {
    const { service, asked, healthAsked } = build();

    await assert.rejects(
      () => service.resolve({ audience: 'everybody' as never, now: NOW }),
      RangeError,
    );
    assert.deepStrictEqual(asked, []);
    assert.deepStrictEqual(healthAsked, []);
  });
});

describe('refusing rather than hinting', () => {
  it('refuses an audience too large for a pop-up, naming the ceiling', async () => {
    const { service } = build({ throws: new ConnectAudienceTooLargeError(CONNECT_AUDIENCE_MAX_USERS + 7) });

    const outcome = await service.resolve({ audience: 'purchase-not-connected', now: NOW });

    assert.equal(outcome.kind, 'refused');
    const refused = outcome as { cause: string; limit: number | null; reason: string };
    assert.equal(refused.cause, 'too_large');
    assert.equal(refused.limit, CONNECT_AUDIENCE_MAX_USERS);
    assert.match(refused.reason, /nobody was hinted/);
  });

  it('refuses a cohort the database stopped at its statement timeout', async () => {
    const { service } = build({ throws: statementTimeout() });

    const outcome = await service.resolve({ audience: 'trial-not-connected', now: NOW });

    assert.equal(outcome.kind, 'refused');
    assert.equal((outcome as { cause: string }).cause, 'timeout');
    assert.equal((outcome as { limit: number | null }).limit, null);
  });

  it('spares the second bucket once the first is refused', async () => {
    const { service, asked } = build({ throws: new ConnectAudienceTooLargeError(CONNECT_AUDIENCE_MAX_USERS + 1) });

    await service.resolve({ audience: 'paid-not-connected', now: NOW });

    assert.equal(asked.length, 1);
  });

  it('lets any other failure through, for the action to report as a failed run', async () => {
    const { service } = build({ throws: new Error('Timed out fetching a new connection from the connection pool') });

    await assert.rejects(
      () => service.resolve({ audience: 'purchase-not-connected', now: NOW }),
      /connection pool/,
    );
  });
});

describe('the ceiling on one run', () => {
  it('takes five hundred and says it was capped', async () => {
    const { service } = build({ paid: Array.from({ length: 501 }, (_, index) => `p-${index}`) });

    const outcome = await service.resolve({ audience: 'purchase-not-connected', now: NOW });

    assert.equal(outcome.kind, 'ok');
    const ok = outcome as { userIds: readonly string[]; truncated: boolean };
    assert.equal(ok.truncated, true);
    assert.equal(ok.userIds.length, 500);
    assert.equal(ok.userIds[0], 'p-0', 'the longest-waiting were not the ones taken');
  });

  it('does not claim a cap at exactly the ceiling', async () => {
    const { service } = build({ paid: Array.from({ length: 500 }, (_, index) => `p-${index}`) });

    const outcome = await service.resolve({ audience: 'purchase-not-connected', now: NOW });

    assert.equal((outcome as { truncated: boolean }).truncated, false);
  });
});
