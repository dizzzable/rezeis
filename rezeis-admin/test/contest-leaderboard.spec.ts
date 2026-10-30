import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ContestKind, ContestMetric, WheelSectorKind } from '@prisma/client';

import { addCalendarMonth, safeZone } from '../src/modules/contests/contest-calendar.util';
import {
  countPlaces,
  expandPlaces,
  readContestProblems,
  readGapToPrize,
} from '../src/modules/contests/services/contest.service';
import { compareStandings, type Standing } from '../src/modules/contests/services/contest-standings.service';
import { contestMetricPhrase, formatContestScore } from '../src/modules/notifications/utils/contest-score.util';
import { buildContestFacts } from '../src/modules/notifications/utils/subscription-facts.util';

describe('a month later, on the project clock', () => {
  it('keeps the wall-clock hour in Moscow: 1 November 00:00 → 1 December 00:00', () => {
    // 1 Nov 00:00 MSK is 31 Oct 21:00 UTC — the last day of October in UTC,
    // which must not turn the next end into "the last day of November".
    const next = addCalendarMonth(new Date('2026-10-31T21:00:00.000Z'), 'Europe/Moscow');
    assert.equal(next.toISOString(), '2026-11-30T21:00:00.000Z');
  });

  it('keeps the last day of a month the last day, without drifting to the 30th', () => {
    const zone = 'Europe/Moscow';
    const october = new Date('2026-10-31T20:59:00.000Z'); // 31 Oct 23:59 MSK
    const november = addCalendarMonth(october, zone);
    assert.equal(november.toISOString(), '2026-11-30T20:59:00.000Z');
    const december = addCalendarMonth(november, zone);
    assert.equal(december.toISOString(), '2026-12-31T20:59:00.000Z');
    const february = addCalendarMonth(addCalendarMonth(december, zone), zone);
    assert.equal(february.toISOString(), '2027-02-28T20:59:00.000Z');
  });

  it('clamps a day the next month does not have', () => {
    const next = addCalendarMonth(new Date('2027-01-30T09:00:00.000Z'), 'UTC');
    assert.equal(next.toISOString(), '2027-02-28T09:00:00.000Z');
  });

  it('keeps the local hour across a change of daylight saving', () => {
    // 1 March 00:00 in Berlin is CET (UTC+1); 1 April 00:00 is CEST (UTC+2).
    const next = addCalendarMonth(new Date('2027-02-28T23:00:00.000Z'), 'Europe/Berlin');
    assert.equal(next.toISOString(), '2027-03-31T22:00:00.000Z');
  });

  it('falls back to UTC for a zone nobody knows', () => {
    assert.equal(safeZone('Mars/Olympus'), 'UTC');
    assert.equal(safeZone(null), 'UTC');
    assert.equal(safeZone(' Europe/Moscow '), 'Europe/Moscow');
  });
});

const prize = (place: number, placeTo: number | null = null) => ({
  place,
  placeTo,
  kind: WheelSectorKind.POINTS,
  amount: 100,
  keyPoolId: null,
  promoRewardType: null,
  promoPlanId: null,
  promoLifetime: null,
  manualInstructions: null,
});

describe('prize places', () => {
  it('counts a range out place by place, first place first', () => {
    const places = expandPlaces([prize(4, 10), prize(1), prize(2, 3)]);
    assert.equal(places.length, 10);
    assert.deepEqual(
      places.map((row) => row.place),
      [1, 2, 2, 4, 4, 4, 4, 4, 4, 4],
    );
    assert.equal(countPlaces([prize(1), prize(2, 3), prize(4, 10)]), 10);
  });

  it('accepts ranges that cover the places from the first with no gap', () => {
    const problems = readContestProblems({
      startAt: new Date('2026-11-01T00:00:00Z'),
      endAt: new Date('2026-12-01T00:00:00Z'),
      prizes: [prize(1), prize(2, 3), prize(4, 10)],
    });
    assert.deepEqual(problems, []);
  });

  it('refuses a gap or an overlap between ranges', () => {
    const window = { startAt: new Date('2026-11-01T00:00:00Z'), endAt: new Date('2026-12-01T00:00:00Z') };
    assert.ok(readContestProblems({ ...window, prizes: [prize(1), prize(3, 5)] }).includes('Места должны идти подряд, начиная с первого'));
    assert.ok(readContestProblems({ ...window, prizes: [prize(1, 3), prize(3, 5)] }).includes('Места должны идти подряд, начиная с первого'));
  });

  it('refuses more than a hundred places', () => {
    const problems = readContestProblems({
      startAt: new Date('2026-11-01T00:00:00Z'),
      endAt: new Date('2026-12-01T00:00:00Z'),
      prizes: [prize(1), prize(2, 101)],
    });
    assert.ok(problems.includes('Призовых мест больше 100'));
  });

  it('wants a leaderboard to say what it ranks by', () => {
    const problems = readContestProblems({
      startAt: new Date('2026-11-01T00:00:00Z'),
      endAt: new Date('2026-12-01T00:00:00Z'),
      kind: ContestKind.LEADERBOARD,
      metric: null,
      prizes: [prize(1)],
    });
    assert.ok(problems.includes('Рейтинг: выберите, по чему считать места'));
    assert.deepEqual(
      readContestProblems({
        startAt: new Date('2026-11-01T00:00:00Z'),
        endAt: new Date('2026-12-01T00:00:00Z'),
        kind: ContestKind.LEADERBOARD,
        metric: ContestMetric.TRAFFIC,
        prizes: [prize(1)],
      }),
      [],
    );
  });
});

