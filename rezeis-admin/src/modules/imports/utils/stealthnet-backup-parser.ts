import {
  MAX_GZIP_OUTPUT_BYTES,
  MAX_INPUT_BYTES,
  MAX_SQL_BYTES,
  ensureBufferWithinLimit,
  gunzipBuffer,
  isGzipBuffer,
} from './backup-archive.util';

/**
 * STEALTHNET backup parser.
 *
 * Source: https://github.com/systemmaster1200-eng/remnawave-STEALTHNET-Bot
 *
 * Unlike altshop / remnashop (which export a typed JSON payload inside
 * a tar.gz), STEALTHNET dumps via plain `pg_dump --format=plain` so we
 * receive a raw `.sql` file with `COPY ... FROM stdin;` blocks. Each
 * row is tab-separated with these conventions:
 *
 *   - `\N` represents SQL NULL.
 *   - `{...}` is the postgres array literal.
 *   - JSON columns are stored as escaped UTF-8 strings.
 *   - The block ends with a single `\.` line.
 *   - Tabs / newlines / backslashes inside text are escaped as
 *     `\t`, `\n`, `\\` (per the COPY spec).
 *
 * We only parse the eight tables the importer cares about — the rest of
 * the dump (admin_events, marketplace_*, system_settings, etc.) is
 * ignored. Smaller surface = much faster parsing on the 0.7 MB dumps
 * we've seen and far fewer surprises when STEALTHNET adds new tables.
 */

// ── Public types ────────────────────────────────────────────────────────────

/**
 * `clients` row — STEALTHNET's user-facing record. The schema mirrors
 * remnawave-bedolaga + altshop heritage, but identifiers are CUIDs
 * rather than auto-increments.
 */
