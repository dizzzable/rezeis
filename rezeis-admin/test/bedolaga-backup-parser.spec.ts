import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { Headers, pack } from 'tar-stream';

import { parseBedolagaBackup } from '../src/modules/imports/utils/bedolaga-backup-parser';

/**
 * Reading a Bedolaga backup.
 *
 * The property this file exists for: **the same backup, written the two ways
 * Bedolaga writes it, must import to the same thing.** The bot shells out to
 * `pg_dump` when the binary is on PATH and falls back to a JSON export of the
 * same tables when it is not — so two operators on the same version hand us
 * two entirely different files, and neither of them knows which one they have.
 *
 * A parser that handled one and mangled the other would not fail loudly; it
 * would import half the columns as zeroes.
 */

/** A COPY block, written the way `pg_dump --format=plain` writes one. */
function copyBlock(table: string, columns: readonly string[], rows: readonly string[][]): string {
  return [
    `COPY public.${table} (${columns.join(', ')}) FROM stdin;`,
    ...rows.map((row) => row.join('\t')),
    '\\.',
    '',
  ].join('\n');
}

const USER_COLUMNS = [
  'id',
  'telegram_id',
  'username',
  'first_name',
  'status',
  'language',
  'balance_kopeks',
  'referred_by_id',
  'promo_group_id',
  'promo_offer_discount_percent',
  'has_had_paid_subscription',
  'remnawave_id',
  'created_at',
];

const SUBSCRIPTION_COLUMNS = [
  'id',
  'user_id',
  'status',
  'is_trial',
  'start_date',
  'end_date',
  'traffic_limit_gb',
  'traffic_used_gb',
  'purchased_traffic_gb',
  'device_limit',
  'connected_squads',
  'subscription_url',
  'remnawave_id',
  'tariff_id',
  'autopay_enabled',
];

function sqlDump(): string {
  return [
    '-- PostgreSQL database dump',
    copyBlock('users', USER_COLUMNS, [
      [
        '1',
        '777000111',
        'petya',
        'Пётр',
        'active',
        'ru',
        '125050',
        '\\N',
        '2',
        '0',
        't',
        '4242',
        '2026-01-05 10:00:00+00',
      ],
      [
        '2',
        '\\N',
        '\\N',
        '\\N',
        'blocked',
        'en',
        '-500',
        '1',
        '\\N',
        '15',
        'f',
        '\\N',
        '2026-02-01 09:30:00+00',
      ],
    ]),
    copyBlock('subscriptions', SUBSCRIPTION_COLUMNS, [
      [
        '10',
        '1',
        'active',
        'f',
        '2026-01-05 10:00:00+00',
        '2026-12-31 23:59:00+00',
        '0',
        '12.5',
        '50',
        '3',
        '["squad-a", "squad-b"]',
        'https://sub.example/abc',
        '4242',
        '7',
        't',
      ],
    ]),
    copyBlock('tariffs', ['id', 'name', 'traffic_limit_gb', 'device_limit', 'allowed_squads', 'period_prices', 'is_active', 'display_order'], [
      ['7', 'Год', '0', '3', '["squad-a"]', '{"30": 50000, "365": 500000}', 't', '1'],
    ]),
    copyBlock('promo_groups', ['id', 'name', 'priority', 'server_discount_percent', 'traffic_discount_percent', 'device_discount_percent', 'is_default'], [
      ['2', 'Постоянные', '10', '20', '0', '0', 'f'],
    ]),
    copyBlock('user_promo_groups', ['user_id', 'promo_group_id'], [['1', '2']]),
    copyBlock('withdrawal_requests', ['id', 'user_id', 'amount_kopeks', 'status'], [
      ['1', '1', '10000', 'pending'],
      ['2', '1', '5000', 'completed'],
    ]),
  ].join('\n');
}

