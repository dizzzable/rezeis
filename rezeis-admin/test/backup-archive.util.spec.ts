import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { Headers, pack } from 'tar-stream';

import {
  MAX_JSON_BYTES,
  ensureArchiveEntrySize,
  ensureBufferWithinLimit,
  findArchivePayload,
  gunzipBuffer,
  normalizeTarEntryName,
  normalizeTarEntryType,
} from '../src/modules/imports/utils/backup-archive.util';

/**
 * The one reader that opens every donor's backup.
 *
 * Four importers now share it, which is the point — a rule written four times
 * is a rule fixed once. It also means a hole here is a hole in all four, and
 * until this file existed the shared reader had no test of its own: its rules
 * were exercised only incidentally, through whichever parser happened to trip
 * one.
 *
 * Everything below is a property an operator's upload can attack.
 */

type TarEntry = {
  readonly name: string;
  readonly content?: Buffer;
  readonly type?: Headers['type'];
  readonly linkname?: string;
};

function buildTar(entries: readonly TarEntry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = pack();
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    const add = (index: number): void => {
      if (index === entries.length) {
        archive.finalize();
        return;
      }
      const entry = entries[index];
      const header: Headers = { name: entry.name, type: entry.type, linkname: entry.linkname };
      const done = (error?: Error | null): void => {
        if (error) reject(error);
        else add(index + 1);
      };
      if (entry.type !== undefined && entry.type !== 'file') archive.entry(header, done);
      else archive.entry(header, entry.content ?? Buffer.alloc(0), done);
    };
    add(0);
  });
}

const wantJson = (name: string): 'json' | null => (name === 'database.json' ? 'json' : null);

describe('an entry name is a claim about where a file lives', () => {
  it('accepts the ordinary ones', () => {
    assert.equal(normalizeTarEntryName('database.json'), 'database.json');
    assert.equal(normalizeTarEntryName('backups/database.json'), 'backups/database.json');
    // What `tar czf x.tar.gz .` writes for every member.
    assert.equal(normalizeTarEntryName('./database.json'), 'database.json');
    assert.equal(normalizeTarEntryName('assets/'), 'assets');
  });

  it('refuses every way out of the directory', () => {
    for (const name of [
      '../database.json',
      './../database.json',
      '/etc/passwd',
      'C:/windows/system32',
      'a/../../b',
      'a/./b',
      'a//b',
      '.',
      '..',
      'a\\b.json',
      'data\0.json',
    ]) {
      assert.throws(
        () => normalizeTarEntryName(name),
        (err: Error) => err.message.length > 0,
        `'${name}' should not be accepted`,
      );
    }
  });

  it('refuses an unreasonably long name WITHOUT examining it', () => {
    // THE ATTACK THIS GUARD EXISTS FOR. tar-stream resolves a GNU long-path
    // header itself and hands the name over before any size check has run, so
    // this string is not bounded by the classic 100-byte field. A greedy
    // trailing-slash pattern over four million slashes is quadratic, a regex
    // cannot be interrupted, and the process that dies is the worker — which
    // also runs profile sync, backups and broadcasts.
    const hostile = `${'/'.repeat(4_000_000)}a`;

    const started = Date.now();
    assert.throws(() => normalizeTarEntryName(hostile), /unreasonably long/i);
    assert.ok(
      Date.now() - started < 1000,
      'the refusal must be immediate — the whole point is not to look at it',
    );
  });
});

describe('an entry type is a claim about what a file is', () => {
  it('reads a missing type as a plain file', () => {
    assert.equal(normalizeTarEntryType(undefined), 'file');
    assert.equal(normalizeTarEntryType(null as unknown as Headers['type']), 'file');
  });

  it('refuses anything a backup has no reason to carry', () => {
    for (const type of ['symlink', 'link', 'character-device', 'block-device', 'fifo'] as const) {
      assert.throws(() => normalizeTarEntryType(type), /is not allowed/i);
    }
  });
});