export interface StealthnetClient {
  readonly id: string;
  readonly email: string | null;
  readonly password_hash: string | null;
  readonly role: string;
  readonly remnawave_uuid: string | null;
  readonly referral_code: string | null;
  readonly referrer_id: string | null;
  readonly balance: number;
  readonly preferred_lang: string;
  readonly preferred_currency: string;
  readonly telegram_id: string | null;
  readonly telegram_username: string | null;
  readonly is_blocked: boolean;
  readonly block_reason: string | null;
  readonly trial_used: boolean;
  readonly current_tariff_id: string | null;
  readonly bot_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * `subscriptions` row (historical dumps may still use
 * `secondary_subscriptions`). STEALTHNET supports multiple
 * subscriptions per client; each one carries a remnawave UUID and an
 * optional `tariff_id` (pointing at the active plan).
 *
 * Extra-device add-ons are **not** a separate catalog table — they live
 * on the subscription (`extra_devices` + monthly price) and on the tariff
 * (`included_devices` / `max_extra_devices` / `price_per_extra_device`).
 */
export interface StealthnetSubscription {
  readonly id: string;
  readonly owner_id: string;
  readonly remnawave_uuid: string | null;
  readonly subscription_index: number;
  readonly tariff_id: string | null;
  readonly gift_status: string | null;
  readonly gifted_to_client_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  /** Panel expire when known; may be null for legacy rows. */
  readonly expire_at: string | null;
  /** Paid extra device slots on top of tariff.included_devices. */
  readonly extra_devices: number;
  readonly extra_devices_monthly_price: number;
}

/**
 * `tariffs` row — the catalog plan. STEALTHNET stores duration baseline
 * + price on the same row, with optional `tariff_price_options` rows
 * for additional (length, price) pairs.
 */
export interface StealthnetTariff {
  readonly id: string;
  readonly category_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly duration_days: number;
  readonly internal_squad_uuids: readonly string[];
  readonly traffic_limit_bytes: number | null;
  readonly traffic_reset_mode: string;
  readonly device_limit: number | null;
  readonly price: number;
  readonly currency: string;
  readonly sort_order: number;
  readonly included_devices: number;
  readonly max_extra_devices: number;
  readonly price_per_extra_device: number;
}

/** `tariff_categories` row. */
export interface StealthnetTariffCategory {
  readonly id: string;
  readonly name: string;
  readonly emoji_key: string | null;
  readonly sort_order: number;
}

/**
 * `tariff_price_options` row — additional duration→price pairs for a
 * tariff. The base `tariffs.duration_days/price` is also a valid
 * option; we surface both via the importer's normalisation layer.
 */
export interface StealthnetTariffPriceOption {
  readonly id: string;
  readonly tariff_id: string;
  readonly duration_days: number;
  readonly price: number;
  readonly sort_order: number;
}

/**
 * `payments` row — historical payment records, used to rebuild
 * Transaction history on import.
 */
export interface StealthnetPayment {
  readonly id: string;
  readonly client_id: string;
  readonly order_id: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
  readonly provider: string | null;
  readonly external_id: string | null;
  readonly tariff_id: string | null;
  readonly tariff_price_option_id: string | null;
  readonly proxy_tariff_id: string | null;
  readonly singbox_tariff_id: string | null;
  readonly remnawave_user_id: string | null;
  readonly metadata: string | null;
  readonly created_at: string;
  readonly paid_at: string | null;
  readonly device_count: number | null;
  readonly bot_id: string | null;
}

/**
 * Historical referral reward already credited by STEALTHNET. It is imported
 * as an issued audit record only: the corresponding wallet balance is moved
 * separately by the user importer, so applying it again would double-credit
 * the referrer.
 */
export interface StealthnetReferralCredit {
  readonly id: string;
  readonly referrer_id: string;
  readonly payment_id: string;
  readonly amount: number;
  readonly level: number;
  readonly created_at: string;
}

export interface StealthnetBackupData {
  readonly clients: readonly StealthnetClient[];
  readonly subscriptions: readonly StealthnetSubscription[];
  readonly tariffs: readonly StealthnetTariff[];
  readonly tariffCategories: readonly StealthnetTariffCategory[];
  readonly tariffPriceOptions: readonly StealthnetTariffPriceOption[];
  readonly payments: readonly StealthnetPayment[];
  readonly referralCredits: readonly StealthnetReferralCredit[];
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Parses a STEALTHNET pg_dump backup. Accepts either a raw `.sql` file
 * or a gzipped one (rare in practice — we still detect by the gzip
 * magic so an admin doesn't get a confusing error).
 */
export async function parseStealthnetBackup(buffer: Buffer): Promise<StealthnetBackupData> {
  // This parser used to bound NOTHING: no ceiling on the upload and, worse,
  // none on the decompression — its own `gunzipBuffer` concatenated chunks
  // until the stream ended. A gzip bomb is a small file by definition, so the
  // 100 MB cap at the HTTP layer bounded the wrong number and a modest upload
  // could expand until the process died. Same ceilings as every other importer
  // now, from the one place that owns them.
  ensureBufferWithinLimit(buffer, MAX_INPUT_BYTES, 'Backup file');

  if (isGzipBuffer(buffer)) {
    const decompressed = await gunzipBuffer(buffer, MAX_GZIP_OUTPUT_BYTES, 'backup file');
    ensureBufferWithinLimit(decompressed, MAX_SQL_BYTES, 'Decompressed SQL dump');
    return parseSqlDump(decompressed.toString('utf-8'));
  }

  ensureBufferWithinLimit(buffer, MAX_SQL_BYTES, 'Backup payload');
  return parseSqlDump(buffer.toString('utf-8'));
}

// ── Core parser ─────────────────────────────────────────────────────────────

interface CopyBlock {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
}

/**
 * Tokenise the dump into named COPY blocks. We use a simple line-based
 * scanner because pg_dump output is well-formed and consistent — we
 * don't need a full SQL parser.
 */
function parseSqlDump(sql: string): StealthnetBackupData {
  const lines = sql.split(/\r?\n/);
  const blocksByTable = new Map<string, CopyBlock>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('COPY public.')) continue;

    // "COPY public.tariffs (id, category_id, ...) FROM stdin;"
    const match = line.match(/^COPY public\.(\w+)\s*\(([^)]+)\)\s*FROM stdin;$/);
    if (!match) continue;
    const tableName = match[1];
    const columns = match[2].split(',').map((c) => c.trim());

