import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { maskPublicName } from '../src/modules/contests/contest-public-name.util';
import { readContestProblems, readExtendedEnd } from '../src/modules/contests/services/contest.service';
import { buildContestFacts } from '../src/modules/notifications/utils/subscription-facts.util';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('moving the end of a live contest', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');
  const end = new Date('2026-10-30T12:00:30.000Z');

  it('keeps the end when the form sends it back as it was, seconds lost and all', () => {
    // The panel's date field holds minutes: 12:00:30 comes back as 12:00.
    assert.equal(readExtendedEnd(end, new Date('2026-10-30T12:00:00.000Z'), now), null);
    assert.equal(readExtendedEnd(end, end, now), null);
  });

  it('moves it later', () => {
    const later = new Date(end.getTime() + 2 * HOUR);
    assert.equal(readExtendedEnd(end, later, now)?.getTime(), later.getTime());
  });

  it('refuses to move it earlier — people entered on that date', () => {
    assert.throws(() => readExtendedEnd(end, new Date(end.getTime() - HOUR), now), /только перенести на более позднее/);
  });

  it('refuses a "later" end that has already passed', () => {
    const lapsed = new Date('2026-10-29T11:00:00.000Z');
    const past = new Date('2026-10-29T10:00:00.000Z');
    assert.throws(() => readExtendedEnd(past, lapsed, now), /уже прошло/);
  });
});

describe('a channel needs both halves', () => {
  const base = { startAt: new Date(0), endAt: new Date(HOUR), prizes: [] };

  it('says so when only one is there', () => {
    assert.match(readContestProblems({ ...base, channelChatId: '@news', channelJoinUrl: null }).join(' '), /Канал/);
  });

  it('is content with both, or neither', () => {
    assert.doesNotMatch(
      readContestProblems({ ...base, channelChatId: '@news', channelJoinUrl: 'https://t.me/news' }).join(' '),
      /Канал/,
    );
    assert.doesNotMatch(readContestProblems(base).join(' '), /Канал/);
  });
});

describe('a winner as everybody else sees them', () => {
  it('keeps the first letters and the last one', () => {
    assert.equal(maskPublicName('Иван Петров', null), 'Ив***в');
  });

  it('keeps one letter of a short name', () => {
    assert.equal(maskPublicName('Ян', null), 'Я***');
    assert.equal(maskPublicName(null, '@neo'), 'n***');
  });

  it('falls back to the username, then to nothing', () => {
    assert.equal(maskPublicName('  ', 'darkknight'), 'da***t');
    assert.equal(maskPublicName(null, null), null);
  });

  it('cuts between characters, not inside an emoji', () => {
    assert.equal(maskPublicName('🦊Лиса🦊', null), '🦊Л***🦊');
  });
});

describe('a contest notice in the reader language', () => {
  const MOSCOW = 'Europe/Moscow';

  it('takes the English title for an English reader, the Russian one otherwise', () => {
    const input = { title: { ru: 'Осенний розыгрыш', en: 'Autumn draw' }, prize: { ru: '7 дней', en: '7 days' }, endsAt: undefined };
    assert.equal(buildContestFacts(input, 'ru')['contest'], 'Осенний розыгрыш');
    assert.equal(buildContestFacts(input, 'en')['contest'], 'Autumn draw');
    assert.equal(buildContestFacts(input, 'en')['prize'], '7 days');
  });

  it('falls back to the Russian title when there is no English one, and to a word when there is none', () => {
    assert.equal(buildContestFacts({ title: { ru: 'Розыгрыш' }, prize: undefined, endsAt: undefined }, 'en')['contest'], 'Розыгрыш');
    assert.equal(buildContestFacts({ title: {}, prize: undefined, endsAt: undefined }, 'en')['contest'], 'Contest');
  });

  it('names the zone with the end, as a reset time is', () => {
    const facts = buildContestFacts(
      { title: { ru: 'X' }, prize: undefined, endsAt: '2026-11-05T17:00:00.000Z', timezone: MOSCOW },
      'ru',
    );
    assert.equal(facts['contestEndsDate'], '5 ноября');
    assert.equal(facts['contestEndsTime'], '20:00');
    assert.match(facts['contestEndsDateTime'] ?? '', /^5 ноября в 20:00 /);
  });

  it('gives nothing for a payload that is not a contest', () => {
    assert.deepEqual(buildContestFacts({ title: undefined, prize: undefined, endsAt: undefined }, 'ru'), {});
  });
});
