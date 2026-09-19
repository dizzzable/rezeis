import {
  describeGatewayDataStatement,
  type DescribedGatewayDataWrite,
} from '../../src/modules/payments/utils/transaction-gateway-data.util';

/**
 * Lets a Prisma test double take the payments module's `gatewayData` writes.
 *
 * Those writes are one SQL statement each (`writeTransactionGatewayData`), so a
 * double sees `$executeRaw` where it used to see `transaction.update`. This
 * turns the statement back into the `update` / `updateMany` arguments the
 * double already understands — with `gatewayData` merged onto what the double
 * holds for the row, the way PostgreSQL merges it — so a spec keeps asserting
 * on the same shapes it did.
 */
export interface GatewayDataUpdateArgs {
  readonly where: { readonly id: string; readonly status?: string };
  readonly data: Record<string, unknown> & { readonly gatewayData: Record<string, unknown> };
}

/** The write a raw statement performs; throws on any statement that is not one of ours. */
export function gatewayDataWriteOf(statement: unknown): DescribedGatewayDataWrite {
  const write = describeGatewayDataStatement(statement);
  if (write === undefined) {
    throw new Error('this double only runs writeTransactionGatewayData statements');
  }
  return write;
}

/** `update` arguments equivalent to `write` on a row that holds `currentGatewayData`. */
export function gatewayDataUpdateArgs(
  write: DescribedGatewayDataWrite,
  currentGatewayData: unknown,
): GatewayDataUpdateArgs {
  const held: Record<string, unknown> =
    typeof currentGatewayData === 'object' && currentGatewayData !== null && !Array.isArray(currentGatewayData)
      ? { ...(currentGatewayData as Record<string, unknown>) }
      : {};
  for (const key of write.remove ?? []) delete held[key];
  // Through JSON, as the statement's parameter goes: `undefined` keys drop out.
  const merged = { ...held, ...(JSON.parse(JSON.stringify(write.merge)) as Record<string, unknown>) };
  return {
    where: {
      id: write.transactionId,
      ...(write.onlyIfStatus !== undefined ? { status: write.onlyIfStatus } : {}),
    },
    data: {
      ...(write.status !== undefined ? { status: write.status } : {}),
      ...(write.gatewayId !== undefined ? { gatewayId: write.gatewayId } : {}),
      gatewayData: merged,
    },
  };
}

/**
 * A `$executeRaw` for a double: runs each of our statements through the
 * double's own `update` (or `updateMany`, for a claim), on top of what
 * `currentGatewayData` says the row holds. Returns the rows written.
 */
export function executeGatewayDataWrites(options: {
  readonly currentGatewayData: (transactionId: string) => unknown;
  readonly update: (args: GatewayDataUpdateArgs) => Promise<unknown>;
  readonly updateMany?: (args: GatewayDataUpdateArgs) => Promise<{ count: number }>;
}): (statement: unknown) => Promise<number> {
  return async (statement: unknown) => {
    const write = gatewayDataWriteOf(statement);
    const args = gatewayDataUpdateArgs(write, options.currentGatewayData(write.transactionId));
    if (write.onlyIfStatus !== undefined) {
      if (options.updateMany === undefined) throw new Error('this double has no updateMany for a claim');
      return (await options.updateMany(args)).count;
    }
    await options.update(args);
    return 1;
  };
}
