import { Currency, PaymentGatewayType, PurchaseType, TransactionStatus } from '@prisma/client';

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
  readonly updatedAt: string;
}
