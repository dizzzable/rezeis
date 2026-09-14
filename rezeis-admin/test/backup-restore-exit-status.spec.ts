import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fsp, readdirSync, readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import * as zlib from 'node:zlib';

import { BackupService } from '../src/modules/backup/services/backup.service';

// `require`, not a namespace import: under `esModuleInterop` a namespace import
// is compiled to a COPY of the module's properties, and patching a copy patches
// nothing the service can see. This is the same object it calls `spawn` on.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess: typeof import('node:child_process') = require('node:child_process');
/** The real `spawn`, taken before any case replaces it: some psql doubles are real processes. */
const realSpawn = childProcess.spawn;

/**
 * A restore reports what psql and the Prisma CLI actually did
 * ═══════════════════════════════════════════════════════════
 * Three ways the restore job used to get this wrong:
 *
 *   1. `psql --single-transaction` without `ON_ERROR_STOP`. The first failing
 *      statement aborts the transaction, every later one is refused, psql sends
 *      COMMIT — which PostgreSQL completes as ROLLBACK — and exits 0. psql's
 *      documented exit status: "0 to the shell if it finished normally, 1 if a
 *      fatal error of its own occurs, 2 if the connection to the server went
 *      bad and the session was not interactive, or 3 if an error occurred in a
 *      script and the variable ON_ERROR_STOP was set." So restoring an archive
 *      older than a migration that added a foreign key to `users` changed
 *      nothing, discarded the ERROR lines and emitted INFO "Database restored".
 *
 *   2. The post-restore `prisma migrate deploy` spawned `npx`, which the
 *      production Dockerfile deletes from the image. It failed with ENOENT on
 *      every restore in production, and the panel kept running against the
 *      restored (older) schema.
 *
 *   3. With `ON_ERROR_STOP` set, psql stops READING at the failing statement —
 *      in a real dump that is the DROP section at the top, with megabytes still
 *      to come. Nothing listened for errors on psql's stdin, so the next write's
 *      EPIPE was re-emitted by `pipe` with no listener: an uncaught exception
 *      that took the whole API or worker process down before the restore could
 *      reject. `psql.kill()` on a broken archive did the same through the write
 *      pending at the kill. The earlier doubles read the whole script before
 *      exiting, so none of this could show.
 *
 * `spawn` is replaced by doubles that keep psql's exit-status contract, so the
 * service is judged on the status it receives, as it would be in the image.
 * Where the pipe itself is the question, the double is a real child process.
 */

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown> | undefined;
}

let directory: string;
let previousLocation: string | undefined;
/** Real child processes started by a case, stopped if the case left one running. */
const liveChildren = new Set<ChildProcess>();

before(async () => {
  previousLocation = process.env.BACKUP_LOCATION;
  directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'rezeis-restore-exit-'));
  process.env.BACKUP_LOCATION = directory;
});

