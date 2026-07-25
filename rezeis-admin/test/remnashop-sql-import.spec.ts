import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import { Headers, pack } from 'tar-stream';

import {
  looksLikePgDump,
  parsePgCopyTables,
  pgArray,
  pgBool,
  pgJson,
  pgNumberArray,
  pgTimestampToIso,
} from '../src/modules/imports/utils/pg-dump-parser';
import { parseRemnashopBackup } from '../src/modules/imports/utils/remnashop-backup-parser';

// A representative remnashop pg_dump slice (tabs are real \t; \N is null;
// arrays `{...}`; jsonb plan_snapshot; role enum strings; +00 timestamps).
const SQL_DUMP = [
  "SET client_encoding = 'UTF8';",
  '',
  'COPY public.users (id, telegram_id, username, name, role, language, personal_discount, purchase_discount, is_blocked, is_bot_blocked, current_subscription_id, created_at, updated_at, referral_code, points, is_rules_accepted, is_trial_available) FROM stdin;',
  '30\t100000001\talice_example\tAlice Example\tUSER\tRU\t0\t0\tf\tt\t\\N\t2026-06-10 14:52:59.213265+00\t2026-06-10 14:57:33.974556+00\tcode_a\t0\tf\tt',
  '27\t100000002\t\\N\tBob Example\tADMIN\tEN\t5\t10\tf\tf\t\\N\t2026-06-01 19:00:30.372806+00\t2026-06-01 19:00:30.372806+00\tcode_b\t3\tt\tf',
  '\\.',
  '',
  'COPY public.subscriptions (id, user_remna_id, user_telegram_id, status, is_trial, traffic_limit, device_limit, internal_squads, expire_at, url, plan_snapshot, created_at, updated_at, external_squad, traffic_limit_strategy, tag) FROM stdin;',
  '21\t11111111-1111-4111-8111-111111111111\t100000001\tDELETED\tt\t0\t5\t{22222222-2222-4222-8222-222222222222}\t2026-06-22 20:15:35.297+00\thttps://example.test/subscription\t{"id": 4, "tag": "TEST_TAG", "device_limit": 5}\t2026-05-23 20:15:35.280959+00\t2026-06-17 00:15:19.33+00\t\\N\tNO_RESET\tTEST_TAG',
  '\\.',
  '',
  'COPY public.transactions (id, payment_id, user_telegram_id, status, is_test, purchase_type, gateway_type, pricing, currency, plan_snapshot, created_at) FROM stdin;',
  '7\tpay_001\t100000001\tCOMPLETED\tf\tSUBSCRIPTION\tYOOKASSA\t{"amount":"199.00","duration_days":30}\tRUB\t{"id": 4, "tag": "TEST_TAG"}\t2026-06-11 15:00:00+00',
  '\\.',
  '',
  'COPY public.referrals (id, referrer_telegram_id, referred_telegram_id, level, created_at) FROM stdin;',
  '3\t100000001\t100000002\tDIRECT\t2026-06-12 10:00:00+00',
  '\\.',
  '',
  'COPY public.referral_rewards (id, referral_id, user_telegram_id, type, amount, is_issued, created_at) FROM stdin;',
  '8\t3\t100000001\tPOINTS\t15\tt\t2026-06-13 11:00:00+00',
  '\\.',
  '',
  'COPY public.settings (id, key) FROM stdin;',
  '1\tsensitive_setting',
  '\\.',
  '',
  'COPY public.payment_gateways (id, type) FROM stdin;',
  '5\tYOOKASSA',
  '\\.',
  '',
  'COPY public.broadcasts (id, status) FROM stdin;',
  '10\tSENT',
  '\\.',
  '',
  'COPY public.broadcast_messages (id, broadcast_id) FROM stdin;',
  '11\t10',
  '12\t10',
  '\\.',
  '',
  'COPY public.plans (id, order_index, is_active, type, availability, name, traffic_limit, device_limit, allowed_user_ids, internal_squads, created_at, updated_at, description, tag, traffic_limit_strategy, external_squad, is_trial, public_code) FROM stdin;',
  '4\t0\tt\tDEVICES\tNEW\tTrial 5d\t0\t5\t{}\t{22222222-2222-4222-8222-222222222222}\t2026-05-06 16:04:56.467199+00\t2026-06-17 03:01:15.68622+00\t\\N\tTEST_TAG\tNO_RESET\t\\N\tt\ttest-plan',
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
    assert.equal(users.rows[0].telegram_id, '100000001');
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

describe('parseRemnashopBackup - SQL dump', () => {
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
    assert.deepEqual(sub.internal_squads, ['22222222-2222-4222-8222-222222222222']);
    assert.equal(sub.external_squad, null);
    assert.equal(sub.status, 'DELETED');
    assert.equal((sub.plan_snapshot as { tag: string }).tag, 'TEST_TAG');

    assert.equal(data.transactions.length, 1);
    assert.equal(data.transactions[0].payment_id, 'pay_001');
    assert.equal(data.transactions[0].gateway_type, 'YOOKASSA');
    assert.equal((data.transactions[0].pricing as { amount: string }).amount, '199.00');

    assert.equal(data.referrals.length, 1);
    assert.equal(data.referrals[0].referrer_telegram_id, 100000001);
    assert.equal(data.referrals[0].referred_telegram_id, 100000002);

    assert.equal(data.referralRewards.length, 1);
    assert.equal(data.referralRewards[0].amount, 15);
    assert.equal(data.referralRewards[0].is_issued, true);

    assert.deepEqual(data.excludedData, {
      settings: 1,
      paymentGateways: 1,
      broadcasts: 1,
      broadcastMessages: 2,
    });

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
    assert.equal(data.transactions.length, 1);
  });

  it('accepts the official backup .tar.gz with a nested bot_dump_*.sql.gz', async () => {
    const tarGz = await buildTarGz([
      { name: 'backup_meta.info', content: Buffer.from('DUMP_TYPE="dumpall"\n') },
      {
        name: 'bot_dump_2026-06-17_03_08_44.sql.gz',
        content: gzipSync(Buffer.from(SQL_DUMP, 'utf-8')),
      },
    ]);
    const data = await parseRemnashopBackup(tarGz);
    assert.equal(data.users.length, 2);
    assert.equal(data.subscriptions.length, 1);
    assert.equal(data.transactions.length, 1);
    assert.equal(data.referrals.length, 1);
    assert.equal(data.plans.length, 1);
  });

  it('accepts a raw JSON export and summarizes excluded rows without leaking them', async () => {
    const rawJson = Buffer.from(
      JSON.stringify({
        data: {
          users: [{ id: 1, telegram_id: 123 }],
          subscriptions: [],
          transactions: [{ id: 5, payment_id: 'json-pay', user_telegram_id: 123 }],
          referrals: [
            { id: 6, referrer_telegram_id: 123, referred_telegram_id: 456, level: 'DIRECT' },
          ],
          referral_rewards: [
            {
              id: 7,
              referral_id: 6,
              user_telegram_id: 123,
              type: 'POINTS',
              amount: 5,
              is_issued: true,
            },
          ],
          settings: [{ id: 1 }],
          payment_gateways: [{ id: 2 }],
          broadcasts: [{ id: 3 }],
          broadcast_messages: [{ id: 4 }, { id: 5 }],
        },
      }),
      'utf-8',
    );

    const data = await parseRemnashopBackup(rawJson);
    assert.equal(data.users.length, 1);
    assert.equal(data.transactions[0].payment_id, 'json-pay');
    assert.equal(data.referrals[0].level, 'DIRECT');
    assert.equal(data.referralRewards[0].amount, 5);
    assert.deepEqual(data.excludedData, {
      settings: 1,
      paymentGateways: 1,
      broadcasts: 1,
      broadcastMessages: 2,
    });
    assert.equal((data as unknown as Record<string, unknown>).settings, undefined);
  });

  it('rejects an archive without database.json or a sql dump', async () => {
    const tarGz = await buildTarGz([
      { name: 'backup_meta.info', content: Buffer.from('DUMP_TYPE="dumpall"\n') },
    ]);
    await assert.rejects(() => parseRemnashopBackup(tarGz), /No database\.json or \.sql dump/);
  });

  it('rejects duplicate archive payload entries', async () => {
    const tarGz = await buildTarGz([
      { name: 'database.json', content: Buffer.from('{"users":[{"id":1}]}', 'utf-8') },
      {
        name: 'bot_dump_2026-06-17_03_08_44.sql.gz',
        content: gzipSync(Buffer.from(SQL_DUMP, 'utf-8')),
      },
    ]);

    await assert.rejects(() => parseRemnashopBackup(tarGz), /duplicate database payloads/i);
  });

  it('rejects unsafe archive entry paths', async () => {
    const tarGz = await buildTarGz([
      { name: '../database.json', content: Buffer.from('{"users":[{"id":1}]}', 'utf-8') },
    ]);

    await assert.rejects(() => parseRemnashopBackup(tarGz), /unsafe path/i);
  });

  it('rejects unsafe archive entry types', async () => {
    const tarGz = await buildTarGz([
      { name: 'database.json', type: 'symlink', linkname: 'elsewhere.json' },
    ]);

    await assert.rejects(() => parseRemnashopBackup(tarGz), /type 'symlink' is not allowed/i);
  });

  it('rejects malformed gzip payloads', async () => {
    await assert.rejects(
      () => parseRemnashopBackup(Buffer.from([0x1f, 0x8b, 0x08, 0x00])),
      /Failed to decompress backup file/i,
    );
  });

  it('rejects oversized raw JSON exports', async () => {
    const oversizedJson = Buffer.from(
      JSON.stringify({
        users: [{ id: 1 }],
        filler: 'x'.repeat(64 * 1024 * 1024 + 1024),
      }),
      'utf-8',
    );

    await assert.rejects(() => parseRemnashopBackup(oversizedJson), /JSON export exceeds 64 MiB/);
  });
});

type TarEntryInput = {
  readonly name: string;
  readonly content?: Buffer;
  readonly type?: Headers['type'];
  readonly linkname?: string;
};

function buildTarGz(entries: ReadonlyArray<TarEntryInput>): Promise<Buffer> {
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

      const entry = entries[i];
      const header: Headers = {
        name: entry.name,
        type: entry.type,
        linkname: entry.linkname,
      };

      const done = (err?: Error | null): void => {
        if (err) {
          reject(err);
          return;
        }
        addNext(i + 1);
      };

      if (entry.type && entry.type !== 'file') {
        p.entry(header, done);
        return;
      }

      p.entry(header, entry.content ?? Buffer.alloc(0), done);
    };

    addNext(0);
  });
}
