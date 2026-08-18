import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { BackupService } from '../src/modules/backup/services/backup.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';

/**
 * A backup is only "delivered" once something delivered it
 * ───────────────────────────────────────────────────────
 * The relay path hands reiwa a signed download token and lets the bot fetch
 * and upload the file. `BotNotifierClient.deliver` reports every outcome —
 * a 502, an empty 204, a transport that gave up, a socket error — by
 * RETURNING, never by throwing. `deliverToTelegram` used to wrap that call in a `try`
 * and stamp `deliveryChannel: 'telegram-relay'` + `deliveredAt` on the path
 * after it, which is taken unconditionally; the `catch` could not run. Every
 * failed relay was therefore recorded as a successful off-site delivery, and
 * retention later deleted the local file of a backup that existed nowhere.
 *
 * The direct-token path immediately above has always gated on `response.ok`.
 * These tests hold the relay path to the same standard.
 *
 * Nothing here stubs the notifier. A stub would only prove that a fake
 * returning `{status:'rejected'}` makes the service refuse — it would say
 * nothing about whether the real client EVER returns that for a 502. So the
 * real `BotNotifierClient` is wired to the real `BackupService` and only
 * `fetch` is replaced. The wiring itself is what is on trial, and the
 * `confirmed` control at the bottom fails loudly if this harness ever stops
 * reaching the relay path at all.
 */

const CHAT_ID = '-1001234567890';

interface Harness {
  readonly service: BackupService;
  readonly updates: { readonly where: unknown; readonly data: Record<string, unknown> }[];
  readonly warnings: { readonly message: string; readonly meta: Record<string, unknown> }[];
  readonly fetchCalls: string[];
  /**
   * The `AbortSignal` (if any) the client armed for each call. This route must
   * see `undefined`: `relayRequestTimeoutMs` gives `reiwa.backup.document` no
   * total deadline, because the bot answers only after streaming a file that
   * can be gigabytes, and an abort would surface as an outcome this very
   * service retries — turning one slow backup into three copies in the topic.
   */
  readonly fetchSignals: (AbortSignal | undefined)[];
  readonly backupDir: string;
  readonly filename: string;
}

type FetchStub = (url: unknown, init: { signal?: AbortSignal }) => Promise<unknown>;

let tempDirs: string[] = [];
let realFetch: typeof globalThis.fetch;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  realFetch = globalThis.fetch;
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
  // A local bot token would send `deliverToTelegram` down the DIRECT path and
  // these tests would silently stop exercising the relay.
  delete process.env.BOT_TOKEN;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('a failed Telegram relay is not recorded as an off-site delivery', () => {
  /**
   * Every way `deliver()` can come back without proof of delivery. The names
   * are the statuses the client assigns, and each row drives a different
   * branch of it — these are four distinct events, not four spellings of one.
   */
  const failureModes: readonly {
    readonly label: string;
    readonly expectedStatus: string;
    readonly fetch: FetchStub;
  }[] = [
    {
      label: 'a non-2xx response',
      expectedStatus: 'rejected',
      fetch: async () => ({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => ({}) }),
    },
    {
      label: 'a 204 with no body to carry a message id',
      expectedStatus: 'unconfirmed',
      fetch: async () => ({
        ok: true,
        status: 204,
        statusText: 'No Content',
        json: async () => {
          throw new Error('204 has no body');
        },
      }),
    },
    {
      label: 'a 200 that names no Telegram message',
      expectedStatus: 'unconfirmed',
      fetch: async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({}) }),
    },
    {
      // Not the client's own abort: this route arms none, deliberately. What
      // ends a wedged backup relay is the TRANSPORT giving up — undici's idle
      // defaults — which arrives as a rejection with no `timedOut` flag set,
      // so the client reports `failed`. `isRetryableRelayOutcome` treats that
      // exactly as it treated `timeout`, so nothing about the retry decision
      // moved; only the name of the thing that fired did. The client's own
      // deadline, on the routes that have one, is held up by
      // `test/reiwa-relay-timeout-budget.spec.ts`.
      label: 'a transport that gave up on a request nobody deadlined',
      expectedStatus: 'failed',
      fetch: async () => {
        const err = new Error('Headers Timeout Error');
        err.name = 'HeadersTimeoutError';
        throw err;
      },
    },
    {
      label: 'a transport error thrown before any response',
      expectedStatus: 'failed',
      fetch: async () => {
        throw new Error('ECONNREFUSED 10.0.0.5:443');
      },
    },
  ];

  for (const mode of failureModes) {
    it(`refuses to mark the backup delivered after ${mode.label}`, async () => {
      const h = buildHarness(mode.fetch);

      const delivered = await h.service.deliverToTelegram('backup-1', h.filename);

      // The harness really did reach the relay — otherwise every assertion
      // below would be satisfied by a method that bailed out before trying.
      assert.equal(
        h.fetchCalls.length,
        1,
        'the relay was never attempted — this test proved nothing about relay failure handling',
      );
      assert.match(h.fetchCalls[0] ?? '', /reiwa\.example\.test/);
      assert.equal(
        h.fetchSignals[0],
        undefined,
        'a total deadline on this route cuts a legitimate multi-gigabyte upload, and the ' +
          'cut is retried into a second copy — the cabinet passes `null` here for the ' +
          'same reason (`relayToBot(..., null)`)',
      );

      assert.equal(delivered, false, 'a relay that proved nothing must not report success');

      const claimsDelivery = h.updates.filter(
        (u) =>
          u.data.deliveryChannel === 'telegram-relay' ||
          u.data.deliveryChannel === 'telegram' ||
          u.data.deliveredAt !== undefined,
      );
      assert.deepStrictEqual(
        claimsDelivery,
        [],
        'the record claims an off-site copy that was never proven to exist',
      );

      // What it says instead: still local, and why.
      assert.equal(h.updates.length, 1);
      assert.equal(h.updates[0]?.data.deliveryChannel, 'local');
      assert.equal(
        h.updates[0]?.data.deliveryRecipient,
        `telegram_relay_${mode.expectedStatus}`,
        'the recorded reason must name the outcome the real client produced, ' +
          'so a misclassified failure mode shows up here rather than passing quietly',
      );

      // And the operator hears about it now, not at restore time.
      assert.equal(h.warnings.length, 1, 'a silently undelivered backup is the whole defect');
      assert.equal(h.warnings[0]?.meta.deliveredToTelegram, false);
      assert.equal(h.warnings[0]?.meta.relayStatus, mode.expectedStatus);
    });
  }

  it('still records a confirmed relay exactly as before', async () => {
    // The control. If the harness above ever stops reaching the relay path —
    // wrong env, missing file, size cap, a config typo — this goes red, so the
    // five failure tests above cannot all pass by never getting that far.
    const h = buildHarness(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ messageId: 4242 }),
    }));

    const delivered = await h.service.deliverToTelegram('backup-1', h.filename);

    assert.equal(delivered, true);
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.updates.length, 1);
    assert.equal(h.updates[0]?.data.deliveryChannel, 'telegram-relay');
    assert.equal(h.updates[0]?.data.deliveryRecipient, CHAT_ID);
    assert.ok(h.updates[0]?.data.deliveredAt instanceof Date);
    assert.deepStrictEqual(h.warnings, [], 'a successful delivery must not alarm anybody');
  });
});

