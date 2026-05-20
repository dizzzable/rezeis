import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeCode } from '../src/modules/promocodes/utils/code-normalizer.util';

describe('normalizeCode', () => {
  it('uppercases the code', () => {
    assert.equal(normalizeCode('summer2024'), 'SUMMER2024');
    assert.equal(normalizeCode('abc'), 'ABC');
  });

  it('trims whitespace from both ends', () => {
    assert.equal(normalizeCode('  SUMMER2024  '), 'SUMMER2024');
    assert.equal(normalizeCode('\tSUMMER2024\n'), 'SUMMER2024');
  });

  it('returns empty string for whitespace-only input', () => {
    assert.equal(normalizeCode('   '), '');
    assert.equal(normalizeCode('\t\n'), '');
  });

  it('handles mixed case: Summer2024! -> SUMMER2024!', () => {
    assert.equal(normalizeCode('Summer2024!'), 'SUMMER2024!');
  });

  it('preserves non-alphanumeric characters', () => {
    assert.equal(normalizeCode('SUMMER-2024'), 'SUMMER-2024');
    assert.equal(normalizeCode('SUMMER_2024'), 'SUMMER_2024');
    assert.equal(normalizeCode('SUMMER@2024'), 'SUMMER@2024');
    assert.equal(normalizeCode('SUMMER#2024'), 'SUMMER#2024');
  });

  it('handles empty string', () => {
    assert.equal(normalizeCode(''), '');
  });

  it('normalises repeatedly called codes consistently', () => {
    const code = '  SUMMER2024  ';
    assert.equal(normalizeCode(code), 'SUMMER2024');
    // Calling again should produce the same result
    assert.equal(normalizeCode(normalizeCode(code)), 'SUMMER2024');
  });
});