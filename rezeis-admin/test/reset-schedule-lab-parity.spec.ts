import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  isRollingResetDay,
  nextRemnawaveReset,
  REMNAWAVE_RESET_MINUTE,
  remnawaveResetsBetween,
  type ResetStrategy,
} from '../src/modules/add-on-entitlements/domain/reset-cycle-policy';

/**
 * LIVE PARITY: WHAT REMNAWAVE 3.2, 3.3 AND 3.4 ACTUALLY DID, AGAINST WHAT THE
 * PANEL PREDICTS.
 *
 * `reset-schedule-parity.spec.ts` restates Remnawave's schedule from its
 * sources. This file checks the same functions against Remnawave RUNNING: the
 * official images 3.2.3, 3.3.2 and 3.4.4, observed in a lab on 25.09.2026
 * (`test/fixtures/remnawave-reset-lab/<version>.json`, each with how it was
 * recorded). Stage 4 — a traffic add-on that lasts until Remnawave's own
 * traffic reset — takes the add-on off at the instant these functions give,
 * and the switch «Докупка трафика до сброса» was to go on by default only
 * once they matched a live Remnawave (the owner, 24.09.2026).
 *
 * What was observed, per version:
 *   - «Reset all users traffic» (`POST /api/users/bulk/all/reset-traffic`):
 *     who was reset — every calendar strategy and NO_RESET, and MONTH_ROLLING
 *     only on the anniversary day `isRollingResetDay` names;
 *   - Remnawave's own scheduler, twice, with nothing called: once on a clock
 *     that read Monday 01.02.2027 (the 1st), so all four jobs ran within 20
 *     minutes, and once in the zone UTC−1 on the real clock. Every reset must
 *     be the one `remnawaveResetsBetween` predicts for the profile's strategy,
 *     anchor and the scheduler's zone, within the cron minute; every profile
 *     left alone must have no predicted reset in the window;
 *   - 3.4.4's own statement of its schedule, the `subscription-refill-date`
 *     header, which must equal `nextRemnawaveReset`.
 *
 * The lab itself is not re-run here: the fixtures are its record. A new
 * Remnawave version is checked by recording a fixture for it the same way.
 */

interface LabProfile {
  readonly name: string;
  readonly strategy: ResetStrategy;
  readonly createdAt: string;
  readonly status: string;
  readonly lastTrafficResetAt: string;
  readonly wasReset: boolean;
}

interface LabRun {
  readonly label: string;
  readonly processTimeZone: string;
  readonly processClockShiftMs: number;
  readonly watchedFrom: string;
  readonly watchedUntil: string;
  readonly databaseDate: string;
  readonly reads: ReadonlyArray<{ readonly label: string; readonly at: string; readonly profiles: readonly LabProfile[] }>;
}

interface LabFixture {
  readonly remnawave: { readonly version: string; readonly image: string };
  readonly sentinelLastTrafficResetAt: string;
  readonly bulkAllReset: {
    readonly calledAt: string;
    readonly httpStatus: number;
    readonly profiles: readonly LabProfile[];
  };
  readonly scheduledRuns: readonly LabRun[];
  readonly refillHeader: ReadonlyArray<{
    readonly label: string;
    readonly processTimeZone: string;
    readonly readAt: string;
    readonly profiles: ReadonlyArray<{
      readonly name: string;
      readonly strategy: ResetStrategy;
      readonly createdAt: string;
      readonly refillAt: string | null;
    }>;
  }> | null;
}

const FIXTURES = join(__dirname, 'fixtures', 'remnawave-reset-lab');

function loadFixtures(): LabFixture[] {
  return readdirSync(FIXTURES)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as LabFixture);
}

const fixtures = loadFixtures();

/**
 * A scheduled reset lands within the cron minute: the job fires at second 0
 * of its minute and writes `lastTrafficResetAt` when its batch runs — tens of
 * milliseconds later in the lab.
 */
const CRON_MINUTE_MS = 60_000;
/** «Reset all users traffic» is queued; the lab saw it written within 40 ms of the call. */
const BULK_WRITE_MS = 5_000;

const at = (iso: string): Date => new Date(iso);

