import { BadRequestException } from '@nestjs/common';
import { type Prisma, SubscriptionTermStatus } from '@prisma/client';

/**
 * A SUBSCRIPTION WITH NO END DATE IS NEITHER RENEWED NOR UPGRADED BY A PURCHASE
 * (the owner, 24.09.2026).
 *
 * `expiresAt = null` means "never expires" right across this product: the
 * export writes it as `unlimited`, and a reward of days
 * (`SubscriptionMutationsService.extend`) finds nothing to extend. A renewal of
 * one used to give it an end date: the paid days counted from the payment, so a
 * customer who had bought a subscription without an end paid again to be put
 * on a thirty-day clock. An upgrade did the same, since it restarts the term at
 * the payment (`UPGRADE_RESETS_EXPIRY`). Now:
 *
 *  - nothing offers either: the quote's RENEW and UPGRADE source selections
 *    answer {@link SUBSCRIPTION_IS_LIFETIME_CODE}, so the cabinet's action
 *    policy, renewal list and upgrade options read the subscription as closed
 *    to both and say why. A trial is still upgraded: that is how a trial is
 *    left, whatever its date;
 *  - every renewal and upgrade checkout refuses it before any money is asked
 *    ({@link subscriptionIsLifetime}), whichever client drafts it;
 *  - a payment that arrives anyway changes nothing and is withheld for refund
 *    (`PaymentSubscriptionMutationService`): no post-payment hook runs on it,
 *    «Платежи» shows it «Не применён» with «Отметить возврат», and the
 *    operator is told to return the money. Such a payment was drafted while
 *    the subscription still had a date, and another payment took the date away
 *    before it was paid: an UPGRADE to a plan without an end. A payment from
 *    the partner balance is refused instead, and the balance put back
 *    (`PartnerBalancePaymentService`).
 *
 * Deliberate operator actions still move the date and the plan: «Быстрые
 * действия» → «Истекает:» gives one a date like any other subscription, and
 * «Назначить план» changes its plan.
 */
export const SUBSCRIPTION_IS_LIFETIME_CODE = 'SUBSCRIPTION_IS_LIFETIME';

export function isLifetimeSubscription(subscription: { readonly expiresAt: Date | null }): boolean {
  return subscription.expiresAt === null;
}

/**
 * The refusal every renewal and upgrade checkout throws for one.
 *
 * `{ code, message }`, so the safe filter forwards the code
 * (`SAFE_PRODUCT_CODES`) and the cabinet names the reason. A 400 and not a 409
 * on purpose: a cabinet that does not know the code maps any untyped 409 to
 * QUOTE_CHANGED and sends the buyer back to a review that re-prices into the
 * same refusal, while a 400 it does not know ends in its generic "could not
 * create the payment".
 */
export function subscriptionIsLifetime(purchaseType: 'RENEW' | 'UPGRADE' = 'RENEW'): BadRequestException {
  return new BadRequestException({
    code: SUBSCRIPTION_IS_LIFETIME_CODE,
    message:
      purchaseType === 'UPGRADE'
        ? 'The subscription has no end date and its plan is not changed by a purchase.'
        : 'The subscription has no end date and is never renewed.',
  });
}

/** A queued term with no end, which the subscription's date does not reach past; see {@link findOpenEndedQueuedTerm}. */
export interface OpenEndedQueuedTerm {
  readonly termId: string;
  readonly startsAt: Date;
}

/**
 * A QUEUED PERIOD WITHOUT AN END, AND A DATE BEFORE IT (R1-08).
 *
 * A subscription with a date can still have its paid periods end in one with
 * no end: a period bought without an end waits after the current one (a
 * SCHEDULED term, `endsAt = null`), and an operator then moved the date to or
 * before that period's start. The tail alignment leaves that to a human
 * (`SCHEDULED_SUCCESSOR_BLOCKS`). A renewal has nowhere to go — after a period
 * that never ends — and an upgrade would cancel that paid period, since it
 * restarts the term at the payment. So the quote and every checkout refuse
 * both as they refuse them for a lifetime subscription, with the same code,
 * and a payment that arrives anyway is withheld like one;
 * `scheduleRenewalTermInTransaction` still fails closed if anything reaches it.
 *
 * The question a renewal's own alignment answers, asked without writing: the
 * last queued term has no end, and the date is at or before its start. A date
 * after the start is not this: the alignment ends the queued term at the date,
 * and a renewal follows it. Null for a lifetime subscription (refused as one),
 * and for a chain the term model does not hold.
 */
export async function findOpenEndedQueuedTerm(
  client: Pick<Prisma.TransactionClient, 'subscriptionTerm'>,
  subscription: { readonly id: string; readonly expiresAt: Date | null },
): Promise<OpenEndedQueuedTerm | null> {
  if (subscription.expiresAt === null) return null;
  const queued = await client.subscriptionTerm.findFirst({
    where: { subscriptionId: subscription.id, status: SubscriptionTermStatus.SCHEDULED },
    orderBy: { generation: 'desc' },
    select: { id: true, startsAt: true, endsAt: true },
  });
  if (queued === null || queued.endsAt !== null) return null;
  if (subscription.expiresAt.getTime() > queued.startsAt.getTime()) return null;
  const active = await client.subscriptionTerm.count({
    where: { subscriptionId: subscription.id, status: SubscriptionTermStatus.ACTIVE },
  });
  return active > 0 ? { termId: queued.id, startsAt: queued.startsAt } : null;
}

