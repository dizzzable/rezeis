import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import Database from 'better-sqlite3';

import { parseThreeXuiBackup } from '../src/modules/imports/utils/threexui-backup-parser';

/**
 * The 3x-ui backup parser reads a SQLite file through `better-sqlite3`, a
 * NATIVE addon — and until this file existed no spec loaded the real one.
 * The parser reaches it through a lazy `require` inside the function, so a
 * binary built for another Node ABI (`NODE_MODULE_VERSION`) broke nothing at
 * start-up, nothing in the suite, and nothing in the image build: the first
 * operator to upload a `.db` backup would meet `ERR_DLOPEN_FAILED` in the import
 * queue. The whole suite stayed green on a Node whose addon could not load.
 *
 * Everything here goes through the real addon, in both directions: the fixture
 * is WRITTEN with `better-sqlite3` (in a temporary folder — no binary is
 * committed) and READ back by the parser, which writes its own temporary copy
 * and opens it read-only. A wrong ABI, a missing prebuild for the platform
 * (musl included) or an API the parser no longer finds fails here, in CI,
 * instead of at runtime.
 */

const GIB = 1024 ** 3;

let workDir: string;
let leftoversBefore: string[];

/** The parser's own temporary copies: `3xui-import-<uuid>.db` in `os.tmpdir()`. */
function parserTempFiles(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith('3xui-import-') && name.endsWith('.db'))
    .sort();
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'rezeis-3xui-spec-'));
  leftoversBefore = parserTempFiles();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let backupCounter = 0;

/** Builds a SQLite file with `better-sqlite3` and returns its bytes. */
function buildBackup(populate: (db: Database.Database) => void): Buffer {
  const file = join(workDir, `x-ui-${(backupCounter += 1)}.db`);
  const db = new Database(file);
  try {
    populate(db);
  } finally {
    db.close();
  }
  return readFileSync(file);
}

/** The 3x-ui v3 layout: a dedicated `clients` table beside `client_inbounds`. */
function populateV3(db: Database.Database): void {
  db.exec(`
    CREATE TABLE inbounds (id INTEGER PRIMARY KEY, remark TEXT, protocol TEXT, settings TEXT);
    CREATE TABLE clients (
      id INTEGER PRIMARY KEY, email TEXT, sub_id TEXT, uuid TEXT, password TEXT, flow TEXT,
      limit_ip INTEGER, total_gb INTEGER, expiry_time INTEGER, enable INTEGER, tg_id INTEGER,
      comment TEXT, reset INTEGER, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE client_traffics (
      email TEXT, up INTEGER, down INTEGER, total INTEGER, expiry_time INTEGER,
      enable INTEGER, inbound_id INTEGER
    );
    CREATE TABLE client_inbounds (client_id INTEGER, inbound_id INTEGER);
  `);
  db.prepare('INSERT INTO inbounds VALUES (?, ?, ?, ?)').run(7, 'Reality-DE', 'vless', '{}');
  const insertClient = db.prepare(
    'INSERT INTO clients VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertClient.run(
    1, 'alice', 'subAlice', '11111111-1111-4111-8111-111111111111', null, 'xtls-rprx-vision',
    3, 50 * GIB, 1_800_000_000_000, 1, 123456789, 'first customer', 30, 1, 2,
  );
  insertClient.run(
    2, 'bob', null, null, 'trojan-secret', null,
    0, 0, 0, 0, 0, null, 0, 1, 2,
  );
  const insertTraffic = db.prepare('INSERT INTO client_traffics VALUES (?, ?, ?, ?, ?, ?, ?)');
  // 7.5 GiB: past 2^32, so a 32-bit read in the addon would show.
  insertTraffic.run('alice', 2 * GIB, 7.5 * GIB, 50 * GIB, 1_800_000_000_000, 1, 7);
  db.prepare('INSERT INTO client_inbounds VALUES (?, ?)').run(1, 7);
}

/** The legacy layout: clients live as JSON inside `inbounds.settings`. */
function populateLegacy(db: Database.Database): void {
  db.exec(`
    CREATE TABLE inbounds (id INTEGER PRIMARY KEY, remark TEXT, protocol TEXT, settings TEXT);
    CREATE TABLE client_traffics (
      email TEXT, up INTEGER, down INTEGER, total INTEGER, expiry_time INTEGER,
      enable INTEGER, inbound_id INTEGER
    );
  `);
  const insertInbound = db.prepare('INSERT INTO inbounds VALUES (?, ?, ?, ?)');
  insertInbound.run(
    1,
    'VLESS-NL',
    'vless',
    JSON.stringify({
      clients: [
        {
          email: 'carol',
          id: '22222222-2222-4222-8222-222222222222',
          subId: 'subCarol',
          tgId: 42,
          limitIp: 2,
          totalGB: 10 * GIB,
          expiryTime: 1_900_000_000_000,
          enable: true,
          comment: 'legacy',
          reset: 7,
        },
        { email: 'dave', password: 'pw', enable: false },
      ],
    }),
  );
  // The same e-mail on a second inbound is one customer, not two.
  insertInbound.run(
    2,
    'Trojan-FI',
    'trojan',
    JSON.stringify({ clients: [{ email: 'carol', password: 'other' }, { email: 'erin' }] }),
  );
  // A row whose settings are not JSON is skipped, not fatal.
  insertInbound.run(3, 'Broken', 'vmess', '{not json');
  db.prepare('INSERT INTO client_traffics VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'carol', 1 * GIB, 3 * GIB, 10 * GIB, 1_900_000_000_000, 1, 1,
  );
}

