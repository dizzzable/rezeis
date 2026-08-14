import { BadRequestException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { extract, Headers } from 'tar-stream';

import {
  RemnashopExcludedDataSummary,
  RemnashopReferral,
  RemnashopReferralReward,
  RemnashopSubscription,
  RemnashopTransaction,
  RemnashopUser,
} from '../services/remnashop-importer.service';
import {
  looksLikePgDump,
  parsePgCopyTables,
  pgArray,
  pgBigInt,
  pgBool,
  pgInt,
  pgJson,
  pgNumberArray,
  pgTimestampToIso,
} from './pg-dump-parser';

/**
 * Plan/duration/price rows as exported from remnashop's PostgreSQL DB.
 *
 * remnashop's plan model is similar to altshop's but slimmer: no
 * archive/upgrade/replacement metadata, plus an explicit `is_trial`
 * flag and a `public_code` used as the user-facing slug. We keep the
 * remnashop integer ids so the cloner can build the
 * `remnashop_plan_id → rezeis_plan_id` mapping.
 *
 * See https://github.com/snoups/remnashop/blob/main/src/infrastructure/database/models/plan.py
 */
export interface RemnashopPlan {
  readonly id: number;
  readonly public_code: string;
  readonly name: string;
  readonly description: string | null;
  readonly tag: string | null;
  readonly type: string;
  readonly availability: string;
  readonly traffic_limit_strategy: string;
  readonly traffic_limit: number;
  readonly device_limit: number;
  readonly allowed_user_ids: readonly number[];
  readonly internal_squads: readonly string[];
  readonly external_squad: string | null;
  readonly order_index: number;
  readonly is_active: boolean;
  readonly is_trial: boolean;
}

export interface RemnashopPlanDuration {
  readonly id: number;
  readonly plan_id: number;
  readonly days: number;
  readonly order_index: number;
}

export interface RemnashopPlanPrice {
  readonly id: number;
  readonly plan_duration_id: number;
  readonly currency: string;
  readonly price: string;
}

interface RemnashopBackupData {
  users: RemnashopUser[];
  subscriptions: RemnashopSubscription[];
  transactions: RemnashopTransaction[];
  referrals: RemnashopReferral[];
  referralRewards: RemnashopReferralReward[];
  excludedData: RemnashopExcludedDataSummary;
  /** Optional catalog (full backups expose it, stripped JSON exports may not). */
  plans: RemnashopPlan[];
  planDurations: RemnashopPlanDuration[];
  planPrices: RemnashopPlanPrice[];
}

const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_GZIP_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_SQL_BYTES = 256 * 1024 * 1024;
const ALLOWED_TAR_ENTRY_TYPES = new Set(['file', 'directory', 'pax-header', 'pax-global-header']);

/**
 * Parses a remnashop backup file.
 *
 * Supports:
 *   - Official Remnawave/remnashop backup `.tar.gz` (`backup_meta.info` +
 *     `bot_dir_*.tar.gz` + `bot_dump_*.sql.gz`) — we read the nested
 *     `bot_dump_*.sql.gz` pg dump.
 *   - `.tar.gz` archive with `database.json` inside (same format as altshop)
 *   - Raw `.sql` / `.sql.gz` pg dump
 *   - Raw `.json` file with `{ users, subscriptions, ... }` or `{ data: {...} }`
 */
export async function parseRemnashopBackup(buffer: Buffer): Promise<RemnashopBackupData> {
  ensureBufferWithinLimit(buffer, MAX_INPUT_BYTES, 'Backup file');

  // Gzip magic (1f 8b) — could be a .tar.gz, a gzipped .sql, or gzipped json.
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    const decompressed = await gunzipBuffer(buffer, MAX_GZIP_OUTPUT_BYTES, 'backup file');

    if (isTarBuffer(decompressed)) {
      return parseRemnashopArchive(decompressed);
    }

    const text = decompressed.toString('utf-8');
    if (looksLikePgDump(text)) {
      ensureBufferWithinLimit(decompressed, MAX_SQL_BYTES, 'Decompressed SQL dump');
      return parseRemnashopSqlDump(text);
    }

    try {
      ensureBufferWithinLimit(decompressed, MAX_JSON_BYTES, 'Decompressed JSON export');
      return extractDataFromJson(JSON.parse(text));
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      if (couldBeTarBuffer(decompressed)) {
        return parseRemnashopArchive(decompressed);
      }
      throw new BadRequestException(
        'Unsupported gzip payload. Expected a tar archive, a pg_dump SQL file or a JSON export.',
      );
    }
  }

  // Not gzip: a raw .sql dump or a raw .json export.
  ensureBufferWithinLimit(buffer, MAX_SQL_BYTES, 'Backup payload');
  const text = buffer.toString('utf-8');
  if (looksLikePgDump(text)) {
    return parseRemnashopSqlDump(text);
  }
  try {
    ensureBufferWithinLimit(buffer, MAX_JSON_BYTES, 'JSON export');
    return extractDataFromJson(JSON.parse(text));
  } catch (err) {
    if (err instanceof BadRequestException) throw err;
    throw new BadRequestException(
      'Unsupported file format. Expected a .tar.gz backup, a .sql(.gz) pg dump or a .json export file.',
    );
  }
}

