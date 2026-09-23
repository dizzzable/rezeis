import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable, Transform, Writable } from 'node:stream';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import * as zlib from 'node:zlib';

import { BackupService } from '../src/modules/backup/services/backup.service';

// `require`, not namespace imports: under `esModuleInterop` a namespace import
// is compiled to a COPY of the module's properties, and patching a copy patches
// nothing the service can see. These are the objects it calls `spawn`,
// `createWriteStream` and `createGzip` on.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess: typeof import('node:child_process') = require('node:child_process');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsModule: typeof import('node:fs') = require('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const zlibModule: typeof import('node:zlib') = require('node:zlib');
/** Taken before any case replaces them: some doubles are real processes, some destinations real files. */
const realSpawn = childProcess.spawn;
const realCreateWriteStream = fsModule.createWriteStream;
const realOpen = fsModule.open;
const realUnlink = fsModule.promises.unlink;

/**
 * A backup whose file cannot be written must not leave pg_dump running
 * ════════════════════════════════════════════════════════════════════
 * `runDump` streams `pg_dump | gzip` into the backup file. When the file side
 * failed half-way — the volume full (ENOSPC), a quota (EDQUOT), an I/O error —
 * only the promise heard about it. `pipe` unpiped the dead file stream, gzip
 * filled up and paused, the pipe to pg_dump filled, and pg_dump blocked in
 * write(2) for good: inside its REPEATABLE READ snapshot, with an
 * AccessShareLock on every table it had reached and a database connection, until
 * the API or worker restarted. Every further failing backup left one more, and a
 * restore's `--clean` DROPs queued behind those locks with no timeout. gzip
 * failing was worse: it had no error listener at all, so its error was an
 * uncaught exception, and the job never settled.
 *
 * pg_dump is replaced by doubles that behave like it at its pipe: it writes for
 * as long as it is read and blocks when it is not. Where the pipe itself is the
 * question, the double is a real child process.
 */

let directory: string;
let previousLocation: string | undefined;
let previousCryptKey: string | undefined;
/** Real child processes started by a case, stopped if the case left one running. */
const liveChildren = new Set<ChildProcess>();

before(async () => {
  previousLocation = process.env.BACKUP_LOCATION;
  previousCryptKey = process.env.REZEIS_CRYPT_KEY;
  directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'rezeis-dump-output-'));
  process.env.BACKUP_LOCATION = directory;
  // Stamping is not the question here; with a key it would only append to the file.
  delete process.env.REZEIS_CRYPT_KEY;
});

after(async () => {
  if (previousLocation === undefined) delete process.env.BACKUP_LOCATION;
  else process.env.BACKUP_LOCATION = previousLocation;
  if (previousCryptKey !== undefined) process.env.REZEIS_CRYPT_KEY = previousCryptKey;
  await fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

afterEach(() => {
  mock.restoreAll();
  for (const child of liveChildren) child.kill();
  liveChildren.clear();
});

interface JobRecord {
  /** `backupRecord.update` calls, in order. */
  readonly updates: Array<{ readonly where: unknown; readonly data: Record<string, unknown> }>;
  /** System events: `[kind, message]`. */
  readonly events: Array<readonly [string, string]>;
}

function createService(record: JobRecord): BackupService {
  const prisma = {
    backupRecord: {
      update: async (input: { where: unknown; data: Record<string, unknown> }) => {
        record.updates.push(input);
        return {};
      },
      // Retention after a success: nothing to prune.
      findMany: async () => [],
      delete: async () => ({}),
    },
    settings: { findFirst: async () => null },
  };
  const systemEvents = {
    info: () => undefined,
    warn: () => undefined,
    error: (_type: string, _category: string, message: string) => {
      record.events.push(['error', message]);
    },
    emit: (event: { readonly message: string }) => {
      record.events.push(['emit', event.message]);
    },
  };
  return new BackupService(
    { host: 'postgres', port: 5432, user: 'rezeis', password: 'not-a-real-password', name: 'rezeis' } as never,
    prisma as never,
    systemEvents as never,
    { getDecryptedBotToken: async () => null } as never,
    { add: async () => ({ id: 'job-1' }) } as never,
  );
}

function newRecord(): JobRecord {
  return { updates: [], events: [] };
}

type FakeDump = EventEmitter & {
  stdout: Readable;
  stderr: PassThrough;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
};

/** How a ChildProcess ends: 'exit', its pipes closed, then 'close'. */
function endDump(child: FakeDump, code: number | null, signal: NodeJS.Signals | null): void {
  if (signal === null) child.exitCode = code;
  else child.signalCode = signal;
  child.emit('exit', code, signal);
  child.stdout.destroy();
  child.stderr.end();
  child.emit('close', code, signal);
}

/**
 * pg_dump against a database larger than the volume: it writes for as long as
 * its output is read and never finishes on its own. Nothing reading means
 * `read()` is not called and nothing more is produced — pg_dump waiting in
 * write(2). The bytes are random, so gzip passes them to the file as fast as
 * pg_dump produces them. Killed, it ends the way a process does.
 */
function installEndlessPgDump(kills: string[]): { readonly produced: () => number } {
  let produced = 0;
  mock.method(childProcess, 'spawn', (command: string) => {
    const child = new EventEmitter() as FakeDump;
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new Readable({
      highWaterMark: 64 * 1024,
      read() {
        const chunk = randomBytes(64 * 1024);
        produced += chunk.length;
        this.push(chunk);
      },
    });
    child.stderr = new PassThrough();
    child.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
      kills.push(`kill ${command}`);
      if (child.exitCode !== null || child.signalCode !== null) return false;
      setImmediate(() => endDump(child, null, signal));
      return true;
    };
    return child;
  });
  return { produced: () => produced };
}

/** What write(2) fails with on a full volume. */
function noSpaceLeft(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), {
    code: 'ENOSPC',
    errno: -28,
    syscall: 'write',
  });
}

