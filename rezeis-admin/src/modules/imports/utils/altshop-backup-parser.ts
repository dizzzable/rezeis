import { BadRequestException } from '@nestjs/common';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { extract, Headers } from 'tar-stream';

import {
  AltshopSubscription,
  AltshopTransaction,
  AltshopUser,
} from '../services/altshop-importer.service';

interface AltshopBackupData {
  users: AltshopUser[];
  subscriptions: AltshopSubscription[];
  transactions: AltshopTransaction[];
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

  if (!Array.isArray(users) || users.length === 0) {
    throw new BadRequestException('No user records found in the backup data');
  }

  // Map altshop subscription format: `plan` field → `plan_snapshot`
  const mappedSubscriptions: AltshopSubscription[] = subscriptions.map((sub) => {
    const raw = sub as Record<string, unknown>;
    return {
      ...sub,
      plan_snapshot: (raw.plan ?? raw.plan_snapshot ?? null) as Record<string, unknown> | null,
    };
  });

  return { users, subscriptions: mappedSubscriptions, transactions };
}
