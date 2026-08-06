import { BadRequestException } from '@nestjs/common';
import { PaymentGatewayType, Prisma } from '@prisma/client';
import { z } from 'zod';

import {
  decryptSettingValue,
  encryptSettingValue,
  isEncryptedSettingValue,
  isMaskOf,
  isSecretSettingKey,
  looksLikeEnvelopeSentinel,
  looksLikeMask,
  maskSecretValue,
} from './payment-gateway-secret-cipher';

const telegramStarsSettingsSchema = z
  .object({
    providerToken: z.string().min(1).optional(),
    webhookSecret: z.string().min(1).optional(),
  })
  .strict();

const yookassaBooleanSetting = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true'));

const yookassaSettingsSchema = z
  .object({
    shopId: z.string().min(1).optional(),
    // Panel form historically stores the secret as `apiKey`; YooKassa docs use `secretKey`.
    apiKey: z.string().min(1).optional(),
    secretKey: z.string().min(1).optional(),
    customer: z.string().min(1).optional(),
    vatCode: z.string().min(1).optional(),
    // Request YooKassa `save_payment_method` on interactive checkout (default true at runtime).
    savePaymentMethod: yookassaBooleanSetting.optional(),
    // ── Self-employed (НПД) «Мой Налог» income sync — additive, optional ──
    // Accepts a real boolean or the string forms the admin text/select field
    // posts, and normalizes to a boolean for storage.
    selfEmployedEnabled: yookassaBooleanSetting.optional(),
    moyNalogAuthMethod: z.enum(['password', 'refresh']).optional(),
    moyNalogInn: z.string().min(1).optional(),
    moyNalogPassword: z.string().min(1).optional(),
    moyNalogRefreshToken: z.string().min(1).optional(),
    moyNalogDeviceId: z.string().min(1).optional(),
    moyNalogProxy: z.string().min(1).optional(),
    incomeDescriptionTemplate: z.string().min(1).optional(),
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
    // Required by `POST /v2/payments`. There was nowhere to configure either,
    // so checkout creation could not have succeeded: `shopId` identifies the
    // shop and also feeds the request signature, `secretKey` is the separate
    // value that signs it (`sha1(currency + amount + shopId + secretKey)`).
    shopId: z.string().min(1).optional(),
    secretKey: z.string().min(1).optional(),
    // Fiscal receipt (`items[]`) is mandatory in MulenPay's schema. The codes
    // depend on the merchant's tax setup, so they are operator-configured —
    // same shape as YooKassa's `vatCode`. Defaults documented at the call site.
    vatCode: z.string().min(1).optional(),
    paymentSubject: z.string().min(1).optional(),
    paymentMode: z.string().min(1).optional(),
  })
  .strict();

/**
 * Platega's `paymentMethod` enum, verbatim: 2 = СБП (QR), 3 = ЕРИП,
 * 11 = карточный эквайринг, 12 = международная оплата, 13 = криптовалюта,
 * 14 = SberPay. There is no method 1. The previous mapping sent `CARD` as 1,
 * Platega rejected the unknown value, and every card checkout came back as a
 * 503 with no link; methods 3 and 11–14 were rejected by this schema, so they
 * could not be configured at all. Names are matched exactly — the point of
 * this table is that a near-miss fails loudly rather than picking a method.
 */
const PLATEGA_PAYMENT_METHOD_BY_NAME = {
  '2': 2,
  '3': 3,
  '11': 11,
  '12': 12,
  '13': 13,
  '14': 14,
  SBP: 2,
  SBPQR: 2,
  ERIP: 3,
  CARD: 11,
  INTERNATIONAL: 12,
  CRYPTO: 13,
  SBERPAY: 14,
} as const;