/**
 * The backup file, on a volume that fills up after `capacity` bytes: the write
 * that does not fit fails, and the stream destroys itself as a file stream does.
 */
function installFullVolume(capacity: number): { readonly accepted: () => number } {
  let accepted = 0;
  mock.method(fsModule, 'createWriteStream', (destination: string, options?: unknown) => {
    if (typeof destination !== 'string' || !destination.startsWith(directory)) {
      return realCreateWriteStream(destination, options as never);
    }
    return new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (accepted + chunk.length > capacity) {
          callback(noSpaceLeft());
          return;
        }
        accepted += chunk.length;
        callback();
      },
    });
  });
  return { accepted: () => accepted };
}

/**
 * Errors nobody handled while `work` ran. The test runner fails a case on one
 * too, but it cannot say what the process would have done: with no listener in
 * the API or the worker, that is the process exiting.
 */
function recordUncaughtExceptions(): { readonly errors: unknown[]; readonly stop: () => void } {
  const errors: unknown[] = [];
  const listener = (error: unknown): void => {
    errors.push(error);
  };
  process.on('uncaughtException', listener);
  return { errors, stop: () => process.removeListener('uncaughtException', listener) };
}

type Outcome<T> =
  | { readonly status: 'resolved'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown }
  | { readonly status: 'still pending' };

