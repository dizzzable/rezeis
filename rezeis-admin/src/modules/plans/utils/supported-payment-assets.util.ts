import { PaymentGatewayType } from '@prisma/client';

const SUPPORTED_PAYMENT_ASSETS: Readonly<Record<PaymentGatewayType, readonly string[]>> = {
  [PaymentGatewayType.YOOKASSA]: [],
  [PaymentGatewayType.TELEGRAM_STARS]: [],
  [PaymentGatewayType.PLATEGA]: [],
  [PaymentGatewayType.HELEKET]: ['USDT', 'TON', 'BTC', 'ETH'],
  [PaymentGatewayType.CRYPTOMUS]: ['USDT', 'TON', 'BTC', 'ETH'],
  [PaymentGatewayType.MULENPAY]: [],
  [PaymentGatewayType.ANTILOPAY]: [],
  [PaymentGatewayType.OVERPAY]: [],
  [PaymentGatewayType.PAYPALYCH]: [],
  [PaymentGatewayType.RIOPAY]: [],
  [PaymentGatewayType.WATA]: [],
  [PaymentGatewayType.AURAPAY]: [],
  [PaymentGatewayType.ROLLYPAY]: [],
  [PaymentGatewayType.SEVERPAY]: [],
  [PaymentGatewayType.LAVA]: [],
  [PaymentGatewayType.CRYPTOPAY]: ['USDT', 'TON', 'BTC', 'ETH', 'LTC', 'USDC', 'TRX'],
};

export function getSupportedPaymentAssets(
  gatewayType: PaymentGatewayType,
): readonly string[] | null {
  const assets = SUPPORTED_PAYMENT_ASSETS[gatewayType] ?? [];
  return assets.length > 0 ? assets : null;
}
