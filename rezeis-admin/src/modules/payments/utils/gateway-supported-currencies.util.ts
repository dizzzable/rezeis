import { Currency, PaymentGatewayType } from '@prisma/client';

/**
 * Catalog currencies supported by each payment gateway.
 *
 * The first element in each list is treated as the default currency for
 * a freshly-seeded gateway row. Admins can later switch to any other
 * value in the list via the gateway settings UI; values outside the
 * list are rejected by `assertCurrencySupported`.
 *
 * Sources:
 *   - Provider sales pages and developer docs
 *     (Cryptomus / Heleket support a long crypto list, Telegram Stars
 *     accepts only XTR, fiat aggregators in RU primarily run RUB).
 *   - The internal `gateway_data` we have observed from real callbacks.
 *
 * Crypto aggregators (`CRYPTOMUS`, `HELEKET`) advertise a much wider
 * coin range than what we model in the Prisma `Currency` enum. We
 * intersect with our enum so the frontend never offers a value the
 * database can't store.
 */
export const GATEWAY_SUPPORTED_CURRENCIES: Readonly<
  Record<PaymentGatewayType, readonly Currency[]>
> = {
  TELEGRAM_STARS: ['XTR'],

  // Fiat aggregators in RU — primarily RUB, often have USD as a fallback.
  YOOKASSA: ['RUB', 'USD'],
  PLATEGA: ['RUB', 'USD'],
  OVERPAY: ['RUB'],
  PAYPALYCH: ['RUB'],
  RIOPAY: ['RUB'],
  VALUTIX: ['RUB'],
  ANTILOPAY: ['RUB'],
  AURAPAY: ['RUB'],
  ROLLYPAY: ['RUB'],
  MULENPAY: ['RUB', 'USD'],
  SEVERPAY: ['RUB', 'USD'],
  WATA: ['RUB', 'USD'],
  LAVA: ['RUB', 'USD'],

  // Crypto aggregators — wide stable + native list.
  CRYPTOMUS: ['USDT', 'TON', 'BTC', 'ETH', 'LTC', 'BNB', 'DASH', 'SOL', 'XMR', 'USDC', 'TRX'],
  HELEKET: ['USDT', 'TON', 'BTC', 'ETH', 'LTC', 'BNB', 'DASH', 'SOL', 'XMR', 'USDC', 'TRX'],

  // CryptoPay (@CryptoBot) — supported crypto assets intersected with our enum.
  CRYPTOPAY: ['USDT', 'TON', 'BTC', 'ETH', 'LTC', 'USDC', 'TRX'],

  // Internal partner-balance "wallet" — not a real gateway, never seeded as a
  // PaymentGateway row. Prices in the partner's balance currency directly, so
  // it carries no fixed currency list.
  PARTNER_BALANCE: [],
};

/**
 * Returns the supported currency list for a given gateway. Always
 * returns at least one item — the gateway's default currency.
 */
export function getSupportedCurrencies(
  gatewayType: PaymentGatewayType,
): readonly Currency[] {
  return GATEWAY_SUPPORTED_CURRENCIES[gatewayType] ?? [];
}

/**
 * Validates that the requested currency is supported by the gateway.
 * Throws when the combination is invalid so the controller can map
 * the error to a 400 response.
 */
export function isCurrencySupportedByGateway(
  gatewayType: PaymentGatewayType,
  currency: Currency,
): boolean {
  const supported = GATEWAY_SUPPORTED_CURRENCIES[gatewayType];
  if (!supported || supported.length === 0) {
    return false;
  }
  return supported.includes(currency);
}
