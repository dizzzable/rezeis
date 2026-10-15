import { PaymentGatewayType } from '@prisma/client';

import { readBooleanSetting } from '../services/payment-provider-execution.helpers';
import { ANTILOPAY_AUTOPAY_METHODS, type AntilopayAutopayMethod } from './antilopay-recurrent.util';
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
 *
 * Antilopay is the one gateway with two: it approves repeat charges per
 * project AND per method, a card and SBP apiece (`ANTILOPAY_AUTOPAY_APPROVAL_SETTINGS`),
 * so `savePaymentMethod` means nothing there.
 */
export const AUTOPAY_APPROVED_SETTING = 'savePaymentMethod';

/**
 * «Автосписание картой одобрено провайдером» and «Автосписание по СБП
 * одобрено провайдером»: Antilopay's approval of repeat charges, one switch per
 * method. Both read as OFF until the operator turns them on.
 */
export const ANTILOPAY_AUTOPAY_APPROVAL_SETTINGS: Readonly<Record<AntilopayAutopayMethod, string>> = {
  CARD: 'autopayCardApproved',
  SBP: 'autopaySbpApproved',
};

/**
 * The methods a gateway's operator has approved for automatic charging, for a
 * gateway that approves them one by one (Antilopay); none for any other.
 */
export function approvedAutopayMethods(
  type: PaymentGatewayType,
  settings: Record<string, unknown>,
): readonly AntilopayAutopayMethod[] {
  if (type !== PaymentGatewayType.ANTILOPAY) return [];
  return ANTILOPAY_AUTOPAY_METHODS.filter((method) =>
    readBooleanSetting(settings, ANTILOPAY_AUTOPAY_APPROVAL_SETTINGS[method], false),
  );
}

/**
 * The gateways whose repeat charges this build can run: ЮKassa charges a saved
 * method on the panel's schedule, Platega, RollyPay, Antilopay and AuraPay run
 * a subscription on their own (`PROVIDER_SUBSCRIPTION_GATEWAY_TYPES`).
 */
export const AUTOPAY_GATEWAY_TYPES: ReadonlySet<PaymentGatewayType> = new Set([
  PaymentGatewayType.YOOKASSA,
  PaymentGatewayType.PLATEGA,
  PaymentGatewayType.ROLLYPAY,
  PaymentGatewayType.ANTILOPAY,
  PaymentGatewayType.AURAPAY,
]);

/**
 * Whether the operator approved automatic charging on this gateway. On Antilopay
 * it is asked per `method`: with one, whether THAT method is approved; without
 * one, whether any is (the list of gateways, which then names them). Every other
 * gateway has one switch and ignores the method.
 */
export function isAutopayApproved(
  type: PaymentGatewayType,
  settings: Record<string, unknown>,
  method?: AntilopayAutopayMethod,
): boolean {
  if (!AUTOPAY_GATEWAY_TYPES.has(type)) return false;
  if (type === PaymentGatewayType.ANTILOPAY) {
    const approved = approvedAutopayMethods(type, settings);
    return method === undefined ? approved.length > 0 : approved.includes(method);
  }
  if (!readBooleanSetting(settings, AUTOPAY_APPROVED_SETTING, false)) {
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