/**
 * «Let Platega ask the payer» — stored as a string on purpose.
 *
 * Platega has two create endpoints. `POST /transaction/process` REQUIRES
 * `paymentMethod` and pins the rail; `POST /v2/transaction/process` takes no
 * method at all and the payer chooses on Platega's own hosted page. Selecting
 * this value is what routes a gateway to the second one.
 *
 * Why a string and not a number:
 *  - it cannot collide with the provider enum, now or later. Platega already
 *    burned this project once by not having a method 1, and `0`/`15` are
 *    explicitly rejected by the spec above — reusing either as a sentinel would
 *    mean a future Platega method silently inheriting our meaning.
 *  - it is distinguishable from ABSENT in the persisted JSON. That distinction
 *    is the whole point: an unset `paymentMethod` still falls back to 2 (СБП)
 *    for every install that never touched the field, so «not chosen» and
 *    «chose provider's choice» must be two different states on disk, not one.
 *  - it survives the storage layer untouched. `paymentMethod` is deliberately
 *    NOT in `GATEWAY_SECRET_SETTING_KEYS`, so it is never enveloped, never
 *    masked and never mask-resolved — it round-trips panel → validate →
 *    encrypt → read as the same literal, and stays readable in the database
 *    where a misrouted gateway gets diagnosed.
 *
 * The spelling matches the SCREAMING_SNAKE aliases of the table above so the
 * admin form can post it exactly like `CARD` or `SBERPAY`.
 */
export const PLATEGA_PROVIDER_CHOICE = 'PROVIDER_CHOICE';

/**
 * What checkout sends when the operator never chose a rail. Long-standing
 * behaviour that live installs run on — changing it would silently reroute
 * every existing Platega gateway, so it is named here rather than inlined.
 */
export const PLATEGA_DEFAULT_PAYMENT_METHOD = 2;

/**
 * A value outside the enum fails the union rather than falling back: the parse
 * error travels the normal settings-validation path and the save answers 400.
 * The old helper returned `undefined` for anything it did not recognize, which
 * left the field unset and let checkout use its default of 2 — a typo silently
 * rerouted every payment to СБП while the panel reported the save as accepted.
 */
const plategaPaymentMethodSetting = z
  .union([
    z.literal([2, 3, 11, 12, 13, 14]),
    z.literal(PLATEGA_PROVIDER_CHOICE),
    z.enum([
      '2',
      '3',
      '11',
      '12',
      '13',
      '14',
      'SBP',
      'SBPQR',
      'ERIP',
      'CARD',
      'INTERNATIONAL',
      'CRYPTO',
      'SBERPAY',
    ]),
  ])
  .transform((value) =>
    typeof value === 'number' || value === PLATEGA_PROVIDER_CHOICE
      ? value
      : PLATEGA_PAYMENT_METHOD_BY_NAME[value],
  );

const plategaSettingsSchema = z
  .object({
    merchantId: z.string().min(1).optional(),
    secret: z.string().min(1).optional(),
    paymentMethod: plategaPaymentMethodSetting.optional(),
  })
  .strict();

/**
 * Which Platega create endpoint a gateway's settings select, and with what
 * method. The three states are deliberately kept apart:
 *
 *   `{ paymentMethod: 11 }`                → v1, `paymentMethod: 11`
 *   `{ paymentMethod: 'PROVIDER_CHOICE' }` → v2, no method in the body
 *   absent / anything non-numeric          → v1, `paymentMethod: 2` (СБП)
 *
 * The third case is load-bearing compatibility, not a nicety: every install
 * that never opened the field is live on СБП today, and it must stay there.
 * That is also why the sentinel is checked BEFORE the numeric fallback —
 * reading it as "not a number, therefore unset" is precisely the silent
 * reroute this function exists to prevent.
 */
export type PlategaPaymentMethodChoice =
  | { readonly kind: 'METHOD'; readonly paymentMethod: number }
  | { readonly kind: 'PROVIDER_CHOICE' };

