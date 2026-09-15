import { Prisma } from '@prisma/client';

import { readJsonObject } from '../../../common/utils/read-json-object.util';
import { displayPlanName } from '../../plans/utils/plan-deletion.util';

/**
 * A RENEWAL PAID AFTER ITS SUBSCRIPTION WAS MOVED TO ANOTHER PLAN
 * ═══════════════════════════════════════════════════════════════
 *
 * Before a plan is deleted, its subscriptions are moved to other plans (plan
 * migration runs, `plan_migration_items`). A renewal checkout can be open while
 * that happens: priced before the move and paid after it, or cancelled by the
 * expiry sweep and revived by a late success webhook, which reaches the very
 * same fulfilment. It was priced for the old plan — or, when the old plan was
 * archived, for the replacement it renews onto or for the plan the subscriber
 * chose. Fulfilled as usual, it re-applies that plan's snapshot, limits and
 * squads and silently undoes the move: the subscription lands back on a plan
 * about to be deleted (it then needs a plan choice at its next renewal, and
 * autopay stops), or on a plan the operator did not move it to.
 *
 * Owner decision (15.09.2026, decision 10): the payment still buys its period,
 * but on the plan the subscription is on NOW, and the operator is told. The
 * payment row and its items are never rewritten — their snapshots are verified
 * strictly, and editing them strands money already taken. The one thing the
 * kept renewal writes into the subscription's snapshot is the duration it paid
 * for; see {@link withPaidRenewalDuration}.
 *
 * Upgrades are NOT guarded: a paid plan change wins. Only the two RENEW paths
 * of `PaymentSubscriptionMutationService` ask this module.
 */

/** Machine code on the completion event of a renewal kept on the current plan. */
export const LATE_PLAN_MIGRATION_RENEWAL_CODE = 'RENEWAL_AFTER_PLAN_MIGRATION';

/**
 * What the event feed and the admin push show for that completion. Russian, as
 * the blocked-purchaser completion is: it is operator text. A customer never
 * sees it — the e-mail bridge renders a template's own title, never the message.
 */
export const LATE_PLAN_MIGRATION_RENEWAL_MESSAGE =
  'Продление оплачено после переноса подписки на другой тариф';

/** A renewal line fulfilment keeps on the subscription's current plan. */
export interface LatePlanMigrationRenewal {
  readonly subscriptionId: string;
  /**
   * The plan the payment was priced and charged for: the plan the move left, or
   * the replacement or chosen plan a renewal on it was priced for.
   */
  readonly paidPlanId: string;
  readonly paidPlanName: string;
  /** The plan the subscription's snapshot names now; the renewal keeps it. */
  readonly currentPlanId: string;
  /** The snapshot's `name`, or `null` when it carries none. */
  readonly currentPlanName: string | null;
  /** The run whose move caught this payment. */
  readonly planMigrationRunId: string;
}

/**
 * The plan a renewal might have to keep, or `null` when no plan migration can
 * change what this renewal does.
 *
 * A move writes the target plan's id into the snapshot in the same transaction
 * that marks its item MOVED. So a subscription whose snapshot still names the
 * paid plan — as `id`, or as the importers' `planId`, the two spellings the
 * plan delete guard counts — is on that plan now: re-applying it cannot take
 * the subscription off its current plan, and there is nothing to tell the
 * operator. A snapshot that names no plan has no current plan to keep.
 *
 * It is also what keeps the lookup off the hot path: nearly every renewal is
 * for the plan its subscription is on.
 */
export function resolvePlanMigrationGuardCandidate(
  planSnapshot: unknown,
  paidPlanId: string,
): string | null {
  const snapshot = readJsonObject(planSnapshot);
  const id = readNonEmptyString(snapshot['id']);
  const importedPlanId = readNonEmptyString(snapshot['planId']);
  if (id === paidPlanId || importedPlanId === paidPlanId) {
    return null;
  }
  return id ?? importedPlanId;
}

