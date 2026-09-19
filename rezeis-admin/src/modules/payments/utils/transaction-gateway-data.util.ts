import { Prisma, TransactionStatus } from '@prisma/client';

/**
 * The one way to write a transaction's `gatewayData`: in ONE statement, merged
 * by PostgreSQL onto whatever the row holds when the statement runs.
 *
 * `gatewayData` is written by many paths — the reconciler for every provider
 * notification, the refund ledger, the refund reversal, the expiry sweep, the
 * «Мой налог» jobs — and most of them used to build the whole object from a
 * copy read earlier (`update({ gatewayData: { ...read, ...patch } })`). The row
 * is read first and written after a provider call, a tax-service call or a
 * reversal with a dozen steps, and everything any other path wrote in between
 * was overwritten by that old copy. On PostgreSQL 17, with the real paths:
 *
 *   - the «Мой налог» cancellation erased the refund reversal's own record in
 *     19 of 20 full refunds;
 *   - a registration still waiting on the tax service erased a partial refund's
 *     ledger entry, so the refund that completed the amount was booked as
 *     partial and the payment was never reversed;
 *   - the reversal erased a receipt registered while it ran, so income stayed
 *     declared for money that had gone back, with no receipt id left to cancel.
 *
 * Here the merge is PostgreSQL's (`||`, shallow, like the spread it replaces),
 * so it applies to the row as it is at that moment. Keys given as `undefined`
 * are left as they are — JSON drops them — and a key is only taken out by
 * naming it in `remove`.
 *
 * `test/gateway-data-atomic-merge-guard.spec.ts` fails on a new read-then-write
 * of `gatewayData` anywhere in `src/**`.
 */
export interface GatewayDataWrite {
  /** Keys set on `gatewayData`, onto what the row holds when the statement runs. */
  readonly merge: Readonly<Record<string, unknown>>;
  /** Keys taken out of `gatewayData` in the same statement. */
  readonly remove?: readonly string[];
  /** The row's status, written in the same statement. */
  readonly status?: TransactionStatus;
  /** The provider payment id, written in the same statement. */
  readonly gatewayId?: string;
  /**
   * A claim: the write lands only while the row still has this status, decided
   * in the same statement as the write.
   */
  readonly onlyIfStatus?: TransactionStatus;
}

/** Anything that can run one statement: the pooled client or an interactive transaction's. */
export type GatewayDataWriter = Pick<Prisma.TransactionClient, '$executeRaw'>;

/** What a statement built here does, for a test double that has no PostgreSQL to run it. */
export interface DescribedGatewayDataWrite extends GatewayDataWrite {
  readonly transactionId: string;
}

const described = new WeakMap<Prisma.Sql, DescribedGatewayDataWrite>();

/**
 * The write a statement from {@link writeTransactionGatewayData} performs, or
 * undefined for any other statement. Test doubles apply it to the rows they
 * hold; nothing in production reads it.
 */
export function describeGatewayDataStatement(statement: unknown): DescribedGatewayDataWrite | undefined {
  return typeof statement === 'object' && statement !== null ? described.get(statement as Prisma.Sql) : undefined;
}

/**
 * Applies `write` to transaction `transactionId`. Returns the number of rows
 * written: 1, or 0 when the row is gone or the `onlyIfStatus` claim did not hold.
 */
export async function writeTransactionGatewayData(
  client: GatewayDataWriter,
  transactionId: string,
  write: GatewayDataWrite,
): Promise<number> {
  // A row with no object there — NULL, or anything that is not one — merges as
  // `{}`, as the spread it replaces did.
  const held = Prisma.sql`(CASE WHEN jsonb_typeof("gateway_data") = 'object' THEN "gateway_data" ELSE '{}'::jsonb END)`;
  const current =
    write.remove !== undefined && write.remove.length > 0
      ? Prisma.sql`(${held} - ${[...write.remove]}::text[])`
      : held;
  const assignments: Prisma.Sql[] = [
    Prisma.sql`"gateway_data" = ${current} || ${JSON.stringify(write.merge)}::jsonb`,
  ];
  if (write.status !== undefined) {
    assignments.push(Prisma.sql`"status" = ${write.status}::"TransactionStatus"`);
  }
  if (write.gatewayId !== undefined) {
    assignments.push(Prisma.sql`"gateway_id" = ${write.gatewayId}`);
  }
  assignments.push(Prisma.sql`"updated_at" = now()`);
  const conditions: Prisma.Sql[] = [Prisma.sql`"id" = ${transactionId}`];
  if (write.onlyIfStatus !== undefined) {
    conditions.push(Prisma.sql`"status" = ${write.onlyIfStatus}::"TransactionStatus"`);
  }
  const statement = Prisma.sql`UPDATE "transactions" SET ${Prisma.join(assignments, ', ')} WHERE ${Prisma.join(conditions, ' AND ')}`;
  described.set(statement, { transactionId, ...write });
  return client.$executeRaw(statement);
}