export function resolvePlategaPaymentMethod(
  settings: Record<string, unknown>,
): PlategaPaymentMethodChoice {
  if (settings.paymentMethod === PLATEGA_PROVIDER_CHOICE) {
    return { kind: 'PROVIDER_CHOICE' };
  }
  return {
    kind: 'METHOD',
    paymentMethod:
      typeof settings.paymentMethod === 'number'
        ? settings.paymentMethod
        : PLATEGA_DEFAULT_PAYMENT_METHOD,
  };
}

/**
 * «Ставка ндс, возможные значения: 10, 22. Поле обязательное, если сно
 * Мерчанта - ОСНО» (Antilopay API, p.14). A merchant on ОСНО gets error 17
 * («Не предоставлена ставка НДС или недопустимое значение») on *every*
 * checkout without it, and the schema being `.strict()` meant the value could
 * not even be stored — the gateway was unusable for that whole tax regime.
 * Merchants on УСН/НПД must leave it unset; the field is theirs, not ours,
 * which is why it is an operator setting like YooKassa's and MulenPay's
 * `vatCode` rather than a constant at the call site.
 *
 * A rate outside the enum fails the parse and the save answers 400, instead of
 * being stored and then rejected by Antilopay on every payment.
 */
const antilopayVatSetting = z
  .union([z.literal([10, 22]), z.enum(['10', '22'])])
  .transform((value) => (typeof value === 'number' ? value : Number(value)));

const antilopaySettingsSchema = z
  .object({
    projectIdentificator: z.string().min(1).optional(),
    secretId: z.string().min(1).optional(),
    privateKey: z.string().min(1).optional(),
    publicKey: z.string().min(1).optional(),
    vat: antilopayVatSetting.optional(),
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

/**
 * `serviceId` — «сервис, через который провести платёж» — is required by
 * RioPay/Valutix on newer accounts and unused by legacy single-service ones,
 * so it stays optional. Both schemas are `.strict()`, so before this the value
 * could not be stored at all and the settings save answered 400. Admin forms
 * post text; storage keeps a number so the request body does not have to guess.
 */
const riopayEngineServiceIdSetting = z
  .union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)])
  .transform((value) => (typeof value === 'number' ? value : Number(value)));

const riopaySettingsSchema = z
  .object({
    apiToken: z.string().min(1).optional(),
    serviceId: riopayEngineServiceIdSetting.optional(),
  })
  .strict();

const valutixSettingsSchema = z
  .object({
    apiToken: z.string().min(1).optional(),
    // Same platform engine as RioPay, down to the field name.
    serviceId: riopayEngineServiceIdSetting.optional(),
  })
  .strict();

const wataSettingsSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    // Wata signs webhooks with SHA512withRSA and publishes the PUBLIC key at
    // `GET /api/h2h/public-key` (PKCS1). There is no shared secret — the old
    // `webhookSecret` did not correspond to anything Wata offers. Kept as an
    // accepted key so an existing row does not fail validation on read.
    publicKey: z.string().min(1).optional(),
    webhookSecret: z.string().min(1).optional(),
  })
  .strict();

const aurapaySettingsSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    shopId: z.string().min(1).optional(),
    secretKey: z.string().min(1).optional(),
  })
  .strict();

const rollypaySettingsSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    signingSecret: z.string().min(1).optional(),
  })
  .strict();

const severpaySettingsSchema = z
  .object({
    mid: z.string().min(1).optional(),
    secretToken: z.string().min(1).optional(),
  })
  .strict();

const lavaSettingsSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    offerId: z.string().min(1).optional(),
    webhookApiKey: z.string().min(1).optional(),
  })
  .strict();

const cryptopaySettingsSchema = z
  .object({
    apiToken: z.string().min(1).optional(),
    isTestnet: z.boolean().optional(),
  })
  .strict();

type GatewaySettingsRecord = Record<string, unknown>;

function stripUndefinedEntries(value: GatewaySettingsRecord): Prisma.InputJsonObject {
  const normalizedEntries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  return Object.fromEntries(normalizedEntries) as Prisma.InputJsonObject;
}