/**
 * Was this subscription moved by a plan migration after the checkout priced it?
 *
 * MUST run after the caller has locked the subscription row `FOR UPDATE`, and
 * as its own statement. A move takes the same row lock and writes the MOVED
 * item and the new snapshot in one transaction, so under the lock either both
 * are visible or neither can commit before this fulfilment does. It cannot be
 * folded into the locking statement itself: in READ COMMITTED a locking read
 * that waited for a concurrent move re-reads only the locked row, while a
 * subquery over `plan_migration_items` keeps the snapshot taken before the wait
 * — and would miss exactly the move it waited for.
 *
 * ── Any move of THIS subscription, NOT a move off the paid plan ─────────────
 *
 * The paid plan is not always the plan the subscription was on when the
 * checkout priced it. For an archived plan set to renew onto a replacement, the
 * renewal quote prices that replacement (`SubscriptionRenewalService`'s
 * `pickTargetPlan`), or, when none is on sale, the plan the subscriber chose.
 * Matching the move's `from_plan_id` against the paid plan missed both: a
 * subscription moved from P to Q, a checkout priced before the move for P's
 * replacement R completed, and fulfilment applied R's snapshot, limits and
 * squads — the operator's move undone, and nobody told. So the question is
 * only whether a move of this subscription committed after (or just before,
 * see below) the payment was created. That the paid plan is not the plan the
 * subscription is on now, {@link resolvePlanMigrationGuardCandidate} has
 * already settled.
 *
 * ── `moved_at >= payment.created_at - 10 minutes`, NOT `>= created_at` ─────
 *
 * The payment row's own `created_at` is read in SQL — a revived checkout keeps
 * the instant its checkout was created — but it is not the instant the checkout
 * saw the plan, for two reasons:
 *
 *   * THE READ→INSERT GAP. Checkout reads the subscription WITHOUT a lock to
 *     price the renewal (`SubscriptionRenewalService.quoteSubscriptionRenewal`,
 *     `SubscriptionQuoteService.getQuote`) and inserts the draft a few queries
 *     later (`PaymentsRenewalCheckoutService.createCombinedDraft`; the single
 *     renewal's `PaymentsTransactionsService`). A move committing in between
 *     leaves a payment for the old plan whose `created_at` is AFTER `moved_at`,
 *     and a strict comparison would put the subscription back on that plan,
 *     silently.
 *   * TWO CLOCKS. `created_at` is stamped by the application — Prisma fills
 *     `@default(now())` on the client — while the move stamps `moved_at` with
 *     PostgreSQL's `clock_timestamp()`. Skew between the two moves the boundary
 *     either way.
 *
 * The window rarely catches a renewal priced AFTER the move. After a move the
 * renewal quote prices the plan the snapshot names NOW, and that renewal is not
 * guarded at all: it is for the current plan. Only when the subscription was
 * moved onto an archived plan set to renew onto a replacement does the quote
 * price another one — that replacement, or the subscriber's choice — and only
 * such a renewal created within ten minutes of the move is kept too. That
 * costs the harmless direction: the period is kept on the plan the operator
 * chose, and the operator is told.
 *
 * `null` when no such move exists — including when the snapshot still names
 * the paid plan or names none, in which case nothing is queried at all.
 */
export async function findLatePlanMigrationRenewal(
  tx: Prisma.TransactionClient,
  input: {
    readonly subscription: { readonly id: string; readonly planSnapshot: unknown };
    readonly paidPlan: { readonly id: string; readonly name: string; readonly deletedAt?: Date | null };
    readonly transactionId: string;
  },
): Promise<LatePlanMigrationRenewal | null> {
  const currentPlanId = resolvePlanMigrationGuardCandidate(
    input.subscription.planSnapshot,
    input.paidPlan.id,
  );
  if (currentPlanId === null) {
    return null;
  }
  const rows = await tx.$queryRaw<ReadonlyArray<{ readonly planMigrationRunId: unknown }>>(Prisma.sql`
    SELECT pmi."run_id" AS "planMigrationRunId"
    FROM "plan_migration_items" AS pmi
    WHERE pmi."subscription_id" = ${input.subscription.id}
      AND pmi."status" = 'MOVED'
      AND pmi."moved_at" >= (
        SELECT t."created_at" FROM "transactions" AS t WHERE t."id" = ${input.transactionId}
      ) - INTERVAL '10 minutes'
    ORDER BY pmi."moved_at" DESC, pmi."id" DESC
    LIMIT 1
  `);
  const planMigrationRunId = rows[0]?.planMigrationRunId;
  if (typeof planMigrationRunId !== 'string') {
    return null;
  }
  return {
    subscriptionId: input.subscription.id,
    paidPlanId: input.paidPlan.id,
    paidPlanName: displayPlanName({
      id: input.paidPlan.id,
      name: input.paidPlan.name,
      deletedAt: input.paidPlan.deletedAt ?? null,
    }),
    currentPlanId,
    currentPlanName: readNonEmptyString(readJsonObject(input.subscription.planSnapshot)['name']),
    planMigrationRunId,
  };
}

