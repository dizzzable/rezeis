import { BadRequestException } from '@nestjs/common';

import {
  MAX_GZIP_OUTPUT_BYTES,
  MAX_INPUT_BYTES,
  MAX_JSON_BYTES,
  MAX_SQL_BYTES,
  couldBeTarBuffer,
  ensureBufferWithinLimit,
  findArchivePayload,
  gunzipBuffer,
  isGzipBuffer,
  isTarBuffer,
} from './backup-archive.util';
import { looksLikePgDump, parsePgCopyTables } from './pg-dump-parser';

/**
 * Reading a Bedolaga backup.
 *
 * ── Why this file accepts two shapes, not one ─────────────────────────────
 *
 * Bedolaga backs itself up from inside the bot, and what comes out depends on
 * the container it is running in. `BackupService._dump_postgres` shells out to
 * `pg_dump --format=plain --no-owner --no-privileges` when the binary is on
 * PATH; when it is NOT — and in the official image it frequently is not — it
 * falls back to `_export_database_via_orm` and writes `database.json` instead.
 * Both end up in the same `.tar.gz` next to a `metadata.json`.
 *
 * So an operator who has "a Bedolaga backup" holds one of two entirely
 * different files and has no idea which, because the bot never told them. A
 * parser that handled only the SQL one would fail for half of them with a
 * message about a format they have never heard of.
 *
 * ── The consequence, and the shape of the fix ─────────────────────────────
 *
 * The two shapes disagree about types, not just syntax. In the COPY dump every
 * cell is a string — `"1"`, `"t"`, `"{}"` — while the ORM export writes real
 * JSON: `1`, `true`, `{}`. Mapping each shape separately would mean writing
 * every column twice and would guarantee the two mappings drift.
 *
 * Instead both shapes are normalised into the SAME loose row form
 * (`Record<string, unknown>`), and one set of coercions below reads either. A
 * new column is then added in exactly one place.
 *
 * This file knows the SHAPE of Bedolaga's tables and nothing about what the
 * values mean — units, obligations and the mapping into our own model belong
 * to `bedolaga-importer.service.ts`, which is where they can be argued about.
 */

// ── What we read out of a backup ─────────────────────────────────────────────

export interface BedolagaUser {
  readonly id: number;
  /** BIGINT, nullable: email/OAuth-only accounts exist and carry no telegram. */
  readonly telegram_id: number | null;
  readonly username: string | null;
  readonly first_name: string | null;
  readonly last_name: string | null;
  /** `active` | `blocked` | `deleted`. There is no boolean ban column. */
  readonly status: string;
  readonly language: string | null;
  /** KOPEKS. Legitimately negative — a debt, which their own merge preserves. */
  readonly balance_kopeks: number;
  readonly referred_by_id: number | null;
  readonly referral_code: string | null;
  readonly email: string | null;
  readonly promo_group_id: number | null;
  /** A live one-shot discount promised to this person, in percent. */
  readonly promo_offer_discount_percent: number;
  readonly promo_offer_discount_expires_at: string | null;
  readonly has_had_paid_subscription: boolean;
  /**
   * The panel's numeric id when the operator sells in single-tariff mode. In
   * multi-tariff mode this is null and the id lives on the subscription.
   */
  readonly remnawave_id: number | null;
  /** Legacy: meaningless on a Remnawave 3.x panel. Read, never trusted. */
  readonly remnawave_uuid: string | null;
  readonly created_at: string | null;
}