/** POSIX tar archives carry the "ustar" magic at byte offset 257. */
function isTarBuffer(buf: Buffer): boolean {
  return buf.length > 262 && buf.toString('ascii', 257, 262) === 'ustar';
}

function couldBeTarBuffer(buf: Buffer): boolean {
  return buf.length >= 512 && buf.length % 512 === 0;
}

/**
 * Walk a (already-decompressed) tar archive, capturing either a top-level
 * `database.json` or a nested `*.sql` / `*.sql.gz` pg dump. The bulky
 * `bot_dir_*.tar.gz` and `backup_meta.info` entries are skipped.
 */
async function parseRemnashopArchive(tarBuffer: Buffer): Promise<RemnashopBackupData> {
  return new Promise((resolve, reject) => {
    const readable = Readable.from([tarBuffer]);
    const extractor = extract();
    let settled = false;
    let payload: {
      readonly kind: 'json' | 'sql.gz' | 'sql';
      readonly name: string;
      readonly bytes: Buffer;
    } | null = null;

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      const exception = toBadRequestException(err, 'Failed to parse backup contents');
      readable.unpipe(extractor);
      readable.destroy();
      extractor.destroy();
      reject(exception);
    };

    extractor.on('entry', (header: Headers, stream, next) => {
      let normalizedName: string;
      let type: 'file' | 'ignore';

      try {
        normalizedName = normalizeTarEntryName(header.name);
        type = normalizeTarEntryType(header.type);
        if (type === 'file') ensureArchiveEntrySize(normalizedName, header.size);
      } catch (err) {
        stream.resume();
        fail(err);
        return;
      }

      stream.on('error', fail);

      if (type !== 'file') {
        stream.resume();
        stream.on('end', next);
        return;
      }

      const entryKind = classifyArchiveEntry(normalizedName);
      if (entryKind === null) {
        stream.resume();
        stream.on('end', next);
        return;
      }

      if (payload !== null) {
        stream.resume();
        fail(
          new BadRequestException(
            `Archive contains duplicate database payloads ('${payload.name}' and '${normalizedName}')`,
          ),
        );
        return;
      }

      void readStreamToBuffer(stream, MAX_ARCHIVE_ENTRY_BYTES, `archive entry '${normalizedName}'`)
        .then((bytes) => {
          if (settled) return;
          payload = { kind: entryKind, name: normalizedName, bytes };
          next();
        })
        .catch(fail);
    });

    extractor.on('finish', async () => {
      if (settled) return;
      try {
        if (payload === null) {
          throw new BadRequestException(
            'No database.json or .sql dump found in the archive (expected a Remnawave/remnashop backup).',
          );
        }

        if (payload.kind === 'json') {
          ensureBufferWithinLimit(payload.bytes, MAX_JSON_BYTES, `Archive entry '${payload.name}'`);
          resolve(extractDataFromJson(JSON.parse(payload.bytes.toString('utf-8'))));
          return;
        }

        if (payload.kind === 'sql.gz') {
          const sqlBytes = await gunzipBuffer(
            payload.bytes,
            MAX_SQL_BYTES,
            `archive entry '${payload.name}'`,
          );
          resolve(parseRemnashopSqlDump(sqlBytes.toString('utf-8')));
          return;
        }

        ensureBufferWithinLimit(payload.bytes, MAX_SQL_BYTES, `Archive entry '${payload.name}'`);
        resolve(parseRemnashopSqlDump(payload.bytes.toString('utf-8')));
      } catch (err) {
        fail(err);
      }
    });

    extractor.on('error', fail);
    readable.on('error', fail);
    readable.pipe(extractor);
  });
}

/** remnashop `user_role` enum → the numeric role the importer expects. */
const ROLE_TO_NUMBER: Record<string, number> = {
  USER: 1,
  PREVIEW: 2,
  ADMIN: 3,
  DEV: 4,
  OWNER: 5,
  SYSTEM: 6,
};