describe('a declared size is a claim about how much will arrive', () => {
  it('refuses a size that cannot be reasoned about', () => {
    // `isSafeInteger`, not `isFinite`: a fractional size or one past 2^53 is a
    // header we do not understand, and that is not a reason to read it anyway.
    for (const size of [undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      assert.throws(() => ensureArchiveEntrySize('x', size), /invalid size/i);
    }
  });

  it('refuses one larger than the ceiling', () => {
    assert.throws(() => ensureArchiveEntrySize('x', 512 * 1024 * 1024), /exceeds/i);
  });
});

describe('what the reader will not swallow', () => {
  it('refuses an empty upload by name', () => {
    assert.throws(() => ensureBufferWithinLimit(Buffer.alloc(0), 1024, 'Backup file'), /is empty/i);
  });

  it('stops a gzip bomb DURING decompression, not after', async () => {
    // Half a gigabyte of zeroes is well under a megabyte compressed, so no
    // ceiling on the upload can catch this — only one on the output can.
    const bomb = gzipSync(Buffer.alloc(512 * 1024 * 1024, 0));

    await assert.rejects(
      () => gunzipBuffer(bomb, 64 * 1024 * 1024, 'backup file'),
      /after decompression/i,
    );
  });
});

describe('finding the one entry that matters', () => {
  it('walks past the archive root that tar writes first', async () => {
    // `tar czf backup.tar.gz .` opens with a member named exactly `./`. It
    // names no file, and refusing it would reject an ordinary backup before
    // reading a single byte of it.
    const tar = await buildTar([
      { name: './', type: 'directory' },
      { name: './database.json', content: Buffer.from('{"users":[]}') },
    ]);

    const payload = await findArchivePayload(tar, wantJson);

    assert.equal(payload?.name, 'database.json');
  });

  it('answers null when nothing in the archive is the payload', async () => {
    const tar = await buildTar([{ name: 'metadata.json', content: Buffer.from('{}') }]);

    assert.equal(await findArchivePayload(tar, wantJson), null);
  });

  it('refuses two payloads rather than picking one', async () => {
    // Two databases in one archive is an archive we do not understand, and
    // either choice would be a guess about somebody's customers.
    const tar = await buildTar([
      { name: 'database.json', content: Buffer.from('{"a":1}') },
      { name: 'database.json', content: Buffer.from('{"a":2}') },
    ]);

    await assert.rejects(() => findArchivePayload(tar, wantJson), /duplicate database payloads/i);
  });

  it('refuses an unsafe entry even when it is not the one it wants', async () => {
    const tar = await buildTar([{ name: '../escape.json', content: Buffer.from('{}') }]);

    await assert.rejects(() => findArchivePayload(tar, wantJson), /unsafe path/i);
  });

  it('turns a throwing classifier into a refusal, not a hang', async () => {
    // tar-stream emits entries synchronously and holds its lock while it does:
    // an unguarded throw here escapes as an uncaught exception and leaves the
    // extractor locked, so the promise never settles and the job hangs.
    const tar = await buildTar([{ name: 'database.json', content: Buffer.from('{}') }]);

    await assert.rejects(
      () =>
        findArchivePayload(tar, () => {
          throw new Error('classifier exploded');
        }),
      /classifier exploded/,
    );
  });

  it('honours the caller\u2019s ceiling, not the global one', async () => {
    // Buffering the global maximum and refusing it against a tighter limit
    // afterwards spends exactly the memory the tighter limit exists to save.
    const tar = await buildTar([
      { name: 'database.json', content: Buffer.alloc(2 * 1024 * 1024, 0x61) },
    ]);

    await assert.rejects(() => findArchivePayload(tar, wantJson, 1024), /exceeds/i);
    // The same archive is fine when the caller allows it.
    const payload = await findArchivePayload(tar, wantJson, MAX_JSON_BYTES);
    assert.equal(payload?.bytes.length, 2 * 1024 * 1024);
  });
});
