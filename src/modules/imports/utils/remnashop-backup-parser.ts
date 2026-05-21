import { BadRequestException } from '@nestjs/common';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { extract, Headers } from 'tar-stream';

import {
  RemnashopSubscription,
  RemnashopUser,
} from '../services/remnashop-importer.service';

interface RemnashopBackupData {
  users: RemnashopUser[];
  subscriptions: RemnashopSubscription[];
}

/**
 * Parses a remnashop backup file.
 *
 * Supports:
 *   - `.tar.gz` archive with `database.json` inside (same format as altshop)
 *   - Raw `.json` file with `{ users: [...], subscriptions: [...] }` or
 *     `{ data: { users: [...], subscriptions: [...] } }`
 */
export async function parseRemnashopBackup(buffer: Buffer): Promise<RemnashopBackupData> {
  // Try to detect if this is a gzip file (magic bytes: 1f 8b)
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return parseRemnashopTarGz(buffer);
  }

  // Try to parse as raw JSON
  try {
    const json = JSON.parse(buffer.toString('utf-8'));
    return extractDataFromJson(json);
  } catch {
    throw new BadRequestException(
      'Unsupported file format. Expected .tar.gz backup or .json export file.',
    );
  }
}

async function parseRemnashopTarGz(buffer: Buffer): Promise<RemnashopBackupData> {
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

    const readable = Readable.from(buffer);
    const gunzip = createGunzip();

    gunzip.on('error', (err) => {
      reject(new BadRequestException(`Failed to decompress archive: ${err.message}`));
    });

    readable.pipe(gunzip).pipe(extractor);
  });
}

function extractDataFromJson(json: Record<string, unknown>): RemnashopBackupData {
  // Handle both formats:
  // 1. { metadata: {...}, data: { users: [...], subscriptions: [...], ... } }
  // 2. { users: [...], subscriptions: [...] }
  const data = (json.data ?? json) as Record<string, unknown>;

  const users = (data.users ?? []) as RemnashopUser[];
  const subscriptions = (data.subscriptions ?? []) as RemnashopSubscription[];

  if (!Array.isArray(users) || users.length === 0) {
    throw new BadRequestException('No user records found in the backup data');
  }

  return { users, subscriptions };
}
