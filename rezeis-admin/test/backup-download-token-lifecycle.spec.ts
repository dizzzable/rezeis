import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';

import { UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';

import { InternalBackupDownloadController } from '../src/modules/backup/controllers/internal-backup-download.controller';
import {
  backupDownloadTokenFingerprint,
  signBackupDownloadToken,
  verifyBackupDownloadToken,
} from '../src/modules/backup/utils/backup-download-token.util';

/**
 * Sound crypto, weak lifecycle
 * ────────────────────────────
 * The token is HMAC-SHA256 over `recordId.exp`, base64url, ten-minute TTL,
 * constant-time verify, bound to one record. All correct. What was missing:
 *
 *   * it was NOT single use, and the route it opens lives on
 *     `/api/internal/...` — a prefix the admin IP allowlist deliberately does
 *     not cover and every shipped proxy example forwards to the internet. So
 *     anyone who obtained the URL within ten minutes — from a proxy access
 *     log, the bot's own log, an error report quoting the request — downloaded
 *     the whole database. Now the first redemption spends it.
 *   * the HMAC used the RAW master key, where every other cipher in this tree
 *     derives with a domain separator.
 *
 * Binding the token to an admin is not possible and is not attempted: the
 * consumer is the reiwa bot, which holds no admin identity.
 */

const SECRET = 'crypt-key-fixture';

let previousKey: string | undefined;

before(() => {
  previousKey = process.env.REZEIS_CRYPT_KEY;
  process.env.REZEIS_CRYPT_KEY = SECRET;
});

after(() => {
  if (previousKey === undefined) delete process.env.REZEIS_CRYPT_KEY;
  else process.env.REZEIS_CRYPT_KEY = previousKey;
});

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** How the token used to be signed: the master key, used raw as the HMAC key. */
function signWithRawMasterKey(recordId: string, secret: string, ttlMs = 60_000): string {
  const payload = `${recordId}.${Date.now() + ttlMs}`;
  const mac = base64url(createHmac('sha256', secret).update(payload).digest());
  return base64url(`${payload}.${mac}`);
}

interface CacheCall {
  readonly key: string;
  readonly ttlSeconds: number;
}

function buildController(options: {
  readonly claim: (key: string) => boolean;
  readonly fileFound?: boolean;
}): { controller: InternalBackupDownloadController; claims: CacheCall[] } {
  const claims: CacheCall[] = [];
  const backupService = {
    resolveBackupFileForDownload: async () =>
      options.fileFound === false
        ? null
        : { fullPath: __filename, filename: 'rezeis-db.sql.gz' },
  };
  const rawCacheService = {
    claimOnce: async (key: string, ttlSeconds: number) => {
      claims.push({ key, ttlSeconds });
      return options.claim(key);
    },
  };
  return {
    controller: new InternalBackupDownloadController(
      backupService as never,
      rawCacheService as never,
    ),
    claims,
  };
}

/**
 * A real writable, because the controller pipes into it. A plain object would
 * throw inside `Readable.pipe` and turn every assertion below into a test of
 * the stub instead of the route.
 */
function fakeResponse(): Response {
  const sink = new PassThrough();
  sink.resume();
  (sink as unknown as { setHeader: (key: string, value: string) => void }).setHeader = () => undefined;
  return sink as unknown as Response;
}

describe('backup download token — the key is domain-separated', () => {
  it('still round-trips a token it minted itself', () => {
    const token = signBackupDownloadToken('rec-1', SECRET, 60_000);
    assert.equal(verifyBackupDownloadToken(token, SECRET), 'rec-1');
  });

  it('rejects a token signed with the RAW master key', () => {
    // The old construction. Rejecting it is the observable proof that the key
    // is derived now, and it is safe to reject: tokens live ten minutes and
    // nothing outside this process ever computes the signature.
    const legacy = signWithRawMasterKey('rec-1', SECRET);
    assert.equal(verifyBackupDownloadToken(legacy, SECRET), null);
  });

  it('derives with the same separator style as every other cipher here', () => {
    const derived = createHash('sha256').update(`rezeis-admin:backup-download:${SECRET}`).digest();
    const payloadPrefix = 'rec-1.';
    const token = signBackupDownloadToken('rec-1', SECRET, 60_000);
    const decoded = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    assert.ok(decoded.startsWith(payloadPrefix));
    const lastDot = decoded.lastIndexOf('.');
    const payload = decoded.slice(0, lastDot);
    const signature = decoded.slice(lastDot + 1);
    assert.equal(signature, base64url(createHmac('sha256', derived).update(payload).digest()));
  });

  it('fingerprints a token instead of exposing it as a cache key', () => {
    const token = signBackupDownloadToken('rec-1', SECRET, 60_000);
    const fingerprint = backupDownloadTokenFingerprint(token);
    assert.match(fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(!fingerprint.includes(token), 'the bearer credential must not appear in a Redis key');
    assert.equal(fingerprint, backupDownloadTokenFingerprint(token), 'must be stable');
  });

  it('gives different tokens different fingerprints', () => {
    // The property the single-use claim rests on, and the one nothing used to
    // check. "Stable" above is `f(x) === f(x)`: it compares the function to
    // itself and holds for `() => 'constant'` just as happily. Under that
    // implementation every download token in the deployment shares ONE Redis
    // claim key — the first redemption ever burns it, and every backup
    // delivered to Telegram after that answers 401 "already been used", for
    // the life of the key. The bot retries three times with freshly-minted
    // tokens and all three fail identically.
    const forOneRecord = signBackupDownloadToken('rec-1', SECRET, 60_000);
    const forAnother = signBackupDownloadToken('rec-2', SECRET, 60_000);
    // The retry case: the SAME record, minted again. `backup.deliver-telegram`
    // does exactly this on `attempts: 3`, so these two must not collide either.
    const sameRecordAgain = signBackupDownloadToken('rec-1', SECRET, 61_000);

    assert.notEqual(forOneRecord, forAnother, 'the fixture minted one token, not two');
    assert.notEqual(forOneRecord, sameRecordAgain, 'the fixture minted one token, not two');

    const fingerprints = new Set([
      backupDownloadTokenFingerprint(forOneRecord),
      backupDownloadTokenFingerprint(forAnother),
      backupDownloadTokenFingerprint(sameRecordAgain),
    ]);
    assert.equal(
      fingerprints.size,
      3,
      'two distinct tokens fingerprint to the same string, so they share a ' +
        'Redis claim key and spending one spends the other',
    );
  });

  it('is the SHA-256 of the token itself', () => {
    // Computed independently rather than by calling the function again, which
    // is what made the assertion above vacuous for so long.
    const token = signBackupDownloadToken('rec-1', SECRET, 60_000);
    assert.equal(
      backupDownloadTokenFingerprint(token),
      createHash('sha256').update(token).digest('hex'),
      'the fingerprint is no longer derived from the token it names',
    );
  });
});

describe('internal backup download — a token is spent by its first use', () => {
  it('serves the file once', async () => {
    const { controller, claims } = buildController({ claim: () => true });
    const token = signBackupDownloadToken('rec-1', SECRET, 60_000);

    await controller.download('rec-1', token, fakeResponse());

    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.key, `backup:download-token:${backupDownloadTokenFingerprint(token)}`);
    assert.ok(
      (claims[0]?.ttlSeconds ?? 0) >= 600,
      'the spent-marker must outlive the token, or the token becomes replayable again',
    );
  });

  it('refuses the second use of the same URL', async () => {
    const token = signBackupDownloadToken('rec-1', SECRET, 60_000);
    const seen = new Set<string>();
    const { controller } = buildController({
      claim: (key) => {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    });

    await controller.download('rec-1', token, fakeResponse());
    await assert.rejects(
      () => controller.download('rec-1', token, fakeResponse()),
      (err: unknown) => {
        assert.ok(err instanceof UnauthorizedException, `expected 401, got ${String(err)}`);
        assert.match(err.message, /already been used/i);
        return true;
      },
    );
  });

  it('fails closed when the cache cannot answer', async () => {
    // `claimOnce` returns false when Redis is unavailable. Without Redis there
    // is no BullMQ either, so nothing legitimate is minting these tokens.
    const { controller } = buildController({ claim: () => false });
    const token = signBackupDownloadToken('rec-1', SECRET, 60_000);

    await assert.rejects(
      () => controller.download('rec-1', token, fakeResponse()),
      (err: unknown) => err instanceof UnauthorizedException,
    );
  });

  it('spends only the token that was used, not every token in the deployment', async () => {
    // The operational consequence of a fingerprint that does not depend on its
    // input, asserted where an operator would feel it: two backups, two
    // tokens, two deliveries. If both tokens map to one claim key the second
    // download answers 401 and the backup never reaches Telegram.
    const seen = new Set<string>();
    const { controller, claims } = buildController({
      claim: (key) => {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    });
    const first = signBackupDownloadToken('rec-1', SECRET, 60_000);
    const second = signBackupDownloadToken('rec-2', SECRET, 60_000);

    await controller.download('rec-1', first, fakeResponse());
    await controller.download('rec-2', second, fakeResponse());

    assert.equal(claims.length, 2, 'one of the two downloads never reached the claim');
    assert.notEqual(
      claims[0]?.key,
      claims[1]?.key,
      'two different tokens claimed the SAME Redis key — the first redemption ' +
        'in the deployment spends every token that will ever be minted',
    );
  });

  it('does not spend a token that failed its signature check', async () => {
    // Otherwise an unauthenticated caller could burn a token it never held,
    // simply by guessing record ids.
    const { controller, claims } = buildController({ claim: () => true });
    const forged = signBackupDownloadToken('rec-1', 'a-different-key', 60_000);

    await assert.rejects(
      () => controller.download('rec-1', forged, fakeResponse()),
      (err: unknown) => err instanceof UnauthorizedException,
    );
    assert.deepEqual(claims, [], 'the claim must come after the signature check');
  });

  it('does not spend a token when the record id does not match', async () => {
    const { controller, claims } = buildController({ claim: () => true });
    const token = signBackupDownloadToken('rec-1', SECRET, 60_000);

    await assert.rejects(
      () => controller.download('rec-2', token, fakeResponse()),
      (err: unknown) => err instanceof UnauthorizedException,
    );
    assert.deepEqual(claims, []);
  });
});
