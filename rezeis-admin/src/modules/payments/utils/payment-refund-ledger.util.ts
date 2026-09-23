/**
 * The refund bookkeeping stored on a transaction's `gatewayData`.
 *
 * TWO writers maintain these keys: the operator-initiated refund in
 * `PaymentRefundService`, and the `refund.succeeded` webhook in
 * `PaymentReconciliationService`. They are the same refund seen from two sides,
 * so they MUST agree on how much has been given back — the total is what
 * decides whether a refund is partial (side-effects left intact) or full
 * (partner commission debited, tax income cancelled, subscription revoked).
 *
 * The readers live here, in one place, deliberately: the two paths each had
 * their own copy, only one of them deduplicated, and a 500-of-1000 refund was
 * counted twice — the customer lost the whole subscription, the partner the
 * whole commission and the tax income was cancelled on revenue we kept. One
 * copy cannot drift from itself.
 *
 * The row lock both writers take lives here for the same reason
 * (see {@link lockTransactionRefundLedger}).
 */
import { Prisma } from '@prisma/client';

/** The Prisma surface a fenced ledger write needs: the row lock, and the row. */
type RefundLedgerLockClient = Pick<Prisma.TransactionClient, '$queryRaw' | 'transaction'>;

/**
 * Serializes the two refund writers on the transaction row and hands back
 * `gatewayData` as it stands INSIDE the lock. Must be called from an
 * interactive `$transaction`; the lock is held until that transaction commits.
 *
 * Both writers do a read-modify-write on `refundedAmountTotal` and `refunds`,
 * and both used to merge onto a snapshot loaded outside any fence — the panel
 * re-read the row but wrote with a bare `update`, and the webhook path reused
 * the snapshot `findTransactionForEvent` had loaded at the top of
 * reconciliation. A genuine interleave (a panel refund for refund-2 concurrent
 * with the `refund.succeeded` webhook for refund-1) therefore lost whichever
 * write committed first: last-writer-wins dropped the other's ledger entry and
 * its share of the total.
 *
 * `SELECT ... FOR UPDATE` rather than an optimistic compare-and-set on the
 * previously-read `gatewayData`: it is the house pattern (`lockTrialClaimUser`
 * in `trial-claim-ledger.util.ts` does exactly this), and a CAS would have to
 * fence on the whole JSON blob — a column several unrelated code paths also
 * write (`providerStatus`, `amountMismatchAt`, `paymentMethodId`, the revocation
 * audit), so it would spin on collisions that have nothing to do with refunds.
 * The lock is cheap here specifically because the provider HTTP call is already
 * done by the time either writer reaches its critical section, and the heavy
 * reversal runs after the lock is released — so it spans a read and a write,
 * not a network round-trip.
 *
 * Reads the column through the typed client rather than returning it from the
 * raw row, so both callers get the same `Prisma.JsonValue` the rest of the
 * refund code already handles.
 */
export async function lockTransactionRefundLedger(
  client: RefundLedgerLockClient,
  transactionId: string,
): Promise<Prisma.JsonValue | null> {
  const rows = await client.$queryRaw<readonly { readonly id: string }[]>(Prisma.sql`
    SELECT "id"
    FROM "transactions"
    WHERE "id" = ${transactionId}
    FOR UPDATE
  `);
  if (rows.length !== 1) {
    throw new Error('REFUND_LEDGER_TRANSACTION_NOT_FOUND');
  }
  const locked = await client.transaction.findUnique({
    where: { id: transactionId },
    select: { gatewayData: true },
  });
  return locked?.gatewayData ?? null;
}

/**
 * Stamped under the row lock by the one run of the refund reversal
 * (`PaymentReconciliationService.reverseFulfilledPayment`) before it starts,
 * and removed by the write that ends it, which stamps `refundReversedAt`.
 *
 * `refundReversedAt` alone could not keep the reversal to one run: it is
 * written at the END of the reversal, after the lock is released, so two doors
 * into it — «Отметить возврат» and a provider's refund notice, the panel's
 * ЮKassa refund and its own `refund.succeeded`, two notices — each found it
 * unset and each ran the whole reversal: the partner debit and the subscription
 * revocation twice (the second one overwriting the revoked subscription's
 * original expiry, the one breadcrumb for undoing a mistaken refund), two
 * refund events, and the provider's status written back to an older word.
 */
export const REFUND_REVERSAL_CLAIMED_AT_KEY = 'refundReversalClaimedAt';

/**
 * How long a reversal's claim turns every other run away. Far longer than a
 * reversal takes (its steps are database writes and one queue job) so a slow
 * one is never run twice; a claim older than this belongs to a run that died
 * before it finished, and the next door in completes it.
 */
export const REFUND_REVERSAL_CLAIM_MS = 5 * 60 * 1000;

/** Whether `gatewayData` carries a reversal claim still inside {@link REFUND_REVERSAL_CLAIM_MS}. */
export function isRefundReversalClaimHeld(gatewayData: unknown, now: number = Date.now()): boolean {
  const claimedAt = (asRecord(gatewayData) ?? {})[REFUND_REVERSAL_CLAIMED_AT_KEY];
  const claimedMs = typeof claimedAt === 'string' ? Date.parse(claimedAt) : Number.NaN;
  return Number.isFinite(claimedMs) && now - claimedMs < REFUND_REVERSAL_CLAIM_MS;
}

/** One issued refund, keyed by the provider's own refund id. */
export interface RefundLedgerEntry {
  readonly refundId: string;
  readonly amount: string;
  readonly at: string;
}

/**
 * Refunds already recorded against a transaction, newest last. Malformed
 * entries are skipped rather than throwing — this ledger caps further refunds,
 * so a corrupt blob must degrade to "assume nothing was refunded" and let the
 * provider be the final authority, not block the operator entirely.
 *
 * Takes `unknown` because the two callers hold the same column under different
 * static types (`Prisma.JsonValue | null` vs an already-narrowed record); the
 * shape is re-checked here regardless, since it is provider-shaped JSON.
 */
export function readRefundLedger(gatewayData: unknown): RefundLedgerEntry[] {
  const record = asRecord(gatewayData) ?? {};
  const raw = record['refunds'];
  if (!Array.isArray(raw)) return [];
  const entries: RefundLedgerEntry[] = [];
  for (const item of raw) {
    const candidate = asRecord(item);
    if (candidate === null) continue;
    const refundId = candidate['refundId'];
    const amount = candidate['amount'];
    if (typeof refundId !== 'string' || refundId.length === 0) continue;
    const parsedAmount = typeof amount === 'string' ? Number(amount) : Number.NaN;
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) continue;
    entries.push({
      refundId,
      amount: amount as string,
      at: typeof candidate['at'] === 'string' ? (candidate['at'] as string) : '',
    });
  }
  return entries;
}

/**
 * Running total already refunded against a transaction, as recorded by earlier
 * refund events and by operator-initiated refunds. Shared key so both writers
 * agree on the remaining balance; unreadable/absent values count as zero.
 *
 * NOT derived from {@link readRefundLedger} alone: a refund the operator issues
 * directly in the provider's dashboard reaches us as a webhook that records the
 * total without a ledger entry, and deriving purely from the ledger would
 * forget it and hand back balance that is already gone.
 */
export function readRefundedTotal(gatewayData: unknown): number {
  const record = asRecord(gatewayData) ?? {};
  const raw = record['refundedAmountTotal'];
  const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