/**
 * Parse a remnashop PostgreSQL dump (pg_dump/pg_dumpall) by reading its COPY
 * blocks. Column order is taken from each COPY header, so this is robust to
 * minor schema drift between remnashop versions.
 */
function parseRemnashopSqlDump(sql: string): RemnashopBackupData {
  const tables = parsePgCopyTables(sql);

  const userRows = tables.get('users')?.rows ?? [];
  if (userRows.length === 0) {
    throw new BadRequestException('No user records found in the SQL dump');
  }

  const users: RemnashopUser[] = userRows.map((r) => ({
    id: pgInt(r.id),
    telegram_id: pgBigInt(r.telegram_id),
    username: r.username,
    referral_code: r.referral_code,
    name: r.name,
    role: ROLE_TO_NUMBER[(r.role ?? 'USER').toUpperCase()] ?? 1,
    language: r.language,
    personal_discount: pgInt(r.personal_discount),
    purchase_discount: pgInt(r.purchase_discount),
    points: pgInt(r.points),
    is_blocked: pgBool(r.is_blocked),
    is_bot_blocked: pgBool(r.is_bot_blocked),
    is_rules_accepted: pgBool(r.is_rules_accepted),
    is_trial_available: pgBool(r.is_trial_available),
    created_at: pgTimestampToIso(r.created_at) ?? r.created_at ?? '',
    updated_at: pgTimestampToIso(r.updated_at) ?? r.updated_at ?? '',
  }));

  const subscriptions: RemnashopSubscription[] = (tables.get('subscriptions')?.rows ?? []).map(
    (r) => ({
      id: pgInt(r.id),
      user_remna_id: r.user_remna_id,
      user_telegram_id: pgBigInt(r.user_telegram_id),
      status: r.status ?? 'ACTIVE',
      is_trial: pgBool(r.is_trial),
      traffic_limit: pgInt(r.traffic_limit),
      device_limit: pgInt(r.device_limit),
      traffic_limit_strategy: r.traffic_limit_strategy,
      tag: r.tag,
      internal_squads: pgArray(r.internal_squads),
      external_squad: r.external_squad,
      expire_at: pgTimestampToIso(r.expire_at),
      url: r.url,
      plan_snapshot: pgJson(r.plan_snapshot),
      created_at: pgTimestampToIso(r.created_at) ?? r.created_at ?? '',
    }),
  );

  const transactions: RemnashopTransaction[] = (tables.get('transactions')?.rows ?? []).map(
    (r) => ({
      id: pgInt(r.id),
      payment_id: r.payment_id,
      user_telegram_id: pickNumber(r, ['user_telegram_id', 'telegram_id']),
      status: r.status ?? 'PENDING',
      is_test: pgBool(r.is_test),
      purchase_type: r.purchase_type ?? 'SUBSCRIPTION',
      gateway_type: r.gateway_type ?? 'UNKNOWN',
      pricing: pgJson(r.pricing),
      currency: r.currency ?? 'USD',
      plan_snapshot: pgJson(r.plan_snapshot ?? r.plan),
      created_at: pgTimestampToIso(r.created_at) ?? r.created_at ?? '',
    }),
  );

  const referrals: RemnashopReferral[] = (tables.get('referrals')?.rows ?? []).map((r) => ({
    id: pgInt(r.id),
    referrer_telegram_id: pickNumber(r, ['referrer_telegram_id', 'referrer_id']),
    referred_telegram_id: pickNumber(r, [
      'referred_telegram_id',
      'referred_id',
      'user_telegram_id',
    ]),
    level: r.level ?? 'DIRECT',
    created_at: pgTimestampToIso(r.created_at) ?? r.created_at ?? '',
  }));

  const referralRewards: RemnashopReferralReward[] = (
    tables.get('referral_rewards')?.rows ?? []
  ).map((r) => ({
    id: pgInt(r.id),
    referral_id: pgInt(r.referral_id),
    user_telegram_id: pickNumber(r, ['user_telegram_id', 'telegram_id']),
    type: r.type ?? 'POINTS',
    amount: pgInt(r.amount),
    is_issued: pgBool(r.is_issued),
    created_at: pgTimestampToIso(r.created_at) ?? r.created_at ?? '',
  }));

  const plans: RemnashopPlan[] = (tables.get('plans')?.rows ?? []).map((r) => ({
    id: pgInt(r.id),
    public_code: r.public_code ?? '',
    name: r.name ?? '',
    description: r.description,
    tag: r.tag,
    type: r.type ?? 'BOTH',
    availability: r.availability ?? 'ALL',
    traffic_limit_strategy: r.traffic_limit_strategy ?? 'NO_RESET',
    traffic_limit: pgInt(r.traffic_limit),
    device_limit: pgInt(r.device_limit),
    allowed_user_ids: pgNumberArray(r.allowed_user_ids),
    internal_squads: pgArray(r.internal_squads),
    external_squad: r.external_squad,
    order_index: pgInt(r.order_index),
    is_active: pgBool(r.is_active),
    is_trial: pgBool(r.is_trial),
  }));

  const planDurations: RemnashopPlanDuration[] = (tables.get('plan_durations')?.rows ?? []).map(
    (r) => ({
      id: pgInt(r.id),
      plan_id: pgInt(r.plan_id),
      days: pgInt(r.days),
      order_index: pgInt(r.order_index),
    }),
  );

  const planPrices: RemnashopPlanPrice[] = (tables.get('plan_prices')?.rows ?? []).map((r) => ({
    id: pgInt(r.id),
    plan_duration_id: pgInt(r.plan_duration_id),
    currency: r.currency ?? 'USD',
    price: r.price ?? '0',
  }));

  return {
    users,
    subscriptions,
    transactions,
    referrals,
    referralRewards,
    excludedData: buildExcludedDataSummary({
      settings: tables.get('settings')?.rows.length ?? 0,
      paymentGateways: tables.get('payment_gateways')?.rows.length ?? 0,
      broadcasts: tables.get('broadcasts')?.rows.length ?? 0,
      broadcastMessages: tables.get('broadcast_messages')?.rows.length ?? 0,
    }),
    plans,
    planDurations,
    planPrices,
  };
}