    const rows: (string | null)[][] = [];
    let j = i + 1;
    while (j < lines.length && lines[j] !== '\\.') {
      // Empty trailing lines occasionally appear in pg_dump output —
      // skip them rather than producing a row with empty cells.
      if (lines[j].length > 0) {
        rows.push(parseCopyRow(lines[j], columns.length));
      }
      j += 1;
    }
    blocksByTable.set(tableName, { columns, rows });
    i = j;
  }

  // STEALTHNET renamed secondary_subscriptions → subscriptions. Prefer the
  // modern name; fall back so older dumps still parse.
  const subscriptionBlock =
    blocksByTable.get('subscriptions') ?? blocksByTable.get('secondary_subscriptions');

  return {
    clients: extractClients(blocksByTable.get('clients')),
    subscriptions: extractSubscriptions(subscriptionBlock),
    tariffs: extractTariffs(blocksByTable.get('tariffs')),
    tariffCategories: extractTariffCategories(blocksByTable.get('tariff_categories')),
    tariffPriceOptions: extractTariffPriceOptions(blocksByTable.get('tariff_price_options')),
    payments: extractPayments(blocksByTable.get('payments')),
    referralCredits: extractReferralCredits(blocksByTable.get('referral_credits')),
  };
}

/**
 * Parse one COPY row into raw cell values.
 *
 * Per the COPY documentation, cells are tab-separated and escaped as:
 *   `\N` → SQL NULL (returned as JS `null`)
 *   `\t` → tab
 *   `\n` → newline
 *   `\r` → carriage return
 *   `\\` → backslash
 *
 * We process the row character-by-character to handle these correctly
 * even when array literals or JSON columns embed escape sequences. The
 * `expectedColumns` parameter is informational — pg_dump always emits
 * the same number of cells per block but we tolerate mismatch by
 * padding with nulls instead of throwing.
 */
