import { BadRequestException } from '@nestjs/common';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { ThreeXuiClient } from '../services/threexui-importer.service';

interface ClientRow {
  id: number;
  email: string;
  sub_id: string | null;
  uuid: string | null;
  password: string | null;
  flow: string | null;
  limit_ip: number;
  total_gb: number;
  expiry_time: number;
  enable: number;
  tg_id: number;
  comment: string | null;
  reset: number;
  created_at: number;
  updated_at: number;
}

interface ClientTrafficRow {
  email: string;
  up: number;
  down: number;
  total: number;
  expiry_time: number;
  enable: number;
  inbound_id: number;
}

interface InboundRow {
  id: number;
  remark: string;
  protocol: string;
  settings: string;
}

interface SettingsJson {
  clients?: Array<{
    email?: string;
    id?: string;
    password?: string;
    subId?: string;
    tgId?: number;
    limitIp?: number;
    totalGB?: number;
    expiryTime?: number;
    enable?: boolean;
    comment?: string;
    reset?: number;
  }>;
}

/**
 * Parses a 3x-ui SQLite database file (`.db`) and extracts client records.
 *
 * Supports both v3 (dedicated `clients` table) and legacy (JSON in `inbounds.settings`).
 * Also accepts raw JSON array of clients.
 *
 * @param buffer - The uploaded file buffer (.db or .json)
 * @param subBaseUrl - Optional base URL for generating subscription URLs
 */
export function parseThreeXuiBackup(buffer: Buffer, subBaseUrl?: string): ThreeXuiClient[] {
  // Try JSON first (if user exports clients as JSON)
  if (isJsonBuffer(buffer)) {
    try {
      const json = JSON.parse(buffer.toString('utf-8'));
      const clients = Array.isArray(json) ? json : json.clients ?? json.data ?? [];
      if (Array.isArray(clients) && clients.length > 0) {
        return clients as ThreeXuiClient[];
      }
    } catch {
      // Not valid JSON, try SQLite
    }
  }

  // Parse as SQLite database
  return parseSqliteDb(buffer, subBaseUrl);
}

function parseSqliteDb(buffer: Buffer, subBaseUrl?: string): ThreeXuiClient[] {
  // Write buffer to a temp file (better-sqlite3 requires a file path)
  const tempPath = join(tmpdir(), `3xui-import-${randomUUID()}.db`);

  try {
    writeFileSync(tempPath, buffer);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(tempPath, { readonly: true });

    const clients: ThreeXuiClient[] = [];

    // Try v3 approach: dedicated `clients` table
    const hasClientsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clients'")
      .get();

    if (hasClientsTable) {
      clients.push(...parseFromClientsTable(db, subBaseUrl));
    } else {
      // Legacy: parse from inbounds.settings JSON
      clients.push(...parseFromInboundsSettings(db, subBaseUrl));
    }

    db.close();

    if (clients.length === 0) {
      throw new BadRequestException('No client records found in the 3x-ui database');
    }

    return clients;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

function parseFromClientsTable(db: unknown, subBaseUrl?: string): ThreeXuiClient[] {
  const typedDb = db as { prepare: (sql: string) => { all: () => unknown[] } };

  const clientRows = typedDb
    .prepare('SELECT * FROM clients')
    .all() as ClientRow[];

  // Get traffic data
  const trafficRows = typedDb
    .prepare('SELECT * FROM client_traffics')
    .all() as ClientTrafficRow[];

  const trafficByEmail = new Map<string, ClientTrafficRow>();
  for (const row of trafficRows) {
    trafficByEmail.set(row.email, row);
  }

  // Get inbound info for protocol/remark
  const inboundRows = typedDb
    .prepare('SELECT id, remark, protocol FROM inbounds')
    .all() as InboundRow[];

  // Get client-inbound mapping
  let clientInbounds: Array<{ client_id: number; inbound_id: number }> = [];
  const hasClientInboundsTable = typedDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='client_inbounds'")
    .all();
  if (hasClientInboundsTable.length > 0) {
    clientInbounds = typedDb
      .prepare('SELECT client_id, inbound_id FROM client_inbounds')
      .all() as Array<{ client_id: number; inbound_id: number }>;
  }

  const inboundById = new Map(inboundRows.map((r) => [r.id, r]));
  const clientInboundMap = new Map<number, number>();
  for (const ci of clientInbounds) {
    clientInboundMap.set(ci.client_id, ci.inbound_id);
  }

  return clientRows.map((row): ThreeXuiClient => {
    const traffic = trafficByEmail.get(row.email);
    const inboundId = clientInboundMap.get(row.id);
    const inbound = inboundId ? inboundById.get(inboundId) : undefined;

    return {
      email: row.email,
      uuid: row.uuid || null,
      password: row.password || null,
      subId: row.sub_id || null,
      tgId: row.tg_id ?? 0,
      totalGb: row.total_gb ?? 0,
      limitIp: row.limit_ip ?? 0,
      expiryTime: row.expiry_time ?? 0,
      enable: row.enable === 1,
      comment: row.comment || null,
      reset: row.reset ?? 0,
      up: traffic?.up ?? 0,
      down: traffic?.down ?? 0,
      inboundRemark: inbound?.remark ?? null,
      inboundProtocol: inbound?.protocol ?? null,
      subscriptionUrl: row.sub_id && subBaseUrl
        ? `${subBaseUrl}/${row.sub_id}`
        : null,
    };
  });
}

function parseFromInboundsSettings(db: unknown, subBaseUrl?: string): ThreeXuiClient[] {
  const typedDb = db as { prepare: (sql: string) => { all: () => unknown[] } };

  const inboundRows = typedDb
    .prepare('SELECT id, remark, protocol, settings FROM inbounds')
    .all() as InboundRow[];

  const trafficRows = typedDb
    .prepare('SELECT * FROM client_traffics')
    .all() as ClientTrafficRow[];

  const trafficByEmail = new Map<string, ClientTrafficRow>();
  for (const row of trafficRows) {
    trafficByEmail.set(row.email, row);
  }

  const clients: ThreeXuiClient[] = [];
  const seenEmails = new Set<string>();

  for (const inbound of inboundRows) {
    let settings: SettingsJson;
    try {
      settings = JSON.parse(inbound.settings || '{}') as SettingsJson;
    } catch {
      continue;
    }

    for (const client of settings.clients ?? []) {
      if (!client.email || seenEmails.has(client.email)) continue;
      seenEmails.add(client.email);

      const traffic = trafficByEmail.get(client.email);

      clients.push({
        email: client.email,
        uuid: client.id || null,
        password: client.password || null,
        subId: client.subId || null,
        tgId: client.tgId ?? 0,
        totalGb: client.totalGB ?? 0,
        limitIp: client.limitIp ?? 0,
        expiryTime: client.expiryTime ?? 0,
        enable: client.enable !== false,
        comment: client.comment || null,
        reset: client.reset ?? 0,
        up: traffic?.up ?? 0,
        down: traffic?.down ?? 0,
        inboundRemark: inbound.remark,
        inboundProtocol: inbound.protocol,
        subscriptionUrl: client.subId && subBaseUrl
          ? `${subBaseUrl}/${client.subId}`
          : null,
      });
    }
  }

  return clients;
}

function isJsonBuffer(buffer: Buffer): boolean {
  // Check if first non-whitespace char is [ or {
  for (let i = 0; i < Math.min(buffer.length, 100); i++) {
    const ch = buffer[i];
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) continue; // whitespace
    return ch === 0x5b || ch === 0x7b; // [ or {
  }
  return false;
}