const standing = (userId: string, score: number, at: string): Standing => ({
  userId,
  score: BigInt(score),
  reachedAt: new Date(at),
});

describe('the order of a leaderboard', () => {
  it('puts the higher score first, then whoever got there first, then the id', () => {
    const rows = [
      standing('c', 5, '2026-11-02T00:00:00Z'),
      standing('b', 7, '2026-11-03T00:00:00Z'),
      standing('a', 5, '2026-11-02T00:00:00Z'),
      standing('d', 5, '2026-11-01T00:00:00Z'),
    ];
    assert.deepEqual(
      [...rows].sort(compareStandings).map((row) => row.userId),
      ['b', 'd', 'a', 'c'],
    );
  });
});

describe('how far from a prize', () => {
  const board = [{ score: 50n }, { score: 30n }, { score: 30n }, { score: 10n }];

  it('is nothing for somebody holding a prize place', () => {
    assert.equal(readGapToPrize(board, 1, 3, null), 0);
  });

  it('is one more than the last prize place holds — a tie goes to whoever was first', () => {
    // Three places: the third is held with 30; the fourth has 10.
    assert.equal(readGapToPrize(board, 3, 3, null), 21);
  });

  it('is the threshold for somebody not on the board, when places are left over', () => {
    assert.equal(readGapToPrize(board.slice(0, 1), -1, 3, 20n), 20);
    assert.equal(readGapToPrize([], -1, 3, null), 1);
  });

  it('is the threshold for somebody in a prize position who has not reached it', () => {
    assert.equal(readGapToPrize([{ score: 5n }], 0, 3, 20n), 15);
  });

  it('is nothing to ask about when no place is on offer', () => {
    assert.equal(readGapToPrize(board, 3, 0, null), null);
  });
});

describe('a leaderboard score in words', () => {
  it('counts friends and points with Russian plurals', () => {
    assert.equal(formatContestScore('REFERRALS_PAID', '1', 'ru', 'RUB'), '1 друг');
    assert.equal(formatContestScore('REFERRALS_PAID', '3', 'ru', 'RUB'), '3 друга');
    assert.equal(formatContestScore('REFERRALS_PAID', '11', 'ru', 'RUB'), '11 друзей');
    assert.equal(formatContestScore('POINTS_EARNED', '21', 'ru', 'RUB'), '21 балл');
    assert.equal(formatContestScore('POINTS_EARNED', '350', 'en', 'RUB'), '350 points');
  });

  it('says traffic in gigabytes and payments in the base currency', () => {
    assert.equal(formatContestScore('TRAFFIC', String(Math.round(12.4 * 1024 ** 3)), 'ru', 'RUB'), '12,4 ГБ');
    assert.equal(formatContestScore('TRAFFIC', String(250 * 1024 ** 3), 'en', 'RUB'), '250 GB');
    const roubles = formatContestScore('PAYMENTS_SUM', '125000', 'ru', 'RUB') ?? '';
    assert.match(roubles.replace(/\s/g, ' '), /^1 250 ₽$/);
  });

  it('says nothing for what it cannot read', () => {
    assert.equal(formatContestScore('TRAFFIC', 'many', 'ru', 'RUB'), null);
    assert.equal(formatContestScore('SOMETHING', '5', 'ru', 'RUB'), null);
    assert.equal(contestMetricPhrase('SOMETHING', 'ru'), null);
  });

  it('reaches the templates as facts', () => {
    const facts = buildContestFacts(
      { title: { ru: 'Топ трафика' }, prize: undefined, endsAt: undefined, metric: 'TRAFFIC', score: String(3 * 1024 ** 3), total: 1234 },
      'ru',
    );
    assert.equal(facts['contestMetric'], 'потраченному трафику');
    assert.equal(facts['contestScore'], '3 ГБ');
    assert.equal(facts['contestTotal']?.replace(/\s/g, ' '), '1 234');
  });
});
