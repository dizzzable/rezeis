import { BadRequestException } from '@nestjs/common';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { extract, Headers } from 'tar-stream';

import {
  AltshopSubscription,
  AltshopTransaction,
  AltshopUser,
  AltshopWebAccount,
} from '../services/altshop-importer.service';

/**
 * Plan/duration/price rows as exported from the altshop PostgreSQL DB.
 *
 * altshop's plan model is a 1:1 ancestor of ours: a `plans` row owns
 * many `plan_durations` rows (each for a different number of days) and
 * each duration owns many `plan_prices` rows (one per currency).
 *
 * We keep the altshop integer ids on these so the cloner can build
 * `altshop_plan_id → rezeis_plan_id` mapping for translating
 * Subscription.plan_id and Plan.upgrade_to_plan_ids.
 */
export interface AltshopPlan {
  readonly id: number;
  readonly order_index: number;
  readonly is_active: boolean;
  readonly is_archived: boolean;
  readonly type: string;
  readonly availability: string;
  readonly archived_renew_mode: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly tag: string | null;
  readonly traffic_limit: number;
  readonly device_limit: number;
  readonly traffic_limit_strategy: string;
  readonly replacement_plan_ids: readonly number[];
  readonly upgrade_to_plan_ids: readonly number[];
  readonly allowed_user_ids: readonly number[];
  readonly internal_squads: readonly string[];
  readonly external_squad: string | null;
}

export interface AltshopPlanDuration {
  readonly id: number;
  readonly plan_id: number;
  readonly days: number;
}

export interface AltshopPlanPrice {
  readonly id: number;
  readonly plan_duration_id: number;
  readonly currency: string;
  readonly price: string; // Numeric serialised as decimal string
}

interface AltshopBackupData {
  users: AltshopUser[];
  subscriptions: AltshopSubscription[];
  transactions: AltshopTransaction[];
  /** Cabinet logins (migrated as claim-pending; bcrypt hash dropped). */
  webAccounts: AltshopWebAccount[];
  /**
   * Optional: the catalog tables. They are present in real altshop
   * backups (`backup_full_*.tar.gz`) but absent in stripped JSON
   * exports — the cloner falls back to "no clone available" gracefully.
   */
  plans: AltshopPlan[];
  planDurations: AltshopPlanDuration[];
  planPrices: AltshopPlanPrice[];
}

/**
 * Parses an altshop backup `.tar.gz` archive.
 *
 * Expected structure:
 *   - `database.json` — contains `{ metadata: {...}, data: { users, subscriptions, transactions, ... } }`
 *   - `metadata.json` — backup metadata (optional, not used for import)
 *   - `assets/` — banners/translations (ignored)
 *
 * Also accepts raw `database.json` content directly.
 */
export async function parseAltshopBackup(buffer: Buffer): Promise<AltshopBackupData> {
  // Try to detect if this is a gzip file (magic bytes: 1f 8b)
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return parseAltshopTarGz(buffer);
  }

  // Try to parse as raw JSON (database.json uploaded directly)
  try {
    const json = JSON.parse(buffer.toString('utf-8'));
    return extractDataFromJson(json);
  } catch {
    throw new BadRequestException(
      'Unsupported file format. Expected .tar.gz backup or database.json file.',
    );
  }
}

async function parseAltshopTarGz(buffer: Buffer): Promise<AltshopBackupData> {
  return new Promise((resolve, reject) => {
    const extractor = extract();
    let databaseJson: string | null = null;

    extractor.on('entry', (header: Headers, stream, next) => {
      const chunks: Buffer[] = [];

      if (header.name === 'database.json') {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          databaseJson = Buffer.concat(chunks).toString('utf-8');
          next();
        });
      } else {
        // Skip non-database entries
        stream.on('end', next);
        stream.resume();
      }
    });

    extractor.on('finish', () => {
      if (!databaseJson) {
        reject(new BadRequestException('database.json not found in the archive'));
        return;
      }

      try {
        const json = JSON.parse(databaseJson);
        resolve(extractDataFromJson(json));
      } catch (err) {
        reject(new BadRequestException(`Failed to parse database.json: ${(err as Error).message}`));
      }
    });

    extractor.on('error', (err) => {
      reject(new BadRequestException(`Failed to extract archive: ${err.message}`));
    });

    // Pipe: buffer → gunzip → tar extract
    const readable = Readable.from(buffer);
    const gunzip = createGunzip();

    gunzip.on('error', (err) => {
      reject(new BadRequestException(`Failed to decompress archive: ${err.message}`));
    });

    readable.pipe(gunzip).pipe(extractor);
  });
}

function extractDataFromJson(json: Record<string, unknown>): AltshopBackupData {
  // Handle both formats:
  // 1. { metadata: {...}, data: { users: [...], ... } }  — full backup database.json
  // 2. { users: [...], subscriptions: [...], ... }       — direct data export
  const data = (json.data ?? json) as Record<string, unknown>;

  const users = (data.users ?? []) as AltshopUser[];
  const subscriptions = (data.subscriptions ?? []) as AltshopSubscription[];
  const transactions = (data.transactions ?? []) as AltshopTransaction[];
  const webAccountsRaw = (data.web_accounts ?? []) as Array<Record<string, unknown>>;
  const plans = (data.plans ?? []) as AltshopPlan[];
  const planDurations = (data.plan_durations ?? []) as AltshopPlanDuration[];
  const planPrices = (data.plan_prices ?? []) as AltshopPlanPrice[];

  if (!Array.isArray(users) || users.length === 0) {
    throw new BadRequestException('No user records found in the backup data');
  }

  // Web accounts: keep only the identity (login/email); the bcrypt password
  // hash is intentionally dropped (unusable by the rezeis cabinet).
  const webAccounts: AltshopWebAccount[] = (Array.isArray(webAccountsRaw) ? webAccountsRaw : [])
    .map((w) => ({
      user_telegram_id: Number(w.user_telegram_id),
      username: typeof w.username === 'string' ? w.username : null,
      email: typeof w.email === 'string' ? w.email : null,
    }))
    .filter((w) => Number.isFinite(w.user_telegram_id) && (w.username !== null || w.email !== null));

  // Map altshop subscription format: `plan` field → `plan_snapshot`
  const mappedSubscriptions: AltshopSubscription[] = subscriptions.map((sub) => {
    const raw = sub as unknown as Record<string, unknown>;
    return {
      ...sub,
      plan_snapshot: (raw.plan ?? raw.plan_snapshot ?? null) as Record<string, unknown> | null,
    };
  });

  return {
    users,
    subscriptions: mappedSubscriptions,
    transactions,
    webAccounts,
    plans: Array.isArray(plans) ? plans : [],
    planDurations: Array.isArray(planDurations) ? planDurations : [],
    planPrices: Array.isArray(planPrices) ? planPrices : [],
  };
}