export interface BedolagaSubscription {
  readonly id: number;
  readonly user_id: number;
  /** `trial` | `active` | `expired` | `disabled` | `limited` | `pending`. */
  readonly status: string;
  readonly is_trial: boolean;
  readonly start_date: string | null;
  readonly end_date: string | null;
  /** GB. **Zero means UNLIMITED**, not "no quota". */
  readonly traffic_limit_gb: number;
  /** GB, fractional — the panel is read in bytes and divided. */
  readonly traffic_used_gb: number;
  readonly purchased_traffic_gb: number;
  readonly device_limit: number;
  /** Raw squad uuid strings; no foreign key behind them. */
  readonly connected_squads: readonly string[];
  readonly subscription_url: string | null;
  readonly remnawave_id: number | null;
  readonly remnawave_short_uuid: string | null;
  readonly remnawave_uuid: string | null;
  readonly tariff_id: number | null;
  readonly autopay_enabled: boolean;
  readonly created_at: string | null;
}

export interface BedolagaTariff {
  readonly id: number;
  readonly name: string;
  readonly description: string | null;
  readonly traffic_limit_gb: number;
  readonly device_limit: number;
  readonly allowed_squads: readonly string[];
  /** `{"30": 50000}` — days (as a STRING key) to kopeks. */
  readonly period_prices: Readonly<Record<string, number>>;
  readonly external_squad_uuid: string | null;
  readonly is_active: boolean;
  readonly display_order: number;
}

export interface BedolagaPromoGroup {
  readonly id: number;
  readonly name: string;
  readonly priority: number;
  readonly server_discount_percent: number;
  readonly traffic_discount_percent: number;
  readonly device_discount_percent: number;
  readonly is_default: boolean;
}

export interface BedolagaUserPromoGroup {
  readonly user_id: number;
  readonly promo_group_id: number;
}

export interface BedolagaTransaction {
  readonly id: number;
  readonly user_id: number;
  /** See `TransactionType`; direction comes from HERE, never from the sign. */
  readonly type: string;
  /** KOPEKS. The sign is inconsistent across types — see the importer. */
  readonly amount_kopeks: number;
  readonly description: string | null;
  readonly payment_method: string | null;
  readonly external_id: string | null;
  /** Defaults to TRUE in the donor: a row is paid unless someone said not. */
  readonly is_completed: boolean;
  readonly created_at: string | null;
  readonly completed_at: string | null;
}

export interface BedolagaPromocode {
  readonly id: number;
  readonly code: string;
  /** `balance` | `subscription_days` | `trial_subscription` | `promo_group` | `discount` | `balance_and_days`. */
  readonly type: string;
  /** KOPEKS — **except** for type `discount`, where it holds a PERCENT. */
  readonly balance_bonus_kopeks: number;
  /** DAYS — **except** for type `discount`, where it holds HOURS. */
  readonly subscription_days: number;
  readonly traffic_gb: number;
  readonly max_uses: number;
  readonly current_uses: number;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly is_active: boolean;
  readonly first_purchase_only: boolean;
}

export interface BedolagaPromocodeUse {
  readonly promocode_id: number;
  readonly user_id: number;
  readonly used_at: string | null;
}

export interface BedolagaReferralEarning {
  readonly id: number;
  /** The person who EARNED it. */
  readonly user_id: number;
  /** The person whose activity caused it. */
  readonly referral_id: number;
  readonly amount_kopeks: number;
  readonly reason: string | null;
  readonly reward_type: string;
  readonly level: number;
  readonly days_granted: number;
  readonly created_at: string | null;
}

export interface BedolagaServerSquad {
  readonly id: number;
  readonly squad_uuid: string;
  readonly display_name: string;
  readonly is_available: boolean;
}

/**
 * What the backup carried that we deliberately do NOT import.
 *
 * Counted rather than dropped in silence: every one of these is either an
 * obligation somebody is owed or a decision an operator has to make by hand,
 * and a migration that says nothing about them is a migration that loses them.
 */
export interface BedolagaExcludedDataSummary {
  /** Money frozen but NOT yet debited — importing both pays it twice. */
  readonly pendingWithdrawals: number;
  readonly withdrawals: number;
  /** Paid-for, undistributed subscription tokens. */
  readonly coupons: number;
  /** Paid gifts not yet claimed by their recipient. */
  readonly gifts: number;
  readonly wheelSpins: number;
  readonly contests: number;
  /** Free servers lent for a window that has not closed yet. */
  readonly temporaryAccess: number;
  readonly discountOffers: number;
  readonly tickets: number;
}

