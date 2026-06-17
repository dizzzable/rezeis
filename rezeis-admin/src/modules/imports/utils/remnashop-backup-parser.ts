import { BadRequestException } from '@nestjs/common';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { extract, Headers } from 'tar-stream';

import {
  RemnashopSubscription,
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
  /** Optional catalog (full backups expose it, stripped JSON exports may not). */
  plans: RemnashopPlan[];
  planDurations: RemnashopPlanDuration[];
  planPrices: RemnashopPlanPrice[];
}

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
  // Gzip magic (1f 8b) — could be a .tar.gz, a gzipped .sql, or gzipped json.
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    let decompressed: Buffer;
    try {
      decompressed = gunzipSync(buffer);
    } catch (err) {
      throw new BadRequestException(`Failed to decompress archive: ${(err as Error).message}`);
    }
    if (isTarBuffer(decompressed)) {
      return parseRemnashopArchive(decompressed);
    }
    const text = decompressed.toString('utf-8');
    if (looksLikePgDump(text)) {
      return parseRemnashopSqlDump(text);
    }
    try {
      return extractDataFromJson(JSON.parse(text));
    } catch {
      // Last resort: maybe a tar without the ustar magic in the sampled range.
      return parseRemnashopArchive(decompressed);
    }
  }

  // Not gzip: a raw .sql dump or a raw .json export.
  const text = buffer.toString('utf-8');
  if (looksLikePgDump(text)) {
    return parseRemnashopSqlDump(text);
  }
  try {
    return extractDataFromJson(JSON.parse(text));
  } catch {
    throw new BadRequestException(
      'Unsupported file format. Expected a .tar.gz backup, a .sql(.gz) pg dump or a .json export file.',
    );
  }
}

/** POSIX tar archives carry the "ustar" magic at byte offset 257. */
function isTarBuffer(buf: Buffer): boolean {
  return buf.length > 262 && buf.toString('ascii', 257, 262) === 'ustar';
}

/**
 * Walk a (already-decompressed) tar archive, capturing either a top-level
 * `database.json` or a nested `*.sql` / `*.sql.gz` pg dump. The bulky
 * `bot_dir_*.tar.gz` and `backup_meta.info` entries are skipped.
 */
async function parseRemnashopArchive(tarBuffer: Buffer): Promise<RemnashopBackupData> {
  return new Promise((resolve, reject) => {
    const extractor = extract();
    let databaseJson: string | null = null;
    let sqlGzBytes: Buffer | null = null;
    let sqlBytes: Buffer | null = null;

    extractor.on('entry', (header: Headers, stream, next) => {
      const name = header.name.split('/').pop() ?? header.name;
      const wantJson = name === 'database.json';
      const wantSqlGz = /\.sql\.gz$/i.test(name);
      const wantSql = /\.sql$/i.test(name);

      if (wantJson || wantSqlGz || wantSql) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (wantJson) databaseJson = buf.toString('utf-8');
          else if (wantSqlGz) sqlGzBytes = buf;
          else sqlBytes = buf;
          next();
        });
      } else {
        stream.on('end', next);
        stream.resume();
      }
    });

    extractor.on('finish', () => {
      try {
        if (databaseJson !== null) {
          resolve(extractDataFromJson(JSON.parse(databaseJson)));
          return;
        }
        if (sqlGzBytes !== null) {
          resolve(parseRemnashopSqlDump(gunzipSync(sqlGzBytes).toString('utf-8')));
          return;
        }
        if (sqlBytes !== null) {
          resolve(parseRemnashopSqlDump(sqlBytes.toString('utf-8')));
          return;
        }
        reject(
          new BadRequestException(
            'No database.json or .sql dump found in the archive (expected a Remnawave/remnashop backup).',
          ),
        );
      } catch (err) {
        reject(new BadRequestException(`Failed to parse backup contents: ${(err as Error).message}`));
      }
    });

    extractor.on('error', (err) => {
      reject(new BadRequestException(`Failed to extract archive: ${err.message}`));
    });

    Readable.from(tarBuffer).pipe(extractor);
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

  const subscriptions: RemnashopSubscription[] = (tables.get('subscriptions')?.rows ?? []).map((r) => ({
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

  const planDurations: RemnashopPlanDuration[] = (tables.get('plan_durations')?.rows ?? []).map((r) => ({
    id: pgInt(r.id),
    plan_id: pgInt(r.plan_id),
    days: pgInt(r.days),
    order_index: pgInt(r.order_index),
  }));

  const planPrices: RemnashopPlanPrice[] = (tables.get('plan_prices')?.rows ?? []).map((r) => ({
    id: pgInt(r.id),
    plan_duration_id: pgInt(r.plan_duration_id),
    currency: r.currency ?? 'USD',
    price: r.price ?? '0',
  }));

  return { users, subscriptions, plans, planDurations, planPrices };
}

function extractDataFromJson(json: Record<string, unknown>): RemnashopBackupData {
  // Handle both formats:
  // 1. { metadata: {...}, data: { users: [...], subscriptions: [...], ... } }
  // 2. { users: [...], subscriptions: [...] }
  const data = (json.data ?? json) as Record<string, unknown>;

  const users = (data.users ?? []) as RemnashopUser[];
  const subscriptions = (data.subscriptions ?? []) as RemnashopSubscription[];
  const plans = (data.plans ?? []) as RemnashopPlan[];
  const planDurations = (data.plan_durations ?? []) as RemnashopPlanDuration[];
  const planPrices = (data.plan_prices ?? []) as RemnashopPlanPrice[];

  if (!Array.isArray(users) || users.length === 0) {
    throw new BadRequestException('No user records found in the backup data');
  }

  return {
    users,
    subscriptions,
    plans: Array.isArray(plans) ? plans : [],
    planDurations: Array.isArray(planDurations) ? planDurations : [],
    planPrices: Array.isArray(planPrices) ? planPrices : [],
  };
}
