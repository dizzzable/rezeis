import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Job } from 'bullmq';

import {
  isFinalFailedAttempt,
  isFinalProcessorAttempt,
} from '../src/modules/backup/backup-delivery-retry.util';
import { BACKUP_JOBS } from '../src/modules/backup/backup.constants';
import { BackupProcessor } from '../src/modules/backup/backup.processor';
import { BackupService } from '../src/modules/backup/services/backup.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';

/**
 * The three attempts that had never once run
 * ──────────────────────────────────────────
 * `backup.deliver-telegram` is queued with `attempts: 3` and an exponential
 * backoff. BullMQ retries only a processor that THROWS, and this one returned
 * `{ delivered: false }` for every failure — so the retry configuration had
 * never fired for a delivery failure in its life. A four-second timeout or a
 * passing 502 left the backup local-only for good.
 *
 * These tests drive the REAL processor over the REAL service over the REAL
 * `BotNotifierClient`, stubbing only `fetch`, and step the attempt loop the way
 * BullMQ steps it — asking the installed `Job.prototype.shouldRetryJob` itself
 * when to stop rather than a copy of that rule written here. So the loop cannot
 * agree with a bug in this file's own arithmetic, and a test that "passes"
 * because nothing ever retried is caught by the attempt-count assertions.
 */

const CHAT_ID = '-1001234567890';
const JOB_ATTEMPTS = 3;
const JOB_OPTS = { attempts: JOB_ATTEMPTS, backoff: { type: 'exponential', delay: 10_000 } };

// ── Fetch stubs, one per relay outcome ──────────────────────────────────────

type FetchStub = (url: unknown, init: { signal?: AbortSignal }) => Promise<unknown>;

const CONFIRMED: FetchStub = async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => ({ messageId: 4242 }),
});
const REJECTED_502: FetchStub = async () => ({
  ok: false,
  status: 502,
  statusText: 'Bad Gateway',
  json: async () => ({}),
});
const REJECTED_400: FetchStub = async () => ({
  ok: false,
  status: 400,
  statusText: 'Bad Request',
  json: async () => ({}),
});
const UNCONFIRMED_204: FetchStub = async () => ({
  ok: true,
  status: 204,
  statusText: 'No Content',
  json: async () => {
    throw new Error('204 has no body');
  },
});
const UNCONFIRMED_200: FetchStub = async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => ({}),
});
const TRANSPORT_ERROR: FetchStub = async () => {
  throw new Error('ECONNREFUSED 10.0.0.5:443');
};
const TIMES_OUT: FetchStub = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });

let tempDirs: string[] = [];
let realFetch: typeof globalThis.fetch;
let realTimeoutMs = 0;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  realFetch = globalThis.fetch;
  realTimeoutMs = (BotNotifierClient as unknown as { TIMEOUT_MS: number }).TIMEOUT_MS;
  savedEnv = {
    REIWA_URL: process.env.REIWA_URL,
    WEBHOOK_SECRET_HEADER: process.env.WEBHOOK_SECRET_HEADER,
    REZEIS_CRYPT_KEY: process.env.REZEIS_CRYPT_KEY,
    BACKUP_LOCATION: process.env.BACKUP_LOCATION,
    BOT_TOKEN: process.env.BOT_TOKEN,
  };
  process.env.REIWA_URL = 'https://reiwa.example.test';
  process.env.WEBHOOK_SECRET_HEADER = 'test-webhook-secret';
  process.env.REZEIS_CRYPT_KEY = 'test-crypt-key-0123456789abcdef';
  // A local token would send delivery down the DIRECT path and none of this
  // would exercise the relay.
  delete process.env.BOT_TOKEN;
  // The client's real 4s budget would stall the suite three times over.
  (BotNotifierClient as unknown as { TIMEOUT_MS: number }).TIMEOUT_MS = 5;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  (BotNotifierClient as unknown as { TIMEOUT_MS: number }).TIMEOUT_MS = realTimeoutMs;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

// ── The attempt counter this whole fix hangs on ─────────────────────────────

