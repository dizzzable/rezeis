import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSubscriptionFacts } from '../src/modules/notifications/utils/subscription-facts.util';

/**
 * The strings a subscription notification prints.
 *
 * These are read by customers as a statement about what they have paid for, so
 * the cases that matter are the ones where a wrong answer is worse than no
 * answer: an unknown figure rendered as zero, a capped allowance rendered as
 * unlimited, and a deadline rendered in the wrong hour.
 */

const MOSCOW = 'Europe/Moscow';

describe('traffic', () => {
  it('says unlimited for a plan with no cap', () => {
    // `0` is the product's "unlimited" everywhere else; a plan that says so
    // must not print "0 ГБ осталось", which reads as exhausted.
    const facts = buildSubscriptionFacts({ trafficLimitGb: 0, trafficUsedGb: 12 }, 'ru');
    assert.match(facts['traffic'], /Безлимит/);
    assert.equal(facts['trafficLimit'], 'Безлимит');
    assert.equal(facts['trafficUsed'], '12 ГБ');
  });

  it('never invents a remainder for an unlimited plan', () => {
    // What is left of an unlimited allowance is not a number.
    const facts = buildSubscriptionFacts({ trafficLimitGb: null, trafficUsedGb: 12 }, 'ru');
    assert.equal('trafficLeft' in facts, false);
  });

  it('reports used, limit and remainder for a capped plan', () => {
    const facts = buildSubscriptionFacts({ trafficLimitGb: 50, trafficUsedGb: 12.4 }, 'ru');
    assert.equal(facts['trafficUsed'], '12.4 ГБ');
    assert.equal(facts['trafficLimit'], '50 ГБ');
    assert.equal(facts['trafficLeft'], '37.6 ГБ');
  });

  it('does not go negative when the panel reports an overrun', () => {
    // A customer over their cap is a real state, and "-3 ГБ осталось" is not a
    // sentence anybody should receive.
    const facts = buildSubscriptionFacts({ trafficLimitGb: 10, trafficUsedGb: 13 }, 'ru');
    assert.equal(facts['trafficLeft'], '0 ГБ');
  });

  it('says what it knows when the VPN panel was unreachable', () => {
    // The limit is local, the usage is not. Printing `0 ГБ использовано` here
    // would be a lie that reads as "you have used nothing" — the exact opposite
    // of the truth for somebody about to be cut off.
    const facts = buildSubscriptionFacts({ trafficLimitGb: 50, trafficUsedGb: null }, 'ru');
    assert.equal(facts['trafficLimit'], '50 ГБ');
    assert.equal('trafficUsed' in facts, false);
    assert.equal('trafficLeft' in facts, false);
  });

  for (const [used, lamp, label] of [
    [10, '🟢', 'plenty left'],
    [80, '🟡', 'past three quarters'],
    [95, '🔴', 'past nine tenths'],
  ] as const) {
    it(`shows ${lamp} when ${label}`, () => {
      // The colour is read before the numbers are. One colour for every state
      // would be decoration.
      const facts = buildSubscriptionFacts({ trafficLimitGb: 100, trafficUsedGb: used }, 'ru');
      assert.ok(facts['traffic'].startsWith(lamp), facts['traffic']);
    });
  }

  it('translates', () => {
    const facts = buildSubscriptionFacts({ trafficLimitGb: 0 }, 'en');
    assert.equal(facts['trafficLimit'], 'Unlimited');
    const capped = buildSubscriptionFacts({ trafficLimitGb: 50, trafficUsedGb: 10 }, 'en');
    assert.equal(capped['trafficLeft'], '40 GB');
  });
});

describe('devices', () => {
  it('says unlimited for a plan with no device cap', () => {
    const facts = buildSubscriptionFacts({ deviceLimit: 0 }, 'ru');
    assert.equal(facts['devices'], 'Безлимит');
  });

  it('reports how many are free when the count is known', () => {
    const facts = buildSubscriptionFacts({ deviceLimit: 3, devicesUsed: 3 }, 'ru');
    assert.equal(facts['devices'], '0 доступно');
    assert.equal(facts['devicesUsed'], '3');
    assert.equal(facts['devicesLeft'], '0');
  });

  it('falls back to the allowance when the count is unknown', () => {
    // The limit is a local column and the count is a panel read. Losing the
    // second must not blank the line.
    const facts = buildSubscriptionFacts({ deviceLimit: 3, devicesUsed: null }, 'ru');
    assert.equal(facts['devices'], '3');
    assert.equal('devicesLeft' in facts, false);
  });

  it('does not go negative when more devices are bound than the plan allows', () => {
    // Reachable after a plan downgrade: the panel keeps HWID rows and nothing
    // on the limit-change path deletes them.
    const facts = buildSubscriptionFacts({ deviceLimit: 2, devicesUsed: 5 }, 'ru');
    assert.equal(facts['devicesLeft'], '0');
  });
});

describe('when it ends', () => {
  // 2026-08-28T20:13:00Z is 23:13 in Moscow — the case that proves the zone is
  // applied rather than the process clock being printed.
  const INSTANT = '2026-08-28T20:13:00.000Z';

  it('renders the date and time in the operator time zone', () => {
    const facts = buildSubscriptionFacts({ expiresAt: INSTANT, timezone: MOSCOW }, 'ru');
    assert.equal(facts['expiresDate'], '28 августа');
    assert.equal(facts['expiresTime'], '23:13');
  });

  it('renders UTC when no zone is configured', () => {
    // The honest default. Three hours wrong is worse than plainly UTC.
    const facts = buildSubscriptionFacts({ expiresAt: INSTANT }, 'ru');
    assert.equal(facts['expiresTime'], '20:13');
  });

  it('falls back to UTC rather than throwing on a bad zone', () => {
    // `Intl` throws a RangeError on an unknown zone, and this runs inside
    // notification rendering — a typo in settings would stop every
    // notification in the product instead of showing one wrong hour.
    const facts = buildSubscriptionFacts(
      { expiresAt: INSTANT, timezone: 'Mars/Olympus' },
      'ru',
    );
    assert.equal(facts['expiresTime'], '20:13');
  });

  it('translates the month', () => {
    const facts = buildSubscriptionFacts({ expiresAt: INSTANT, timezone: MOSCOW }, 'en');
    assert.equal(facts['expiresDate'], '28 August');
  });

  it('keeps a 24-hour clock in English too', () => {
    // The line states a deadline. "11:13 pm" invites the reader to work out
    // which one it is.
    const facts = buildSubscriptionFacts({ expiresAt: INSTANT, timezone: MOSCOW }, 'en');
    assert.equal(facts['expiresTime'], '23:13');
  });

  it('says nothing at all when there is no timestamp', () => {
    const facts = buildSubscriptionFacts({ expiresAt: null }, 'ru');
    assert.equal('expiresDate' in facts, false);
    assert.equal('expiresTime' in facts, false);
  });

  it('says nothing for a timestamp that will not parse', () => {
    const facts = buildSubscriptionFacts({ expiresAt: 'not a date' }, 'ru');
    assert.equal('expiresDate' in facts, false);
  });
});
