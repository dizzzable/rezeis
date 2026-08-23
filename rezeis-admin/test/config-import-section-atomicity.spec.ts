/**
 * A section lands whole, or not at all — and the summary says which.
 *
 * The bug, established before it was changed
 * ─────────────────────────────────────────
 * `importConfig` opened ONE `$transaction` around every section, and
 * `importSection` caught its own errors. So a write that failed never aborted
 * anything: the loop carried on and the transaction COMMITTED. Measured against
 * a transaction-aware double, a webhooks section of ten rows failing on the
 * third produced:
 *
 *     transactions : BEGIN COMMIT
 *     COMMITTED    : webhooks[0], webhooks[1], faqItems[0..2]
 *     summary      : webhooks status=failed created=0 updated=0
 *
 * Two rows in the database, reported as zero. Not under-reporting — the summary
 * actively claimed nothing was written. During the staging-to-production
 * promotion this module exists for, the operator then retries or hand-fixes
 * against a destination they have been told is untouched. Worse, `dryRun`
 * predicted the same `created: 0`, so the preview was also wrong about what a
 * real run leaves behind.
 *
 * All-or-nothing across the whole import was the other candidate and it is
 * worse: one malformed FAQ row would discard nine good sections. So the
 * contract is per-section atomicity.
 *
 * How these cases are built
 * ─────────────────────────
 * The Prisma double is transaction-aware: writes are STAGED and only flushed to
 * `committed` when the transaction callback resolves, and discarded when it
 * throws. `committed` is therefore ground truth for "what is in the database",
 * and the load-bearing case asserts the service's own summary against it rather
 * than against a number written here by hand.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConfigExportPayloadInterface } from '../src/modules/config-portability/services/config-export.service';
import { ConfigImportService } from '../src/modules/config-portability/services/config-import.service';

/** Delegate name per section, mirroring what the service reaches for. */
const DELEGATE: Readonly<Record<string, string>> = {
  webhooks: 'webhookSubscription',
  faqItems: 'faqItem',
  blockedIps: 'blockedIp',
};

const PERMISSIONS = new Set([
  'config_portability:import',
  'webhooks:create',
  'webhooks:edit',
  'faq:create',
  'faq:edit',
  'blocked_ips:create',
  'blocked_ips:delete',
]);

interface Harness {
  readonly prisma: unknown;
  /** Writes whose transaction COMMITTED. Ground truth for the database. */
  readonly committed: string[];
  /** 'BEGIN' / 'COMMIT' / 'ROLLBACK', in order. */
  readonly txLog: string[];
}

/**
 * Transaction-aware recording double.
 *
 * The staging buffer is the whole point: a double that recorded writes as they
 * happened would report the two rows the old code wrote before the failure as
 * though they were in the database whether the transaction committed or not,
 * and so could not tell the bug from the fix.
 */
function buildHarness(
  failAt: { readonly section: string; readonly index: number } | null,
): Harness {
  const committed: string[] = [];
  const txLog: string[] = [];
  const seen: Record<string, number> = {};
  let staged: string[] = [];

  const delegate = (section: string) => ({
    findUnique: async () => null,
    findFirst: async () => null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const index = (seen[section] = (seen[section] ?? 0) + 1) - 1;
      if (failAt !== null && failAt.section === section && failAt.index === index) {
        throw new Error('Invalid prisma.create() invocation: Argument `secret` is missing.');
      }
      staged.push(`${section}[${index}]`);
      return data;
    },
    update: async ({ data }: { data: Record<string, unknown> }) => data,
  });

  const tx: Record<string, unknown> = {};
  for (const [section, name] of Object.entries(DELEGATE)) tx[name] = delegate(section);

  const prisma = {
    ...tx,
    $transaction: async (cb: (client: typeof tx) => Promise<unknown>) => {
      txLog.push('BEGIN');
      staged = [];
      try {
        const value = await cb(tx);
        txLog.push('COMMIT');
        committed.push(...staged);
        return value;
      } catch (err) {
        txLog.push('ROLLBACK');
        staged = [];
        throw err;
      }
    },
    adminAuditLog: { create: async () => ({}) },
  };
  return { prisma, committed, txLog };
}

