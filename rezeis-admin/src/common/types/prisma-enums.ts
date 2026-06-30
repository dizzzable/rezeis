/**
 * String-literal equivalents of Prisma-generated enums.
 * Use these until `prisma generate` has been run.
 * Once generated, you can import directly from '@prisma/client'.
 */

export type UserRole = 'DEV' | 'ADMIN' | 'USER';
export type Locale = 'AR' | 'AZ' | 'BE' | 'CS' | 'DE' | 'EN' | 'ES' | 'FA' | 'FR' | 'HE' | 'HI' | 'ID' | 'IT' | 'JA' | 'KK' | 'KO' | 'MS' | 'NL' | 'PL' | 'PT' | 'RO' | 'RU' | 'SR' | 'TR' | 'UK' | 'UZ' | 'VI';
export type Currency = 'USD' | 'XTR' | 'RUB' | 'USDT' | 'TON' | 'BTC' | 'ETH' | 'LTC' | 'BNB' | 'DASH' | 'SOL' | 'XMR' | 'USDC' | 'TRX';
export type PaymentGatewayType = 'TELEGRAM_STARS' | 'YOOKASSA' | 'YOOMONEY' | 'CRYPTOMUS' | 'HELEKET' | 'CRYPTOPAY' | 'TBANK' | 'ROBOKASSA' | 'STRIPE' | 'MULENPAY' | 'CLOUDPAYMENTS' | 'PAL24' | 'WATA' | 'PLATEGA' | 'AURAPAY' | 'ROLLYPAY' | 'SEVERPAY' | 'LAVA' | 'ANTILOPAY' | 'OVERPAY' | 'PAYPALYCH' | 'RIOPAY' | 'VALUTIX';
export type SubscriptionStatus = 'ACTIVE' | 'DISABLED' | 'LIMITED' | 'EXPIRED' | 'DELETED';
export type TransactionStatus = 'PENDING' | 'COMPLETED' | 'CANCELED' | 'REFUNDED' | 'FAILED';
export type PurchaseType = 'NEW' | 'RENEW' | 'UPGRADE' | 'ADDITIONAL';
export type PurchaseChannel = 'WEB' | 'TELEGRAM';
export type PlanType = 'TRAFFIC' | 'DEVICES' | 'BOTH' | 'UNLIMITED';
export type PlanAvailability = 'ALL' | 'NEW' | 'EXISTING' | 'INVITED' | 'ALLOWED' | 'TRIAL';
export type ArchivedPlanRenewMode = 'SELF_RENEW' | 'REPLACE_ON_RENEW';
export type TrafficLimitStrategy = 'MONTH' | 'YEAR' | 'NO_RESET' | 'DAY' | 'WEEK';
export type PromocodeRewardType = 'DURATION' | 'TRAFFIC' | 'DEVICES' | 'SUBSCRIPTION' | 'PERSONAL_DISCOUNT' | 'PURCHASE_DISCOUNT';
export type PromocodeAvailability = 'ALL' | 'NEW' | 'EXISTING' | 'INVITED' | 'ALLOWED';
export type BroadcastStatus = 'PROCESSING' | 'COMPLETED' | 'CANCELED' | 'DELETED' | 'ERROR';
export type BroadcastAudience = 'ALL' | 'PLAN' | 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'EXPIRED' | 'TRIAL';
export type BroadcastMessageStatus = 'SENT' | 'FAILED' | 'EDITED' | 'DELETED' | 'PENDING';
export type ReferralRewardType = 'POINTS' | 'EXTRA_DAYS';
export type ReferralInviteSource = 'BOT' | 'WEB' | 'UNKNOWN';
export type WithdrawalStatus = 'PENDING' | 'COMPLETED' | 'REJECTED' | 'CANCELED';
export type AccessMode = 'PUBLIC' | 'INVITED' | 'PURCHASE_BLOCKED' | 'REG_BLOCKED' | 'RESTRICTED';
export type BackupScope = 'DB' | 'ASSETS' | 'FULL';
export type DeviceType = 'ANDROID' | 'IPHONE' | 'WINDOWS' | 'MAC' | 'OTHER';