/**
 * The one snapshot write a kept renewal makes: the duration it paid for, under
 * `selectedDurationDays`, exactly as a normal renewal records it
 * (`buildPlanSnapshot` / `buildItemPlanSnapshot`). Every other key stays as
 * the move wrote it.
 *
 * Not cosmetic. Autopay renews by it —
 * `SubscriptionRenewalService.quoteSubscriptionRenewal` reads
 * `selectedDurationDays` to choose the next duration — so a subscriber who paid
 * for a year before the move would otherwise be renewed next time for whatever
 * duration the snapshot held before.
 *
 * Only where a normal renewal writes it: on the column path. With a durable
 * term a normal renewal writes no snapshot now — the appended term carries the
 * duration in its own snapshot, which replaces the subscription's when the term
 * activates — and so the caller writes none either.
 */
export function withPaidRenewalDuration(
  planSnapshot: unknown,
  durationDays: number,
): Record<string, unknown> {
  return { ...readJsonObject(planSnapshot), selectedDurationDays: durationDays };
}

/**
 * The flat keys a single renewal's completion event carries. Flat, because the
 * completion's metadata is also the e-mail template's variable bag and the
 * outbound webhook's payload, and both read keys, not paths.
 */
export function latePlanMigrationRenewalMetadata(
  renewal: LatePlanMigrationRenewal,
): Record<string, string | null> {
  return {
    code: LATE_PLAN_MIGRATION_RENEWAL_CODE,
    paidPlanId: renewal.paidPlanId,
    paidPlanName: renewal.paidPlanName,
    currentPlanId: renewal.currentPlanId,
    currentPlanName: renewal.currentPlanName,
    planMigrationRunId: renewal.planMigrationRunId,
  };
}

/**
 * The card note («📝 Заметка») for a single renewal. The subscription itself is
 * already on the card's plan block, so the note names the two plans.
 *
 * It says when the payment arrived, not when its invoice was created: a draft
 * inserted a moment after the move is kept too (see
 * {@link findLatePlanMigrationRenewal}), and "created before the move" would
 * be false about it.
 */
export function describeLatePlanMigrationRenewal(renewal: LatePlanMigrationRenewal): string {
  const paid = quotePlan(renewal.paidPlanName);
  const current = quotePlan(renewal.currentPlanName ?? renewal.currentPlanId);
  return (
    `Продление тарифа ${paid} оплачено, когда подписку уже перенесли на тариф ${current}. ` +
    'Срок продлён на оплаченный период, тариф, лимиты и сквады подписки ' +
    `не менялись: она осталась на ${current}. ${RECALCULATION_HINT}`
  );
}

/** Lines of one combined renewal listed on its note; the rest are counted. */
const COMBINED_NOTE_LINE_LIMIT = 5;

/**
 * The card note for a combined renewal. That card has no subscription block —
 * the payment renews several — so every kept line names its subscription.
 */
export function describeLatePlanMigrationRenewals(
  renewals: readonly LatePlanMigrationRenewal[],
): string {
  const listed = renewals.slice(0, COMBINED_NOTE_LINE_LIMIT).map((renewal) => {
    const paid = quotePlan(renewal.paidPlanName);
    const current = quotePlan(renewal.currentPlanName ?? renewal.currentPlanId);
    return `подписка ${renewal.subscriptionId} оплачена по тарифу ${paid} и осталась на ${current}`;
  });
  const hidden = renewals.length - listed.length;
  const tail = hidden > 0 ? `; и ещё ${hidden}` : '';
  return (
    'Продление оплачено, когда часть подписок уже перенесли на другие тарифы. ' +
    'Срок продлён на оплаченный период, тарифы, лимиты и сквады этих подписок не менялись: ' +
    `${listed.join('; ')}${tail}. ${RECALCULATION_HINT}`
  );
}

const RECALCULATION_HINT = 'Если цены тарифов различаются, решите, нужен ли перерасчёт.';

function quotePlan(name: string): string {
  return `«${name}»`;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
