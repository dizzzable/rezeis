import assert from 'node:assert/strict';
import test from 'node:test';

import { configureBigIntJsonSerialization } from '../src/common/runtime/bigint-json';

type BigIntPrototypeWithSerializer = bigint & { readonly toJSON?: () => string };

test('configureBigIntJsonSerialization serializes bigint values as decimal strings', () => {
  configureBigIntJsonSerialization();

  const serialized = JSON.stringify({
    telegramId: 90071992547409931234n,
    nested: { messageId: 12345678901234567890n },
  });

  assert.equal(
    serialized,
    '{"telegramId":"90071992547409931234","nested":{"messageId":"12345678901234567890"}}',
  );
});

test('configureBigIntJsonSerialization is idempotent and keeps the serializer stable', () => {
  configureBigIntJsonSerialization();
  const firstSerializer = (BigInt.prototype as BigIntPrototypeWithSerializer).toJSON;

  configureBigIntJsonSerialization();
  const secondSerializer = (BigInt.prototype as BigIntPrototypeWithSerializer).toJSON;

  assert.equal(secondSerializer, firstSerializer);
  assert.equal(JSON.stringify([1n, 2n, 3n]), '["1","2","3"]');
});