export interface BedolagaBackupData {
  readonly users: readonly BedolagaUser[];
  readonly subscriptions: readonly BedolagaSubscription[];
  readonly tariffs: readonly BedolagaTariff[];
  readonly promoGroups: readonly BedolagaPromoGroup[];
  readonly userPromoGroups: readonly BedolagaUserPromoGroup[];
  readonly transactions: readonly BedolagaTransaction[];
  readonly promocodes: readonly BedolagaPromocode[];
  readonly promocodeUses: readonly BedolagaPromocodeUse[];
  readonly referralEarnings: readonly BedolagaReferralEarning[];
  readonly serverSquads: readonly BedolagaServerSquad[];
  readonly excludedData: BedolagaExcludedDataSummary;
  /** `sql` when read from a pg_dump, `orm` from Bedolaga's JSON export. */
  readonly sourceFormat: 'sql' | 'orm';
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Parse whatever the operator uploaded.
 *
 * Accepted, in the order they are tried:
 *   - Bedolaga's own `.tar.gz` (metadata.json + `database.sql` | `database.json`)
 *   - a bare `pg_dump` `.sql`, gzipped or not
 *   - a bare `database.json`, gzipped or not
 */
export async function parseBedolagaBackup(buffer: Buffer): Promise<BedolagaBackupData> {
  ensureBufferWithinLimit(buffer, MAX_INPUT_BYTES, 'Backup file');

  if (isGzipBuffer(buffer)) {
    const decompressed = await gunzipBuffer(buffer, MAX_GZIP_OUTPUT_BYTES, 'backup file');

    if (isTarBuffer(decompressed)) {
      return parseArchive(decompressed);
    }

    const text = decompressed.toString('utf-8');
    if (looksLikePgDump(text)) {
      ensureBufferWithinLimit(decompressed, MAX_SQL_BYTES, 'Decompressed SQL dump');
      return fromSqlDump(text);
    }

    try {
      ensureBufferWithinLimit(decompressed, MAX_JSON_BYTES, 'Decompressed JSON export');
      return fromJsonExport(JSON.parse(text));
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // A tar whose header lacks the ustar magic: the last reading left.
      if (couldBeTarBuffer(decompressed)) {
        return parseArchive(decompressed);
      }
      throw new BadRequestException(
        'Unsupported gzip payload. Expected a Bedolaga backup archive, a pg_dump SQL file or a database.json export.',
      );
    }
  }

  ensureBufferWithinLimit(buffer, MAX_SQL_BYTES, 'Backup payload');
  const text = buffer.toString('utf-8');
  if (looksLikePgDump(text)) {
    return fromSqlDump(text);
  }
  try {
    ensureBufferWithinLimit(buffer, MAX_JSON_BYTES, 'JSON export');
    return fromJsonExport(JSON.parse(text));
  } catch (err) {
    if (err instanceof BadRequestException) throw err;
    throw new BadRequestException(
      'Unsupported file format. Expected a Bedolaga .tar.gz backup, a .sql(.gz) pg_dump or a database.json export.',
    );
  }
}

/** Bedolaga names its payload `database.sql` or `database.json`; be lenient. */
function classifyEntry(name: string): 'json' | 'sql.gz' | 'sql' | null {
  const basename = name.split('/').pop() ?? name;
  if (basename === 'database.json') return 'json';
  if (/\.sql\.gz$/i.test(basename)) return 'sql.gz';
  if (/\.sql$/i.test(basename)) return 'sql';
  // `metadata.json` sits beside the payload and must not be mistaken for it.
  if (/^database\.json\.gz$/i.test(basename)) return 'json';
  return null;
}

async function parseArchive(tarBuffer: Buffer): Promise<BedolagaBackupData> {
  const payload = await findArchivePayload(tarBuffer, classifyEntry);
  if (payload === null) {
    throw new BadRequestException(
      'No database.sql or database.json found in the archive (expected a Bedolaga backup).',
    );
  }

  if (payload.kind === 'json') {
    ensureBufferWithinLimit(payload.bytes, MAX_JSON_BYTES, `Archive entry '${payload.name}'`);
    return fromJsonExport(JSON.parse(payload.bytes.toString('utf-8')));
  }

  if (payload.kind === 'sql.gz') {
    const sqlBytes = await gunzipBuffer(
      payload.bytes,
      MAX_SQL_BYTES,
      `archive entry '${payload.name}'`,
    );
    return fromSqlDump(sqlBytes.toString('utf-8'));
  }

  ensureBufferWithinLimit(payload.bytes, MAX_SQL_BYTES, `Archive entry '${payload.name}'`);
  return fromSqlDump(payload.bytes.toString('utf-8'));
}

// ── The two shapes, normalised to one ────────────────────────────────────────

type LooseRow = Record<string, unknown>;
type Tables = ReadonlyMap<string, readonly LooseRow[]>;

function fromSqlDump(sql: string): BedolagaBackupData {
  const copied = parsePgCopyTables(sql);
  const tables = new Map<string, readonly LooseRow[]>();
  for (const [name, table] of copied) {
    tables.set(name, table.rows as readonly LooseRow[]);
  }
  return build(tables, 'sql');
}

/**
 * Bedolaga's ORM export: `{ metadata, data: { table: [row] }, associations }`.
 *
 * Association tables (`user_promo_groups` and friends) live in their own
 * section because SQLAlchemy models them separately, so both sections are
 * flattened into one lookup — the rest of this file should not have to care
 * which side of the file a table came from.
 */
function fromJsonExport(json: unknown): BedolagaBackupData {
  if (!isRecord(json)) {
    throw new BadRequestException('JSON export is not an object');
  }
  const data = isRecord(json.data) ? json.data : json;
  const associations = isRecord(json.associations) ? json.associations : {};

  const tables = new Map<string, readonly LooseRow[]>();
  for (const source of [data, associations]) {
    for (const [name, value] of Object.entries(source)) {
      if (Array.isArray(value)) {
        tables.set(name, value.filter(isRecord));
      }
    }
  }
  if (!tables.has('users')) {
    throw new BadRequestException('JSON export contains no `users` table');
  }
  return build(tables, 'orm');
}

function build(tables: Tables, sourceFormat: 'sql' | 'orm'): BedolagaBackupData {
  const userRows = rowsOf(tables, 'users');
  if (userRows.length === 0) {
    throw new BadRequestException('No user records found in the Bedolaga backup');
  }

  return {
    sourceFormat,
    users: userRows.map(
      (r): BedolagaUser => ({
        id: asInt(r.id),
        telegram_id: asNullableInt(r.telegram_id),
        username: asNullableString(r.username),
        first_name: asNullableString(r.first_name),
        last_name: asNullableString(r.last_name),
        status: asString(r.status, 'active'),
        language: asNullableString(r.language),
        balance_kopeks: asInt(r.balance_kopeks),
        referred_by_id: asNullableInt(r.referred_by_id),
        referral_code: asNullableString(r.referral_code),
        email: asNullableString(r.email),
        promo_group_id: asNullableInt(r.promo_group_id),
        promo_offer_discount_percent: asInt(r.promo_offer_discount_percent),
        promo_offer_discount_expires_at: asIso(r.promo_offer_discount_expires_at),
        has_had_paid_subscription: asBool(r.has_had_paid_subscription),
        remnawave_id: asNullableInt(r.remnawave_id),
        remnawave_uuid: asNullableString(r.remnawave_uuid),
        created_at: asIso(r.created_at),
      }),
    ),
    subscriptions: rowsOf(tables, 'subscriptions').map(
      (r): BedolagaSubscription => ({
        id: asInt(r.id),
        user_id: asInt(r.user_id),
        status: asString(r.status, 'active'),
        is_trial: asBool(r.is_trial),
        start_date: asIso(r.start_date),
        end_date: asIso(r.end_date),
        traffic_limit_gb: asInt(r.traffic_limit_gb),
        traffic_used_gb: asFloat(r.traffic_used_gb),
        purchased_traffic_gb: asInt(r.purchased_traffic_gb),
        device_limit: asInt(r.device_limit, 1),
        connected_squads: asStringArray(r.connected_squads),
        subscription_url: asNullableString(r.subscription_url),
        remnawave_id: asNullableInt(r.remnawave_id),
        remnawave_short_uuid: asNullableString(r.remnawave_short_uuid),
        remnawave_uuid: asNullableString(r.remnawave_uuid),
        tariff_id: asNullableInt(r.tariff_id),
        autopay_enabled: asBool(r.autopay_enabled),
        created_at: asIso(r.created_at),
      }),
    ),
    tariffs: rowsOf(tables, 'tariffs').map(
      (r): BedolagaTariff => ({
        id: asInt(r.id),
        name: asString(r.name, 'Tariff'),
        description: asNullableString(r.description),
        traffic_limit_gb: asInt(r.traffic_limit_gb),
        device_limit: asInt(r.device_limit, 1),
        allowed_squads: asStringArray(r.allowed_squads),
        period_prices: asNumberMap(r.period_prices),
        external_squad_uuid: asNullableString(r.external_squad_uuid),
        is_active: asBool(r.is_active),
        display_order: asInt(r.display_order),
      }),
    ),
    promoGroups: rowsOf(tables, 'promo_groups').map(
      (r): BedolagaPromoGroup => ({
        id: asInt(r.id),
        name: asString(r.name, 'Group'),
        priority: asInt(r.priority),
        server_discount_percent: asInt(r.server_discount_percent),
        traffic_discount_percent: asInt(r.traffic_discount_percent),
        device_discount_percent: asInt(r.device_discount_percent),
        is_default: asBool(r.is_default),
      }),
    ),
    userPromoGroups: rowsOf(tables, 'user_promo_groups').map(
      (r): BedolagaUserPromoGroup => ({
        user_id: asInt(r.user_id),
        promo_group_id: asInt(r.promo_group_id),
      }),
    ),
    transactions: rowsOf(tables, 'transactions').map(
      (r): BedolagaTransaction => ({
        id: asInt(r.id),
        user_id: asInt(r.user_id),
        type: asString(r.type, 'deposit'),
        amount_kopeks: asInt(r.amount_kopeks),
        description: asNullableString(r.description),
        payment_method: asNullableString(r.payment_method),
        external_id: asNullableString(r.external_id),
        is_completed: asBool(r.is_completed, true),
        created_at: asIso(r.created_at),
        completed_at: asIso(r.completed_at),
      }),
    ),
    promocodes: rowsOf(tables, 'promocodes').map(
      (r): BedolagaPromocode => ({
        id: asInt(r.id),
        code: asString(r.code, ''),
        type: asString(r.type, 'balance'),
        balance_bonus_kopeks: asInt(r.balance_bonus_kopeks),
        subscription_days: asInt(r.subscription_days),
        traffic_gb: asInt(r.traffic_gb),
        max_uses: asInt(r.max_uses, 1),
        current_uses: asInt(r.current_uses),
        valid_from: asIso(r.valid_from),
        valid_until: asIso(r.valid_until),
        is_active: asBool(r.is_active),
        first_purchase_only: asBool(r.first_purchase_only),
      }),
    ),
    promocodeUses: rowsOf(tables, 'promocode_uses').map(
      (r): BedolagaPromocodeUse => ({
        promocode_id: asInt(r.promocode_id),
        user_id: asInt(r.user_id),
        used_at: asIso(r.used_at),
      }),
    ),
    referralEarnings: rowsOf(tables, 'referral_earnings').map(
      (r): BedolagaReferralEarning => ({
        id: asInt(r.id),
        user_id: asInt(r.user_id),
        referral_id: asInt(r.referral_id),
        amount_kopeks: asInt(r.amount_kopeks),
        reason: asNullableString(r.reason),
        reward_type: asString(r.reward_type, 'money'),
        level: asInt(r.level, 1),
        days_granted: asInt(r.days_granted),
        created_at: asIso(r.created_at),
      }),
    ),
    serverSquads: rowsOf(tables, 'server_squads').map(
      (r): BedolagaServerSquad => ({
        id: asInt(r.id),
        squad_uuid: asString(r.squad_uuid, ''),
        display_name: asString(r.display_name, ''),
        is_available: asBool(r.is_available),
      }),
    ),
    excludedData: {
      pendingWithdrawals: rowsOf(tables, 'withdrawal_requests').filter(
        (r) => asString(r.status, '') === 'pending',
      ).length,
      withdrawals: rowsOf(tables, 'withdrawal_requests').length,
      coupons: rowsOf(tables, 'coupons').filter((r) => asString(r.status, '') === 'active').length,
      gifts: rowsOf(tables, 'guest_purchases').filter((r) => asBool(r.is_gift)).length,
      wheelSpins: rowsOf(tables, 'wheel_spins').length,
      contests: rowsOf(tables, 'referral_contests').length,
      temporaryAccess: rowsOf(tables, 'subscription_temporary_access').filter((r) =>
        asBool(r.is_active),
      ).length,
      discountOffers: rowsOf(tables, 'discount_offers').filter((r) => asBool(r.is_active)).length,
      tickets: rowsOf(tables, 'tickets').length,
    },
  };
}

function rowsOf(tables: Tables, name: string): readonly LooseRow[] {
  return tables.get(name) ?? [];
}

// ── Coercions that read either shape ─────────────────────────────────────────
//
// Every one of these takes `unknown` because the same column arrives as a
// string from the COPY dump and as a native value from the JSON export.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asNullableString(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function asInt(value: unknown, fallback = 0): number {
  const parsed = asNullableInt(value);
  return parsed === null ? fallback : parsed;
}

function asNullableInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asFloat(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * `t`/`f` from COPY, `true`/`false` from JSON — and a fallback that matters:
 * most of Bedolaga's defaults are Python-side only, so a column written
 * outside the ORM is physically NULL where the code assumes a value.
 */
function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (t === 't' || t === 'true' || t === '1' || t === 'yes') return true;
    if (t === 'f' || t === 'false' || t === '0' || t === 'no') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

/** A Postgres timestamp, an ISO string, or a JSON date — all to ISO. */
function asIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // `2026-06-10 14:52:59.213265+00` → `...T...+00:00`
  const normalized = trimmed.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * A list of strings from a JSON column.
 *
 * Bedolaga declares `connected_squads` / `allowed_squads` as SQLAlchemy `JSON`,
 * so the COPY dump carries a JSON literal (`["a","b"]`), NOT a Postgres array
 * literal (`{a,b}`) — the two look similar and decode differently. Both are
 * accepted anyway, because a column can be migrated between the two and a
 * migration that silently loses everybody's servers is not worth the risk.
 */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : [];
    } catch {
      return [];
    }
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim().replace(/^"|"$/g, ''))
      .filter((item) => item.length > 0);
  }
  return [];
}

/** `period_prices` and friends: an object whose keys are strings of numbers. */
function asNumberMap(value: unknown): Record<string, number> {
  const source = typeof value === 'string' ? safeJson(value) : value;
  if (!isRecord(source)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    const parsed = asNullableInt(raw);
    if (parsed !== null) out[key] = parsed;
  }
  return out;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
