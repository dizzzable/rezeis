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
  readonly updatedAt: string;
}
