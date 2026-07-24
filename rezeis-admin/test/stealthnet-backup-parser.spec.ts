import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseStealthnetBackup } from '../src/modules/imports/utils/stealthnet-backup-parser';

/**
 * Real operator dump (STEALTHNET pg_dump plain). Path may be absent in CI —
 * tests skip gracefully when the fixture is not mounted.
 */
const REAL_DUMP =
  process.env.STEALTHNET_DUMP_PATH ??
  'C:\\Users\\dizzable\\Downloads\\Telegram Desktop\\stealthnet-backup-2026-07-20T15-52-41.sql';

function miniDump(opts: {
  readonly subscriptionTable?: 'subscriptions' | 'secondary_subscriptions';
  readonly withExtra?: boolean;
}): string {
  const table = opts.subscriptionTable ?? 'subscriptions';
  const extraVals = opts.withExtra ? '\t2026-08-01 00:00:00\t2\t80' : '';
  // columns must match COPY header
  const subCols = opts.withExtra
    ? 'id, owner_id, remnawave_uuid, subscription_index, tariff_id, gift_status, gifted_to_client_id, created_at, updated_at, expire_at, extra_devices, extra_devices_monthly_price'
    : 'id, owner_id, remnawave_uuid, subscription_index, tariff_id, gift_status, gifted_to_client_id, created_at, updated_at';
  return `
COPY public.clients (id, email, password_hash, role, remnawave_uuid, referral_code, referrer_id, balance, preferred_lang, preferred_currency, telegram_id, telegram_username, is_blocked, block_reason, trial_used, current_tariff_id, bot_id, created_at, updated_at) FROM stdin;
c1\tuser@ex.com\t\\N\tCLIENT\t\\N\t\\N\t\\N\t0\tru\trub\t12345\talice\tf\t\\N\tf\t\\N\t\\N\t2026-01-01 00:00:00\t2026-01-01 00:00:00
\\.

COPY public.${table} (${subCols}) FROM stdin;
s1\tc1\tuuid-1\t0\ttar1\t\\N\t\\N\t2026-01-01 00:00:00\t2026-01-01 00:00:00${extraVals}
\\.

COPY public.tariffs (id, category_id, name, description, duration_days, internal_squad_uuids, traffic_limit_bytes, traffic_reset_mode, device_limit, price, currency, sort_order, included_devices, max_extra_devices, price_per_extra_device) FROM stdin;
tar1\tcat1\tPlan A\t\\N\t30\t{}\t\\N\tno_reset\t\\N\t100\trub\t0\t3\t5\t40
\\.

COPY public.tariff_categories (id, name, emoji_key, sort_order) FROM stdin;
cat1\tMain\t\\N\t0
\\.

COPY public.tariff_price_options (id, tariff_id, duration_days, price, sort_order) FROM stdin;
opt1\ttar1\t90\t250\t1
\\.

COPY public.payments (id, client_id, order_id, amount, currency, status, provider, external_id, tariff_id, tariff_price_option_id, proxy_tariff_id, singbox_tariff_id, remnawave_user_id, metadata, created_at, paid_at, device_count, bot_id) FROM stdin;
p1\tc1\tord-1\t100\trub\tPAID\tyookassa\t\\N\ttar1\t\\N\t\\N\t\\N\t\\N\t\\N\t2026-01-02 00:00:00\t2026-01-02 00:00:00\t\\N\t\\N
\\.
`;
}

describe('parseStealthnetBackup', () => {
  it('reads modern subscriptions table (not only secondary_subscriptions)', async () => {
    const data = await parseStealthnetBackup(Buffer.from(miniDump({}), 'utf8'));
    assert.equal(data.clients.length, 1);
    assert.equal(data.subscriptions.length, 1);
    assert.equal(data.subscriptions[0].remnawave_uuid, 'uuid-1');
    assert.equal(data.tariffs.length, 1);
    assert.equal(data.tariffs[0].included_devices, 3);
    assert.equal(data.tariffs[0].max_extra_devices, 5);
    assert.equal(data.tariffs[0].price_per_extra_device, 40);
    assert.equal(data.tariffPriceOptions.length, 1);
    assert.equal(data.payments.length, 1);
  });

  it('still accepts legacy secondary_subscriptions table name', async () => {
    const data = await parseStealthnetBackup(
      Buffer.from(miniDump({ subscriptionTable: 'secondary_subscriptions' }), 'utf8'),
    );
    assert.equal(data.subscriptions.length, 1);
    assert.equal(data.subscriptions[0].id, 's1');
  });

  it('parses expire_at and extra_devices add-on counters', async () => {
    const data = await parseStealthnetBackup(
      Buffer.from(miniDump({ withExtra: true }), 'utf8'),
    );
    const sub = data.subscriptions[0];
    assert.equal(sub.extra_devices, 2);
    assert.equal(sub.extra_devices_monthly_price, 80);
    assert.ok(sub.expire_at?.includes('2026-08-01'));
  });

  it('parses the operator real dump when available (363 clients / 325 subs)', async () => {
    let buf: Buffer;
    try {
      buf = readFileSync(REAL_DUMP);
    } catch {
      // CI / sandbox without the local Telegram dump — skip.
      return;
    }
    const data = await parseStealthnetBackup(buf);
    assert.equal(data.clients.length, 363);
    assert.equal(data.subscriptions.length, 325, 'must not drop subscriptions table');
    assert.equal(data.tariffs.length, 3);
    assert.ok(data.subscriptions.every((s) => s.remnawave_uuid));
    const withExtra = data.subscriptions.filter((s) => s.extra_devices > 0);
    assert.equal(withExtra.length, 3);
    assert.ok(data.tariffs.some((t) => t.included_devices >= 1));
  });
});
