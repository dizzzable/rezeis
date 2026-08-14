import { BadRequestException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { extract, Headers } from 'tar-stream';

import type {
  AltshopExcludedDataSummary,
  AltshopPartner,
  AltshopPartnerReferral,
  AltshopPartnerTransaction,
  AltshopReferral,
  AltshopReferralReward,
  AltshopSubscription,
  AltshopTransaction,
  AltshopUser,
  AltshopWebAccount,
} from '../services/altshop-importer.service';

/** Catalog rows retained for the optional post-import plan-cloning step. */
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
  readonly price: string;
}

export interface AltshopBackupData {
  users: AltshopUser[];
  subscriptions: AltshopSubscription[];
  transactions: AltshopTransaction[];
  webAccounts: AltshopWebAccount[];
  referrals: AltshopReferral[];
  referralRewards: AltshopReferralReward[];
  partners: AltshopPartner[];
  partnerReferrals: AltshopPartnerReferral[];
  partnerTransactions: AltshopPartnerTransaction[];
  excludedData: AltshopExcludedDataSummary;
  plans: AltshopPlan[];
  planDurations: AltshopPlanDuration[];
  planPrices: AltshopPlanPrice[];
}

const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_GZIP_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const ALLOWED_TAR_ENTRY_TYPES = new Set(['file', 'directory', 'pax-header', 'pax-global-header']);

/**
 * Parses an official AltShop `.tar.gz` backup (with a root `database.json`),
 * or a direct `database.json` upload. Only product data is returned: donor
 * passwords, payment-gateway credentials, live invite tokens and runtime
 * settings are intentionally never passed to the importer.
 */
export async function parseAltshopBackup(buffer: Buffer): Promise<AltshopBackupData> {
  ensureBufferWithinLimit(buffer, MAX_INPUT_BYTES, 'Backup file');

  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    const decompressed = await gunzipBuffer(buffer, MAX_GZIP_OUTPUT_BYTES, 'backup file');
    if (!isTarBuffer(decompressed)) {
      return parseJsonBuffer(decompressed, 'Decompressed JSON export');
    }
    return parseAltshopArchive(decompressed);
  }

  return parseJsonBuffer(buffer, 'JSON export');
}

function isTarBuffer(buffer: Buffer): boolean {
  return buffer.length > 262 && buffer.toString('ascii', 257, 262) === 'ustar';
}

function parseJsonBuffer(buffer: Buffer, label: string): AltshopBackupData {
  ensureBufferWithinLimit(buffer, MAX_JSON_BYTES, label);
  try {
    return extractDataFromJson(JSON.parse(buffer.toString('utf-8')));
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(
      'Unsupported file format. Expected an AltShop .tar.gz backup or database.json file.',
    );
  }
}

async function parseAltshopArchive(tarBuffer: Buffer): Promise<AltshopBackupData> {
  return new Promise((resolve, reject) => {
    const readable = Readable.from([tarBuffer]);
    const extractor = extract();
    let settled = false;
    let databaseJson: Buffer | null = null;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      readable.unpipe(extractor);
      readable.destroy();
      extractor.destroy();
      reject(toBadRequestException(error, 'Failed to parse AltShop archive'));
    };

    extractor.on('entry', (header: Headers, stream, next) => {
      let normalizedName: string;
      let type: 'file' | 'ignore';
      try {
        normalizedName = normalizeTarEntryName(header.name);
        type = normalizeTarEntryType(header.type);
        if (type === 'file') ensureArchiveEntrySize(normalizedName, header.size);
      } catch (error) {
        stream.resume();
        fail(error);
        return;
      }

      stream.on('error', fail);
      if (type !== 'file' || normalizedName !== 'database.json') {
        stream.resume();
        stream.on('end', next);
        return;
      }

      if (databaseJson !== null) {
        stream.resume();
        fail(new BadRequestException('Archive contains more than one database.json payload'));
        return;
      }

      void readStreamToBuffer(stream, MAX_ARCHIVE_ENTRY_BYTES, "archive entry 'database.json'")
        .then((bytes) => {
          if (settled) return;
          databaseJson = bytes;
          next();
        })
        .catch(fail);
    });

    extractor.on('finish', () => {
      if (settled) return;
      try {
        if (databaseJson === null) {
          throw new BadRequestException('database.json not found in the AltShop archive');
        }
        ensureBufferWithinLimit(databaseJson, MAX_JSON_BYTES, "Archive entry 'database.json'");
        settled = true;
        resolve(extractDataFromJson(JSON.parse(databaseJson.toString('utf-8'))));
      } catch (error) {
        fail(error);
      }
    });

    extractor.on('error', fail);
    readable.on('error', fail);
    readable.pipe(extractor);
  });
}

