import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The S4 lab's record of Remnawave's own scheduled runs
 * (`test/fixtures/remnawave-reset-lab/<version>.json`, with how each was
 * recorded): which profiles one run reset, the instant it stamped on each,
 * and the status each had before the run — a LIMITED one gets an instant of
 * its own, milliseconds after the others (review R4-03).
 */
export interface LabStamp {
  readonly name: string;
  readonly strategy: string;
  /** The profile's status in the read before the run. */
  readonly statusBefore: string;
  /** `lastTrafficResetAt` as the run wrote it. */
  readonly at: Date;
}

interface LabProfile {
  readonly name: string;
  readonly strategy: string;
  readonly status: string;
  readonly lastTrafficResetAt: string;
  readonly wasReset: boolean;
}

interface LabFixture {
  readonly scheduledRuns: ReadonlyArray<{
    readonly label: string;
    readonly reads: ReadonlyArray<{ readonly label: string; readonly profiles: readonly LabProfile[] }>;
  }>;
}

/** The profiles of `strategy` the lab's run `runLabel` on Remnawave `version` reset. */
export function labRun(version: string, runLabel: string, strategy: string): LabStamp[] {
  const file = join(__dirname, '..', 'fixtures', 'remnawave-reset-lab', `${version}.json`);
  const fixture = JSON.parse(readFileSync(file, 'utf8')) as LabFixture;
  const run = fixture.scheduledRuns.find((candidate) => candidate.label === runLabel);
  if (run === undefined) throw new Error(`the lab has no run «${runLabel}» for ${version}`);
  const before = new Map((run.reads[0]?.profiles ?? []).map((profile) => [profile.name, profile.status]));
  const stamps = new Map<string, LabStamp>();
  for (const read of run.reads) {
    for (const profile of read.profiles) {
      if (!profile.wasReset || profile.strategy !== strategy || stamps.has(profile.name)) continue;
      stamps.set(profile.name, {
        name: profile.name,
        strategy: profile.strategy,
        statusBefore: before.get(profile.name) ?? profile.status,
        at: new Date(profile.lastTrafficResetAt),
      });
    }
  }
  return [...stamps.values()];
}
