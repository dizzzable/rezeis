import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { EmailVerificationService } from '../src/modules/linking/email-verification.service';

/**
 * Property 14: Email Normalization Idempotence
 *
 * For any email string, the normalization function (lowercase + trim) SHALL be
 * idempotent: normalize(normalize(email)) === normalize(email).
 * The result SHALL always be lowercase with no leading/trailing whitespace.
 *
 * **Validates: Requirements 5.5**
 */
describe('Property 14: Email Normalization Idempotence', () => {
  // Instantiate the service with null dependencies since normalizeEmail is a pure function
  const service = new EmailVerificationService(null as any, null as any, null as any);

  it('normalize(normalize(email)) === normalize(email) for any email string', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (email) => {
        const once = service.normalizeEmail(email);
        const twice = service.normalizeEmail(once);
        assert.equal(
          twice,
          once,
          `Idempotence violated: normalize("${email}") = "${once}", normalize(normalize("${email}")) = "${twice}"`,
        );
      }),
      { numRuns: 1000 },
    );
  });

  it('normalized result is always lowercase', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (email) => {
        const normalized = service.normalizeEmail(email);
        assert.equal(
          normalized,
          normalized.toLowerCase(),
          `Result "${normalized}" contains uppercase characters`,
        );
      }),
      { numRuns: 1000 },
    );
  });

  it('normalized result has no leading or trailing whitespace', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (email) => {
        const normalized = service.normalizeEmail(email);
        assert.equal(
          normalized,
          normalized.trim(),
          `Result "${normalized}" has leading/trailing whitespace`,
        );
      }),
      { numRuns: 1000 },
    );
  });

  it('idempotence holds for email-like strings with whitespace and mixed case', () => {
    // Generate more realistic email-like strings with whitespace padding and mixed case
    const emailLikeArb = fc
      .tuple(
        fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 0, maxLength: 5 }),
        fc.stringOf(
          fc.constantFrom(
            ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._%+-'.split(''),
          ),
          { minLength: 1, maxLength: 30 },
        ),
        fc.constant('@'),
        fc.stringOf(
          fc.constantFrom(
            ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-'.split(''),
          ),
          { minLength: 1, maxLength: 20 },
        ),
        fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 0, maxLength: 5 }),
      )
      .map(([leadingWs, local, at, domain, trailingWs]) => `${leadingWs}${local}${at}${domain}${trailingWs}`);

    fc.assert(
      fc.property(emailLikeArb, (email) => {
        const once = service.normalizeEmail(email);
        const twice = service.normalizeEmail(once);

        // Idempotence
        assert.equal(twice, once, `Idempotence violated for email-like input "${email}"`);

        // Always lowercase
        assert.equal(once, once.toLowerCase(), `Result "${once}" is not fully lowercase`);

        // No leading/trailing whitespace
        assert.equal(once, once.trim(), `Result "${once}" has leading/trailing whitespace`);
      }),
      { numRuns: 500 },
    );
  });
});
