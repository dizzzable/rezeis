import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';

import type { WithheldConversionMark } from '../utils/trial-conversion.util';

export interface AdminPaymentTransactionInterface {
  readonly id: string;
  readonly paymentId: string;
  readonly userId: string;
  readonly userTelegramId: string | null;
  readonly userUsername: string | null;
  readonly userName: string | null;
  readonly userEmail: string | null;
  readonly subscriptionId: string | null;
  readonly status: TransactionStatus;
  readonly purchaseType: PurchaseType;
  readonly channel: PurchaseChannel;
  readonly gatewayType: PaymentGatewayType;
  readonly currency: Currency;
  readonly amount: string;
  readonly paymentAsset: string | null;
  readonly gatewayId: string | null;
  readonly planSnapshot: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A row of the admin payments list: the transaction plus what the payment
 * details sheet needs and a draft response has no use for.
 */
export interface AdminPaymentTransactionListItemInterface extends AdminPaymentTransactionInterface {
  /** When the purchase was provisioned; null until then, and for a payment that never is. */
  readonly fulfilledAt: string | null;
  /**
   * The subscriptions a COMBINED renewal pays for. Such a payment's own
   * `subscriptionId` is null — its targets live in `TransactionItem` rows — so
   * without this the list could not say which subscriptions it renewed.
   * Empty for every single-subscription payment.
   */
  readonly lineItemSubscriptionIds: readonly string[];
  /**
   * Set for a trial's conversion that was received after another payment had
   * converted the trial, and so applied to nothing: it is COMPLETED and
   * `fulfilledAt` is stamped, yet nothing was delivered, and its money is for
   * the operator to return (`payment.withheld`, «Отметить возврат»). Null for
   * every other payment.
   */
  readonly conversionWithheld: WithheldConversionMark | null;
}
