type BigIntPrototypeWithJson = typeof BigInt.prototype & {
  toJSON?: () => string;
};

function serializeBigInt(this: bigint): string {
  return this.toString();
}

export function configureBigIntJsonSerialization(): void {
  const prototype = BigInt.prototype as BigIntPrototypeWithJson;
  if (prototype.toJSON !== undefined) return;

  Object.defineProperty(prototype, 'toJSON', {
    configurable: true,
    value: serializeBigInt,
    writable: true,
  });
}