describe('retention spends duplicated copies before sole ones', () => {
  it('keeps the local file of a backup that never went off-site and prunes one Telegram is holding', async () => {
    const { service, dir, deleted, warnings } = buildRetentionHarness({
      maxKeep: 2,
      telegramEnabled: true,
      // newest → oldest
      records: [
        { id: 'r1', filename: 'newest.sql.gz', deliveryChannel: 'telegram-relay' },
        { id: 'r2', filename: 'safe-offsite.sql.gz', deliveryChannel: 'telegram-relay' },
        { id: 'r3', filename: 'only-copy.sql.gz', deliveryChannel: 'local' },
      ],
    });

    await runRetention(service);

    // The sole copy outlives the duplicate, and the newest stays local so
    // "restore the latest" needs no round trip to Telegram.
    assert.ok(existsSync(join(dir, 'only-copy.sql.gz')), 'retention deleted the only copy of a backup');
    assert.ok(existsSync(join(dir, 'newest.sql.gz')), 'the newest backup must stay local');
    assert.ok(!existsSync(join(dir, 'safe-offsite.sql.gz')));

    assert.deepStrictEqual(deleted, ['r2'], 'exactly one record should have been pruned');
    assert.deepStrictEqual(warnings, [], 'pruning a file Telegram still holds is not data loss');
  });

  it('still prunes to maxKeep, and says so when the file it deletes was the only copy', async () => {
    const { service, dir, deleted, warnings } = buildRetentionHarness({
      maxKeep: 1,
      telegramEnabled: true,
      records: [
        { id: 'r1', filename: 'newest.sql.gz', deliveryChannel: 'local' },
        { id: 'r2', filename: 'doomed.sql.gz', deliveryChannel: 'local' },
      ],
    });

    await runRetention(service);

    // Retention is not disabled by an undelivered backup — the disk bound is
    // unchanged. What changes is that its loss is announced.
    assert.ok(existsSync(join(dir, 'newest.sql.gz')));
    assert.ok(!existsSync(join(dir, 'doomed.sql.gz')));
    assert.deepStrictEqual(deleted, ['r2']);

    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.message), /only copy of doomed\.sql\.gz/);
    assert.equal(warnings[0]?.meta.deliveredToTelegram, false);
  });

  it('leaves the count-and-recency policy untouched when every backup is off-site', async () => {
    // The no-op case that guards against the reordering above quietly changing
    // retention for deployments where delivery works.
    const { service, dir, deleted } = buildRetentionHarness({
      maxKeep: 2,
      telegramEnabled: true,
      records: [
        { id: 'r1', filename: 'a.sql.gz', deliveryChannel: 'telegram-relay' },
        { id: 'r2', filename: 'b.sql.gz', deliveryChannel: 'telegram' },
        { id: 'r3', filename: 'c.sql.gz', deliveryChannel: 'telegram-relay' },
      ],
    });

    await runRetention(service);

    assert.deepStrictEqual(deleted, ['r3'], 'oldest-first must still be the rule among equals');
    assert.ok(existsSync(join(dir, 'a.sql.gz')));
    assert.ok(existsSync(join(dir, 'b.sql.gz')));
    assert.ok(!existsSync(join(dir, 'c.sql.gz')));
  });

  it('does not alarm an operator who never asked for off-site copies', async () => {
    const { service, deleted, warnings } = buildRetentionHarness({
      maxKeep: 1,
      telegramEnabled: false,
      records: [
        { id: 'r1', filename: 'a.sql.gz', deliveryChannel: 'local' },
        { id: 'r2', filename: 'b.sql.gz', deliveryChannel: 'local' },
      ],
    });

    await runRetention(service);

    assert.deepStrictEqual(deleted, ['r2']);
    assert.deepStrictEqual(warnings, [], 'local-only is a choice, not an incident');
  });
});