/** The same data, as Bedolaga's ORM export writes it: real JSON types. */
function jsonExport(): unknown {
  return {
    metadata: { version: 'orm-1.0', database_type: 'postgresql' },
    data: {
      users: [
        {
          id: 1,
          telegram_id: 777000111,
          username: 'petya',
          first_name: 'Пётр',
          status: 'active',
          language: 'ru',
          balance_kopeks: 125050,
          referred_by_id: null,
          promo_group_id: 2,
          promo_offer_discount_percent: 0,
          has_had_paid_subscription: true,
          remnawave_id: 4242,
          created_at: '2026-01-05T10:00:00+00:00',
        },
        {
          id: 2,
          telegram_id: null,
          username: null,
          first_name: null,
          status: 'blocked',
          language: 'en',
          balance_kopeks: -500,
          referred_by_id: 1,
          promo_group_id: null,
          promo_offer_discount_percent: 15,
          has_had_paid_subscription: false,
          remnawave_id: null,
          created_at: '2026-02-01T09:30:00+00:00',
        },
      ],
      subscriptions: [
        {
          id: 10,
          user_id: 1,
          status: 'active',
          is_trial: false,
          start_date: '2026-01-05T10:00:00+00:00',
          end_date: '2026-12-31T23:59:00+00:00',
          traffic_limit_gb: 0,
          traffic_used_gb: 12.5,
          purchased_traffic_gb: 50,
          device_limit: 3,
          connected_squads: ['squad-a', 'squad-b'],
          subscription_url: 'https://sub.example/abc',
          remnawave_id: 4242,
          tariff_id: 7,
          autopay_enabled: true,
        },
      ],
      tariffs: [
        {
          id: 7,
          name: 'Год',
          traffic_limit_gb: 0,
          device_limit: 3,
          allowed_squads: ['squad-a'],
          period_prices: { '30': 50000, '365': 500000 },
          is_active: true,
          display_order: 1,
        },
      ],
      promo_groups: [
        {
          id: 2,
          name: 'Постоянные',
          priority: 10,
          server_discount_percent: 20,
          traffic_discount_percent: 0,
          device_discount_percent: 0,
          is_default: false,
        },
      ],
      withdrawal_requests: [
        { id: 1, user_id: 1, amount_kopeks: 10000, status: 'pending' },
        { id: 2, user_id: 1, amount_kopeks: 5000, status: 'completed' },
      ],
    },
    associations: {
      user_promo_groups: [{ user_id: 1, promo_group_id: 2 }],
    },
  };
}

describe('the two shapes a Bedolaga backup comes in', () => {
  it('reads the pg_dump one', async () => {
    const data = await parseBedolagaBackup(Buffer.from(sqlDump(), 'utf-8'));

    assert.equal(data.sourceFormat, 'sql');
    assert.equal(data.users.length, 2);
    assert.equal(data.users[0].telegram_id, 777000111);
    assert.equal(data.users[0].balance_kopeks, 125050);
    assert.equal(data.subscriptions[0].traffic_used_gb, 12.5);
    assert.deepEqual([...data.subscriptions[0].connected_squads], ['squad-a', 'squad-b']);
  });

  it('reads the ORM one', async () => {
    const data = await parseBedolagaBackup(Buffer.from(JSON.stringify(jsonExport()), 'utf-8'));

    assert.equal(data.sourceFormat, 'orm');
    assert.equal(data.users.length, 2);
    assert.equal(data.users[0].telegram_id, 777000111);
  });

  it('agrees with itself: the same backup, both ways, is the same data', async () => {
    // THE POINT OF THIS FILE. Every field below arrives as a STRING from the
    // dump and as a native value from the export; a coercion that reads only
    // one of them turns real customers into rows of zeroes without failing.
    const fromSql = await parseBedolagaBackup(Buffer.from(sqlDump(), 'utf-8'));
    const fromJson = await parseBedolagaBackup(
      Buffer.from(JSON.stringify(jsonExport()), 'utf-8'),
    );

    assert.deepEqual(fromJson.users, fromSql.users);
    assert.deepEqual(fromJson.subscriptions, fromSql.subscriptions);
    assert.deepEqual(fromJson.tariffs, fromSql.tariffs);
    assert.deepEqual(fromJson.promoGroups, fromSql.promoGroups);
    assert.deepEqual(fromJson.userPromoGroups, fromSql.userPromoGroups);
    assert.deepEqual(fromJson.excludedData, fromSql.excludedData);
  });
});

describe('what the parser preserves', () => {
  it('keeps a person who has no telegram at all', async () => {
    // Bedolaga sells to email and OAuth accounts too; dropping them at the
    // door would lose a slice of the customer base silently.
    const data = await parseBedolagaBackup(Buffer.from(sqlDump(), 'utf-8'));

    assert.equal(data.users[1].telegram_id, null);
    assert.equal(data.users[1].status, 'blocked');
  });

  it('keeps a NEGATIVE balance as a negative number', async () => {
    // A debt is deliberate in the donor — their own account merge preserves
    // it. Clamping here would forgive it before anybody could decide to.
    const data = await parseBedolagaBackup(Buffer.from(sqlDump(), 'utf-8'));

    assert.equal(data.users[1].balance_kopeks, -500);
  });

  it('counts what it will not import, instead of dropping it in silence', async () => {
    const data = await parseBedolagaBackup(Buffer.from(sqlDump(), 'utf-8'));

    // A pending withdrawal is money still sitting in the balance: import both
    // without noticing and the operator pays it twice.
    assert.equal(data.excludedData.pendingWithdrawals, 1);
    assert.equal(data.excludedData.withdrawals, 2);
  });

  it('reads a period price table whose keys are strings', async () => {
    const data = await parseBedolagaBackup(Buffer.from(sqlDump(), 'utf-8'));

    assert.deepEqual(data.tariffs[0].period_prices, { '30': 50000, '365': 500000 });
  });
});