/** Which resets P1 predicts for a profile between two instants on the scheduler's clock. */
function predictedResets(profile: LabProfile, timeZone: string, from: string, to: string): Date[] {
  return remnawaveResetsBetween(
    { strategy: profile.strategy, anchorAt: at(profile.createdAt), timeZone },
    at(from),
    at(to),
  );
}

describe('the lab recorded every supported Remnawave line, every strategy, scheduled and in bulk', () => {
  it('has 3.2, 3.3 and 3.4 — 3.4 at the newest tag, 3.4.4', () => {
    assert.deepEqual(
      fixtures.map((fixture) => fixture.remnawave.version),
      ['3.2.3', '3.3.2', '3.4.4'],
    );
  });

  it('saw each scheduled job reset someone and NO_RESET reset by nobody on a schedule', () => {
    for (const fixture of fixtures) {
      const version = fixture.remnawave.version;
      assert.deepEqual(
        fixture.scheduledRuns.map((run) => run.label),
        ['shifted-clock', 'zone'],
        version,
      );
      const resetBySchedule = new Set<string>();
      for (const run of fixture.scheduledRuns) {
        const last = run.reads[run.reads.length - 1]!;
        for (const profile of last.profiles) if (profile.wasReset) resetBySchedule.add(profile.strategy);
      }
      assert.deepEqual([...resetBySchedule].sort(), ['DAY', 'MONTH', 'MONTH_ROLLING', 'WEEK'], version);
      // Non-vacuity of the bulk case: rolling profiles on both sides of the day filter.
      const rolling = fixture.bulkAllReset.profiles.filter((profile) => profile.strategy === 'MONTH_ROLLING');
      assert.ok(rolling.some((profile) => profile.wasReset), version);
      assert.ok(rolling.some((profile) => !profile.wasReset), version);
    }
  });
});