function extractDataFromJson(json: unknown): AltshopBackupData {
  if (!isRecord(json)) {
    throw new BadRequestException('database.json must contain a JSON object');
  }
  const data = isRecord(json.data) ? json.data : json;
  const users = arrayField<AltshopUser>(data, 'users');
  if (users.length === 0) {
    throw new BadRequestException('No user records found in the backup data');
  }

  const webAccounts = arrayField<Record<string, unknown>>(data, 'web_accounts')
    .map((account) => ({
      user_telegram_id: Number(account.user_telegram_id),
      username: typeof account.username === 'string' ? account.username : null,
      email: typeof account.email === 'string' ? account.email : null,
    }))
    .filter(
      (account) =>
        Number.isSafeInteger(account.user_telegram_id) &&
        (account.username !== null || account.email !== null),
    );

  const subscriptions = arrayField<AltshopSubscription>(data, 'subscriptions').map((subscription) => {
    const raw = subscription as unknown as Record<string, unknown>;
    return {
      ...subscription,
      plan_snapshot: (raw.plan ?? raw.plan_snapshot ?? null) as Record<string, unknown> | null,
    };
  });

  return {
    users,
    subscriptions,
    transactions: arrayField<AltshopTransaction>(data, 'transactions').map((transaction) => {
      const raw = transaction as unknown as Record<string, unknown>;
      return {
        ...transaction,
        plan_snapshot: (raw.plan ?? raw.plan_snapshot ?? null) as Record<string, unknown> | null,
      };
    }),
    webAccounts,
    referrals: arrayField<AltshopReferral>(data, 'referrals'),
    referralRewards: arrayField<AltshopReferralReward>(data, 'referral_rewards'),
    partners: arrayField<AltshopPartner>(data, 'partners'),
    partnerReferrals: arrayField<AltshopPartnerReferral>(data, 'partner_referrals'),
    partnerTransactions: arrayField<AltshopPartnerTransaction>(data, 'partner_transactions'),
    excludedData: {
      settings: arrayField<unknown>(data, 'settings').length,
      paymentGateways: arrayField<unknown>(data, 'payment_gateways').length,
      referralInvites: arrayField<unknown>(data, 'referral_invites').length,
      promocodes: arrayField<unknown>(data, 'promocodes').length,
      promocodeActivations: arrayField<unknown>(data, 'promocode_activations').length,
      partnerWithdrawals: arrayField<unknown>(data, 'partner_withdrawals').length,
      broadcasts: arrayField<unknown>(data, 'broadcasts').length,
      broadcastMessages: arrayField<unknown>(data, 'broadcast_messages').length,
    },
    plans: arrayField<AltshopPlan>(data, 'plans'),
    planDurations: arrayField<AltshopPlanDuration>(data, 'plan_durations'),
    planPrices: arrayField<AltshopPlanPrice>(data, 'plan_prices'),
  };
}

function arrayField<T>(record: Record<string, unknown>, key: string): T[] {
  const value = record[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException(`Field '${key}' must be an array when present`);
  }
  return value as T[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureBufferWithinLimit(buffer: Buffer, limit: number, label: string): void {
  if (buffer.length > limit) {
    throw new BadRequestException(`${label} exceeds the ${formatBytes(limit)} size limit`);
  }
}

// `size` is optional in the tar header, and an entry that does not declare one
// is rejected exactly like a malformed one — we refuse to read a payload whose
// length we cannot bound in advance.
function ensureArchiveEntrySize(name: string, size: number | undefined): void {
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
    throw new BadRequestException(`Archive entry '${name}' has an invalid size`);
  }
  if (size > MAX_ARCHIVE_ENTRY_BYTES) {
    throw new BadRequestException(
      `Archive entry '${name}' exceeds the ${formatBytes(MAX_ARCHIVE_ENTRY_BYTES)} size limit`,
    );
  }
}

function normalizeTarEntryName(name: string): string {
  if (!name || name.includes('\0') || name.includes('\\')) {
    throw new BadRequestException('Archive contains an unsafe entry name');
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new BadRequestException(`Archive entry '${name}' must use a relative path`);
  }
  const parts = name.split('/');
  // tar commonly stores directories as `assets/`; the trailing slash is not
  // a path traversal segment and is discarded before validation.
  if (parts[parts.length - 1] === '') parts.pop();
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new BadRequestException(`Archive entry '${name}' contains an unsafe path`);
  }
  return parts.join('/');
}

// Typed off the tar-stream header instead of a bare `string`: the library also
// reports `null` for an entry with no type byte, and that case must land on the
// same "plain file" default as a missing one.
function normalizeTarEntryType(type: Headers['type']): 'file' | 'ignore' {
  const normalized = type ?? 'file';
  if (!ALLOWED_TAR_ENTRY_TYPES.has(normalized)) {
    throw new BadRequestException(`Archive contains unsafe entry type '${normalized}'`);
  }
  return normalized === 'file' ? 'file' : 'ignore';
}

async function gunzipBuffer(buffer: Buffer, limit: number, label: string): Promise<Buffer> {
  const input = Readable.from([buffer]);
  const gunzip = createGunzip();
  try {
    return await readStreamToBuffer(input.pipe(gunzip), limit, `Decompressed ${label}`);
  } catch (error) {
    input.destroy();
    gunzip.destroy();
    throw toBadRequestException(error, `Failed to decompress ${label}`);
  }
}

async function readStreamToBuffer(stream: NodeJS.ReadableStream, limit: number, label: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) {
        const destroyable = stream as NodeJS.ReadableStream & {
          destroy?: (error?: Error) => void;
        };
        destroyable.destroy?.(
          new BadRequestException(`${label} exceeds the ${formatBytes(limit)} size limit`),
        );
        return;
      }
      chunks.push(bytes);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function toBadRequestException(error: unknown, fallback: string): BadRequestException {
  if (error instanceof BadRequestException) return error;
  const message = error instanceof Error && error.message ? `: ${error.message}` : '';
  return new BadRequestException(`${fallback}${message}`);
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MiB`;
}