function extractDataFromJson(json: Record<string, unknown>): RemnashopBackupData {
  // Handle both formats:
  // 1. { metadata: {...}, data: { users: [...], subscriptions: [...], ... } }
  // 2. { users: [...], subscriptions: [...] }
  const data = (json.data ?? json) as Record<string, unknown>;

  const users = (data.users ?? []) as RemnashopUser[];
  const subscriptions = (data.subscriptions ?? []) as RemnashopSubscription[];
  const transactions = (data.transactions ?? []) as RemnashopTransaction[];
  const referrals = (data.referrals ?? []) as RemnashopReferral[];
  const referralRewards = (data.referral_rewards ??
    data.referralRewards ??
    []) as RemnashopReferralReward[];
  const plans = (data.plans ?? []) as RemnashopPlan[];
  const planDurations = (data.plan_durations ??
    data.planDurations ??
    []) as RemnashopPlanDuration[];
  const planPrices = (data.plan_prices ?? data.planPrices ?? []) as RemnashopPlanPrice[];

  if (!Array.isArray(users) || users.length === 0) {
    throw new BadRequestException('No user records found in the backup data');
  }

  return {
    users,
    subscriptions: Array.isArray(subscriptions) ? subscriptions : [],
    transactions: Array.isArray(transactions) ? transactions : [],
    referrals: Array.isArray(referrals) ? referrals : [],
    referralRewards: Array.isArray(referralRewards) ? referralRewards : [],
    excludedData: extractExcludedDataFromJson(data),
    plans: Array.isArray(plans) ? plans : [],
    planDurations: Array.isArray(planDurations) ? planDurations : [],
    planPrices: Array.isArray(planPrices) ? planPrices : [],
  };
}

async function gunzipBuffer(buffer: Buffer, maxBytes: number, label: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const readable = Readable.from([buffer]);
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let settled = false;
    let totalBytes = 0;

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      const exception = toBadRequestException(err, `Failed to decompress ${label}`);
      readable.unpipe(gunzip);
      readable.destroy();
      gunzip.destroy();
      reject(exception);
    };

    gunzip.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        fail(
          new BadRequestException(
            `${capitalize(label)} exceeds ${formatBytes(maxBytes)} after decompression`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, totalBytes));
    });
    gunzip.on('error', fail);
    readable.on('error', fail);
    readable.pipe(gunzip);
  });
}

function readStreamToBuffer(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let totalBytes = 0;

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      const destroyable = stream as unknown as { destroy?: () => void };
      if (typeof destroyable.destroy === 'function') {
        destroyable.destroy();
      }
      reject(toBadRequestException(err, `Failed to read ${label}`));
    };

    stream.on('data', (chunk: Buffer | string) => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bufferChunk.length;
      if (totalBytes > maxBytes) {
        fail(new BadRequestException(`${capitalize(label)} exceeds ${formatBytes(maxBytes)}`));
        return;
      }
      chunks.push(bufferChunk);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, totalBytes));
    });
    stream.on('error', fail);
  });
}