for (const fixture of fixtures) {
  const version = fixture.remnawave.version;

  describe(`Remnawave ${version} — «Reset all users traffic»`, () => {
    it('resets every calendar strategy and NO_RESET, and MONTH_ROLLING only on its anniversary day', () => {
      const bulk = fixture.bulkAllReset;
      assert.equal(bulk.httpStatus, 202);
      for (const profile of bulk.profiles) {
        const expected =
          profile.strategy === 'MONTH_ROLLING' ? isRollingResetDay(at(profile.createdAt), at(bulk.calledAt)) : true;
        assert.equal(profile.wasReset, expected, `${profile.name} created ${profile.createdAt}`);
        if (profile.wasReset) {
          const delay = at(profile.lastTrafficResetAt).getTime() - at(bulk.calledAt).getTime();
          assert.ok(delay >= 0 && delay < BULK_WRITE_MS, `${profile.name}: written ${delay} ms after the call`);
        } else {
          assert.equal(profile.lastTrafficResetAt, fixture.sentinelLastTrafficResetAt, profile.name);
        }
      }
    });
  });

  describe(`Remnawave ${version} — its own scheduler`, () => {
    for (const run of fixture.scheduledRuns) {
      it(`${run.label}: every reset is the one predicted for the strategy, anchor and zone, within the cron minute`, () => {
        for (const read of run.reads) {
          for (const profile of read.profiles) {
            const where = `${run.label}/${read.label}: ${profile.name} (${profile.strategy}, created ${profile.createdAt})`;
            if (run.processClockShiftMs !== 0 && profile.strategy === 'MONTH_ROLLING') {
              // The scheduler's clock was moved and the database's was not:
              // the rolling job fired at the scheduler's 00:10 and chose by the
              // database's date — the rule `isRollingResetDay` states. P1's
              // instants assume one clock, as every real install has.
              const onDatabaseDate = isRollingResetDay(at(profile.createdAt), at(`${run.databaseDate}T12:00:00.000Z`));
              const jobHasRun =
                at(read.at).getTime() >=
                at(`${read.at.slice(0, 10)}T00:00:00.000Z`).getTime() + REMNAWAVE_RESET_MINUTE.MONTH_ROLLING * 60_000;
              assert.equal(profile.wasReset, onDatabaseDate && jobHasRun, where);
              if (profile.wasReset) {
                const minute = at(profile.lastTrafficResetAt).getUTCHours() * 60 + at(profile.lastTrafficResetAt).getUTCMinutes();
                assert.equal(minute, REMNAWAVE_RESET_MINUTE.MONTH_ROLLING, where);
              }
              continue;
            }
            const predicted = predictedResets(profile, run.processTimeZone, run.watchedFrom, read.at);
            if (!profile.wasReset) {
              assert.deepEqual(predicted.map((instant) => instant.toISOString()), [], `${where}: predicted, not observed`);
              continue;
            }
            assert.ok(predicted.length > 0, `${where}: reset at ${profile.lastTrafficResetAt}, none predicted`);
            const expected = predicted[predicted.length - 1]!;
            const delay = at(profile.lastTrafficResetAt).getTime() - expected.getTime();
            assert.ok(
              delay >= 0 && delay < CRON_MINUTE_MS,
              `${where}: reset at ${profile.lastTrafficResetAt}, predicted ${expected.toISOString()}`,
            );
          }
        }
      });
    }

    it('switches a LIMITED profile back on at a scheduled reset', () => {
      for (const run of fixture.scheduledRuns) {
        const last = run.reads[run.reads.length - 1]!;
        const limited = last.profiles.filter((profile) => profile.name === 'day_lim');
        assert.equal(limited.length, 1, run.label);
        assert.equal(limited[0]!.wasReset, true, run.label);
        assert.equal(limited[0]!.status, 'ACTIVE', run.label);
      }
    });
  });

  if (fixture.refillHeader !== null) {
    describe(`Remnawave ${version} — its own statement of the schedule (subscription-refill-date)`, () => {
      it('names the reset the panel predicts', () => {
        assert.ok(fixture.refillHeader!.length > 0);
        for (const read of fixture.refillHeader!) {
          for (const profile of read.profiles) {
            // In a zone other than UTC, 3.4.4's header takes a rolling
            // profile's day on the scheduler's clock, while the reset itself
            // follows the database's UTC date (the zone run above shows which
            // is real): only the calendar strategies are compared there.
            if (read.processTimeZone !== 'UTC' && profile.strategy === 'MONTH_ROLLING') continue;
            const predicted = nextRemnawaveReset(
              { strategy: profile.strategy, anchorAt: at(profile.createdAt), timeZone: read.processTimeZone },
              at(read.readAt),
            );
            assert.equal(
              profile.refillAt,
              predicted === null ? null : predicted.toISOString(),
              `${read.label}: ${profile.name} (${profile.strategy}, created ${profile.createdAt})`,
            );
          }
        }
      });

      it('is NOT the rolling schedule outside UTC: its header named a day the scheduler did not reset on', () => {
        // Why nothing may read this header as the oracle — S4-sync's daily
        // check included. In UTC−1 the header counted a rolling profile's
        // anniversary on the scheduler's local clock, while Remnawave's reset
        // chose by the database's UTC date, as P1 does: the zone run below
        // reset the profile created 25.08 00:00 UTC on 25.09 and left the one
        // created 26.08 00:00 UTC alone — the opposite of what the header said.
        const header = fixture.refillHeader!.find((read) => read.processTimeZone !== 'UTC');
        const zoneRun = fixture.scheduledRuns.find((run) => run.label === 'zone');
        assert.ok(header !== undefined && zoneRun !== undefined);
        const resetAt = (name: string) =>
          zoneRun.reads[zoneRun.reads.length - 1]!.profiles.find((profile) => profile.name === name)!;
        const said = (name: string) => header.profiles.find((profile) => profile.name === name)!.refillAt;
        for (const [name, reset] of [['r25_0000', true], ['r26_0000', false]] as const) {
          assert.equal(resetAt(name).wasReset, reset, name);
          const predicted = nextRemnawaveReset(
            { strategy: 'MONTH_ROLLING', anchorAt: at(resetAt(name).createdAt), timeZone: header.processTimeZone },
            at(header.readAt),
          );
          assert.notEqual(said(name), predicted?.toISOString(), `${name}: the header agreed with P1 after all`);
        }
        assert.equal(said('r26_0000'), '2026-09-25T01:10:00.000Z', 'the header announced a reset that never came');
      });
    });
  }
}
