/**
 * Property 10: Verification Code Format
 *
 * *For any* email verification request, the generated code SHALL be exactly
 * 6 decimal digits (range 000000–999999).
 *
 * **Validates: Requirements 5.1**
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { EmailVerificationService } from '../src/modules/linking/email-verification.service';

// --- Helpers ---

/**
 * Access the private generateVerificationCode method via prototype.
 * This allows us to test the code generation logic directly.
 */
function callGenerateVerificationCode(service: EmailVerificationService): string {
  return (service as any).generateVerificationCode();
}

/**
 * Create a minimal EmailVerificationService instance with null dependencies.
 * We only need the code generation method which has no external dependencies.
 */
function createMinimalService(): EmailVerificationService {
  return new EmailVerificationService(
    null as any, // prisma — not needed for code generation
    null as any, // cache — not needed for code generation
    null as any, // emailService — not needed for code generation
  );
}

// --- Tests ---

describe('Property 10: Verification Code Format', () => {
  const CODE_REGEX = /^\d{6}$/;

  it('for any invocation, generateVerificationCode always produces exactly 6 decimal digits', () => {
    const service = createMinimalService();

    fc.assert(
      fc.property(fc.constant(null), () => {
        const code = callGenerateVerificationCode(service);

        // Must be exactly 6 characters long
        assert.equal(
          code.length,
          6,
          `Expected code length to be 6, got ${code.length}: "${code}"`,
        );

        // Must match the 6-digit decimal pattern
        assert.ok(
          CODE_REGEX.test(code),
          `Expected code to match /^\\d{6}$/, got: "${code}"`,
        );
      }),
      { numRuns: 1000 },
    );
  });

  it('for any invocation, generated codes are within the numeric range 000000–999999', () => {
    const service = createMinimalService();

    fc.assert(
      fc.property(fc.constant(null), () => {
        const code = callGenerateVerificationCode(service);
        const numericValue = parseInt(code, 10);

        // Must be a valid number
        assert.ok(
          !isNaN(numericValue),
          `Expected code to be a valid number, got: "${code}"`,
        );

        // Must be in range [0, 999999]
        assert.ok(
          numericValue >= 0 && numericValue <= 999999,
          `Expected numeric value in range [0, 999999], got: ${numericValue}`,
        );

        // Verify that padStart preserves the original numeric value
        assert.equal(
          numericValue.toString().padStart(6, '0'),
          code,
          `Expected code "${code}" to be the zero-padded representation of ${numericValue}`,
        );
      }),
      { numRuns: 1000 },
    );
  });

  it('for any invocation, codes contain only ASCII digit characters (0-9)', () => {
    const service = createMinimalService();

    fc.assert(
      fc.property(fc.constant(null), () => {
        const code = callGenerateVerificationCode(service);

        for (let i = 0; i < code.length; i++) {
          const charCode = code.charCodeAt(i);
          assert.ok(
            charCode >= 48 && charCode <= 57, // ASCII '0' = 48, '9' = 57
            `Expected only digit characters, found char code ${charCode} ("${code[i]}") at position ${i} in "${code}"`,
          );
        }
      }),
      { numRuns: 1000 },
    );
  });
});