/**
 * Drops blank/whitespace-only string entries before validation. The admin
 * settings form posts every field (blank ones included); without this an
 * untouched optional field would be a `''` that fails `.min(1)` and rejects
 * the whole save. Stripping a key also lets an operator clear a previously
 * stored value, since settings are replaced (not merged) on update.
 */
function stripBlankStringEntries(value: GatewaySettingsRecord): GatewaySettingsRecord {
  const normalizedEntries = Object.entries(value).filter(
    ([, entryValue]) => !(typeof entryValue === 'string' && entryValue.trim().length === 0),
  );
  return Object.fromEntries(normalizedEntries);
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

  const rawSettings = stripBlankStringEntries(value as GatewaySettingsRecord);
  // A submitted value carrying the storage envelope's sentinel would be stored
  // verbatim and then handed to `decryptSettingValue` on every read, which
  // cannot open it and therefore drops the field — the operator's credential
  // would vanish silently. Refusing it here keeps the sentinel meaning exactly
  // one thing: "this panel wrote it".
  if (Object.values(rawSettings).some(looksLikeEnvelopeSentinel)) {
    throw new BadRequestException('PAYMENT_GATEWAY_SETTINGS_INVALID');
  }
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
      case PaymentGatewayType.PLATEGA:
        return stripUndefinedEntries(plategaSettingsSchema.parse(rawSettings));
      case PaymentGatewayType.ANTILOPAY:
        return stripUndefinedEntries(antilopaySettingsSchema.parse(rawSettings));
      case PaymentGatewayType.OVERPAY:
        return stripUndefinedEntries(overpaySettingsSchema.parse(rawSettings));
      case PaymentGatewayType.PAYPALYCH:
        return stripUndefinedEntries(paypalychSettingsSchema.parse(rawSettings));
      case PaymentGatewayType.RIOPAY:
        return stripUndefinedEntries(riopaySettingsSchema.parse(rawSettings));
      case PaymentGatewayType.VALUTIX:
        return stripUndefinedEntries(valutixSettingsSchema.parse(rawSettings));
      case PaymentGatewayType.WATA:
        return stripUndefinedEntries(wataSettingsSchema.parse(rawSettings));
      case PaymentGatewayType.AURAPAY:
        return stripUndefinedEntries(aurapaySettingsSchema.parse(rawSettings));
      case PaymentGatewayType.ROLLYPAY:
        return stripUndefinedEntries(rollypaySettingsSchema.parse(rawSettings));
      case PaymentGatewayType.SEVERPAY:
        return stripUndefinedEntries(severpaySettingsSchema.parse(rawSettings));
      case PaymentGatewayType.LAVA:
        return stripUndefinedEntries(lavaSettingsSchema.parse(rawSettings));
      case PaymentGatewayType.CRYPTOPAY:
        return stripUndefinedEntries(cryptopaySettingsSchema.parse(rawSettings));
      default:
        return stripUndefinedEntries(rawSettings);
    }
  } catch {
    throw new BadRequestException('PAYMENT_GATEWAY_SETTINGS_INVALID');
  }
}

/**
 * The single funnel every payment code path uses to read a gateway's settings,
 * which is why transparent decryption lives here rather than at the ~20 call
 * sites: checkout creation, webhook verification, refunds, reconciliation and
 * the «Мой Налог» processor all keep asking for a plain object and keep getting
 * one.
 *
 * Rows written before at-rest encryption hold plaintext and must keep working —
 * a value is only decrypted when it carries the storage envelope, so a legacy
 * row passes through untouched and is upgraded the next time it is saved. A
 * field whose envelope cannot be opened is dropped rather than surfaced as
 * ciphertext; see `decryptSettingValue`.
 */