function parseCopyRow(raw: string, expectedColumns: number): (string | null)[] {
  const cells: (string | null)[] = [];
  let buffer = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\t') {
      cells.push(finaliseCell(buffer));
      buffer = '';
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      switch (next) {
        case 'N': // \N appears only on its own (no surrounding text)
          if (buffer === '' && (i + 2 === raw.length || raw[i + 2] === '\t')) {
            buffer = '\u0000NULL';
            i += 2;
            continue;
          }
          buffer += '\\N';
          i += 2;
          continue;
        case 't':
          buffer += '\t';
          i += 2;
          continue;
        case 'n':
          buffer += '\n';
          i += 2;
          continue;
        case 'r':
          buffer += '\r';
          i += 2;
          continue;
        case '\\':
          buffer += '\\';
          i += 2;
          continue;
        default:
          buffer += next;
          i += 2;
          continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  cells.push(finaliseCell(buffer));

  while (cells.length < expectedColumns) cells.push(null);
  return cells;
}

function finaliseCell(buffer: string): string | null {
  if (buffer === '\u0000NULL') return null;
  return buffer;
}

// ── Per-table extractors ────────────────────────────────────────────────────
//
// The mapping below is column-index based so adding new STEALTHNET
// schema columns later is a one-line change. Each extractor falls back
// to a sensible default when the column is missing or null — better
// than failing the entire import on one stale dump.

function colIndex(block: CopyBlock | undefined, name: string): number {
  if (!block) return -1;
  return block.columns.indexOf(name);
}

function readString(row: readonly (string | null)[], idx: number, fallback = ''): string {
  if (idx < 0 || idx >= row.length) return fallback;
  return row[idx] ?? fallback;
}

function readNullableString(row: readonly (string | null)[], idx: number): string | null {
  if (idx < 0 || idx >= row.length) return null;
  return row[idx];
}

function readBoolean(row: readonly (string | null)[], idx: number, fallback = false): boolean {
  const v = readNullableString(row, idx);
  if (v === null) return fallback;
  return v === 't' || v === 'true' || v === '1';
}

function readNumber(row: readonly (string | null)[], idx: number, fallback = 0): number {
  const v = readNullableString(row, idx);
  if (v === null) return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function readNullableNumber(row: readonly (string | null)[], idx: number): number | null {
  const v = readNullableString(row, idx);
  if (v === null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function readInt(row: readonly (string | null)[], idx: number, fallback = 0): number {
  const v = readNullableString(row, idx);
  if (v === null) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function readNullableInt(row: readonly (string | null)[], idx: number): number | null {
  const v = readNullableString(row, idx);
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * PostgreSQL array literals: `{}` empty, `{a,b,c}` simple, `{"a","b"}`
 * quoted (when values contain commas/braces). For UUID arrays we only
 * see the simple form, but we still strip quotes defensively.
 */
function readStringArray(row: readonly (string | null)[], idx: number): string[] {
  const v = readNullableString(row, idx);
  if (v === null || v === '{}') return [];
  if (!v.startsWith('{') || !v.endsWith('}')) return [];
  const inner = v.slice(1, -1);
  if (inner === '') return [];
  return inner.split(',').map((part) => {
    const trimmed = part.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return trimmed;
  });
}

function extractClients(block: CopyBlock | undefined): StealthnetClient[] {
  if (!block) return [];
  const idIdx = colIndex(block, 'id');
  const emailIdx = colIndex(block, 'email');
  const passwordHashIdx = colIndex(block, 'password_hash');
  const roleIdx = colIndex(block, 'role');
  const remnawaveIdx = colIndex(block, 'remnawave_uuid');
  const refCodeIdx = colIndex(block, 'referral_code');
  const referrerIdIdx = colIndex(block, 'referrer_id');
  const balanceIdx = colIndex(block, 'balance');
  const langIdx = colIndex(block, 'preferred_lang');
  const currencyIdx = colIndex(block, 'preferred_currency');
  const telegramIdIdx = colIndex(block, 'telegram_id');
  const telegramUserIdx = colIndex(block, 'telegram_username');
  const isBlockedIdx = colIndex(block, 'is_blocked');
  const blockReasonIdx = colIndex(block, 'block_reason');
  const trialUsedIdx = colIndex(block, 'trial_used');
  const currentTariffIdx = colIndex(block, 'current_tariff_id');
  const botIdIdx = colIndex(block, 'bot_id');
  const createdAtIdx = colIndex(block, 'created_at');
  const updatedAtIdx = colIndex(block, 'updated_at');

  return block.rows.map((row) => ({
    id: readString(row, idIdx),
    email: readNullableString(row, emailIdx),
    password_hash: readNullableString(row, passwordHashIdx),
    role: readString(row, roleIdx, 'CLIENT'),
    remnawave_uuid: readNullableString(row, remnawaveIdx),
    referral_code: readNullableString(row, refCodeIdx),
    referrer_id: readNullableString(row, referrerIdIdx),
    balance: readNumber(row, balanceIdx, 0),
    preferred_lang: readString(row, langIdx, 'ru'),
    preferred_currency: readString(row, currencyIdx, 'usd'),
    telegram_id: readNullableString(row, telegramIdIdx),
    telegram_username: readNullableString(row, telegramUserIdx),
    is_blocked: readBoolean(row, isBlockedIdx, false),
    block_reason: readNullableString(row, blockReasonIdx),
    trial_used: readBoolean(row, trialUsedIdx, false),
    current_tariff_id: readNullableString(row, currentTariffIdx),
    bot_id: readNullableString(row, botIdIdx),
    created_at: readString(row, createdAtIdx, new Date().toISOString()),
    updated_at: readString(row, updatedAtIdx, new Date().toISOString()),
  }));
}

function extractSubscriptions(block: CopyBlock | undefined): StealthnetSubscription[] {
  if (!block) return [];
  const idIdx = colIndex(block, 'id');
  const ownerIdIdx = colIndex(block, 'owner_id');
  const remnawaveIdx = colIndex(block, 'remnawave_uuid');
  const indexIdx = colIndex(block, 'subscription_index');
  const tariffIdIdx = colIndex(block, 'tariff_id');
  const giftStatusIdx = colIndex(block, 'gift_status');
  const giftedToIdx = colIndex(block, 'gifted_to_client_id');
  const createdAtIdx = colIndex(block, 'created_at');
  const updatedAtIdx = colIndex(block, 'updated_at');
  const expireAtIdx = colIndex(block, 'expire_at');
  const extraDevicesIdx = colIndex(block, 'extra_devices');
  const extraDevicesPriceIdx = colIndex(block, 'extra_devices_monthly_price');

  return block.rows.map((row) => ({
    id: readString(row, idIdx),
    owner_id: readString(row, ownerIdIdx),
    remnawave_uuid: readNullableString(row, remnawaveIdx),
    subscription_index: readInt(row, indexIdx, 0),
    tariff_id: readNullableString(row, tariffIdIdx),
    gift_status: readNullableString(row, giftStatusIdx),
    gifted_to_client_id: readNullableString(row, giftedToIdx),
    created_at: readString(row, createdAtIdx, new Date().toISOString()),
    updated_at: readString(row, updatedAtIdx, new Date().toISOString()),
    expire_at: readNullableString(row, expireAtIdx),
    extra_devices: Math.max(0, readInt(row, extraDevicesIdx, 0)),
    extra_devices_monthly_price: Math.max(0, readNumber(row, extraDevicesPriceIdx, 0)),
  }));
}

function extractTariffs(block: CopyBlock | undefined): StealthnetTariff[] {
  if (!block) return [];
  const idIdx = colIndex(block, 'id');
  const catIdx = colIndex(block, 'category_id');
  const nameIdx = colIndex(block, 'name');
  const descIdx = colIndex(block, 'description');
  const durationIdx = colIndex(block, 'duration_days');
  const squadsIdx = colIndex(block, 'internal_squad_uuids');
  const trafficLimitIdx = colIndex(block, 'traffic_limit_bytes');
  const trafficModeIdx = colIndex(block, 'traffic_reset_mode');
  const deviceLimitIdx = colIndex(block, 'device_limit');
  const priceIdx = colIndex(block, 'price');
  const currencyIdx = colIndex(block, 'currency');
  const sortIdx = colIndex(block, 'sort_order');
  const includedIdx = colIndex(block, 'included_devices');
  const maxExtraIdx = colIndex(block, 'max_extra_devices');
  const pricePerExtraIdx = colIndex(block, 'price_per_extra_device');

  return block.rows.map((row) => ({
    id: readString(row, idIdx),
    category_id: readString(row, catIdx),
    name: readString(row, nameIdx),
    description: readNullableString(row, descIdx),
    duration_days: readInt(row, durationIdx, 30),
    internal_squad_uuids: readStringArray(row, squadsIdx),
    traffic_limit_bytes: readNullableNumber(row, trafficLimitIdx),
    traffic_reset_mode: readString(row, trafficModeIdx, 'no_reset'),
    device_limit: readNullableInt(row, deviceLimitIdx),
    price: readNumber(row, priceIdx, 0),
    currency: readString(row, currencyIdx, 'usd'),
    sort_order: readInt(row, sortIdx, 0),
    included_devices: readInt(row, includedIdx, 1),
    max_extra_devices: readInt(row, maxExtraIdx, 0),
    price_per_extra_device: readNumber(row, pricePerExtraIdx, 0),
  }));
}

function extractTariffCategories(block: CopyBlock | undefined): StealthnetTariffCategory[] {
  if (!block) return [];
  const idIdx = colIndex(block, 'id');
  const nameIdx = colIndex(block, 'name');
  const emojiIdx = colIndex(block, 'emoji_key');
  const sortIdx = colIndex(block, 'sort_order');

  return block.rows.map((row) => ({
    id: readString(row, idIdx),
    name: readString(row, nameIdx),
    emoji_key: readNullableString(row, emojiIdx),
    sort_order: readInt(row, sortIdx, 0),
  }));
}

function extractTariffPriceOptions(block: CopyBlock | undefined): StealthnetTariffPriceOption[] {
  if (!block) return [];
  const idIdx = colIndex(block, 'id');
  const tariffIdx = colIndex(block, 'tariff_id');
  const durationIdx = colIndex(block, 'duration_days');
  const priceIdx = colIndex(block, 'price');
  const sortIdx = colIndex(block, 'sort_order');

  return block.rows.map((row) => ({
    id: readString(row, idIdx),
    tariff_id: readString(row, tariffIdx),
    duration_days: readInt(row, durationIdx, 30),
    price: readNumber(row, priceIdx, 0),
    sort_order: readInt(row, sortIdx, 0),
  }));
}

function extractPayments(block: CopyBlock | undefined): StealthnetPayment[] {
  if (!block) return [];
  const idIdx = colIndex(block, 'id');
  const clientIdIdx = colIndex(block, 'client_id');
  const orderIdIdx = colIndex(block, 'order_id');
  const amountIdx = colIndex(block, 'amount');
  const currencyIdx = colIndex(block, 'currency');
  const statusIdx = colIndex(block, 'status');
  const providerIdx = colIndex(block, 'provider');
  const externalIdx = colIndex(block, 'external_id');
  const tariffIdIdx = colIndex(block, 'tariff_id');
  const tariffOptionIdx = colIndex(block, 'tariff_price_option_id');
  const proxyTariffIdx = colIndex(block, 'proxy_tariff_id');
  const singboxTariffIdx = colIndex(block, 'singbox_tariff_id');
  const remnawaveUserIdx = colIndex(block, 'remnawave_user_id');
  const metadataIdx = colIndex(block, 'metadata');
  const createdAtIdx = colIndex(block, 'created_at');
  const paidAtIdx = colIndex(block, 'paid_at');
  const deviceCountIdx = colIndex(block, 'device_count');
  const botIdIdx = colIndex(block, 'bot_id');

  return block.rows.map((row) => ({
    id: readString(row, idIdx),
    client_id: readString(row, clientIdIdx),
    order_id: readString(row, orderIdIdx),
    amount: readNumber(row, amountIdx, 0),
    currency: readString(row, currencyIdx, 'rub'),
    status: readString(row, statusIdx, 'PENDING'),
    provider: readNullableString(row, providerIdx),
    external_id: readNullableString(row, externalIdx),
    tariff_id: readNullableString(row, tariffIdIdx),
    tariff_price_option_id: readNullableString(row, tariffOptionIdx),
    proxy_tariff_id: readNullableString(row, proxyTariffIdx),
    singbox_tariff_id: readNullableString(row, singboxTariffIdx),
    remnawave_user_id: readNullableString(row, remnawaveUserIdx),
    metadata: readNullableString(row, metadataIdx),
    created_at: readString(row, createdAtIdx, new Date().toISOString()),
    paid_at: readNullableString(row, paidAtIdx),
    device_count: readNullableInt(row, deviceCountIdx),
    bot_id: readNullableString(row, botIdIdx),
  }));
}

function extractReferralCredits(block: CopyBlock | undefined): StealthnetReferralCredit[] {
  if (!block) return [];
  const idIdx = colIndex(block, 'id');
  const referrerIdIdx = colIndex(block, 'referrer_id');
  const paymentIdIdx = colIndex(block, 'payment_id');
  const amountIdx = colIndex(block, 'amount');
  const levelIdx = colIndex(block, 'level');
  const createdAtIdx = colIndex(block, 'created_at');

  return block.rows
    .map((row) => ({
      id: readString(row, idIdx),
      referrer_id: readString(row, referrerIdIdx),
      payment_id: readString(row, paymentIdIdx),
      amount: Math.max(0, readInt(row, amountIdx, 0)),
      level: Math.max(1, readInt(row, levelIdx, 1)),
      created_at: readString(row, createdAtIdx, new Date().toISOString()),
    }))
    .filter((credit) => credit.id.length > 0 && credit.referrer_id.length > 0 && credit.payment_id.length > 0);
}