after(async () => {
  if (previousLocation === undefined) delete process.env.BACKUP_LOCATION;
  else process.env.BACKUP_LOCATION = previousLocation;
  await fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

afterEach(() => {
  mock.restoreAll();
  for (const child of liveChildren) child.kill();
  liveChildren.clear();
});

function createService(): BackupService {
  return new BackupService(
    { host: 'postgres', port: 5432, user: 'rezeis', password: 'not-a-real-password', name: 'rezeis' } as never,
    {} as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined } as never,
    { getDecryptedBotToken: async () => null } as never,
    { add: async () => ({ id: 'job-1' }) } as never,
  );
}

/** `-v ON_ERROR_STOP=1`, `--set=ON_ERROR_STOP=1` or `-vON_ERROR_STOP=1`. */
function setsOnErrorStop(args: readonly string[]): boolean {
  return args.some((arg, index) => {
    const value = /^(?:-v|--set=?|--variable=?)?(ON_ERROR_STOP=(?:1|on|true))$/i.exec(arg);
    if (value === null) return false;
    if (arg.toUpperCase().startsWith('ON_ERROR_STOP')) {
      return ['-v', '--set', '--variable'].includes(args[index - 1] ?? '');
    }
    return true;
  });
}

type FakeChild = EventEmitter & {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
};

const FAILING_STATEMENT_MARKER = '-- this statement fails';
const PSQL_ERROR_LINE =
  'psql:<stdin>:3: ERROR:  cannot drop constraint users_pkey on table public.users because other objects depend on it\n';

/** What a write fails with once the process reading the other end of the pipe is gone. */
function brokenPipe(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
}

/** How a ChildProcess ends: 'exit', its stdin destroyed, then 'close' once its stdio is done. */
function endChild(child: FakeChild, code: number | null, signal: NodeJS.Signals | null): void {
  child.emit('exit', code, signal);
  child.stdin.destroy();
  child.stderr.end();
  child.emit('close', code, signal);
}

/**
 * A psql that reads the whole script, fails on the marked statement, and exits
 * the way psql does: 3 with `ON_ERROR_STOP` set, 0 without it.
 */
function installFakePsql(calls: SpawnCall[]): void {
  mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options?: Record<string, unknown>) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    let script = '';
    child.stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        script += chunk.toString('utf8');
        callback();
      },
      final(callback) {
        callback();
        const failed = script.includes(FAILING_STATEMENT_MARKER);
        if (failed) child.stderr.write(PSQL_ERROR_LINE);
        setImmediate(() => endChild(child, failed && setsOnErrorStop(args) ? 3 : 0, null));
      },
    });
    return child;
  });
}

/**
 * psql as it behaves on the statement it stops at: it reads no further and
 * exits. Every write after that fails with EPIPE, and Node hears about the
 * failed write before the exit — a write on a closed pipe fails at once, the
 * exit arrives through SIGCHLD. That is the order that killed the process.
 */
function installPsqlThatStopsReading(
  calls: SpawnCall[],
  stop: { readonly at: string; readonly exitCode: number; readonly stderr: string },
): void {
  mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options?: Record<string, unknown>) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    let read = '';
    let stopped = false;
    let exiting = false;
    const exitSoon = (): void => {
      if (exiting) return;
      exiting = true;
      setImmediate(() => endChild(child, stop.exitCode, null));
    };
    child.stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (stopped) {
          callback(brokenPipe());
          exitSoon();
          return;
        }
        read += chunk.toString('utf8');
        if (read.includes(stop.at)) {
          stopped = true;
          if (stop.stderr.length > 0) child.stderr.write(stop.stderr);
        }
        callback();
      },
      final(callback) {
        callback();
        exitSoon();
      },
    });
    return child;
  });
}

/**
 * psql itself, as far as its pipes can tell: run as a real child process, so the
 * archive goes through a real OS pipe and the EPIPE is the kernel's. With
 * `ON_ERROR_STOP` (read off the psql arguments by the wrapper) it prints the
 * ERROR, exits 3 and never reads the rest; without it, it reads to the end and
 * exits 0. `FAKE_PSQL_STDOUT_BYTES` makes it print that much output first, the
 * way psql prints a command tag for every statement of a dump.
 */
const FAKE_PSQL_SOURCE = [
  "const fs = require('node:fs');",
  "const onErrorStop = process.env.FAKE_PSQL_ON_ERROR_STOP === '1';",
  'const report = process.env.FAKE_PSQL_REPORT;',
  "const stdoutBytes = Number(process.env.FAKE_PSQL_STDOUT_BYTES || '0');",
  "const tags = Buffer.alloc(stdoutBytes, 'COPY 1\\n');",
  'for (let offset = 0; offset < tags.length; ) offset += fs.writeSync(1, tags, offset);',
  'let read = 0;',
  "let tail = '';",
  'let failed = false;',
  "process.stdin.on('data', (chunk) => {",
  '  read += chunk.length;',
  "  const text = tail + chunk.toString('latin1');",
  '  tail = text.slice(-64);',
  `  if (failed || !text.includes(${JSON.stringify(FAILING_STATEMENT_MARKER)})) return;`,
  '  failed = true;',
  `  fs.writeSync(2, ${JSON.stringify(PSQL_ERROR_LINE)});`,
  '  if (!onErrorStop) return;',
  '  if (report) fs.writeFileSync(report, String(read));',
  '  process.exit(3);',
  '});',
  "process.stdin.on('end', () => {",
  '  if (report) fs.writeFileSync(report, String(read));',
  '  process.exit(0);',
  '});',
].join('\n');