export function readGatewaySettings(
  value: Prisma.JsonValue,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const stored = value as Record<string, unknown>;
  // Legacy plaintext rows are the common case on an un-migrated panel and this
  // runs on every checkout, so avoid rebuilding the object when there is
  // nothing to decrypt.
  if (!Object.values(stored).some(isEncryptedSettingValue)) {
    return stored;
  }
  const decrypted: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(stored)) {
    if (!isEncryptedSettingValue(entryValue)) {
      decrypted[key] = entryValue;
      continue;
    }
    const plaintext = decryptSettingValue(entryValue);
    if (plaintext !== null) {
      decrypted[key] = plaintext;
    }
  }
  return decrypted;
}

/**
 * Encrypts the secret-bearing entries of an already-normalized settings object.
 * Applied immediately before the write, so the object handed to Prisma is the
 * only place the ciphertext exists and everything upstream — validation, the
 * readiness guard — reasons about real values.
 *
 * Non-secret entries are copied verbatim: the stored JSON stays browsable, and
 * a `paymentMethod` or a `vat` rate can still be read straight out of the
 * database when a gateway misbehaves.
 */
export function encryptGatewaySettingsForStorage(
  gatewayType: PaymentGatewayType,
  settings: Prisma.InputJsonObject,
): Prisma.InputJsonObject {
  const encrypted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    encrypted[key] =
      typeof value === 'string' && isSecretSettingKey(gatewayType, key)
        ? encryptSettingValue(value)
        : value;
  }
  return encrypted as Prisma.InputJsonObject;
}

/**
 * Replaces secret values with their mask for a caller that may manage gateways
 * but may not see credentials. Returns the masked keys alongside so the admin
 * UI never has to string-sniff a value to know it is hidden.
 *
 * Input must be the DECRYPTED settings (i.e. `readGatewaySettings` output):
 * the mask carries the real last 4 characters, and the update path recognizes
 * an unchanged field by comparing against exactly this rendering.
 */
export function maskGatewaySettings(
  gatewayType: PaymentGatewayType,
  settings: Record<string, unknown>,
): {
  readonly settings: Record<string, unknown>;
  readonly maskedKeys: readonly string[];
} {
  const masked: Record<string, unknown> = {};
  const maskedKeys: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'string' && value.length > 0 && isSecretSettingKey(gatewayType, key)) {
      masked[key] = maskSecretValue(value);
      maskedKeys.push(key);
      continue;
    }
    masked[key] = value;
  }
  return { settings: masked, maskedKeys };
}

/**
 * Turns a submitted settings payload back into real values by substituting the
 * stored credential wherever the caller sent back the mask it was shown.
 *
 * This is what makes write-without-read work. Settings are REPLACED, not
 * merged, so an operator holding only `payment_gateways:edit` — who receives
 * masks — would otherwise save the form and overwrite every live credential
 * with `********`, taking the gateway down. A field whose incoming value
 * matches the mask of what is stored means "unchanged"; anything else is a
 * genuine new value and is written as sent.
 *
 * A masked value with nothing stored behind it is dropped rather than stored
 * literally: there is no credential to keep, and persisting the mask would make
 * `isGatewayConfigured` report a gateway as ready with `********` as its key.
 */
export function resolveMaskedGatewaySettings(
  gatewayType: PaymentGatewayType,
  incoming: Record<string, unknown>,
  storedPlaintext: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value !== 'string' || !isSecretSettingKey(gatewayType, key)) {
      resolved[key] = value;
      continue;
    }
    const stored = storedPlaintext[key];
    const hasStored = typeof stored === 'string' && stored.length > 0;
    if (hasStored && (isMaskOf(value, stored as string) || looksLikeMask(value))) {
      resolved[key] = stored;
      continue;
    }
    if (!hasStored && looksLikeMask(value)) {
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
}

