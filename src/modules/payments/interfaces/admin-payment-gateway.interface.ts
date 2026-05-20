import { Currency, PaymentGatewayType } from '@prisma/client';

export interface AdminPaymentGatewayInterface {
  readonly id: string;
  readonly type: PaymentGatewayType;
  readonly orderIndex: number;
  readonly currency: Currency;
  readonly isActive: boolean;
  readonly settings: Record<string, unknown>;
  readonly isUsedInPricing: boolean;
  readonly activePlanDurationCount: number;
  readonly updatedAt: string;
}
