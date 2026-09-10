import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * EVERY SPEC THAT NEEDS A REAL DATABASE IS NAMED IN THE JOB THAT HAS ONE.
 *
 * A spec that reads `TEST_DATABASE_URL` swaps its suite for `describe.skip`
 * when the variable is absent. That is the right thing to do — the default
 * `npm test` run has no PostgreSQL — but it means such a file reports SUCCESS
 * in the ordinary run while asserting nothing, and it is the CI job
 * `postgres-concurrency` that actually exercises it. That job takes an
 * EXPLICIT LIST of filenames.
 *
 * So a spec left off the list runs nowhere: skipped in `backend-tests`, never
 * invoked in `postgres-concurrency`, green in both. The job's own comment says
 * exactly this and the list still drifted —
 * `subscription-device-limit-reduction.spec.ts` sat outside it, and the
 * property it proves (a database trigger's behaviour under a real engine, which
 * no unit test can reach) was unguarded from the day it was written.
 *
 * Handwritten lists do not stay in step with a directory. This is the step.
 */

const TEST_DIR = __dirname;
const WORKFLOW = readFileSync(join(TEST_DIR, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');

/** The `postgres-concurrency` job, from its key to the start of the next one. */
function postgresJob(source: string): string {
  const start = source.indexOf('  postgres-concurrency:');
  assert.notEqual(start, -1, 'the postgres-concurrency job is gone from ci.yml');
  // A job key is the only thing at exactly two spaces of indent, so the next
  // one ends this block. Slicing to EOF instead would let a name ANYWHERE
  // later in the file count as listed.
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9_-]*:/);
  return next === -1 ? rest : rest.slice(0, next);
}

const JOB = postgresJob(WORKFLOW);

/**
 * Specs whose suite is swapped for `describe.skip` without a live database.
 *
 * The test is the READ — `process.env.TEST_DATABASE_URL` — not a mention of
 * the name, which would sweep up any spec that merely explains itself in a
 * comment and demand it be added to a job it has no use for. This file is
 * excluded by name for the same reason: it talks about the variable at length
 * and needs no database of its own.
 */
const SELF = 'postgres-job-lists-every-database-spec.spec.ts';

const NEEDS_DATABASE = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.spec.ts') && name !== SELF)
  .filter((name) =>
    readFileSync(join(TEST_DIR, name), 'utf8').includes('process.env.TEST_DATABASE_URL'),
  );

describe('the CI job that has a PostgreSQL', () => {
  it('was found, and stops where the next job starts', () => {
    // Anti-emptiness anchor in both directions. An empty block agrees that
    // nothing is listed; an OVERLONG one agrees that everything is, including
    // a filename that only appears in some later job or comment.
    //
    // `JOB.length < WORKFLOW.length` was the first thing written here and it
    // is not the check: the slice starts partway into the file, so it is
    // shorter than the whole even when it runs to the end. `postgres-concurrency`
    // happens to be last today, which is exactly why the weak form looked fine
    // — it would have gone wrong the day a job was appended after it. Measured:
    // replacing the slice with a run to EOF left all five cases green.
    assert.ok(JOB.length > 200, `the job block is ${JOB.length} characters`);
    assert.ok(JOB.includes('postgres:17-alpine'), 'this is not the job with the database');

    const anotherJobKey = /\n {2}[a-z][a-z0-9_-]*:/.exec(JOB);
    assert.equal(
      anotherJobKey?.[0] ?? null,
      null,
      'the block ran past its own job and into the next one',
    );
  });

  it('still recognises this very file as needing no database', () => {
    // The self-exclusion is a named constant, so it can go stale silently when
    // the file is renamed — and a stale one makes this file report ITSELF as
    // unlisted, which reads as a CI drift that is not there.
    assert.ok(readdirSync(TEST_DIR).includes(SELF), 'the self-exclusion names a file that is gone');
  });

  it('would stop at a job appended after it', () => {
    // The rule above cannot prove this against the real file, because
    // `postgres-concurrency` is currently LAST: a slice that runs to the end of
    // the workflow produces the identical text, so the two implementations are
    // indistinguishable there. Measured — replacing the slice with a run to EOF
    // left every other case in this file green.
    //
    // A job appended after it is the day that stops being true, and it is also
    // the day a filename listed in THAT job starts counting as listed in this
    // one. Asserted on a fixture, since the real file cannot ask the question.
    const fixture = [
      'jobs:',
      '  postgres-concurrency:',
      '    services:',
      '      postgres:',
      '        image: postgres:17-alpine',
      '    steps:',
      '      - run: node --test test/mine.spec.ts',
      '  a-later-job:',
      '    steps:',
      '      - run: node --test test/not-mine.spec.ts',
    ].join(String.fromCharCode(10));

    const block = postgresJob(fixture);

    assert.ok(block.includes('test/mine.spec.ts'));
    assert.equal(
      block.includes('test/not-mine.spec.ts'),
      false,
      'a spec listed in a later job counts as listed in this one',
    );
  });

  it('has specs to name at all', () => {
    // If this ever reads zero, the detection below stopped working and the
    // rule underneath it became a rule about nothing.
    assert.ok(
      NEEDS_DATABASE.length >= 10,
      `found ${NEEDS_DATABASE.length} specs that read TEST_DATABASE_URL`,
    );
  });

  it('names every spec that needs one', () => {
    const unlisted = NEEDS_DATABASE.filter((name) => !JOB.includes(`test/${name}`));

    assert.deepEqual(
      unlisted,
      [],
      'these skip in the ordinary run and are never invoked in CI, so they guard nothing',
    );
  });

  it('names no spec that is gone', () => {
    // The other direction. A renamed or deleted file leaves the job invoking a
    // path that does not exist — `node --test` exits non-zero on it, so this
    // one fails loudly in CI rather than silently. Caught here instead, where
    // the fix is obvious.
    const listed = Array.from(JOB.matchAll(/\btest\/([A-Za-z0-9._-]+\.spec\.ts)/g), (m) => m[1]);
    assert.ok(listed.length >= 10, `parsed ${listed.length} filenames out of the job`);

    const onDisk = new Set(readdirSync(TEST_DIR));
    const missing = listed.filter((name) => !onDisk.has(name));

    assert.deepEqual(missing, [], 'the job invokes a spec that is not there');
  });
});