// ── Harnesses ───────────────────────────────────────────────────────────────

function makeBackupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rezeis-backup-test-'));
  tempDirs.push(dir);
  process.env.BACKUP_LOCATION = dir;
  return dir;
}

function buildHarness(fetchStub: FetchStub): Harness {
  const dir = makeBackupDir();
  const filename = 'rezeis-db-2026-06-01.sql.gz';
  writeFileSync(join(dir, filename), 'not-a-real-dump');

  const fetchCalls: string[] = [];
  const fetchSignals: (AbortSignal | undefined)[] = [];
  globalThis.fetch = ((url: unknown, init: { signal?: AbortSignal }) => {
    fetchCalls.push(String(url));
    fetchSignals.push(init?.signal);
    return fetchStub(url, init ?? {});
  }) as unknown as typeof globalThis.fetch;

  const updates: { where: unknown; data: Record<string, unknown> }[] = [];
  const warnings: { message: string; meta: Record<string, unknown> }[] = [];

  const service = new BackupService(
    dbConfig(),
    {
      settings: {
        findFirst: async () => ({
          systemNotifications: {
            backup: { telegram: { enabled: true, chatId: CHAT_ID, topicId: 7 } },
          },
        }),
      },
      backupRecord: {
        update: async (args: { where: unknown; data: Record<string, unknown> }) => {
          updates.push(args);
          return args;
        },
      },
    } as never,
    {
      info: () => undefined,
      error: () => undefined,
      warn: (_type: string, _cat: string, message: string, meta: Record<string, unknown>) => {
        warnings.push({ message, meta });
      },
    } as never,
    { getDecryptedBotToken: async () => null } as never,
    { add: async () => ({ id: 'job-1' }) } as never,
    new BotNotifierClient(),
  );

  return { service, updates, warnings, fetchCalls, fetchSignals, backupDir: dir, filename };
}

function buildRetentionHarness(input: {
  readonly maxKeep: number;
  readonly telegramEnabled: boolean;
  readonly records: readonly { id: string; filename: string; deliveryChannel: string }[];
}): {
  readonly service: BackupService;
  readonly dir: string;
  readonly deleted: string[];
  readonly warnings: { readonly message: string; readonly meta: Record<string, unknown> }[];
} {
  const dir = makeBackupDir();
  for (const row of input.records) writeFileSync(join(dir, row.filename), 'dump');

  const deleted: string[] = [];
  const warnings: { message: string; meta: Record<string, unknown> }[] = [];

  const service = new BackupService(
    dbConfig(),
    {
      settings: {
        findFirst: async () => ({
          systemNotifications: {
            backup: {
              maxKeep: input.maxKeep,
              telegram: { enabled: input.telegramEnabled, chatId: CHAT_ID },
            },
          },
        }),
      },
      backupRecord: {
        // `findMany` is ordered createdAt-desc in production; the fixture is
        // written newest-first to match.
        findMany: async () => input.records.map((r) => ({ ...r })),
        delete: async (args: { where: { id: string } }) => {
          deleted.push(args.where.id);
          return args;
        },
      },
    } as never,
    {
      info: () => undefined,
      error: () => undefined,
      warn: (_type: string, _cat: string, message: string, meta: Record<string, unknown>) => {
        warnings.push({ message, meta });
      },
    } as never,
    { getDecryptedBotToken: async () => null } as never,
    { add: async () => ({ id: 'job-1' }) } as never,
  );

  return { service, dir, deleted, warnings };
}

/** `applyRetention` is private and reached only through `runDump`, which spawns pg_dump. */
async function runRetention(service: BackupService): Promise<void> {
  await (service as unknown as { applyRetention: () => Promise<void> }).applyRetention();
}

function dbConfig(): never {
  return {
    host: 'postgres',
    port: 5432,
    user: 'rezeis',
    password: 'not-a-real-password',
    name: 'rezeis',
  } as never;
}
