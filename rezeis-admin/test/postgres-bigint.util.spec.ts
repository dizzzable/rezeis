import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_POSTGRES_BIGINT,
  MIN_POSTGRES_BIGINT,
  parsePostgresBigInt,
  parseTelegramId,
} from '../src/common/utils/postgres-bigint.util';

describe('postgres-bigint util', () => {
  it('pins the int8 bounds to the values Postgres actually enforces', () => {
    assert.equal(MAX_POSTGRES_BIGINT, 2n ** 63n - 1n);
    assert.equal(MIN_POSTGRES_BIGINT, -(2n ** 63n));
    assert.equal(MAX_POSTGRES_BIGINT.toString(), '9223372036854775807');
    assert.equal(MIN_POSTGRES_BIGINT.toString(), '-9223372036854775808');
  });

  it('documents the premise: BigInt does not throw on an overflowing digit string', () => {
    // The whole reason `try { BigInt(x) } catch` guards nothing. If this ever
    // starts throwing, the range checks below are no longer the only defence
    // and this file should be revisited.
    assert.equal(BigInt('99999999999999999999999999'), 99999999999999999999999999n);
  });

  describe('parseTelegramId', () => {
    it('accepts an ordinary Telegram id', () => {
      assert.equal(parseTelegramId('123456789'), 123456789n);
    });

    it('accepts exactly the largest id int8 can hold', () => {
      assert.equal(parseTelegramId('9223372036854775807'), MAX_POSTGRES_BIGINT);
    });

    it('rejects that value plus one', () => {
      assert.equal(parseTelegramId('9223372036854775808'), null);
    });

    it('rejects a digit string far past the bound', () => {
      assert.equal(parseTelegramId('99999999999999999999999999'), null);
    });

    it('rejects non-decimal input instead of throwing', () => {
      for (const input of ['', ' ', 'abc', '12a', '1.5', '1e3', ' 123', '123 ', '+123']) {
        assert.equal(parseTelegramId(input), null, `expected null for ${JSON.stringify(input)}`);
      }
    });

    it('rejects a signed id — Telegram user ids are positive and no caller can pass a sign', () => {
      assert.equal(parseTelegramId('-1'), null);
      assert.equal(parseTelegramId('-9223372036854775808'), null);
    });

    it('keeps leading zeros meaning what BigInt always made them mean', () => {
      assert.equal(parseTelegramId('0077'), 77n);
      assert.equal(parseTelegramId('0'), 0n);
    });
  });

  describe('parsePostgresBigInt', () => {
    it('accepts both bounds exactly', () => {
      assert.equal(parsePostgresBigInt('9223372036854775807'), MAX_POSTGRES_BIGINT);
      assert.equal(parsePostgresBigInt('-9223372036854775808'), MIN_POSTGRES_BIGINT);
    });

    it('rejects one past each bound', () => {
      assert.equal(parsePostgresBigInt('9223372036854775808'), null);
      assert.equal(parsePostgresBigInt('-9223372036854775809'), null);
    });

    it('accepts the negative values it accepted before this guard existed', () => {
      assert.equal(parsePostgresBigInt('-5'), -5n);
    });

    it('returns null where BigInt would have thrown a raw 500', () => {
      for (const input of ['', 'abc', '-', '--1', '1.5', '0x10']) {
        assert.equal(parsePostgresBigInt(input), null, `expected null for ${JSON.stringify(input)}`);
      }
    });
  });
});
