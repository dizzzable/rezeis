import { createHash, timingSafeEqual } from 'node:crypto';

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isApiTokenHashMatch(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}
