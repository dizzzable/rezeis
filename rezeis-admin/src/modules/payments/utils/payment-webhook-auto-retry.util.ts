import { PaymentWebhookLifecycleStatus, Prisma } from '@prisma/client';

/**
 * When a FAILED payment inbox event is run again by itself
 * (`PaymentAutoRetryService`), and when that stops.
 *
 * A ladder of waits: after the n-th run failed, the next is due `delaysMs[n-1]`
 * after that failure; an event that never ran (its enqueue failed) is due at
 * once. `delaysMs.length + 1` runs in all; after the last one the event waits
 * for «Платежи» → «Вебхуки» → «Повторить».
 */
export interface AutoRetryLadder {
  readonly delaysMs: readonly number[];
  /**
   * A FAILED event whose last failure is older than this is not picked up any
   * more — longer than the longest wait, so it never cuts a ladder short; it
   * only keeps an old failure, from before a ladder was lengthened or from
   * while the panel was down, from being run again out of the blue.
   */
  readonly staleAfterMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Every event but a dispute: two retries, at 5 and 15 minutes — the ladder the
 * panel always had. What fails here fails inside the panel (a database error,
 * a fulfilment that threw), or is a ЮKassa completion whose check could not
 * reach ЮKassa, which the expiry sweep polls again by itself
 * (`PaymentPendingExpiryService`); a longer ladder would run the same failing
 * code for days.
 */
export const ORDINARY_RETRY_LADDER: AutoRetryLadder = {
  delaysMs: [5 * MINUTE, 15 * MINUTE],
  staleAfterMs: 2 * HOUR,
};

/**
 * A Platega dispute (chargeback) of an autopay charge
 * (`ProviderSubscriptionService.recordDispute`). Its handling starts by asking
 * Platega for the subscription, so it fails for as long as Platega's API is
 * down — and a chargeback must not wait for a person to press «Повторить»:
 * until it runs, the commission and the cashback stand and the autopay goes
 * on. Ten retries over about three days: often at first, then twice a day,
 * then daily.
 */
export const DISPUTE_RETRY_LADDER: AutoRetryLadder = {
  delaysMs: [
    5 * MINUTE,
    15 * MINUTE,
    30 * MINUTE,
    1 * HOUR,
    2 * HOUR,
    4 * HOUR,
    8 * HOUR,
    12 * HOUR,
    24 * HOUR,
    24 * HOUR,
  ],
  staleAfterMs: 48 * HOUR,
};

/**
 * What marks a dispute's inbox event: its key
 * (`subscription:<id>:dispute-callback:<charge>`). The key and not the payload,
 * so the database can tell the two ladders apart: a JSON path that is absent
 * compares as NULL, and `NOT` of that would lose every other event.
 */
export const DISPUTE_EVENT_KEY_MARKER = ':dispute-callback:';

/** Whether an inbox event is a dispute, by its key ({@link DISPUTE_EVENT_KEY_MARKER}). */
export function isDisputeEventKey(providerEventId: string | null | undefined): boolean {
  return typeof providerEventId === 'string' && providerEventId.includes(DISPUTE_EVENT_KEY_MARKER);
}

/** The ladder an event climbs. */
export function autoRetryLadderFor(event: { readonly providerEventId?: string | null }): AutoRetryLadder {
  return isDisputeEventKey(event.providerEventId) ? DISPUTE_RETRY_LADDER : ORDINARY_RETRY_LADDER;
}

/** How many runs in all an event on this ladder gets by itself. */
export function autoRetryRuns(ladder: AutoRetryLadder): number {
  return ladder.delaysMs.length + 1;
}

/**
 * Whether an event that has had `runs` runs gets no further automatic one:
 * the next failure is the last, and «Повторить» is the way on.
 */
export function autoRetryExhausted(
  event: { readonly providerEventId?: string | null },
  runs: number,
): boolean {
  return runs >= autoRetryRuns(autoRetryLadderFor(event));
}

/** How long after its last failure an event that has had `runs` runs is due again. */
export function autoRetryDelayMs(ladder: AutoRetryLadder, runs: number): number {
  if (runs <= 0) return 0;
  return ladder.delaysMs[runs - 1] ?? Number.POSITIVE_INFINITY;
}

/**
 * The FAILED events due for their next automatic run at `now`: on each ladder,
 * at each count of runs it allows, failed at least that step's wait ago and
 * not longer ago than the ladder's staleness.
 */
export function dueForAutoRetryWhere(now: Date): Prisma.PaymentWebhookEventWhereInput {
  const steps = (
    ladder: AutoRetryLadder,
    kind: Prisma.PaymentWebhookEventWhereInput,
  ): Prisma.PaymentWebhookEventWhereInput[] =>
    Array.from({ length: autoRetryRuns(ladder) }, (_, runs) => ({
      AND: [
        kind,
        {
          reconciliationAttempts: runs,
          lastTransitionAt: {
            lte: new Date(now.getTime() - autoRetryDelayMs(ladder, runs)),
            gte: new Date(now.getTime() - ladder.staleAfterMs),
          },
        },
      ],
    }));
  const dispute: Prisma.PaymentWebhookEventWhereInput = { providerEventId: { contains: DISPUTE_EVENT_KEY_MARKER } };
  return {
    status: PaymentWebhookLifecycleStatus.FAILED,
    OR: [
      ...steps(ORDINARY_RETRY_LADDER, { NOT: dispute }),
      ...steps(DISPUTE_RETRY_LADDER, dispute),
    ],
  };
}
