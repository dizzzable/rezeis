import { PaymentGatewayType, PurchaseChannel } from '@prisma/client';

export function isGatewayAvailableForChannel(
  gatewayType: PaymentGatewayType,
  channel: PurchaseChannel,
): boolean {
  if (channel === PurchaseChannel.WEB) {
    return gatewayType !== PaymentGatewayType.TELEGRAM_STARS;
  }
  return true;
}