/**
 * "Configured" means the gateway can complete a payment end to end, so the
 * credential the webhook verifier reads counts as required — not just the ones
 * checkout creation needs.
 *
 * Six gateways used to be judged on their checkout credentials alone. The badge
 * turned green, the operator enabled the gateway, checkouts succeeded, and then
 * every callback was rejected with `PAYMENT_WEBHOOK_SIGNATURE_INVALID` because
 * the verifying credential was never stored: money left the buyer, the
 * transaction stayed PENDING, and the expiry sweep cancelled it. Each key below
 * is the one `payment-webhook-normalizer.service.ts` actually reads for that
 * gateway — change one there and this list has to move with it.
 *
 * YooKassa is deliberately absent: it signs nothing, and source-IP allowlisting
 * is its only callback authentication, so there is no credential to require.
 */
export function isGatewayConfigured(
  gatewayType: PaymentGatewayType,
  value: Prisma.JsonValue,
): boolean {
  const settings = readGatewaySettings(value);
  switch (gatewayType) {
    case PaymentGatewayType.TELEGRAM_STARS:
      return typeof settings.webhookSecret === 'string' && settings.webhookSecret.trim().length > 0;
    case PaymentGatewayType.YOOKASSA:
      return (
        hasRequiredStrings(settings, ['shopId', 'apiKey']) ||
        hasRequiredStrings(settings, ['shopId', 'secretKey'])
      );
    case PaymentGatewayType.HELEKET:
      return hasRequiredStrings(settings, ['merchantId', 'apiKey']);
    case PaymentGatewayType.PLATEGA:
      return hasRequiredStrings(settings, ['merchantId', 'secret']);
    case PaymentGatewayType.MULENPAY:
      return hasRequiredStrings(settings, ['apiKey']);
    case PaymentGatewayType.CRYPTOMUS:
      return hasRequiredStrings(settings, ['merchantId', 'apiKey']);
    case PaymentGatewayType.ANTILOPAY:
      // `privateKey` signs our request; `publicKey` verifies Antilopay's
      // `X-Apay-Callback` RSA signature. Different keys, both mandatory.
      return hasRequiredStrings(settings, [
        'projectIdentificator',
        'secretId',
        'privateKey',
        'publicKey',
      ]);
    case PaymentGatewayType.OVERPAY:
      // `publicKey` verifies the RSA `Content-Signature` callback header.
      return hasRequiredStrings(settings, ['shopId', 'secretKey', 'publicKey']);
    case PaymentGatewayType.PAYPALYCH:
      return hasRequiredStrings(settings, ['shopId', 'apiKey']);
    case PaymentGatewayType.RIOPAY:
      return hasRequiredStrings(settings, ['apiToken']);
    case PaymentGatewayType.VALUTIX:
      return hasRequiredStrings(settings, ['apiToken']);
    case PaymentGatewayType.WATA:
      // Wata's pre-payment webhook declines the transaction outright if we do
      // not answer 200 within 10 seconds, so a missing `publicKey` — the
      // SHA512withRSA key from `GET /api/h2h/public-key` — does not merely lose
      // a notification here, it kills the payment before the bank is asked.
      return hasRequiredStrings(settings, ['apiKey', 'publicKey']);
    case PaymentGatewayType.AURAPAY:
      // `secretKey` is the HMAC secret behind the `X-Signature` callback header
      // and is separate from the `apiKey` that authenticates checkout creation.
      return hasRequiredStrings(settings, ['apiKey', 'shopId', 'secretKey']);
    case PaymentGatewayType.ROLLYPAY:
      // `signingSecret` verifies the `X-Signature`/`X-Timestamp` callback pair;
      // `apiKey` only opens the create-payment endpoint.
      return hasRequiredStrings(settings, ['apiKey', 'signingSecret']);
    case PaymentGatewayType.SEVERPAY:
      return hasRequiredStrings(settings, ['mid', 'secretToken']);
    case PaymentGatewayType.LAVA:
      // Lava signs nothing; the callback is authenticated by the separate
      // webhook key echoed back in `X-Api-Key`, issued per recipient in the
      // developer portal and not interchangeable with the gateway `apiKey`.
      return hasRequiredStrings(settings, ['apiKey', 'offerId', 'webhookApiKey']);
    case PaymentGatewayType.CRYPTOPAY:
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
