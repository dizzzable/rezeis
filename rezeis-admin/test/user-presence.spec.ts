import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PRESENCE_AWAY_MS,
  PRESENCE_ONLINE_MS,
  isUserPresence,
  presenceFilter,
  resolveUserPresence,
} from '../src/modules/users/utils/user-presence.util';

/**
 * Whether a customer is at the screen, and how the list finds the ones who are.
 *
 * The two halves have to agree, and nothing makes them: `resolveUserPresence`
 * labels a row that the database already returned, while `presenceFilter` asks
 * the database for rows without ever seeing one. A boundary that drifts between
 * them shows up as a list of people labelled `away` under a filter that says
 * `online` — which reads as the labels being wrong rather than the query.
 *
 * So every case below fixes a clock and checks BOTH: the label a timestamp
 * earns, and whether the filter for that bucket would have selected it.
 */

const NOW = new Date('2026-09-06T12:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/** Does the fragment the filter produced actually select this timestamp? */
function selects(bucket: 'online' | 'away' | 'offline', lastSeenAt: Date | null): boolean {
  const filter = presenceFilter(bucket, NOW) as Record<string, any>;
  const test = (clause: Record<string, any>): boolean => {
    const range = clause['lastSeenAt'];
    if (range === null) return lastSeenAt === null;
    if (lastSeenAt === null) return false;
    const okGt = range.gt === undefined || lastSeenAt.getTime() > range.gt.getTime();
    const okLte = range.lte === undefined || lastSeenAt.getTime() <= range.lte.getTime();
    return okGt && okLte;
  };
  return Array.isArray(filter['OR'])
    ? filter['OR'].some((clause: Record<string, any>) => test(clause))
    : test(filter);
}

/** The label and the query must give the same answer for the same instant. */
function agree(lastSeenAt: Date | null, expected: 'online' | 'away' | 'offline'): void {
  assert.equal(resolveUserPresence(lastSeenAt, NOW), expected);
  for (const bucket of ['online', 'away', 'offline'] as const) {
    assert.equal(
      selects(bucket, lastSeenAt),
      bucket === expected,
      `${lastSeenAt?.toISOString() ?? 'never seen'} is labelled ${expected}, but the ${bucket} filter ${
        selects(bucket, lastSeenAt) ? 'selects' : 'does not select'
      } it`,
    );
  }
}

describe('user presence', () => {
  it('calls activity in the last few minutes "online"', () => {
    agree(ago(0), 'online');
    agree(ago(60_000), 'online');
    agree(ago(PRESENCE_ONLINE_MS - 1), 'online');
  });

  it('calls the hour after that "away"', () => {
    agree(ago(PRESENCE_ONLINE_MS), 'away');
    agree(ago(20 * 60_000), 'away');
    agree(ago(PRESENCE_AWAY_MS - 1), 'away');
  });

  it('calls anything older "offline"', () => {
    agree(ago(PRESENCE_AWAY_MS), 'offline');
    agree(ago(24 * 60 * 60_000), 'offline');
  });

  it('counts a customer who has never opened the cabinet as offline', () => {
    // Most of a Telegram-first install has no `lastSeenAt` at all. A range
    // filter alone drops every NULL, so "offline" would return almost nobody —
    // and the operator would conclude the filter was broken rather than empty.
    agree(null, 'offline');
  });

  it('treats a timestamp from the future as right now', () => {
    // Clock skew between the reporter and this process. `offline` is the one
    // answer it certainly is not.
    assert.equal(resolveUserPresence(new Date(NOW.getTime() + 30_000), NOW), 'online');
  });

  it('accepts only the three names', () => {
    assert.equal(isUserPresence('online'), true);
    assert.equal(isUserPresence('away'), true);
    assert.equal(isUserPresence('offline'), true);
    assert.equal(isUserPresence('afk'), false);
    assert.equal(isUserPresence('constructor'), false);
    assert.equal(isUserPresence(undefined), false);
  });

  it('leaves no instant unclaimed and no instant claimed twice', () => {
    // The three buckets are a partition. A gap loses users from every filter at
    // once; an overlap shows the same person under two of them.
    for (let minutes = 0; minutes <= 120; minutes += 1) {
      const seen = ago(minutes * 60_000);
      const matched = (['online', 'away', 'offline'] as const).filter((bucket) =>
        selects(bucket, seen),
      );
      assert.equal(
        matched.length,
        1,
        `${minutes} minutes ago is selected by ${matched.length} filters: ${matched.join(', ')}`,
      );
    }
  });
});