function installRealFakePsql(calls: SpawnCall[], env: Readonly<Record<string, string>> = {}): void {
  mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options?: Record<string, unknown>) => {
    calls.push({ command, args: [...args], options });
    const spawnOptions = (options ?? {}) as SpawnOptions;
    const child = realSpawn(process.execPath, ['-e', FAKE_PSQL_SOURCE], {
      ...spawnOptions,
      env: {
        ...(spawnOptions.env ?? process.env),
        ...env,
        FAKE_PSQL_ON_ERROR_STOP: setsOnErrorStop(args) ? '1' : '0',
      },
    });
    liveChildren.add(child);
    child.once('exit', () => liveChildren.delete(child));
    return child;
  });
}

/** A dump that fails near its top with megabytes behind the failing statement, as a real one does. */
function dumpFailingAtTheTop(): string {
  return (
    'SET statement_timeout = 0;\n'
    + `${FAILING_STATEMENT_MARKER}\n`
    + 'ALTER TABLE IF EXISTS ONLY public.users DROP CONSTRAINT IF EXISTS users_pkey;\n'
    + "INSERT INTO public.plans VALUES ('plan-id', 'A plan that is never reached');\n".repeat(100_000)
  );
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

/** Time for an error raised after the verdict — a failed write, a late close — to surface. */
function afterStragglers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

async function writeArchive(name: string, sql: string): Promise<void> {
  await fsp.writeFile(path.join(directory, name), zlib.gzipSync(Buffer.from(sql, 'utf8')));
}

describe('BackupService.runRestore — a failing restore script is a failed restore', () => {
  it('rejects with psql’s ERROR line when a statement of the archive fails', async () => {
    const calls: SpawnCall[] = [];
    installFakePsql(calls);
    await writeArchive(
      'older-than-points-ledger.sql.gz',
      'SET statement_timeout = 0;\n-- this statement fails\nALTER TABLE IF EXISTS ONLY public.users DROP CONSTRAINT IF EXISTS users_pkey;\n',
    );

    await assert.rejects(
      () => createService().runRestore('older-than-points-ledger.sql.gz', { allowForeignArchive: true }),
      (err: unknown) => {
        assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
        assert.match(err.message, /other objects depend on it/, 'the operator must see why');
        return true;
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, 'psql');
    // One transaction, so the statement that failed took the whole restore
    // back with it: the database is left as it was before.
    assert.ok(calls[0]!.args.includes('--single-transaction'));
  });

  it('survives psql leaving the archive unread on the failing statement, and rejects with psql’s status', async () => {
    installPsqlThatStopsReading([], { at: FAILING_STATEMENT_MARKER, exitCode: 3, stderr: PSQL_ERROR_LINE });
    await writeArchive('stops-in-the-drop-section.sql.gz', dumpFailingAtTheTop());

    const uncaught = recordUncaughtExceptions();
    try {
      await assert.rejects(
        () => createService().runRestore('stops-in-the-drop-section.sql.gz', { allowForeignArchive: true }),
        (err: unknown) => {
          assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
          assert.match(err.message, /^psql exited 3: /, 'psql’s status decides, not the EPIPE of a write it never read');
          assert.match(err.message, /other objects depend on it/, 'the operator must see why');
          return true;
        },
      );
      await afterStragglers();
      assert.deepStrictEqual(uncaught.errors.map(String), [], 'an unhandled stream error takes the API or worker process down');
    } finally {
      uncaught.stop();
    }
  });

  it('does not call it restored when psql exits 0 before it has read the whole archive', async () => {
    // `\q` half-way through: psql stops reading and exits 0. The rest of the
    // archive never ran, and the job must not say "restored".
    installPsqlThatStopsReading([], { at: '\\q', exitCode: 0, stderr: '' });
    await writeArchive(
      'quits-half-way.sql.gz',
      `SET statement_timeout = 0;\n\\q\n${"INSERT INTO public.plans VALUES ('plan-id');\n".repeat(100_000)}`,
    );

    const uncaught = recordUncaughtExceptions();
    try {
      await assert.rejects(
        () => createService().runRestore('quits-half-way.sql.gz', { allowForeignArchive: true }),
        /psql exited 0 before it had read the whole archive/,
      );
      await afterStragglers();
      assert.deepStrictEqual(uncaught.errors.map(String), []);
    } finally {
      uncaught.stop();
    }
  });

  it('through a real pipe: psql exiting on the failing statement with megabytes unwritten is a rejection, not a dead process', async () => {
    const report = path.join(directory, 'real-pipe-read-bytes.txt');
    installRealFakePsql([], { FAKE_PSQL_REPORT: report });
    const sql = dumpFailingAtTheTop();
    await writeArchive('real-pipe.sql.gz', sql);

    const uncaught = recordUncaughtExceptions();
    try {
      await assert.rejects(
        () => createService().runRestore('real-pipe.sql.gz', { allowForeignArchive: true }),
        (err: unknown) => {
          assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
          assert.match(err.message, /^psql exited 3: /);
          assert.match(err.message, /other objects depend on it/);
          return true;
        },
      );
      await afterStragglers();
      assert.deepStrictEqual(uncaught.errors.map(String), [], 'an unhandled stream error takes the API or worker process down');
    } finally {
      uncaught.stop();
    }
    const readBytes = Number(await fsp.readFile(report, 'utf8'));
    assert.ok(
      readBytes < Buffer.byteLength(sql) / 10,
      `the stand-in must have stopped with most of the archive unread, or this case proves nothing (read ${readBytes} bytes)`,
    );
  });

  it('kills psql when the archive breaks off half-way, before anything closes its input, and survives the write left pending', { timeout: 20_000 }, async () => {
    // A truncated archive (an acknowledged foreign upload that was cut short)
    // fails in gunzip after psql has already run part of it. The pipe does not
    // end psql's input on a source error, so psql sat in the open transaction
    // holding the locks of every table it had dropped until the worker exited —
    // and an input closed then ENDS the script, which psql commits. So psql is
    // killed, and nothing may close its input before that.
    const calls: SpawnCall[] = [];
    const events: string[] = [];
    let writePendingAtKill = false;
    mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options?: Record<string, unknown>) => {
      calls.push({ command, args: [...args], options });
      const child = new EventEmitter() as FakeChild;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let pending: ((error?: Error | null) => void) | null = null;
      child.stdin = new Writable({
        // psql is busy executing the first chunk it read; the rest of what
        // arrives queues behind it, as it does in a pipe.
        highWaterMark: 8 * 1024 * 1024,
        write(_chunk: Buffer, _encoding, callback) {
          pending = callback;
        },
        final(callback) {
          events.push('input ended');
          callback();
        },
      });
      const destroyInput = child.stdin.destroy.bind(child.stdin);
      child.stdin.destroy = (error?: Error) => {
        events.push('input closed');
        return destroyInput(error);
      };
      child.kill = () => {
        events.push(`kill ${command}`);
        writePendingAtKill = pending !== null;
        setImmediate(() => {
          // SIGTERM: the process and its end of the pipe are gone, so the
          // write that was on its way fails.
          const waiting = pending;
          pending = null;
          waiting?.(brokenPipe());
          endChild(child, null, 'SIGTERM');
        });
        return true;
      };
      return child;
    });
    const whole = zlib.gzipSync(Buffer.from('DROP TABLE IF EXISTS public.plans;\n'.repeat(20_000), 'utf8'));
    await fsp.writeFile(path.join(directory, 'cut-short.sql.gz'), whole.subarray(0, Math.floor(whole.length / 2)));

    const uncaught = recordUncaughtExceptions();
    try {
      await assert.rejects(
        () => createService().runRestore('cut-short.sql.gz', { allowForeignArchive: true }),
        /Decompression failed/,
      );
      await afterStragglers();
      assert.deepStrictEqual(uncaught.errors.map(String), [], 'an unhandled stream error takes the API or worker process down');
    } finally {
      uncaught.stop();
    }

    assert.equal(writePendingAtKill, true, 'the case needs a write on its way when psql is killed');
    assert.equal(events.filter((event) => event.startsWith('kill')).length, 1, `psql is killed once: ${events.join(', ')}`);
    assert.equal(events[0], 'kill psql', `psql must be killed before its input is closed: ${events.join(', ')}`);
    assert.ok(!events.includes('input ended'), 'and its input must not be ended, which would let it COMMIT');
  });

  it('does not leave psql blocked on an output pipe that nothing reads', { timeout: 20_000 }, async () => {
    // psql prints a command tag for every statement it runs. Nothing in the
    // service reads them, and once an unread pipe is full psql blocks in the
    // middle of the restore — inside its transaction, holding its locks — and
    // the job never settles.
    installRealFakePsql([], { FAKE_PSQL_STDOUT_BYTES: String(4 * 1024 * 1024) });
    await writeArchive('chatty.sql.gz', 'SET statement_timeout = 0;\nCREATE TABLE public.plans (id text);\n');

    assert.equal(await createService().runRestore('chatty.sql.gz', { allowForeignArchive: true }), true);
  });

  it('resolves for an archive whose every statement succeeds (control)', async () => {
    const calls: SpawnCall[] = [];
    installFakePsql(calls);
    await writeArchive('clean.sql.gz', 'SET statement_timeout = 0;\nCREATE TABLE public.plans (id text);\n');

    assert.equal(await createService().runRestore('clean.sql.gz', { allowForeignArchive: true }), true);
  });

  it('resolves through a real pipe for an archive psql reads to the end (control)', async () => {
    installRealFakePsql([]);
    await writeArchive('clean-real-pipe.sql.gz', 'SET statement_timeout = 0;\nCREATE TABLE public.plans (id text);\n'.repeat(50_000));

    assert.equal(await createService().runRestore('clean-real-pipe.sql.gz', { allowForeignArchive: true }), true);
  });
});