describe('which attempt is the last one, according to bullmq itself', () => {
  /**
   * Whether `attemptsMade` counts the running attempt or the finished ones
   * changed between bullmq majors, and an off-by-one here alerts the operator
   * on attempt 2 of 3 — or never. So this asks the installed `Job` rather than
   * trusting the docs: `shouldRetryJob` is the exact predicate the worker uses
   * to decide retry-vs-fail.
   */
  it('pins isFinalProcessorAttempt to the installed Job.shouldRetryJob', async () => {
    assert.equal(
      typeof (Job.prototype as unknown as Record<string, unknown>).shouldRetryJob,
      'function',
      'bullmq no longer exposes Job#shouldRetryJob — the attempt arithmetic below is ' +
        'unverified against the real retry gate and must be re-derived before trusting it',
    );

    const observed: { attemptsMade: number; bullmqRetries: boolean; ourVerdict: boolean }[] = [];
    for (let attemptsMade = 0; attemptsMade < JOB_ATTEMPTS; attemptsMade += 1) {
      observed.push({
        attemptsMade,
        bullmqRetries: await bullmqWouldRetry(attemptsMade, new Error('boom')),
        ourVerdict: isFinalProcessorAttempt({ attemptsMade, opts: JOB_OPTS }),
      });
    }

    // bullmq 5 bumps `attemptsMade` inside moveToFailed/moveToCompleted — after
    // the processor settles — so attempt N sees N-1 while it runs.
    assert.deepStrictEqual(observed, [
      { attemptsMade: 0, bullmqRetries: true, ourVerdict: false },
      { attemptsMade: 1, bullmqRetries: true, ourVerdict: false },
      { attemptsMade: 2, bullmqRetries: false, ourVerdict: true },
    ]);

    // Guard the guard: a bullmq that never retried would make "our verdict is
    // the negation of bullmq's" true at every row for the wrong reason.
    assert.ok(
      observed.some((row) => row.bullmqRetries),
      'bullmq retried nothing at all — this comparison proves nothing about the boundary',
    );
    for (const row of observed) {
      assert.equal(row.ourVerdict, !row.bullmqRetries, `disagreement at attemptsMade=${row.attemptsMade}`);
    }
  });

  it('counts one higher inside the failed event than inside the processor', () => {
    // `Worker.handleFailed` awaits `moveToFailed` — which increments
    // `attemptsMade` — and only then emits `failed`. Same attempt, two bases.
    for (let n = 1; n <= JOB_ATTEMPTS; n += 1) {
      const insideProcessor = n - 1;
      const insideFailedEvent = n;
      assert.equal(
        isFinalProcessorAttempt({ attemptsMade: insideProcessor, opts: JOB_OPTS }),
        n === JOB_ATTEMPTS,
        `processor view wrong on attempt ${n}`,
      );
      assert.equal(
        isFinalFailedAttempt({ attemptsMade: insideFailedEvent, opts: JOB_OPTS }),
        n === JOB_ATTEMPTS,
        `failed-event view wrong on attempt ${n}`,
      );
    }
  });
});

// ── Retry vs. terminal ──────────────────────────────────────────────────────