describe('what the parser refuses', () => {
  it('unwraps a gzipped dump', async () => {
    const data = await parseBedolagaBackup(gzipSync(Buffer.from(sqlDump(), 'utf-8')));

    assert.equal(data.users.length, 2);
  });

  it('refuses a file that is neither', async () => {
    await assert.rejects(
      () => parseBedolagaBackup(Buffer.from('this is a photograph of a cat', 'utf-8')),
      /Unsupported file format/,
    );
  });

  it('refuses an empty file rather than importing nothing', async () => {
    await assert.rejects(() => parseBedolagaBackup(Buffer.alloc(0)), /empty/i);
  });

  it('refuses a dump with no users in it', async () => {
    const empty = copyBlock('tariffs', ['id', 'name'], [['1', 'X']]);

    await assert.rejects(() => parseBedolagaBackup(Buffer.from(empty, 'utf-8')), /no user records/i);
  });
});

/** A `.tar.gz` shaped the way Bedolaga's own backup writer shapes one. */
function buildBackupArchive(entries: readonly TarEntry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = pack();
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('error', reject);
    archive.on('end', () => resolve(gzipSync(Buffer.concat(chunks))));
    const add = (index: number): void => {
      if (index === entries.length) {
        archive.finalize();
        return;
      }
      const entry = entries[index];
      const header: Headers = { name: entry.name, type: entry.type };
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

type TarEntry = { readonly name: string; readonly content?: Buffer; readonly type?: Headers['type'] };

describe('the file an operator actually uploads', () => {
  it('reads the archive the bot writes, alongside its metadata', async () => {
    // Every other case here feeds a bare dump. This is the shape that comes
    // out of Bedolaga's own Backups menu, and it was the one shape nothing
    // exercised.
    const archive = await buildBackupArchive([
      { name: './', type: 'directory' },
      { name: 'metadata.json', content: Buffer.from('{"format_version":"2.0"}') },
      { name: 'database.sql', content: Buffer.from(sqlDump(), 'utf-8') },
    ]);

    const data = await parseBedolagaBackup(archive);

    assert.equal(data.sourceFormat, 'sql');
    assert.equal(data.users.length, 2);
  });

  it('reads the JSON archive the same way', async () => {
    const archive = await buildBackupArchive([
      { name: 'metadata.json', content: Buffer.from('{"format_version":"2.0"}') },
      { name: 'database.json', content: Buffer.from(JSON.stringify(jsonExport()), 'utf-8') },
    ]);

    const data = await parseBedolagaBackup(archive);

    assert.equal(data.sourceFormat, 'orm');
    assert.equal(data.users[0].telegram_id, 777000111);
  });

  it('is not confused by the operator’s own data directory inside the archive', async () => {
    // Bedolaga copies the WHOLE `data/` directory into its backup. An
    // operator with any stray `.sql` in there — or a nested database.json
    // from some other tool — would give two matches, and two matches is a
    // refusal. A real backup would be rejected with nothing they could do.
    const archive = await buildBackupArchive([
      { name: 'metadata.json', content: Buffer.from('{}') },
      { name: 'data/exports/last-report.sql', content: Buffer.from('SELECT 1;') },
      { name: 'data/backups/database.json', content: Buffer.from('{"data":{"users":[]}}') },
      { name: 'database.sql', content: Buffer.from(sqlDump(), 'utf-8') },
    ]);

    const data = await parseBedolagaBackup(archive);

    assert.equal(data.users.length, 2, 'the payload is the one at the root');
  });

  it('refuses a malformed payload as a refusal, not as a raw exception', async () => {
    // A SyntaxError escaping here becomes the whole of the operator's error
    // message, and is reported as a server fault rather than a bad upload.
    const archive = await buildBackupArchive([
      { name: 'database.json', content: Buffer.from('{"data": {"users": [') },
    ]);

    await assert.rejects(() => parseBedolagaBackup(archive), /Failed to parse backup contents/i);
  });

  it('says so when the archive holds no database at all', async () => {
    const archive = await buildBackupArchive([
      { name: 'metadata.json', content: Buffer.from('{}') },
    ]);

    await assert.rejects(() => parseBedolagaBackup(archive), /No database\.sql or database\.json/i);
  });
});

describe('what the report can honestly claim', () => {
  it('admits that a JSON backup cannot see every table', async () => {
    // The ORM export dumps a hand-picked list of models and coupons are not
    // among them, so a zero there means "this file does not say" — telling an
    // operator with three thousand unredeemed coupons that nothing was left
    // behind would be worse than saying nothing.
    const fromJson = await parseBedolagaBackup(
      Buffer.from(JSON.stringify(jsonExport()), 'utf-8'),
    );
    const fromSql = await parseBedolagaBackup(Buffer.from(sqlDump(), 'utf-8'));

    assert.equal(fromSql.excludedDataIsComplete, true);
    assert.equal(fromJson.excludedDataIsComplete, false);
  });
});
