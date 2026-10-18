import { Currency, PaymentGatewayType, PurchaseType, TransactionStatus } from '@prisma/client';

export type SubscriptionProvisioningStatus =
  | 'NOT_APPLICABLE'
  | 'FULFILLING'
  | 'PROFILE_PENDING'
  | 'READY'
  | 'FAILED';

export type SubscriptionProvisioningFailureCode = 'PROFILE_SYNC_FAILED';

export interface InternalPaymentCheckoutInterface {
  readonly paymentId: string;
  readonly transactionStatus: TransactionStatus;
  readonly gatewayType: PaymentGatewayType;
  readonly purchaseType: PurchaseType;
  readonly amount: string;
  readonly currency: Currency;
  readonly checkoutUrl: string | null;
  readonly providerMode: string;
  readonly createdAt: string;
}

export interface InternalPaymentStatusInterface {
  readonly paymentId: string;
  readonly status: TransactionStatus;
  readonly gatewayType: PaymentGatewayType;
  readonly purchaseType: PurchaseType;
  readonly amount: string;
  readonly currency: Currency;
  readonly checkoutUrl: string | null;
  readonly failureReason: string | null;
  readonly subscriptionId: string | null;
  readonly subscriptionProvisioningStatus: SubscriptionProvisioningStatus;
  readonly subscriptionProvisioningFailureCode: SubscriptionProvisioningFailureCode | null;
  /**
   * Points the purchase credited, read from the ledger row keyed on this
   * transaction; `null` until the cashback hook has run, or when the payment
   * earned nothing. Always present, so a cabinet can tell "no cashback" from
   * "a panel too old to say".
   */
  readonly cashbackPoints: number | null;
  /**
   * An Antilopay SBP sign-up whose plan comes with its first charge, while that
   * plan is not delivered: the payer confirmed the subscription and its first
   * charge is awaited (`firstChargeAt`: Antilopay's date for it, the delay's end
   * when there is one; null when it does not say), or that charge did not come.
   * Null for every other payment. A cabinet that does not read it shows the
   * payment by `status` alone, as before.
   */
  readonly autopaySignUp: {
    readonly state: 'AWAITING_FIRST_CHARGE' | 'FIRST_CHARGE_FAILED';
    readonly firstChargeAt: string | null;
  } | null;
  readonly updatedAt: string;
}