describe('BackupService.runMigrateDeploy — runs the Prisma CLI the image ships', () => {
  it('spawns node on the app-local prisma CLI, never npx', async () => {
    const calls: SpawnCall[] = [];
    mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options?: Record<string, unknown>) => {
      calls.push({ command, args: [...args], options });
      const child = new EventEmitter() as FakeChild;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      setImmediate(() => child.emit('exit', 0));
      return child;
    });

    assert.equal(await createService().runMigrateDeploy(), true);

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.doesNotMatch(call!.command, /\bnpx\b|\bnpm\b/, 'the production image has neither npx nor npm');
    assert.equal(call!.command, process.execPath);
    assert.equal(call!.args[0], require.resolve('prisma/build/index.js'), 'the CLI from node_modules');
    assert.deepStrictEqual(call!.args.slice(1), ['migrate', 'deploy']);
    assert.notEqual(call!.options?.shell, true, 'no shell is needed to start node');
  });

  it('nothing under src/ spawns npx or npm, which the runtime image does not have', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts')) {
          const source = readFileSync(full, 'utf8');
          if (/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*['"`](?:npx|npm)\b/.test(source)) {
            offenders.push(path.relative(path.join(__dirname, '..'), full));
          }
        }
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    assert.deepStrictEqual(offenders, []);
  });
});