describe('a delivery failure worth repeating is repeated', () => {
  const retryable: readonly { label: string; fetch: FetchStub; status: string }[] = [
    { label: 'a request that times out', fetch: TIMES_OUT, status: 'timeout' },
    { label: 'a transport error', fetch: TRANSPORT_ERROR, status: 'failed' },
    { label: 'a 502 from the relay', fetch: REJECTED_502, status: 'rejected' },
  ];

  for (const mode of retryable) {
    it(`throws on ${mode.label} so bullmq spends all three attempts`, async () => {
      const run = await runJob(mode.fetch);

      // The retry configuration finally executes. Before this change the loop
      // ended after one pass, which is what makes this assertion the test.
      assert.equal(run.attempts, JOB_ATTEMPTS, 'bullmq did not retry — the processor returned instead of throwing');
      assert.equal(run.fetchCalls, JOB_ATTEMPTS, 'a retry that never re-contacted the relay is not a retry');
      assert.equal(run.errors.length, JOB_ATTEMPTS);
      for (const err of run.errors) {
        assert.match(err.message, /Backup Telegram delivery failed/);
      }

      // Exactly one alert across the whole sequence — not one per attempt.
      assert.equal(
        run.alerts.length,
        1,
        `operator alerts across ${run.attempts} attempts: ${JSON.stringify(run.alerts.map((a) => a.message))}`,
      );
      assert.equal(run.alerts[0]?.level, 'warn');
      assert.match(String(run.alerts[0]?.message), /Telegram relay did not confirm delivery/);
      assert.equal(run.alerts[0]?.meta.relayStatus, mode.status);
      assert.equal(run.alerts[0]?.meta.deliveredToTelegram, false);

      // The record tells the truth after every attempt, alert or no alert.
      assert.equal(run.updates.length, JOB_ATTEMPTS);
      for (const update of run.updates) {
        assert.equal(update.data.deliveryChannel, 'local');
        assert.equal(update.data.deliveryRecipient, `telegram_relay_${mode.status}`);
        assert.equal(update.data.deliveredAt, undefined, 'a backup nobody confirmed must not claim a delivery time');
      }
    });
  }
});

describe('a delivery failure nothing can fix is not repeated', () => {
  const terminal: readonly { label: string; fetch: FetchStub; status: string }[] = [
    { label: 'a 204 that carries no message id', fetch: UNCONFIRMED_204, status: 'unconfirmed' },
    { label: 'a 200 that names no Telegram message', fetch: UNCONFIRMED_200, status: 'unconfirmed' },
    { label: 'a 400 the relay will refuse identically', fetch: REJECTED_400, status: 'rejected' },
  ];

  for (const mode of terminal) {
    it(`does not throw on ${mode.label}`, async () => {
      const run = await runJob(mode.fetch);

      assert.equal(run.attempts, 1, 'a terminal failure was retried — three uploads to be told the same thing');
      assert.equal(run.fetchCalls, 1);
      assert.deepStrictEqual(run.errors, []);
      assert.deepStrictEqual(run.result, { delivered: false }, 'the job must still report the backup undelivered');

      // Terminal means nothing is coming after this, so it alerts immediately.
      assert.equal(run.alerts.length, 1);
      assert.equal(run.alerts[0]?.meta.relayStatus, mode.status);
      assert.equal(run.alerts[0]?.meta.deliveredToTelegram, false);

      assert.equal(run.updates.length, 1);
      assert.equal(run.updates[0]?.data.deliveryChannel, 'local');
      assert.equal(run.updates[0]?.data.deliveryRecipient, `telegram_relay_${mode.status}`);
    });
  }
});

describe('the retry is what the change is for', () => {
  it('rescues a backup whose first attempt timed out, and alarms nobody', async () => {
    // The payoff: a transient failure now ends with the file off-site instead
    // of a record saying "local" forever.
    let call = 0;
    const run = await runJob((url, init) => {
      call += 1;
      return call === 1 ? TIMES_OUT(url, init) : CONFIRMED(url, init);
    });

    assert.equal(run.attempts, 2, 'the second attempt never happened');
    assert.deepStrictEqual(run.result, { delivered: true });
    assert.deepStrictEqual(
      run.alerts,
      [],
      'a backup that arrived on the retry is not an incident worth waking anyone for',
    );

    // First attempt wrote the truth at the time; the second replaced it.
    assert.equal(run.updates.length, 2);
    assert.equal(run.updates[0]?.data.deliveryChannel, 'local');
    assert.equal(run.updates[1]?.data.deliveryChannel, 'telegram-relay');
    assert.equal(run.updates[1]?.data.deliveryRecipient, CHAT_ID);
    assert.ok(run.updates[1]?.data.deliveredAt instanceof Date);
  });

  it('leaves a first-attempt success exactly as it was', async () => {
    const run = await runJob(CONFIRMED);

    assert.equal(run.attempts, 1);
    assert.equal(run.fetchCalls, 1);
    assert.deepStrictEqual(run.errors, []);
    assert.deepStrictEqual(run.result, { delivered: true });
    assert.deepStrictEqual(run.alerts, []);
    assert.equal(run.updates.length, 1);
    assert.equal(run.updates[0]?.data.deliveryChannel, 'telegram-relay');
    assert.ok(run.updates[0]?.data.deliveredAt instanceof Date);
    assert.deepStrictEqual(run.progress, [
      { stage: 'uploading', percent: 30 },
      { stage: 'completed', percent: 100 },
    ]);
  });
});