/** How `work` ended within `ms`, or that it had not: a job that never settles is the defect, not a slow test. */
async function outcomeWithin<T>(work: Promise<T>, ms: number): Promise<Outcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'still pending' }), ms);
  });
  try {
    return await Promise.race([
      work.then(
        (value): Outcome<T> => ({ status: 'resolved', value }),
        (reason: unknown): Outcome<T> => ({ status: 'rejected', reason }),
      ),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Time for an error raised after the verdict — a failed write, a late close — to surface. */
function afterStragglers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

/**
 * The job's output file, and the write stream that creates it. `closed()`
 * settles once that stream has closed — opened, written to or not, closed
 * again — which, not a fixed pause, is the moment after which the file can no
 * longer appear.
 */
function watchOutputFile(filename: string): { readonly file: string; readonly closed: () => Promise<void> } {
  const file = path.join(directory, filename);
  let closed: Promise<void> | undefined;
  mock.method(fsModule, 'createWriteStream', (destination: string, options?: unknown) => {
    const stream = realCreateWriteStream(destination, options as never);
    if (path.resolve(destination) === path.resolve(file)) {
      closed = new Promise<void>((resolve) => {
        stream.once('close', () => resolve());
      });
    }
    return stream;
  });
  return {
    file,
    closed: async () => {
      assert.ok(closed !== undefined, 'the job never created its output file');
      await closed;
    },
  };
}

/** Settles once the job has tried to remove `file`, whatever the attempt found there. */
function whenRemovalTried(file: string): Promise<void> {
  return new Promise<void>((tried) => {
    mock.method(fsModule.promises, 'unlink', async (target: Parameters<typeof realUnlink>[0]) => {
      try {
        return await realUnlink(target);
      } finally {
        if (typeof target === 'string' && path.resolve(target) === path.resolve(file)) tried();
      }
    });
  });
}

/**
 * Holds the open that creates `file` back until `release` settles, or 250 ms
 * pass. A real `fs.WriteStream` opens through this very `fs` object, and
 * asynchronously: this is the window a loaded machine opens by accident, held
 * open on purpose. The 250 ms bound is what a job that waits for its file gets.
 */
function holdOpenOf(file: string, release: Promise<unknown>): void {
  const opening = realOpen as unknown as (...args: unknown[]) => void;
  mock.method(fsModule, 'open', ((...args: unknown[]) => {
    const target = args[0];
    if (typeof target !== 'string' || path.resolve(target) !== path.resolve(file)) {
      opening(...args);
      return;
    }
    void Promise.race([release, new Promise<void>((resolve) => setTimeout(resolve, 250))]).then(() => opening(...args));
  }) as unknown as typeof fsModule.open);
}

function runDump(service: BackupService, filename: string): Promise<{ sizeBytes: number; checksum: string }> {
  return service.runDump('backup-1', filename, 'DB', 'admin-1', false);
}

/**
 * The job's own account of the failure: the record the «Бэкапы» page shows.
 *
 * And no card. `BackupProcessor.onFailed` sends the one card, on the last
 * attempt; this path used to send one on every attempt as well — three cards
 * for one backup that did not happen. Not even a «completed» one, of course.
 */
function assertFailureRecorded(record: JobRecord, pattern: RegExp): void {
  assert.equal(record.updates.length, 1, `one update of the backup record: ${JSON.stringify(record.updates)}`);
  assert.match(String(record.updates[0]!.data['errorMessage']), pattern);
  assert.deepEqual(record.events, [], `runDump sends no card of its own: ${JSON.stringify(record.events)}`);
}

describe('BackupService.runDump — a backup file that cannot be written ends pg_dump too', () => {
  it('kills pg_dump and fails the job when the volume fills up half-way', { timeout: 20_000 }, async () => {
    const kills: string[] = [];
    const dump = installEndlessPgDump(kills);
    const volume = installFullVolume(1024 * 1024);
    const record = newRecord();

    const uncaught = recordUncaughtExceptions();
    try {
      const outcome = await outcomeWithin(runDump(createService(record), 'full-volume.sql.gz'), 10_000);
      assert.equal(outcome.status, 'rejected', `the job must fail, got ${outcome.status}`);
      const reason = (outcome as { readonly reason: unknown }).reason;
      assert.equal((reason as NodeJS.ErrnoException).code, 'ENOSPC', `the operator must see why: ${String(reason)}`);
      await afterStragglers();
      assert.deepStrictEqual(uncaught.errors.map(String), [], 'an unhandled stream error takes the API or worker process down');
    } finally {
      uncaught.stop();
    }

    // Vacuity guard: the failure has to come half-way, with pg_dump still writing.
    assert.ok(volume.accepted() > 0, 'the file must have taken part of the dump before the volume filled');
    assert.ok(dump.produced() > volume.accepted(), 'pg_dump must have had more to write than the volume took');

    assert.deepStrictEqual(kills, ['kill pg_dump'], 'pg_dump must be killed, once, rather than left blocked on its pipe');
    assertFailureRecorded(record, /ENOSPC/);
  });

  it('kills pg_dump when gzip fails half-way, and nothing is thrown past the job', { timeout: 20_000 }, async () => {
    const kills: string[] = [];
    installEndlessPgDump(kills);
    installFullVolume(Number.MAX_SAFE_INTEGER);
    const gzipFailure = new Error('zlib: insufficient memory');
    let passed = 0;
    mock.method(zlibModule, 'createGzip', () => new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        passed += chunk.length;
        if (passed > 1024 * 1024) {
          callback(gzipFailure);
          return;
        }
        callback(null, chunk);
      },
    }));
    const record = newRecord();

    const uncaught = recordUncaughtExceptions();
    try {
      const outcome = await outcomeWithin(runDump(createService(record), 'gzip-fails.sql.gz'), 10_000);
      await afterStragglers();
      assert.deepStrictEqual(uncaught.errors.map(String), [], 'an unhandled stream error takes the API or worker process down');
      assert.equal(outcome.status, 'rejected', `the job must fail, got ${outcome.status}`);
      assert.equal((outcome as { readonly reason: unknown }).reason, gzipFailure);
    } finally {
      uncaught.stop();
    }

    assert.deepStrictEqual(kills, ['kill pg_dump'], 'pg_dump must be killed, once, rather than left blocked on its pipe');
    assertFailureRecorded(record, /insufficient memory/);
  });

  it('through a real pipe: pg_dump blocked on a full pipe is ended by the failure, not left running', { timeout: 30_000 }, async () => {
    // The stand-in writes into a real OS pipe for as long as it is read, like
    // pg_dump on a large database, and never exits by itself.
    const source = [
      "const { randomBytes } = require('node:crypto');",
      'function write() {',
      '  while (process.stdout.write(randomBytes(64 * 1024)));',
      "  process.stdout.once('drain', write);",
      '}',
      'write();',
    ].join('\n');
    let child: ChildProcess | undefined;
    let exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> | undefined;
    mock.method(childProcess, 'spawn', (_command: string, _args: readonly string[], options?: SpawnOptions) => {
      const started = realSpawn(process.execPath, ['-e', source], { ...(options ?? {}) });
      liveChildren.add(started);
      exited = new Promise((resolve) => {
        started.once('exit', (code, signal) => {
          liveChildren.delete(started);
          resolve({ code, signal });
        });
      });
      child = started;
      return started;
    });
    installFullVolume(4 * 1024 * 1024);
    const record = newRecord();

    const uncaught = recordUncaughtExceptions();
    try {
      const outcome = await outcomeWithin(runDump(createService(record), 'real-pipe.sql.gz'), 15_000);
      assert.equal(outcome.status, 'rejected', `the job must fail, got ${outcome.status}`);
      assert.equal(((outcome as { readonly reason: unknown }).reason as NodeJS.ErrnoException).code, 'ENOSPC');
      await afterStragglers();
      assert.deepStrictEqual(uncaught.errors.map(String), [], 'an unhandled stream error takes the API or worker process down');
    } finally {
      uncaught.stop();
    }

    assert.ok(child !== undefined && exited !== undefined, 'pg_dump must have been started');
    const ended = await outcomeWithin(exited, 5_000);
    assert.equal(ended.status, 'resolved', 'pg_dump is still running, blocked on a pipe nothing reads');
    assert.deepStrictEqual(
      (ended as { readonly value: unknown }).value,
      { code: null, signal: 'SIGTERM' },
      'ended by the kill, before its pipe was torn down under it',
    );
    assertFailureRecorded(record, /ENOSPC/);
  });
});

