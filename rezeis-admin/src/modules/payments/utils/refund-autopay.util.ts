import type { PaymentGatewayType, Prisma } from '@prisma/client';

/**
 * What a refund does to the payer's autopay — the provider subscriptions
 * Platega and RollyPay charge on their own schedule.
 *
 * The owner's rule, in their words: «все возвраты, которые захочет
 * пользователь, удаляют автосписания» — a refund ends the autopay. Until it
 * did, a full refund left the provider subscription live; the provider charged
 * again next period, and that charge renewed the refunded subscription.
 */

/**
 * Whether a refund ends the autopay. THE one place that decides it: every
 * refund path asks here — the full reversal
 * (`PaymentReconciliationService.reverseFulfilledPayment`), a provider's
 * partial refund notice (`handleRefundReversal`), and the panel's own partial
 * ЮKassa refund (`PaymentRefundService.refundTransaction`).
 *
 * EVERY refund does, a partial one included — the owner's decision of
 * 23.09.2026: «Частичный возврат какой… в таких услугах обычно накидываются
 * дни и все, либо возврат делается… пользователь пишет в поддержку либо в
 * платежку». Compensation is given as days, not as money; a refund, through
 * support or through the payment provider, ends the relationship and its
 * autopay. To keep the autopay on a partial refund after all, return
 * `refund.full` here.
 */
export function refundEndsAutopay(refund: { readonly full: boolean }): boolean {
  void refund;
  return true;
}

/**
 * `ProviderSubscription.cancelledBy` for a cancel a refund asked for.
 *
 * Written on every live row of the refunded subscription BEFORE the provider
 * is asked, and left there when the provider cannot be reached. So the row
 * says, whatever the provider does: the stranded sweep retries the cancel
 * every pass until it lands, and a charge the provider takes anyway renews
 * nothing — it is withheld for refund (`AUTOPAY_AFTER_REFUND`).
 */
export const REFUND_CANCELLED_BY = 'REFUND';

/** What a refund did to the autopay, for the operator's refund card. */
export interface AutopayRefundOutcome {
  /** Cancelled at the provider now, or already stopped. */
  readonly cancelled: readonly AutopayRow[];
  /** The provider could not be reached or refused: the sweep retries these. */
  readonly failed: readonly AutopayRow[];
  /**
   * The user's ЮKassa autopay — every saved method: a card, SBP, ЮMoney — is
   * off because of this refund: this door switched it off, or another door
   * into the same refund did ({@link SAVED_CARD_AUTOPAY_OFF_AT_KEY}).
   */
  readonly savedCardAutopayOff?: boolean;
  /** Switching it off failed for at least one method. Wins over `savedCardAutopayOff`. */
  readonly savedCardAutopayFailed?: boolean;
  /**
   * The user's ЮKassa autopay charges that went through while the refund was
   * switching the autopay off: a charge held the saved method when the refund
   * came, and it renewed the subscription. Payment ids.
   */
  readonly yookassaChargesDuringRefund?: readonly string[];
  /**
   * The user's ЮKassa autopay charges still PENDING when the autopay was
   * switched off — started before the refund: if one goes through, it renews
   * the subscription. Payment ids.
   */
  readonly yookassaChargesPending?: readonly string[];
  /**
   * The card went out before the provider's cancel had finished, because the
   * panel was stopping. The rows are marked, so the sweep finishes it.
   */
  readonly providerCancelInterrupted?: boolean;
}

/**
 * Stamped on a refunded payment's `gatewayData` when its refund switched the
 * user's ЮKassa autopay off, in the same database transaction as the switch
 * (`SavedPaymentMethodService.disableAutopayForRefund`) — so another door
 * into the same refund (the provider's notice of the panel's partial refund),
 * which finds nothing left to switch, reads it and says so.
 */
export const SAVED_CARD_AUTOPAY_OFF_AT_KEY = 'refundSavedCardAutopayOffAt';

/**
 * How an autopay charge of the ЮKassa saved method starts its idempotency
 * key: `auto-renew:{subscriptionId}:{expiresAtMs}:a{n}` (`IDEMPOTENCY_PREFIX`
 * in `auto-renew.service.ts`, which is the one place that writes them).
 */
export const AUTO_RENEW_IDEMPOTENCY_PREFIX = 'auto-renew:';

export interface AutopayRow {
  readonly gatewayType: string;
  readonly providerSubscriptionId: string;
}

export const NO_AUTOPAY: AutopayRefundOutcome = { cancelled: [], failed: [] };

/**
 * The provider subscription an autopay charge (2 and up) belongs to, off the
 * marker `ProviderSubscriptionService` writes on it; null for any other payment.
 * The first charge is the payer's own checkout, found by `firstTransactionId`.
 */
export function readProviderChargeMarker(
  transaction: { readonly planSnapshot: unknown },
): { readonly providerSubscriptionId: string; readonly chargeNumber: number | null } | null {
  const snapshot =
    typeof transaction.planSnapshot === 'object' && transaction.planSnapshot !== null && !Array.isArray(transaction.planSnapshot)
      ? (transaction.planSnapshot as Record<string, unknown>)
      : {};
  if (snapshot['snapshotSource'] !== PROVIDER_SUBSCRIPTION_CHARGE) return null;
  const providerSubscriptionId = snapshot['providerSubscriptionId'];
  if (typeof providerSubscriptionId !== 'string' || providerSubscriptionId.length === 0) return null;
  const chargeNumber = snapshot['chargeNumber'];
  return {
    providerSubscriptionId,
    chargeNumber: typeof chargeNumber === 'number' && Number.isSafeInteger(chargeNumber) ? chargeNumber : null,
  };
}

