import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INTERNAL_SIGNATURE_WINDOW_MS,
  buildInternalSignature,
  verifyInternalSignature,
} from '../src/common/http/internal-signature.util';

/**
 * Known-answer vector. The identical vector is pinned in
 * `reiwa/test/internal-hmac.test.ts`, because the two implementations must agree
 * byte-for-byte: reiwa signs, this service verifies, and a silent divergence
 * would either reject every internal call (strict mode) or reduce the check to
 * noise in the log (soft mode).
 */
const VECTOR = {
  secret: 'known-answer-secret',
  method: 'POST',
  path: '/api/internal/advertising/click',
  body: '{"code":"ABC123"}',
  timestamp: '1700000000000',
  signature: 'a0bf2b2aa02d53db176c8274b6fe4c7646c57521c5fa4b79be10da1744dadcb6',
};

describe('internal request signature', () => {
  it('reproduces the pinned known-answer vector', () => {
    assert.equal(
      buildInternalSignature({
        secret: VECTOR.secret,
        method: VECTOR.method,
        path: VECTOR.path,
        body: VECTOR.body,
        timestamp: VECTOR.timestamp,
      }),
      VECTOR.signature,
    );
  });

  it('accepts a correctly signed request', () => {
    const now = Number(VECTOR.timestamp);
    assert.deepEqual(
      verifyInternalSignature({ ...VECTOR, nowMs: now }),
      { valid: true },
    );
  });

  it('rejects a tampered body', () => {
    const now = Number(VECTOR.timestamp);
    const result = verifyInternalSignature({ ...VECTOR, body: '{"code":"HACKED"}', nowMs: now });
    assert.deepEqual(result, { valid: false, reason: 'mismatch' });
  });

  it('rejects a different path or method under the same signature', () => {
    const now = Number(VECTOR.timestamp);
    // Without the method and path in the canonical message, a signature captured
    // from a harmless GET could be replayed onto a writing POST.
    assert.equal(
      verifyInternalSignature({ ...VECTOR, path: '/api/internal/web-auth/register', nowMs: now })
        .reason,
      'mismatch',
    );
    assert.equal(verifyInternalSignature({ ...VECTOR, method: 'GET', nowMs: now }).reason, 'mismatch');
  });

  it('rejects a stale timestamp in both directions', () => {
    const ts = Number(VECTOR.timestamp);
    assert.equal(
      verifyInternalSignature({ ...VECTOR, nowMs: ts + INTERNAL_SIGNATURE_WINDOW_MS + 1000 }).reason,
      'stale',
    );
    // A far-future timestamp would otherwise buy an attacker a longer replay window.
    assert.equal(
      verifyInternalSignature({ ...VECTOR, nowMs: ts - INTERNAL_SIGNATURE_WINDOW_MS - 1000 }).reason,
      'stale',
    );
  });

  it('reports a missing signature separately from a wrong one', () => {
    // The distinction is the whole point of the soft rollout mode: "nobody signs
    // yet" is a deployment problem, "the digest is wrong" is a security one.
    assert.equal(
      verifyInternalSignature({ ...VECTOR, signature: undefined }).reason,
      'missing_headers',
    );
    assert.equal(
      verifyInternalSignature({ ...VECTOR, timestamp: undefined }).reason,
      'missing_headers',
    );
    assert.equal(verifyInternalSignature({ ...VECTOR, secret: '' }).reason, 'missing_headers');
  });

  it('rejects a malformed signature without throwing', () => {
    const now = Number(VECTOR.timestamp);
    assert.equal(
      verifyInternalSignature({ ...VECTOR, signature: 'not-hex-at-all', nowMs: now }).reason,
      'malformed_signature',
    );
    assert.equal(
      verifyInternalSignature({ ...VECTOR, timestamp: 'yesterday' }).reason,
      'malformed_timestamp',
    );
  });

  // Most internal GETs carry the identity in the query, and reiwa signs the path
  // together with it. Every vector here used to be query-free, which is exactly
  // why a guard that stripped the query looked correct.
  it('treats the query string as part of the signed path', () => {
    const path = '/api/internal/user/session?telegramId=42';
    const timestamp = '1700000000000';
    const withQuery = buildInternalSignature({
      secret: VECTOR.secret,
      method: 'GET',
      path,
      body: '',
      timestamp,
    });
    const withoutQuery = buildInternalSignature({
      secret: VECTOR.secret,
      method: 'GET',
      path: '/api/internal/user/session',
      body: '',
      timestamp,
    });
    assert.notEqual(withQuery, withoutQuery, 'the query must change the digest');
    assert.deepEqual(
      verifyInternalSignature({
        secret: VECTOR.secret,
        method: 'GET',
        path,
        body: '',
        timestamp,
        signature: withQuery,
        nowMs: Number(timestamp),
      }),
      { valid: true },
    );
  });

  it('signs an empty body deterministically (GET requests carry none)', () => {
    const signature = buildInternalSignature({
      secret: VECTOR.secret,
      method: 'GET',
      path: '/api/internal/user/123/advertising/stats',
      body: '',
      timestamp: VECTOR.timestamp,
    });
    assert.match(signature, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      verifyInternalSignature({
        secret: VECTOR.secret,
        method: 'GET',
        path: '/api/internal/user/123/advertising/stats',
        body: '',
        timestamp: VECTOR.timestamp,
        signature,
        nowMs: Number(VECTOR.timestamp),
      }),
      { valid: true },
    );
  });
});
