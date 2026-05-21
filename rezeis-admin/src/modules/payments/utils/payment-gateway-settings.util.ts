import { BadRequestException } from '@nestjs/common';
import { PaymentGatewayType, Prisma } from '@prisma/client';
import { z } from 'zod';

const telegramStarsSettingsSchema = z
  .object({
    providerToken: z.string().min(1).optional(),
    webhookSecret: z.string().min(1).optional(),
  })
  .strict();

const yookassaSettingsSchema = z
  .object({
    shopId: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    customer: z.string().min(1).optional(),
    vatCode: z.string().min(1).optional(),
  })
  .strict();

const heleketSettingsSchema = z
  .object({
    merchantId: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
  })
  .strict();

const cryptomusSettingsSchema = z
  .object({
    merchantId: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
  })
  .strict();

const mulenpaySettingsSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
  })
  .strict();

const plategaSettingsSchema = z
  .object({
    merchantId: z.string().min(1).optional(),
    secret: z.string().min(1).optional(),
    paymentMethod: z.union([z.literal(1), z.literal(2), z.enum(['1', '2', 'CARD', 'SBP', 'SBPQR'])]).optional(),
  })
  .strict();

const antilopaySettingsSchema = z
  .object({
    projectIdentificator: z.string().min(1).optional(),
    secretId: z.string().min(1).optional(),
    privateKey: z.string().min(1).optional(),
    publicKey: z.string().min(1).optional(),
  })
  .strict();

const overpaySettingsSchema = z
  .object({
    shopId: z.string().min(1).optional(),
    secretKey: z.string().min(1).optional(),
    publicKey: z.string().min(1).optional(),
  })
  .strict();

const paypalychSettingsSchema = z
  .object({
    shopId: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    secretKey: z.string().min(1).optional(),
  })
  .strict();

const riopaySettingsSchema = z
  .object({
    apiToken: z.string().min(1).optional(),
  })
  .strict();

type GatewaySettingsRecord = Record<string, unknown>;

function stripUndefinedEntries(value: GatewaySettingsRecord): Prisma.InputJsonObject {
  const normalizedEntries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  return Object.fromEntries(normalizedEntries) as Prisma.InputJsonObject;
}

function normalizePlategaPaymentMethod(value: unknown): 1 | 2 | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 1 || value === '1' || value === 'CARD') {
    return 1;
  }
  if (value === 2 || value === '2' || value === 'SBP' || value === 'SBPQR') {
    return 2;
  }
  return undefined;
}

export function normalizeGatewaySettingsForStorage(
  gatewayType: PaymentGatewayType,
  value: unknown,
): Prisma.InputJsonObject {
  if (value === null) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('PAYMENT_GATEWAY_SETTINGS_INVALID');
  }

  const rawSettings = value as GatewaySettingsRecord;
  try {
    switch (gatewayType) {
      case PaymentGatewayType.TELEGRAM_STARS:
        return stripUndefinedEntries(telegramStarsSettingsSchema.parse(rawSettings));
      case PaymentGatewayType.YOOKASSA:
        return stripUndefinedEntries(yookassaSettingsSchema.parse(rawSettings));
      case PaymentGatewayType.HELEKET:
        return stripUndefinedEntries(heleketSettingsSchema.parse(rawSettings));
      case PaymentGatewayType.CRYPTOMUS:
        return stripUndefinedEntries(cryptomusSettingsSchema.parse(rawSettings));
      case PaymentGatewayType.MULENPAY:
        return stripUndefinedEntries(mulenpaySettingsSchema.parse(rawSettings));
      case PaymentGatewayType.PLATEGA: {
        const parsedSettings = plategaSettingsSchema.parse(rawSettings);
        return stripUndefinedEntries({
          ...parsedSettings,
          paymentMethod: normalizePlategaPaymentMethod(parsedSettings.paymentMethod),
        });
      }
      case PaymentGatewayType.ANTILOPAY:
        return stripUndefinedEntries(antilopaySettingsSchema.parse(rawSettings));
      case PaymentGatewayType.OVERPAY:
        return stripUndefinedEntries(overpaySettingsSchema.parse(rawSettings));
      case PaymentGatewayType.PAYPALYCH:
        return stripUndefinedEntries(paypalychSettingsSchema.parse(rawSettings));
      case PaymentGatewayType.RIOPAY:
        return stripUndefinedEntries(riopaySettingsSchema.parse(rawSettings));
      default:
        return stripUndefinedEntries(rawSettings);
    }
  } catch {
    throw new BadRequestException('PAYMENT_GATEWAY_SETTINGS_INVALID');
  }
}

export function readGatewaySettings(
  value: Prisma.JsonValue,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function isGatewayConfigured(
  gatewayType: PaymentGatewayType,
  value: Prisma.JsonValue,
): boolean {
  const settings = readGatewaySettings(value);
  switch (gatewayType) {
    case PaymentGatewayType.TELEGRAM_STARS:
      return typeof settings.webhookSecret === 'string' && settings.webhookSecret.trim().length > 0;
    case PaymentGatewayType.YOOKASSA:
      return hasRequiredStrings(settings, ['shopId', 'apiKey']);
    case PaymentGatewayType.HELEKET:
      return hasRequiredStrings(settings, ['merchantId', 'apiKey']);
    case PaymentGatewayType.PLATEGA:
      return hasRequiredStrings(settings, ['merchantId', 'secret']);
    case PaymentGatewayType.MULENPAY:
      return hasRequiredStrings(settings, ['apiKey']);
    case PaymentGatewayType.CRYPTOMUS:
      return hasRequiredStrings(settings, ['merchantId', 'apiKey']);
    case PaymentGatewayType.ANTILOPAY:
      return hasRequiredStrings(settings, ['projectIdentificator', 'secretId', 'privateKey']);
    case PaymentGatewayType.OVERPAY:
      return hasRequiredStrings(settings, ['shopId', 'secretKey']);
    case PaymentGatewayType.PAYPALYCH:
      return hasRequiredStrings(settings, ['shopId', 'apiKey']);
    case PaymentGatewayType.RIOPAY:
      return hasRequiredStrings(settings, ['apiToken']);
    default:
      return false;
  }
}

function hasRequiredStrings(
  settings: Record<string, unknown>,
  propertyNames: readonly string[],
): boolean {
  return propertyNames.every((propertyName) => {
    const propertyValue = settings[propertyName];
    return typeof propertyValue === 'string' && propertyValue.trim().length > 0;
  });
}