/**
 * Where a renewal payment that met a lifetime subscription records, in its own
 * `gatewayData`, the lines it did not apply: the provenance a refund, or an
 * operator's question, reads.
 */
export const LIFETIME_RENEWAL_NOT_APPLIED_KEY = 'lifetimeRenewalNotApplied';

/** Machine code on the completion of a combined renewal that applied some lines and not these. */
export const LIFETIME_RENEWAL_NOT_APPLIED_CODE = 'LIFETIME_RENEWAL_NOT_APPLIED';

/** Its message; operator text, as `RENEWAL_PRICED_BEFORE_UPGRADE_MESSAGE` is. */
export const LIFETIME_RENEWAL_NOT_APPLIED_MESSAGE = 'Продление бессрочной подписки не применено';

/** The message of the operator's card for a payment withheld because its subscription has no end date. */
export const LIFETIME_PAYMENT_WITHHELD_MESSAGE = 'Платёж получен, но не применён: подписка бессрочная';

/** One renewal line (or a single renewal) that met a lifetime subscription and changed nothing. */
export interface LifetimeRenewalNotApplied {
  readonly subscriptionId: string;
  readonly paidPlanName: string;
  readonly paidDays: number;
  /** What the line cost — named on a combined renewal's card, where only this part goes back. */
  readonly amount?: string;
  readonly currency?: string;
  /** Set when the subscription has a date and a queued period without an end; see {@link findOpenEndedQueuedTerm}. */
  readonly openEndedTerm?: OpenEndedQueuedTerm;
}

/** The provenance written under {@link LIFETIME_RENEWAL_NOT_APPLIED_KEY}. */
export function lifetimeRenewalNotAppliedProvenance(
  lines: readonly LifetimeRenewalNotApplied[],
  now: Date,
): Record<string, unknown> {
  return {
    recordedAt: now.toISOString(),
    subscriptionIds: lines.map((line) => line.subscriptionId),
  };
}

/**
 * What happened, for the operator's note («📝 Заметка»), in Russian: what was
 * paid for, and that nothing changed. It names the subscription because a
 * combined renewal's card has no subscription block of its own. The refund
 * sentence is the caller's: the whole payment when it was withheld, only the
 * line's part when other lines were applied.
 */
export function describeLifetimeRenewalNotApplied(line: LifetimeRenewalNotApplied): string {
  return describeNotApplied(
    `Продление тарифа «${line.paidPlanName}» ${paidTerm(line.paidDays)} оплачено для подписки ${line.subscriptionId}`,
    'продление не применено — срок, статус, лимиты и опции не менялись.',
    line.openEndedTerm,
  );
}

/**
 * The same for an upgrade withheld because its subscription has no end date,
 * with the operator's own way to another plan, which a purchase no longer is.
 */
export function describeLifetimeUpgradeNotApplied(input: {
  readonly subscriptionId: string;
  readonly paidPlanName: string;
  readonly paidDays: number;
  readonly openEndedTerm?: OpenEndedQueuedTerm;
}): string {
  return (
    describeNotApplied(
      `Смена тарифа на «${input.paidPlanName}» ${paidTerm(input.paidDays)} оплачена для подписки ${input.subscriptionId}`,
      'смена не применена — тариф, срок, статус, лимиты и опции не менялись.',
      input.openEndedTerm,
    ) + ' Сменить тариф такой подписке можно вручную: «Пользователи» → пользователь → «Быстрые действия» → «Назначить план».'
  );
}

function describeNotApplied(paid: string, unchanged: string, openEndedTerm: OpenEndedQueuedTerm | undefined): string {
  if (openEndedTerm !== undefined) {
    return (
      `${paid}, а у неё уже запланирован бессрочный период (с ${openEndedTerm.startsAt.toISOString().slice(0, 10)}), ` +
      `и дата подписки стоит не позже его начала: ${unchanged} Исправьте дату подписки или этот период.`
    );
  }
  return `${paid}, а она бессрочная: ${unchanged}`;
}

/** The paid term as the note names it: days, or none for a plan without an end. */
function paidTerm(days: number): string {
  return days > 0 ? `на ${days} дн.` : 'без срока';
}

/**
 * The refund sentence for a combined renewal whose other lines were applied:
 * only this line's part goes back, and «Отметить возврат» records a whole
 * refund, so it is not the way here.
 */
export function describeLifetimeLineRefund(line: LifetimeRenewalNotApplied): string {
  const part =
    line.amount !== undefined && line.currency !== undefined ? `${line.amount} ${line.currency}` : 'её часть';
  return (
    `Верните за эту позицию ${part}: для ЮKassa — «Пользователи» → пользователь → вкладка «Операции» → ` +
    'у платежа «Вернуть» с этой суммой; у другого провайдера — в его кабинете. «Отметить возврат» здесь не нужен: ' +
    'он записывает возврат всего платежа.'
  );
}

/** The flat key the card prints its plan-block line from (`system-events.service.ts`). */
export const LIFETIME_RENEWAL_CARD_KEY = 'lifetimeRenewalNotApplied';

/** The same, for an upgrade withheld because its subscription has no end date. */
export const LIFETIME_UPGRADE_CARD_KEY = 'lifetimeUpgradeNotApplied';
