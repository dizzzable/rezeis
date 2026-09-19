import { PaymentGatewayType } from '@prisma/client';

import { readBooleanSetting } from '../services/payment-provider-execution.helpers';
import { readRollypayPlanIds, readRollypayTerminalId } from './rollypay-subscription.util';

/**
 * «Автоплатежи одобрены провайдером», the operator's switch in the gateway's
 * settings. It is stored under `savePaymentMethod`, the key ЮKassa's
 * «Сохранять карты для автоплатежей» already used.
 *
 * Providers run repeat charges only for a shop they approved: a live ЮKassa
 * shop needs a letter to its manager («По умолчанию автоплатежи работают только
 * в тестовом магазине»). So an absent key reads as OFF, and a shop nobody
 * approved no longer offers to save a card it cannot charge. Until 19.09.2026
 * the absent key read as ON; the `20260919200000_yookassa_autopay_approved`
 * migration wrote it as ON wherever customers already held an active saved
 * ЮKassa method and OFF everywhere else, an operator's own OFF aside, so
 * installs that charge today keep charging.
 *
 * The switch stops NEW sign-ups only. A method saved while it was ON is still
 * charged after it goes OFF; the customer turns it off in «Способы оплаты».
 */
export const AUTOPAY_APPROVED_SETTING = 'savePaymentMethod';

/**
 * The gateways whose repeat charges this build can run: ЮKassa charges a saved
 * method on the panel's schedule, Platega and RollyPay run a subscription on
 * their own (`PROVIDER_SUBSCRIPTION_GATEWAY_TYPES`).
 */
export const AUTOPAY_GATEWAY_TYPES: ReadonlySet<PaymentGatewayType> = new Set([
  PaymentGatewayType.YOOKASSA,
  PaymentGatewayType.PLATEGA,
  PaymentGatewayType.ROLLYPAY,
]);

export function isAutopayApproved(type: PaymentGatewayType, settings: Record<string, unknown>): boolean {
  if (!AUTOPAY_GATEWAY_TYPES.has(type) || !readBooleanSetting(settings, AUTOPAY_APPROVED_SETTING, false)) {
    return false;
  }
  // RollyPay signs a payer up only on a tariff it set up for the kassa. With
  // no kassa or no tariff named, every sign-up would be refused, so the
  // cabinet is not offered one.
  if (type === PaymentGatewayType.ROLLYPAY) {
    return readRollypayTerminalId(settings) !== null && readRollypayPlanIds(settings).length > 0;
  }
  return true;
}
