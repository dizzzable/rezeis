import 'reflect-metadata';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ImportQueueService,
  resolveImportStageDir,
  resolveStagedExtension,
} from '../src/modules/imports/services/import-queue.service';

/**
 * `main.ts`'s `resolveUploadsRoot()`, reproduced verbatim. This is the root
 * handed to `express.static` under the `/uploads` prefix — every byte beneath
 * it is fetchable unauthenticated, outside every Nest guard. The staging
 * directory used to be `<this>/imports`, computed from the SAME expression.
 */
function servedUploadsRoot(): string {
  const fromEnv = process.env.ADMIN_UPLOADS_DIR;
  if (fromEnv && fromEnv.trim().length > 0) {
    return resolve(fromEnv);
  }
  return resolve(process.cwd(), 'data', 'uploads');
}

/** True when `candidate` would be reachable through the static handler. */
function isServed(candidate: string): boolean {
  const rel = relative(servedUploadsRoot(), candidate);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`));
}

function buildService(): ImportQueueService {
  const queue = {
    add: async () => ({ id: 'job-1' }),
  };
  const prismaService = {
    importRecord: {
      create: async () => ({ id: 'import-1' }),
    },
  };
  return new ImportQueueService(queue as never, prismaService as never);
}

describe('import staging directory', () => {
  const previousUploadsDir = process.env.ADMIN_UPLOADS_DIR;

  afterEach(() => {
    if (previousUploadsDir === undefined) {
      delete process.env.ADMIN_UPLOADS_DIR;
    } else {
      process.env.ADMIN_UPLOADS_DIR = previousUploadsDir;
    }
  });

  it('is outside the served /uploads root with the default data layout', () => {
    delete process.env.ADMIN_UPLOADS_DIR;
    const stageDir = resolveImportStageDir();
    assert.equal(isServed(join(servedUploadsRoot(), 'imports')), true, 'sanity: the OLD location was served');
    assert.equal(isServed(stageDir), false, `staged imports must not be under ${servedUploadsRoot()}`);
    assert.equal(stageDir, resolve(process.cwd(), 'data', 'import-staging'));
  });

  it('is outside the served /uploads root when ADMIN_UPLOADS_DIR is set', () => {
    process.env.ADMIN_UPLOADS_DIR = '/app/data/uploads';
    const stageDir = resolveImportStageDir();
    assert.equal(isServed(stageDir), false);
    // Still a sibling on the same shared `rezeis-data` volume (`/app/data`),
    // so the worker container can read what the api container staged.
    assert.equal(stageDir, resolve('/app/data/import-staging'));
  });

  it('the service uses the resolved location, not a served one', () => {
    process.env.ADMIN_UPLOADS_DIR = '/app/data/uploads';
    const service = buildService();
    assert.equal(service.getStageDir(), resolveImportStageDir());
    assert.equal(isServed(service.getStageDir()), false);
  });
});

describe('resolveStagedExtension — client-supplied suffixes', () => {
  it('rejects the renderable types the old suffix copy let through', () => {
    for (const name of [
      'payload.html',
      'payload.svg',
      'payload.xhtml',
      'payload.js',
      'payload.htm',
      'payload.mjs',
      'payload.php',
      'payload.SVG',
    ]) {
      assert.equal(resolveStagedExtension(name), '.bin', `${name} must not keep its extension`);
    }
  });

  it('keeps every suffix the four import parsers are fed in practice', () => {
    assert.equal(resolveStagedExtension('x-ui.db'), '.db');
    assert.equal(resolveStagedExtension('x-ui.sqlite'), '.sqlite');
    assert.equal(resolveStagedExtension('x-ui.sqlite3'), '.sqlite3');
    assert.equal(resolveStagedExtension('database.json'), '.json');
    assert.equal(resolveStagedExtension('stealthnet_dump.sql'), '.sql');
    assert.equal(resolveStagedExtension('backup.tar.gz'), '.tar.gz');
    assert.equal(resolveStagedExtension('bot_dump_2026.sql.gz'), '.sql.gz');
    assert.equal(resolveStagedExtension('export.json.gz'), '.json.gz');
    assert.equal(resolveStagedExtension('dump.gz'), '.gz');
    assert.equal(resolveStagedExtension('X-UI.DB'), '.db');
  });

  it('falls back to .bin for a name with no extension at all', () => {
    assert.equal(resolveStagedExtension('database'), '.bin');
    assert.equal(resolveStagedExtension(''), '.bin');
  });
});

describe('enqueueFileImport — where the bytes actually land', () => {
  let root: string;
  const previousUploadsDir = process.env.ADMIN_UPLOADS_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'import-stage-'));
    process.env.ADMIN_UPLOADS_DIR = join(root, 'uploads');
    await fs.mkdir(join(root, 'uploads'), { recursive: true });
  });

  afterEach(async () => {
    if (previousUploadsDir === undefined) {
      delete process.env.ADMIN_UPLOADS_DIR;
    } else {
      process.env.ADMIN_UPLOADS_DIR = previousUploadsDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes a competitor pg_dump outside the static root, under an inert name', async () => {
    const service = buildService();
    await service.enqueueFileImport({
      sourceType: 'stealthnet',
      mode: 'import',
      createdBy: 'admin-1',
      fileBuffer: Buffer.from('-- PostgreSQL database dump\n', 'utf8'),
      // The exploit shape: a client-chosen suffix that the static handler
      // would serve as an active document.
      originalFilename: 'customers.html',
    });

    // Nothing under the served root.
    assert.deepEqual(await fs.readdir(join(root, 'uploads')), []);

    const staged = await fs.readdir(service.getStageDir());
    assert.equal(staged.length, 1);
    assert.match(staged[0], /^[0-9a-f-]{36}\.bin$/);
    assert.equal(isServed(join(service.getStageDir(), staged[0])), false);
  });
});