function ensureBufferWithinLimit(buffer: Buffer, maxBytes: number, label: string): void {
  if (buffer.length === 0) {
    throw new BadRequestException(`${label} is empty`);
  }
  if (buffer.length > maxBytes) {
    throw new BadRequestException(`${label} exceeds ${formatBytes(maxBytes)}`);
  }
}

function ensureArchiveEntrySize(name: string, size: number | undefined): void {
  if (!Number.isFinite(size) || size === undefined || size < 0) {
    throw new BadRequestException(`Archive entry '${name}' has an invalid size`);
  }
  if (size > MAX_ARCHIVE_ENTRY_BYTES) {
    throw new BadRequestException(
      `Archive entry '${name}' exceeds ${formatBytes(MAX_ARCHIVE_ENTRY_BYTES)}`,
    );
  }
}

// Typed off the tar-stream header instead of a bare `string`: the library also
// reports `null` for an entry with no type byte, and that case must land on the
// same "plain file" default as a missing one.
function normalizeTarEntryType(type: Headers['type']): 'file' | 'ignore' {
  const normalized = type ?? 'file';
  if (!ALLOWED_TAR_ENTRY_TYPES.has(normalized)) {
    throw new BadRequestException(`Archive entry type '${normalized}' is not allowed`);
  }
  return normalized === 'file' ? 'file' : 'ignore';
}

function normalizeTarEntryName(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new BadRequestException('Archive entry has an empty name');
  }
  if (name.includes('\0')) {
    throw new BadRequestException('Archive entry name contains a null byte');
  }
  if (name.includes('\\')) {
    throw new BadRequestException(`Archive entry '${name}' uses an unsafe path separator`);
  }

  const trimmed = name.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (trimmed.length === 0 || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    throw new BadRequestException(`Archive entry '${name}' has an unsafe path`);
  }

  const segments = trimmed.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new BadRequestException(`Archive entry '${name}' has an unsafe path`);
  }

  return trimmed;
}

function classifyArchiveEntry(name: string): 'json' | 'sql.gz' | 'sql' | null {
  const basename = name.split('/').pop() ?? name;
  if (basename === 'database.json') return 'json';
  if (/\.sql\.gz$/i.test(basename)) return 'sql.gz';
  if (/\.sql$/i.test(basename)) return 'sql';
  return null;
}

function extractExcludedDataFromJson(data: Record<string, unknown>): RemnashopExcludedDataSummary {
  const explicit = data.excludedData ?? data.excluded_data;
  if (isRecord(explicit)) {
    return buildExcludedDataSummary({
      settings: numberFromUnknown(explicit.settings),
      paymentGateways: numberFromUnknown(explicit.paymentGateways ?? explicit.payment_gateways),
      broadcasts: numberFromUnknown(explicit.broadcasts),
      broadcastMessages: numberFromUnknown(
        explicit.broadcastMessages ?? explicit.broadcast_messages,
      ),
    });
  }

  return buildExcludedDataSummary({
    settings: countJsonArray(data.settings),
    paymentGateways: countJsonArray(data.payment_gateways ?? data.paymentGateways),
    broadcasts: countJsonArray(data.broadcasts),
    broadcastMessages: countJsonArray(data.broadcast_messages ?? data.broadcastMessages),
  });
}

function buildExcludedDataSummary(
  counts: RemnashopExcludedDataSummary,
): RemnashopExcludedDataSummary {
  return {
    settings: Math.max(0, counts.settings),
    paymentGateways: Math.max(0, counts.paymentGateways),
    broadcasts: Math.max(0, counts.broadcasts),
    broadcastMessages: Math.max(0, counts.broadcastMessages),
  };
}

function countJsonArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function pickNumber(row: Record<string, string | null>, keys: readonly string[]): number {
  for (const key of keys) {
    if (key in row) return pgBigInt(row[key]);
  }
  return 0;
}

function numberFromUnknown(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return `${mebibytes.toFixed(Number.isInteger(mebibytes) ? 0 : 1)} MiB`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

function toBadRequestException(err: unknown, fallbackMessage: string): BadRequestException {
  if (err instanceof BadRequestException) return err;
  if (err instanceof Error && err.message.length > 0) {
    return new BadRequestException(`${fallbackMessage}: ${err.message}`);
  }
  return new BadRequestException(fallbackMessage);
}