// ── onFailed ────────────────────────────────────────────────────────────────

describe('the failed-job handler does not repeat what delivery already said', () => {
  it('adds no SYSTEM_ERROR when an exhausted delivery has alerted for itself', async () => {
    const run = await runJob(TIMES_OUT);

    assert.equal(run.attempts, JOB_ATTEMPTS);
    assert.equal(run.onFailedCalls, JOB_ATTEMPTS, 'bullmq emits `failed` on every attempt, not just the last');
    // One alert for three failed attempts and three `failed` events. Both the
    // per-attempt alert and the onFailed duplicate would show up here.
    assert.equal(run.alerts.length, 1);
    assert.deepStrictEqual(
      run.alerts.filter((a) => a.type === 'system.error'),
      [],
      'the delivery path already named the backup and the relay status; a job-id SYSTEM_ERROR is the same incident twice',
    );
  });

  it('still alerts once for a delivery failure nothing else reported', async () => {
    // A Prisma outage in `loadTelegramConfig` escapes the delivery path
    // untouched: no record write, no warn, nothing told the operator. That is
    // exactly what onFailed is for — but once, not once per attempt.
    const h = buildHarness(CONFIRMED, {
      settingsFindFirst: async () => {
        throw new Error('the database is not accepting connections');
      },
    });
    const run = await drive(h);

    assert.equal(run.attempts, JOB_ATTEMPTS, 'an unexpected error must still consume the configured attempts');
    assert.equal(run.onFailedCalls, JOB_ATTEMPTS);
    assert.equal(run.alerts.length, 1, `alerts: ${JSON.stringify(run.alerts.map((a) => a.message))}`);
    assert.equal(run.alerts[0]?.type, 'system.error');
    assert.equal(run.alerts[0]?.level, 'error');
    assert.match(String(run.alerts[0]?.message), /not accepting connections/);
    assert.equal(run.alerts[0]?.meta.jobName, BACKUP_JOBS.DELIVER_TELEGRAM);
  });
});

// ── Harness ─────────────────────────────────────────────────────────────────

interface RecordedEvent {
  readonly level: 'info' | 'warn' | 'error';
  readonly type: string;
  readonly message: string;
  readonly meta: Record<string, unknown>;
}

interface Harness {
  readonly processor: BackupProcessor;
  readonly alerts: RecordedEvent[];
  readonly updates: { readonly data: Record<string, unknown> }[];
  readonly progress: unknown[];
  readonly filename: string;
  fetchCalls: number;
}

interface Run {
  readonly attempts: number;
  readonly fetchCalls: number;
  readonly onFailedCalls: number;
  readonly errors: Error[];
  readonly result: unknown;
  readonly alerts: readonly RecordedEvent[];
  readonly updates: readonly { readonly data: Record<string, unknown> }[];
  readonly progress: readonly unknown[];
}

