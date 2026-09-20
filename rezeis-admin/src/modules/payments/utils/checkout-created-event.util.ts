import type { Transaction } from '@prisma/client';

import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { planNamesFromTransactionSnapshot } from '../../../common/utils/plan-snapshot.util';
import { readJsonObject } from '../../../common/utils/read-json-object.util';

/**
 * «Создан счёт на оплату» — the one card that was declared and never sent.
 *
 * The type has been in `EVENT_TYPES`, in `EVENT_PRESENTATION` with its own
 * title and emoji, in the outbound-webhook list and in the operator's Telegram
 * tick-box list since before any of this: an operator could tick it and wait
 * forever. Nothing raised it. This is the producer.
 *
 * WHEN IT IS RAISED, and the distinction is the whole design: at the moment a
 * payable invoice is HANDED TO THE CUSTOMER — the provider accepted it and the
 * checkout is being returned. Not when the draft row is written (a draft that
 * the provider then refuses is not a счёт), and not on the two branches that
 * end the checkout there and then:
 *
 *   * the provider answered CANCELED at creation — there is nothing to pay;
 *   * the provider answered SUCCEEDED at creation (a saved-card charge that
 *     went through at once) — `payment.completed` announces that, and two
 *     cards for one instant purchase is a reconciliation puzzle, not news.
 *
 * A keyed replay never reaches here either: it returns the checkout that
 * already exists, and the invoice it names was announced when it was made.
 *
 * Three services create checkouts — a purchase, a combined renewal, an add-on
 * — and all three call this, so the three cards cannot drift apart.
 *
 * NOT an alert: it is absent from `admin-notification-routes.ts` on purpose,
 * so it never reaches push or the notification centre. An invoice being
 * created is the most routine thing this panel does; it belongs in the feed,
 * the audit log and (if the operator ticks it) Telegram.
 */
export function announceCheckoutCreated(
  systemEvents: SystemEventsService,
  input: {
    readonly transaction: Transaction;
    /** The payment link, when the provider issued one. */
    readonly checkoutUrl: string | null;
  },
): void {
  const { transaction, checkoutUrl } = input;
  // A combined renewal's marker counts its lines; a single purchase has none.
  const itemCount = readJsonObject(transaction.planSnapshot)['itemCount'];
  systemEvents.info(
    EVENT_TYPES.PAYMENT_CHECKOUT_CREATED,
    'PAYMENT',
    `Создан счёт на оплату: ${transaction.purchaseType}`,
    {
      userId: transaction.userId,
      paymentId: transaction.paymentId,
      purchaseType: transaction.purchaseType,
      ...planNamesFromTransactionSnapshot(transaction.planSnapshot),
      gatewayType: transaction.gatewayType,
      channel: transaction.channel,
      amount: transaction.amount.toString(),
      currency: transaction.currency,
      ...(typeof itemCount === 'number' ? { itemCount } : {}),
      ...(transaction.subscriptionId === null ? {} : { subscriptionId: transaction.subscriptionId }),
      // The card renders this as «🧾 Ссылка на оплату». It is the customer's
      // own link and an operator chasing an unpaid invoice is exactly who
      // needs it; it is already what the autopay-3DS card carries.
      ...(checkoutUrl === null || checkoutUrl.length === 0 ? {} : { checkoutUrl }),
    },
  );
}
