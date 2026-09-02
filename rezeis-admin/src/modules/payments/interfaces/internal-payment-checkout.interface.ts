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
  readonly updatedAt: string;
}
