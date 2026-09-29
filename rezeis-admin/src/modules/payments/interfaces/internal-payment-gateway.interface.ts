import { Currency, PaymentGatewayType } from '@prisma/client';

import type { AntilopayAutopayMethod } from '../utils/antilopay-recurrent.util';

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
  /**
   * The methods the operator approved for «для автоматического списания», on a
   * gateway that approves them one by one (Antilopay: a card and SBP, each with
   * its own switch). Present only there. `autopay` stays false on such a
   * gateway, whatever the switches say: a cabinet that knows only the boolean
   * offers its one option, and would offer a method nobody approved. So a
   * cabinet older than the list, or a panel older than the cabinet, shows no
   * automatic charging on Antilopay at all.
   */
  readonly autopayMethods?: readonly AntilopayAutopayMethod[];
}