describe('the native SQLite addon behind the 3x-ui backup import', () => {
  it('loads in this Node and answers a query', () => {
    // Fails with ERR_DLOPEN_FAILED on a binary built for another NODE_MODULE_VERSION
    // (this runtime reports `process.versions.modules`), or when the package ships
    // no prebuild for this platform and libc.
    const db = new Database(':memory:');
    try {
      const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
      assert.match(row.v, /^3\.\d+\.\d+/, `ABI ${process.versions.modules}`);
    } finally {
      db.close();
    }
  });
});

describe('parseThreeXuiBackup on a real SQLite file', () => {
  it('reads the v3 layout: clients, their traffic and their inbound', () => {
    const clients = parseThreeXuiBackup(buildBackup(populateV3), 'https://sub.example.com/s');

    assert.deepEqual(clients, [
      {
        email: 'alice',
        uuid: '11111111-1111-4111-8111-111111111111',
        password: null,
        subId: 'subAlice',
        tgId: 123456789,
        totalGb: 50 * GIB,
        limitIp: 3,
        expiryTime: 1_800_000_000_000,
        enable: true,
        comment: 'first customer',
        reset: 30,
        up: 2 * GIB,
        down: 7.5 * GIB,
        inboundRemark: 'Reality-DE',
        inboundProtocol: 'vless',
        subscriptionUrl: 'https://sub.example.com/s/subAlice',
      },
      {
        email: 'bob',
        uuid: null,
        password: 'trojan-secret',
        subId: null,
        tgId: 0,
        totalGb: 0,
        limitIp: 0,
        expiryTime: 0,
        enable: false,
        comment: null,
        reset: 0,
        up: 0,
        down: 0,
        inboundRemark: null,
        inboundProtocol: null,
        subscriptionUrl: null,
      },
    ]);
  });

  it('reads the legacy layout from inbounds.settings, one customer per e-mail', () => {
    const clients = parseThreeXuiBackup(buildBackup(populateLegacy));

    assert.deepEqual(
      clients.map((c) => [c.email, c.inboundRemark, c.inboundProtocol]),
      [
        ['carol', 'VLESS-NL', 'vless'],
        ['dave', 'VLESS-NL', 'vless'],
        ['erin', 'Trojan-FI', 'trojan'],
      ],
    );
    const carol = clients[0];
    assert.equal(carol.uuid, '22222222-2222-4222-8222-222222222222');
    assert.equal(carol.tgId, 42);
    assert.equal(carol.totalGb, 10 * GIB);
    assert.equal(carol.up, 1 * GIB);
    assert.equal(carol.down, 3 * GIB);
    assert.equal(carol.enable, true);
    assert.equal(clients[1].enable, false);
    assert.equal(clients[2].enable, true, 'a client without `enable` is enabled');
  });

  it('refuses a database that holds no client at all', () => {
    const empty = buildBackup((db) => {
      db.exec(`
        CREATE TABLE inbounds (id INTEGER PRIMARY KEY, remark TEXT, protocol TEXT, settings TEXT);
        CREATE TABLE client_traffics (
          email TEXT, up INTEGER, down INTEGER, total INTEGER, expiry_time INTEGER,
          enable INTEGER, inbound_id INTEGER
        );
      `);
    });

    assert.throws(
      () => parseThreeXuiBackup(empty),
      (error: unknown) =>
        error instanceof BadRequestException &&
        /No client records found in the 3x-ui database/.test(error.message),
    );
  });

  it('leaves no copy of the uploaded database behind, whether it parses or is refused', () => {
    parseThreeXuiBackup(buildBackup(populateV3));
    const empty = buildBackup((db) => {
      db.exec('CREATE TABLE inbounds (id INTEGER, remark TEXT, protocol TEXT, settings TEXT)');
      db.exec('CREATE TABLE client_traffics (email TEXT, up INTEGER, down INTEGER)');
    });
    assert.throws(() => parseThreeXuiBackup(empty), BadRequestException);

    assert.deepEqual(parserTempFiles(), leftoversBefore);
  });
});