function buildHarness(
  fetchStub: FetchStub,
  options: { readonly settingsFindFirst?: () => Promise<unknown> } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'rezeis-backup-retry-'));
  tempDirs.push(dir);
  process.env.BACKUP_LOCATION = dir;
  const filename = 'rezeis-db-2026-06-01.sql.gz';
  writeFileSync(join(dir, filename), 'not-a-real-dump');

  const alerts: RecordedEvent[] = [];
  const updates: { data: Record<string, unknown> }[] = [];
  const progress: unknown[] = [];
  const harness = { alerts, updates, progress, filename, fetchCalls: 0 } as Harness;

  globalThis.fetch = ((url: unknown, init: { signal?: AbortSignal }) => {
    harness.fetchCalls += 1;
    return fetchStub(url, init ?? {});
  }) as unknown as typeof globalThis.fetch;

  // One recorder shared by the service AND the processor: an alert emitted
  // from either place lands in the same list, so a duplicate cannot hide in
  // the handler this test is not looking at.
  const record =
    (level: RecordedEvent['level']) =>
    (type: string, _category: string, message: string, meta?: Record<string, unknown>) => {
      alerts.push({ level, type, message, meta: meta ?? {} });
    };
  const systemEvents = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  } as never;

  const service = new BackupService(
    { host: 'postgres', port: 5432, user: 'rezeis', password: 'nope', name: 'rezeis' } as never,
    {
      settings: {
        findFirst:
          options.settingsFindFirst ??
          (async () => ({
            systemNotifications: {
              backup: { telegram: { enabled: true, chatId: CHAT_ID, topicId: 7 } },
            },
          })),
      },
      backupRecord: {
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args);
          return args;
        },
      },
    } as never,
    systemEvents,
    { getDecryptedBotToken: async () => null } as never,
    { add: async () => ({ id: 'job-1' }) } as never,
    new BotNotifierClient(),
  );

  return Object.assign(harness, {
    processor: new BackupProcessor(service, systemEvents, { rehydrateMissingAssets: async () => null } as never),
  });
}

function runJob(fetchStub: FetchStub): Promise<Run> {
  return drive(buildHarness(fetchStub));
}

/**
 * Steps the job the way BullMQ steps it:
 *   process → (throw) → moveToFailed increments attemptsMade → emit `failed`
 *   → retry or stop, per `Job#shouldRetryJob`.
 * The stop condition comes from bullmq, not from this file, so a wrong belief
 * about `attemptsMade` in the production code cannot be mirrored here.
 */
async function drive(h: Harness): Promise<Run> {
  let attemptsMade = 0;
  let attempts = 0;
  let onFailedCalls = 0;
  let result: unknown = undefined;
  const errors: Error[] = [];

  for (;;) {
    attempts += 1;
    assert.ok(attempts <= JOB_ATTEMPTS + 1, 'the attempt loop ran past the configured attempts — retry gate broken');
    const job = {
      id: `job-${attempts}`,
      name: BACKUP_JOBS.DELIVER_TELEGRAM,
      data: { recordId: 'backup-1', filename: h.filename },
      attemptsMade,
      opts: JOB_OPTS,
      updateProgress: async (stage: unknown) => {
        h.progress.push(stage);
      },
    };

    let thrown: Error | null = null;
    try {
      result = await h.processor.process(job as never);
    } catch (err) {
      thrown = err as Error;
    }
    if (thrown === null) break;

    errors.push(thrown);
    result = undefined; // a throwing attempt returns nothing to the queue
    const retries = await bullmqWouldRetry(attemptsMade, thrown);
    attemptsMade += 1; // moveToFailed bumps it before the event fires
    onFailedCalls += 1;
    h.processor.onFailed({ ...job, attemptsMade } as never, thrown);
    if (!retries) break;
  }

  return {
    attempts,
    fetchCalls: h.fetchCalls,
    onFailedCalls,
    errors,
    result,
    alerts: h.alerts,
    updates: h.updates,
    progress: h.progress,
  };
}

/** The installed bullmq's own retry gate, driven directly. */
async function bullmqWouldRetry(attemptsMade: number, err: Error): Promise<boolean> {
  const job = Object.create(Job.prototype) as {
    attemptsMade: number;
    discarded: boolean;
    opts: unknown;
    queue: unknown;
    shouldRetryJob: (e: Error) => Promise<[boolean, number]>;
  };
  job.attemptsMade = attemptsMade;
  job.discarded = false;
  job.opts = JOB_OPTS;
  job.queue = { opts: {}, name: 'backup' };
  const [shouldRetry] = await job.shouldRetryJob(err);
  return shouldRetry;
}