describe('BackupService.runDump — what a finished dump needs (controls)', () => {
  /**
   * pg_dump that prints `sql`, and `stderr`, then exits with `code`. By default
   * it exits once its output has been read to the end, as a process does;
   * `exitAfter` holds the exit back until that promise settles.
   */
  function installPgDumpThatPrints(
    kills: string[],
    output: { readonly sql: string; readonly stderr?: string; readonly code: number; readonly exitAfter?: Promise<unknown> },
  ): void {
    mock.method(childProcess, 'spawn', (command: string) => {
      const child = new EventEmitter() as FakeDump;
      child.pid = 4343;
      child.exitCode = null;
      child.signalCode = null;
      const stdout = new PassThrough();
      child.stdout = stdout;
      child.stderr = new PassThrough();
      child.kill = () => {
        kills.push(`kill ${command}`);
        return false;
      };
      if (output.stderr !== undefined) child.stderr.write(output.stderr);
      stdout.end(Buffer.from(output.sql, 'utf8'));
      stdout.once('end', () => {
        void Promise.resolve(output.exitAfter).then(() => setImmediate(() => endDump(child, output.code, null)));
      });
      return child;
    });
  }

  it('resolves with the size of a file that holds the whole dump', async () => {
    const kills: string[] = [];
    const sql = 'CREATE TABLE public.plans (id text);\n'.repeat(20_000);
    installPgDumpThatPrints(kills, { sql, code: 0 });
    const record = newRecord();

    const result = await runDump(createService(record), 'whole.sql.gz');

    const file = path.join(directory, 'whole.sql.gz');
    assert.equal(result.sizeBytes, (await fsp.stat(file)).size);
    assert.equal(zlib.gunzipSync(await fsp.readFile(file)).toString('utf8'), sql, 'the file must hold every byte pg_dump wrote');
    assert.deepStrictEqual(kills, [], 'a pg_dump that finished is not killed');
    assert.ok(record.events.some(([kind, message]) => kind === 'emit' && message.startsWith('Backup completed: whole.sql.gz')));
  });

  it('reports pg_dump’s own failure with what it printed, and kills nothing', async () => {
    const kills: string[] = [];
    installPgDumpThatPrints(kills, {
      sql: '',
      stderr: 'pg_dump: error: connection to server at "postgres" (172.18.0.2), port 5432 failed: FATAL:  password authentication failed for user "rezeis"\n',
      code: 1,
    });
    const record = newRecord();

    await assert.rejects(
      () => runDump(createService(record), 'refused.sql.gz'),
      /^Error: pg_dump exited 1: pg_dump: error: connection to server .* password authentication failed/,
    );
    assert.deepStrictEqual(kills, [], 'a pg_dump that has exited is not killed');
    assertFailureRecorded(record, /password authentication failed/);
    await assert.rejects(fsp.access(path.join(directory, 'refused.sql.gz')), 'the partial file is removed');
  });

  /** A real spawn of a binary that does not exist: Node emits 'error' and then 'close' with no 'exit'. */
  function installMissingPgDump(): void {
    mock.method(childProcess, 'spawn', (_command: string, args: readonly string[], options?: SpawnOptions) =>
      realSpawn(`pg_dump-not-in-this-image-${process.pid}`, [...args], { ...(options ?? {}) }));
  }

  it('fails the job, and throws nothing past it, when there is no pg_dump to start', async () => {
    installMissingPgDump();
    const output = watchOutputFile('no-binary.sql.gz');
    const record = newRecord();

    const uncaught = recordUncaughtExceptions();
    try {
      await assert.rejects(
        () => runDump(createService(record), 'no-binary.sql.gz'),
        /^Error: pg_dump spawn failed: spawn pg_dump-not-in-this-image-\d+ ENOENT$/,
      );
      // Gone by the time the job reports its failure…
      await assert.rejects(fsp.access(output.file), 'the empty file is removed');
      await afterStragglers();
      assert.deepStrictEqual(uncaught.errors.map(String), [], 'an unhandled stream error takes the API or worker process down');
    } finally {
      uncaught.stop();
    }
    assertFailureRecorded(record, /pg_dump spawn failed/);
    // …and still gone once the stream that creates it has closed: nothing can bring it back after that.
    await output.closed();
    await assert.rejects(fsp.access(output.file), 'the empty file is not created again after the job reported');
  });

  it('leaves no empty file behind when the file is created only after pg_dump failed to start', async () => {
    // The output file is created by the write stream's open, which is
    // asynchronous, and a pg_dump that cannot start fails before it. The job's
    // clean-up then removed a file that was not there yet, and the open created
    // it afterwards: a zero-byte file in the backups directory that no record
    // points at. An idle machine's open usually won; on 23.09.2026, with the
    // suite running beside other test runs, it lost. Here the open waits for the
    // clean-up — so it loses every time the job does not wait for its file.
    installMissingPgDump();
    const output = watchOutputFile('late-open.sql.gz');
    holdOpenOf(output.file, whenRemovalTried(output.file));
    const record = newRecord();

    await assert.rejects(
      () => runDump(createService(record), 'late-open.sql.gz'),
      /^Error: pg_dump spawn failed: spawn pg_dump-not-in-this-image-\d+ ENOENT$/,
    );
    // What the job reports is the same.
    assertFailureRecorded(record, /pg_dump spawn failed/);
    await output.closed();
    await assert.rejects(fsp.access(output.file), 'the empty file is removed, and not created again after');
  });

  it('does not call a dump finished because its output is: pg_dump’s exit status still decides', async () => {
    // The file can be complete and closed before Node reports the exit — the two
    // arrive separately. The earlier code resolved on the file alone, and only
    // an exit that came first could turn that into a failure. Here the exit
    // comes a quarter of a second after the file is closed.
    const kills: string[] = [];
    let fileClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      fileClosed = resolve;
    }).then(() => new Promise<void>((resolve) => setTimeout(resolve, 250)));
    mock.method(fsModule, 'createWriteStream', (destination: string, options?: unknown) => {
      const stream = realCreateWriteStream(destination, options as never);
      stream.once('close', () => fileClosed());
      return stream;
    });
    installPgDumpThatPrints(kills, {
      sql: 'CREATE TABLE public.plans (id text);\n',
      stderr: 'pg_dump: error: query failed: ERROR:  permission denied for table users\n',
      code: 1,
      exitAfter: closed,
    });
    const record = newRecord();

    await assert.rejects(
      () => runDump(createService(record), 'late-exit.sql.gz'),
      /^Error: pg_dump exited 1: pg_dump: error: query failed: ERROR: {2}permission denied for table users$/,
    );
    assertFailureRecorded(record, /permission denied/);
  });
});