function rowsFor(section: string, count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: `${section}-${i}`,
    name: `${section} ${i}`,
    url: 'https://receiver.example/hook',
    secret: 'signing-secret',
    question: 'q',
    answer: 'a',
    address: `203.0.113.${i + 1}`,
    source: 'manual',
  }));
}

interface RunOutcome {
  readonly summaries: ReadonlyArray<{
    readonly section: string;
    readonly status: string;
    readonly created: number;
    readonly updated: number;
    readonly skipped: number;
    readonly errors: readonly string[];
  }>;
  readonly committed: string[];
  readonly txLog: string[];
}

async function runImport(options: {
  readonly sections: Readonly<Record<string, number>>;
  readonly failAt?: { readonly section: string; readonly index: number };
  readonly dryRun?: boolean;
  readonly strategy?: 'skip' | 'overwrite';
}): Promise<RunOutcome> {
  const harness = buildHarness(options.failAt ?? null);
  const sections: Record<string, unknown[]> = {};
  const manifest: Record<string, number> = {};
  for (const [section, count] of Object.entries(options.sections)) {
    sections[section] = rowsFor(section, count);
    manifest[section] = count;
  }
  const service = new ConfigImportService(harness.prisma as never);
  (service as unknown as { logger: { error: (m: string, s?: string) => void } }).logger = {
    error: () => undefined,
  };
  const result = await service.importConfig({
    payload: {
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      source: 'rezeis-admin',
      manifest,
      sections,
    } as unknown as ConfigExportPayloadInterface,
    sections: Object.keys(options.sections) as never,
    strategy: options.strategy ?? 'overwrite',
    dryRun: options.dryRun ?? false,
    importerPermissions: PERMISSIONS,
  });
  return { summaries: result.summaries, committed: harness.committed, txLog: harness.txLog };
}

/** Writes the double actually committed for one section. */
function committedFor(outcome: RunOutcome, section: string): number {
  return outcome.committed.filter((write) => write.startsWith(`${section}[`)).length;
}

describe('config import — a section lands whole or not at all', () => {
  it('does not commit the rows written before a row that failed', async () => {
    // The bug verbatim: ten webhook subscriptions, the third one rejected.
    // Before the fix this committed webhooks[0] and webhooks[1].
    const outcome = await runImport({
      sections: { webhooks: 10 },
      failAt: { section: 'webhooks', index: 2 },
    });

    assert.equal(
      committedFor(outcome, 'webhooks'),
      0,
      `rows survived a failed section: ${outcome.committed.join(', ')}`,
    );
    assert.deepEqual(outcome.txLog, ['BEGIN', 'ROLLBACK']);
    assert.equal(outcome.summaries.find((s) => s.section === 'webhooks')?.status, 'failed');
  });

  it('reports counts that match what the database actually received', async () => {
    // The load-bearing case. Nothing here is a hand-written expectation: the
    // summary is held against the writes the double observed COMMITTING, so a
    // summary that drifts from the database fails whichever way it drifts.
    const outcome = await runImport({
      sections: { webhooks: 10, faqItems: 3, blockedIps: 2 },
      failAt: { section: 'webhooks', index: 2 },
    });

    assert.ok(outcome.summaries.length > 0, 'no sections were reported at all');
    for (const summary of outcome.summaries) {
      assert.equal(
        summary.created + summary.updated,
        committedFor(outcome, summary.section),
        `section "${summary.section}" reported ${summary.created + summary.updated} written `
          + `but the database received ${committedFor(outcome, summary.section)} `
          + `(committed: ${outcome.committed.join(', ') || 'nothing'})`,
      );
    }
  });

  it('does not let one failed section discard the sections that succeeded', async () => {
    // The reason this is per-section rather than all-or-nothing: a single
    // malformed row must not throw away every other section.
    const outcome = await runImport({
      sections: { webhooks: 10, faqItems: 3, blockedIps: 2 },
      failAt: { section: 'webhooks', index: 2 },
    });

    assert.equal(committedFor(outcome, 'faqItems'), 3);
    assert.equal(committedFor(outcome, 'blockedIps'), 2);
    assert.equal(outcome.summaries.find((s) => s.section === 'faqItems')?.status, 'imported');
    assert.equal(outcome.summaries.find((s) => s.section === 'blockedIps')?.status, 'imported');
  });

  it('gives each section its own transaction', async () => {
    // One `$transaction` around the whole loop is what let a swallowed error
    // commit. Three sections must open three.
    const outcome = await runImport({ sections: { webhooks: 2, faqItems: 2, blockedIps: 2 } });

    assert.deepEqual(outcome.txLog, [
      'BEGIN', 'COMMIT',
      'BEGIN', 'COMMIT',
      'BEGIN', 'COMMIT',
    ]);
    assert.equal(outcome.committed.length, 6);
  });

  it('tells the operator the section was rolled back and nothing was applied', async () => {
    // The fact that decides whether they retry or go hand-inspect the
    // destination. A bare "failed" left that open.
    const outcome = await runImport({
      sections: { webhooks: 10 },
      failAt: { section: 'webhooks', index: 2 },
    });

    const message = outcome.summaries.find((s) => s.section === 'webhooks')?.errors[0] ?? '';
    assert.match(message, /rolled back/i, 'the message does not say the section was rolled back');
    assert.match(message, /10 row/, 'the message does not say how many rows were discarded');
    assert.match(message, /before the failure/i, 'the message does not address the earlier rows');
  });
});

