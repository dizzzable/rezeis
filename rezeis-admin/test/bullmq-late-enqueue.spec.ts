import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { withdrawLateJob, type LateJobQueue } from '../src/common/queue/bullmq-late-enqueue';

/**
 * A withdrawal that lost the race says so
 * ═══════════════════════════════════════
 * `withdrawLateJob` takes back a timed-out job whose message the producer then
 * delivered itself. When a worker got to the job first, the message goes out
 * twice, and that is the one duplicate the helper promises to LOG. It logged
 * nothing: it waited for `Queue.remove` to throw, and BullMQ never throws for
 * that — it answers 0 for a job a worker holds, and removes a job a worker
 * already finished without a word (checked on Valkey: `remove` returned 0, no
 * warning, and the worker processed the job anyway).
 *
 * The doubles below answer the way the library does, and the first case pins
 * that to the scripts BullMQ actually ships, so an upgrade that changes either
 * answer fails here instead of turning the warning silent again.
 */

const BULLMQ_COMMANDS = join(__dirname, '..', 'node_modules', 'bullmq', 'dist', 'cjs', 'commands');

function queueAnswering(job: unknown, removed: number): LateJobQueue & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getJob: async () => {
      calls.push('getJob');
      return job;
    },
    remove: async () => {
      calls.push('remove');
      return removed;
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('what BullMQ answers a withdrawal with', () => {
  it('refuses a locked job with 0, removes anything else with 1, and stamps a job a worker takes', () => {
    const removeJob = readFileSync(join(BULLMQ_COMMANDS, 'removeJob-2.lua'), 'utf8');
    assert.match(
      removeJob,
      /if not isLocked\(prefix, jobId, shouldRemoveChildren\) then[\s\S]*?return 1\s*end\s*return 0\s*$/,
      'removeJob no longer answers 1 = removed / 0 = locked: re-read withdrawLateJob against it',
    );
    const prepare = readFileSync(join(BULLMQ_COMMANDS, 'includes', 'prepareJobForProcessing.lua'), 'utf8');
    assert.match(
      prepare,
      /rcall\("HMSET", jobKey, "processedOn", processedOn/,
      'a worker taking a job no longer stamps processedOn: re-read withdrawLateJob against it',
    );
  });
});

describe('withdrawLateJob', () => {
  it('warns when a worker holds the job — BullMQ answers 0, it does not throw', async () => {
    const queue = queueAnswering({ id: 'job-1', processedOn: 1_757_000_000_000 }, 0);
    const warnings: string[] = [];

    await withdrawLateJob(queue, 'job-1', Promise.resolve(true), (message) => void warnings.push(message));
    await settle();

    assert.equal(warnings.length, 1, `one duplicate, one line: ${JSON.stringify(warnings)}`);
    assert.match(warnings[0] as string, /job-1 was held by a worker .* delivered twice/);
    // Both withdrawals ran — the second after the add landed — and still one line.
    assert.deepStrictEqual(queue.calls, ['getJob', 'remove', 'getJob', 'remove']);
  });

  it('warns when a worker already finished it — the removal succeeds, the message went out anyway', async () => {
    const queue = queueAnswering({ id: 'job-1', processedOn: 1_757_000_000_000, finishedOn: 1_757_000_000_900 }, 1);
    const warnings: string[] = [];

    await withdrawLateJob(queue, 'job-1', Promise.resolve(false), (message) => void warnings.push(message));

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] as string, /already taken by a worker/);
  });

  it('stays silent when it withdrew the job before any worker took it', async () => {
    // The replayed path: the read and the removal run right behind the add,
    // so the job is still waiting — the case the helper exists for.
    for (const job of [{ id: 'job-1' }, undefined]) {
      const queue = queueAnswering(job, 1);
      const warnings: string[] = [];

      await withdrawLateJob(queue, 'job-1', Promise.resolve(true), (message) => void warnings.push(message));
      await settle();

      assert.deepStrictEqual(warnings, [], JSON.stringify(job));
    }
  });
});
