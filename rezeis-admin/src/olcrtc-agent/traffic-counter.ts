import { readFile } from 'node:fs/promises';

export interface TrafficCounterSnapshot {
  readonly rxBytes: bigint;
  readonly txBytes: bigint;
}

export async function readTrafficCounterSnapshot(filePath: string): Promise<TrafficCounterSnapshot> {
  return parseTrafficCounterSnapshot(await readFile(filePath, 'utf8'));
}

export function parseTrafficCounterSnapshot(raw: string): TrafficCounterSnapshot {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error('traffic counter snapshot must be a JSON object');
  return {
    rxBytes: parseByteCounter(parsed.rxBytes, 'rxBytes'),
    txBytes: parseByteCounter(parsed.txBytes, 'txBytes'),
  };
}

export function isMissingTrafficCounterFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function parseByteCounter(value: unknown, name: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${name} must be a string or number`);
  const normalized = String(value);
  if (!/^\d+$/u.test(normalized)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