/** `planSnapshot.snapshotSource` of an autopay charge 2 and up. */
export const PROVIDER_SUBSCRIPTION_CHARGE = 'PROVIDER_SUBSCRIPTION_CHARGE';

/**
 * Whether an autopay charge belongs to an autopay a refund ended — cancelled for
 * the refund, or still waiting for that cancel to land (`REFUND_CANCELLED_BY`).
 * Such a charge renews nothing: it is withheld for refund.
 */
export async function autopayEndedByRefund(
  client: Pick<Prisma.TransactionClient, 'providerSubscription'>,
  transaction: { readonly gatewayType: PaymentGatewayType; readonly planSnapshot: unknown },
): Promise<boolean> {
  const marker = readProviderChargeMarker(transaction);
  if (marker === null) return false;
  const row = await client.providerSubscription.findUnique({
    where: {
      gatewayType_providerSubscriptionId: {
        gatewayType: transaction.gatewayType,
        providerSubscriptionId: marker.providerSubscriptionId,
      },
    },
    select: { cancelledBy: true },
  });
  return row?.cancelledBy === REFUND_CANCELLED_BY;
}

/**
 * The line the operator's refund card carries about the autopay, or null when
 * there was none to end. Says what happened and, when the provider could not
 * be reached, what to do.
 */
export function describeAutopayOutcome(outcome: AutopayRefundOutcome): string | null {
  const parts: string[] = [];
  if (outcome.cancelled.length > 0) {
    parts.push(`Автосписание отменено: ${gatewayList(outcome.cancelled)}.`);
  }
  // A row the panel could not even read was not marked either, so the sweep
  // has nothing to retry: the card must not promise that it does.
  const unread = outcome.failed.filter((row) => row.gatewayType === UNKNOWN_AUTOPAY_GATEWAY);
  const failed = outcome.failed.filter((row) => row.gatewayType !== UNKNOWN_AUTOPAY_GATEWAY);
  if (failed.length > 0) {
    parts.push(
      `Автосписание у ${gatewayList(failed)} отменить не удалось: панель повторяет отмену ` +
        'каждые 10 минут, а списание, если провайдер его всё же проведёт, подписку не продлит. ' +
        'Чтобы остановить списания сразу, отмените подписку в личном кабинете провайдера.',
    );
  }
  if (unread.length > 0) {
    parts.push(
      'Проверить автосписания клиента не удалось: панель не смогла прочитать их и могла не отменить. ' +
        'Проверьте подписку клиента в личном кабинете Platega или RollyPay и при необходимости отмените её там.',
    );
  }
  if (outcome.providerCancelInterrupted === true) {
    parts.push(
      'Отмена автосписания у провайдера не успела завершиться до перезапуска панели: ' +
        'панель повторяет её каждые 10 минут.',
    );
  }
  // One line about the ЮKassa autopay, never two: a failure anywhere wins,
  // because it is the one that asks for something to be done.
  if (outcome.savedCardAutopayFailed === true) {
    parts.push(
      'Автосписание через ЮKassa выключить не удалось: следующее продление может списать деньги. ' +
        'Клиент может выключить его сам в кабинете, в «Способах оплаты».',
    );
  } else if (outcome.savedCardAutopayOff === true) {
    parts.push('Автосписание через ЮKassa выключено.');
  }
  const during = outcome.yookassaChargesDuringRefund ?? [];
  if (during.length === 1) {
    parts.push(
      `Во время возврата уже шло автосписание через ЮKassa (платёж ${during[0]}) — оно прошло и продлило ` +
        'подписку. Если его тоже нужно вернуть — «Вернуть» у этого платежа.',
    );
  } else if (during.length > 1) {
    parts.push(
      `Во время возврата уже шли автосписания через ЮKassa (платежи ${during.join(', ')}) — они прошли и ` +
        'продлили подписку. Если их тоже нужно вернуть — «Вернуть» у этих платежей.',
    );
  }
  const pending = outcome.yookassaChargesPending ?? [];
  if (pending.length === 1) {
    parts.push(
      `Автосписание через ЮKassa (платёж ${pending[0]}), начатое до возврата, ещё не завершилось: если оно ` +
        'пройдёт, подписка продлится, и этот платёж нужно будет вернуть отдельно.',
    );
  } else if (pending.length > 1) {
    parts.push(
      `Автосписания через ЮKassa (платежи ${pending.join(', ')}), начатые до возврата, ещё не завершились: ` +
        'если они пройдут, подписка продлится, и эти платежи нужно будет вернуть отдельно.',
    );
  }
  return parts.length === 0 ? null : parts.join(' ');
}

function gatewayList(rows: readonly AutopayRow[]): string {
  return [...new Set(rows.map((row) => GATEWAY_NAMES[row.gatewayType] ?? row.gatewayType))].join(', ');
}

/** A failure the panel could not pin on a gateway: the rows could not even be read. */
export const UNKNOWN_AUTOPAY_GATEWAY = 'UNKNOWN';

/** The gateways that run a provider subscription, by the names the panel shows. */
const GATEWAY_NAMES: Readonly<Record<string, string>> = {
  PLATEGA: 'Platega',
  ROLLYPAY: 'RollyPay',
};