describe('config import — a dry run still means nothing is written', () => {
  it('commits nothing at all while still reporting what would happen', async () => {
    const outcome = await runImport({ sections: { webhooks: 4, faqItems: 3 }, dryRun: true });

    assert.deepEqual(outcome.committed, [], 'a dry run wrote to the database');
    assert.deepEqual(outcome.txLog, ['BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK']);
    // The preview keeps its answer: the counts ride out on the sentinel.
    assert.equal(outcome.summaries.find((s) => s.section === 'webhooks')?.created, 4);
    assert.equal(outcome.summaries.find((s) => s.section === 'faqItems')?.created, 3);
    for (const summary of outcome.summaries) assert.equal(summary.status, 'imported');
  });

  it('rolls back every section, not merely the last one', async () => {
    const outcome = await runImport({
      sections: { webhooks: 2, faqItems: 2, blockedIps: 2 },
      dryRun: true,
    });

    assert.equal(outcome.txLog.filter((e) => e === 'ROLLBACK').length, 3);
    assert.equal(outcome.txLog.filter((e) => e === 'COMMIT').length, 0);
    assert.deepEqual(outcome.committed, []);
  });

  it('predicts a failing section the same way a real run resolves it', async () => {
    // Today's preview said `created: 0` for a section a real run would leave
    // two rows behind in. Now both say zero, and both mean it.
    const preview = await runImport({
      sections: { webhooks: 10, faqItems: 3 },
      failAt: { section: 'webhooks', index: 2 },
      dryRun: true,
    });
    const real = await runImport({
      sections: { webhooks: 10, faqItems: 3 },
      failAt: { section: 'webhooks', index: 2 },
    });

    for (const section of ['webhooks', 'faqItems']) {
      const p = preview.summaries.find((s) => s.section === section);
      const r = real.summaries.find((s) => s.section === section);
      assert.equal(p?.status, r?.status, `"${section}" status differs between preview and run`);
      assert.equal(p?.created, r?.created, `"${section}" created differs between preview and run`);
    }
    assert.deepEqual(preview.committed, [], 'the preview wrote something');
    assert.equal(committedFor(real, 'webhooks'), 0, 'the real run left rows behind');
  });
});

describe('config import — nothing else about a healthy import moved', () => {
  it('commits every section of a clean import and reports it', async () => {
    const outcome = await runImport({ sections: { webhooks: 3, faqItems: 2 } });

    assert.equal(outcome.committed.length, 5);
    for (const summary of outcome.summaries) {
      assert.equal(summary.status, 'imported');
      assert.deepEqual(summary.errors, []);
      assert.equal(summary.created + summary.updated, committedFor(outcome, summary.section));
    }
  });

  it('keeps an empty section a no-op', async () => {
    // The manifest agrees the source had zero rows. Nothing to write, nothing
    // to roll back, and the status still reads `imported` rather than a
    // failure — the distinction this module already draws elsewhere.
    const outcome = await runImport({ sections: { webhooks: 0 } });

    assert.deepEqual(outcome.committed, []);
    const summary = outcome.summaries.find((s) => s.section === 'webhooks');
    assert.equal(summary?.status, 'imported');
    assert.equal(summary?.created, 0);
    assert.deepEqual(summary?.errors, []);
  });
});
