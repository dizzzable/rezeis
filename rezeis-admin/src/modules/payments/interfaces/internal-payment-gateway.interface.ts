import { Currency, PaymentGatewayType } from '@prisma/client';

/**
 * User-safe view of a payment gateway exposed via
 * `GET /api/internal/payments/gateways`.
 *
 * Stripped of operator-only fields:
 *   - `settings` (provider credentials),
 *   - `isUsedInPricing` / `activePlanDurationCount` (admin pricing tooling),
 *   - `updatedAt` (operator audit timestamp).
 *
 * Reiwa renders these as the "choose how to pay" list on the purchase
 * screen — only currency + provider + display order matter.
 */
export interface InternalPaymentGatewayInterface {
  readonly id: string;
  readonly type: PaymentGatewayType;
  readonly currency: Currency;
  readonly orderIndex: number;
  /**
   * The operator switched «Автоплатежи одобрены провайдером» on, and this build
   * can run the gateway's repeat charges. The cabinet then offers a second
   * option, «для автоматического списания». See `gateway-autopay.util.ts`.
   */
  readonly autopay: boolean;
}
