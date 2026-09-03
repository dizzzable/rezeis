import { BadRequestException } from '@nestjs/common';

import {
  MAX_GZIP_OUTPUT_BYTES,
  MAX_INPUT_BYTES,
  MAX_JSON_BYTES,
  ensureBufferWithinLimit,
  findArchivePayload,
  gunzipBuffer,
  isGzipBuffer,
  isTarBuffer,
  toBadRequestException,
} from './backup-archive.util';

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


/**
 * Parses an official AltShop `.tar.gz` backup (with a root `database.json`),
 * or a direct `database.json` upload. Only product data is returned: donor
 * passwords, payment-gateway credentials, live invite tokens and runtime
 * settings are intentionally never passed to the importer.
 */
export async function parseAltshopBackup(buffer: Buffer): Promise<AltshopBackupData> {
  ensureBufferWithinLimit(buffer, MAX_INPUT_BYTES, 'Backup file');

  if (isGzipBuffer(buffer)) {
    const decompressed = await gunzipBuffer(buffer, MAX_GZIP_OUTPUT_BYTES, 'backup file');
    if (!isTarBuffer(decompressed)) {
      return parseJsonBuffer(decompressed, 'Decompressed JSON export');
    }
    return parseAltshopArchive(decompressed);
  }

  return parseJsonBuffer(buffer, 'JSON export');
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

/**
 * AltShop keeps its export at the ROOT of the archive, named exactly
 * `database.json` — not by basename, so a `backups/database.json` inside some
 * other tool's archive is not mistaken for one.
 */
function classifyAltshopEntry(name: string): 'json' | null {
  return name === 'database.json' ? 'json' : null;
}

async function parseAltshopArchive(tarBuffer: Buffer): Promise<AltshopBackupData> {
  const payload = await findArchivePayload(tarBuffer, classifyAltshopEntry);
  if (payload === null) {
    throw new BadRequestException('database.json not found in the AltShop archive');
  }
  ensureBufferWithinLimit(payload.bytes, MAX_JSON_BYTES, "Archive entry 'database.json'");
  try {
    return extractDataFromJson(JSON.parse(payload.bytes.toString('utf-8')));
  } catch (error) {
    // Not `parseJsonBuffer`: somebody who uploaded a perfectly good archive
    // whose payload is malformed should be told THAT, not advised to upload
    // an archive.
    throw toBadRequestException(error, 'Failed to parse AltShop archive');
  }
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

