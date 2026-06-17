import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';

import { pack } from 'tar-stream';

import {
  parsePgCopyTables,
  pgArray,
  pgBool,
  pgJson,
  pgNumberArray,
  pgTimestampToIso,
  looksLikePgDump,
} from '../src/modules/imports/utils/pg-dump-parser';
import { parseRemnashopBackup } from '../src/modules/imports/utils/remnashop-backup-parser';

// A representative remnashop pg_dump slice (tabs are real \t; \N is null;
// arrays `{...}`; jsonb plan_snapshot; role enum strings; +00 timestamps).
const SQL_DUMP = [
  'SET client_encoding = \'UTF8\';',
  '',
  'COPY public.users (id, telegram_id, username, name, role, language, personal_discount, purchase_discount, is_blocked, is_bot_blocked, current_subscription_id, created_at, updated_at, referral_code, points, is_rules_accepted, is_trial_available) FROM stdin;',
  '30\t1481321199\tTim_Sobak\tTim\tUSER\tRU\t0\t0\tf\tt\t\\N\t2026-06-10 14:52:59.213265+00\t2026-06-10 14:57:33.974556+00\tdiptla\t0\tf\tt',
  '27\t8801320487\t\\N\tTioo\tADMIN\tEN\t5\t10\tf\tf\t\\N\t2026-06-01 19:00:30.372806+00\t2026-06-01 19:00:30.372806+00\t94me3p\t3\tt\tf',
  '\\.',
  '',
  'COPY public.subscriptions (id, user_remna_id, user_telegram_id, status, is_trial, traffic_limit, device_limit, internal_squads, expire_at, url, plan_snapshot, created_at, updated_at, external_squad, traffic_limit_strategy, tag) FROM stdin;',
  '21\t055e4d6b-13b3-4ad6-b212-a41dc3dde0af\t5035495652\tDELETED\tt\t0\t5\t{954f9c34-c461-4f48-880c-63898fd924ad}\t2026-06-22 20:15:35.297+00\thttps://link.example/zXLHQafUw5C3oo52\t{"id": 4, "tag": "BETTA", "device_limit": 5}\t2026-05-23 20:15:35.280959+00\t2026-06-17 00:15:19.33+00\t\\N\tNO_RESET\tBETTA',
  '\\.',
  '',
  'COPY public.plans (id, order_index, is_active, type, availability, name, traffic_limit, device_limit, allowed_user_ids, internal_squads, created_at, updated_at, description, tag, traffic_limit_strategy, external_squad, is_trial, public_code) FROM stdin;',
  '4\t0\tt\tDEVICES\tNEW\tTrial 5d\t0\t5\t{}\t{954f9c34-c461-4f48-880c-63898fd924ad}\t2026-05-06 16:04:56.467199+00\t2026-06-17 03:01:15.68622+00\t\\N\tBETTA\tNO_RESET\t\\N\tt\tyUxmKdWd',
  '\\.',
  '',
  'COPY public.plan_durations (id, days, plan_id, order_index) FROM stdin;',
  '1\t30\t4\t0',
  '\\.',
  '',
  'COPY public.plan_prices (id, currency, price, plan_duration_id) FROM stdin;',
  '1\tRUB\t199.00\t1',
  '\\.',
  '',
].join('\n');

describe('pg-dump-parser', () => {
  it('parses COPY blocks into keyed rows with null + escape handling', () => {
    const tables = parsePgCopyTables(SQL_DUMP);
    const users = tables.get('users');
    assert.ok(users);
    assert.equal(users.rows.length, 2);
    assert.equal(users.rows[0].telegram_id, '1481321199');
    assert.equal(users.rows[1].username, null); // \N → null
  });

  it('coerces postgres cell types', () => {
    assert.equal(pgBool('t'), true);
    assert.equal(pgBool('f'), false);
    assert.deepEqual(pgArray('{a,b,c}'), ['a', 'b', 'c']);
    assert.deepEqual(pgArray('{}'), []);
    assert.deepEqual(pgNumberArray('{1,2}'), [1, 2]);
    assert.equal(pgJson('{"a":1}')?.a, 1);
    assert.equal(pgJson(null), null);
    assert.equal(pgTimestampToIso('2026-06-10 14:52:59.213265+00'), '2026-06-10T14:52:59.213Z');
    assert.equal(looksLikePgDump(SQL_DUMP), true);
    assert.equal(looksLikePgDump('{"users":[]}'), false);
  });
});

describe('parseRemnashopBackup — SQL dump', () => {
  it('maps a raw .sql dump to the importer shapes', async () => {
    const data = await parseRemnashopBackup(Buffer.from(SQL_DUMP, 'utf-8'));

    assert.equal(data.users.length, 2);
    assert.equal(data.users[0].role, 1); // USER → 1
    assert.equal(data.users[1].role, 3); // ADMIN → 3
    assert.equal(data.users[1].username, null);
    assert.equal(data.users[1].points, 3);
    assert.equal(data.users[0].is_bot_blocked, true);

    assert.equal(data.subscriptions.length, 1);
    const sub = data.subscriptions[0];
    assert.deepEqual(sub.internal_squads, ['954f9c34-c461-4f48-880c-63898fd924ad']);
    assert.equal(sub.external_squad, null);
    assert.equal(sub.status, 'DELETED');
    assert.equal((sub.plan_snapshot as { tag: string }).tag, 'BETTA');

    assert.equal(data.plans.length, 1);
    assert.equal(data.plans[0].is_trial, true);
    assert.deepEqual(data.plans[0].allowed_user_ids, []);
    assert.equal(data.planDurations.length, 1);
    assert.equal(data.planPrices[0].price, '199.00');
  });

  it('accepts a gzipped .sql dump', async () => {
    const data = await parseRemnashopBackup(gzipSync(Buffer.from(SQL_DUMP, 'utf-8')));
    assert.equal(data.users.length, 2);
    assert.equal(data.subscriptions.length, 1);
  });

  it('accepts the official backup .tar.gz with a nested bot_dump_*.sql.gz', async () => {
    const tarGz = await buildTarGz([
      { name: 'backup_meta.info', content: Buffer.from('DUMP_TYPE="dumpall"\n') },
      { name: 'bot_dump_2026-06-17_03_08_44.sql.gz', content: gzipSync(Buffer.from(SQL_DUMP, 'utf-8')) },
    ]);
    const data = await parseRemnashopBackup(tarGz);
    assert.equal(data.users.length, 2);
    assert.equal(data.subscriptions.length, 1);
    assert.equal(data.plans.length, 1);
  });

  it('rejects an archive without database.json or a sql dump', async () => {
    const tarGz = await buildTarGz([
      { name: 'backup_meta.info', content: Buffer.from('DUMP_TYPE="dumpall"\n') },
    ]);
    await assert.rejects(() => parseRemnashopBackup(tarGz), /No database.json or .sql dump/);
  });
});

function buildTarGz(entries: ReadonlyArray<{ name: string; content: Buffer }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = pack();
    const chunks: Buffer[] = [];
    p.on('data', (c: Buffer) => chunks.push(c));
    p.on('end', () => resolve(gzipSync(Buffer.concat(chunks))));
    p.on('error', reject);

    const addNext = (i: number): void => {
      if (i >= entries.length) {
        p.finalize();
        return;
      }
      p.entry({ name: entries[i].name }, entries[i].content, (err) => {
        if (err) {
          reject(err);
          return;
        }
        addNext(i + 1);
      });
    };
    addNext(0);
  });
}
