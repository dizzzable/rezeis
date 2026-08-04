/**
 * AES-256-GCM cipher and masking rules for payment gateway credentials at rest.
 *
 * Mirrors the TOTP / OAuth / AI-config secret pattern already in the panel
 * (`ai-secret-cipher.ts`): a master key from the environment is passed through
 * SHA-256 with a domain separator to derive a 32-byte AES key. What is new here
 * is that the gateway `settings` column is a mixed bag — an API key sits next
 * to a VAT rate — so encryption is applied per FIELD rather than per column,
 * and the stored JSON stays a readable object with only the credential values
 * replaced by envelopes.
 *
 * Storage format of an encrypted value:
 *   `PGENC1:<iv-hex>:<ciphertext-hex>:<auth-tag-hex>`
 *
 * The `PGENC1:` sentinel exists so a read can tell an envelope from a legacy
 * plaintext credential WITHOUT knowing the gateway type — `readGatewaySettings`
 * has only the JSON value, and every one of the ~20 payment call sites goes
 * through it. Shape-sniffing alone (as the AI-config cipher does) would risk
 * mistaking a real credential that happens to look like `hex:hex:hex` for
 * ciphertext, and a payment credential is not something to guess about.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { PaymentGatewayType } from '@prisma/client';

const IV_BYTES = 12; // GCM standard
const TAG_BYTES = 16;

/** Envelope sentinel. Versioned so a future cipher change stays distinguishable. */
const ENVELOPE_PREFIX = 'PGENC1:';

/**
 * Mask body shown instead of a stored credential. Fixed width regardless of the
 * real length — a variable-width mask would leak how long the secret is, which
 * narrows a brute force for free.
 */
const MASK_BODY = '********';

/**
 * Below this length the mask shows no suffix at all. Revealing the last 4 of a
 * 6-character value hands over most of it; above 8 the suffix is a small
 * fraction and is what lets an operator confirm *which* key is installed
 * without being able to reconstruct it.
 */
const MASK_SUFFIX_MIN_LENGTH = 8;

const MASK_SUFFIX_LENGTH = 4;

/**
 * Secret-bearing setting keys per gateway, i.e. the values that authenticate us
 * to the provider or authenticate the provider's callback to us. Everything a
 * schema in `payment-gateway-settings.util.ts` accepts and that is NOT listed
 * here stays readable on purpose:
 *
 *   - merchant / shop / project identifiers (`shopId`, `merchantId`, `mid`,
 *     `projectIdentificator`, `offerId`) are printed on invoices and in the
 *     provider's own dashboard. Encrypting them hides nothing and takes away
 *     the field an operator cross-checks first when a gateway misbehaves.
 *   - public keys (`publicKey` on Wata / Antilopay / Overpay) verify the
 *     provider's callback signature. Wata literally publishes its own at
 *     `GET /api/h2h/public-key`; a "secret" public key is a contradiction.
 *   - behaviour switches and fiscal codes (`paymentMethod`, `serviceId`, `vat`,
 *     `vatCode`, `paymentSubject`, `paymentMode`, `isTestnet`,
 *     `savePaymentMethod`, `selfEmployedEnabled`, `moyNalogAuthMethod`,
 *     `incomeDescriptionTemplate`, `customer`) are configuration, not
 *     credentials, and reading them back is how a wrong Platega
 *     `paymentMethod` or a missing Antilopay `vat` gets diagnosed.
 *   - `moyNalogInn` is a taxpayer number printed on every receipt issued, and
 *     `moyNalogDeviceId` is a client-generated handle that authenticates
 *     nothing on its own — both are what an operator compares against «Мой
 *     Налог» when auth starts failing.
 *
 * Two entries deserve their reasoning spelled out:
 *   - `moyNalogProxy` is a URL, but proxy URLs routinely embed `user:pass@host`,
 *     so it is treated as credential-bearing.
 *   - Antilopay's `secretId` reads like an identifier, yet it travels in the
 *     `X-Apay-Secret-Id` authentication header paired with the RSA signature
 *     and Antilopay names it a secret. Leaving it readable next to an encrypted
 *     `privateKey` would be an odd place to draw the line.
 */
export const GATEWAY_SECRET_SETTING_KEYS: Readonly<
  Record<PaymentGatewayType, readonly string[]>
> = {
  [PaymentGatewayType.TELEGRAM_STARS]: ['providerToken', 'webhookSecret'],
  [PaymentGatewayType.YOOKASSA]: [
    'apiKey',
    'secretKey',
    'moyNalogPassword',
    'moyNalogRefreshToken',
    'moyNalogProxy',
  ],
  [PaymentGatewayType.HELEKET]: ['apiKey'],
  [PaymentGatewayType.CRYPTOMUS]: ['apiKey'],
  [PaymentGatewayType.MULENPAY]: ['apiKey', 'secretKey'],
  [PaymentGatewayType.PLATEGA]: ['secret'],
  [PaymentGatewayType.ANTILOPAY]: ['secretId', 'privateKey'],
  [PaymentGatewayType.OVERPAY]: ['secretKey'],
  [PaymentGatewayType.PAYPALYCH]: ['apiKey', 'secretKey'],
  [PaymentGatewayType.RIOPAY]: ['apiToken'],
  [PaymentGatewayType.VALUTIX]: ['apiToken'],
  [PaymentGatewayType.WATA]: ['apiKey', 'webhookSecret'],
  [PaymentGatewayType.AURAPAY]: ['apiKey', 'secretKey'],
  [PaymentGatewayType.ROLLYPAY]: ['apiKey', 'signingSecret'],
  [PaymentGatewayType.SEVERPAY]: ['secretToken'],
  [PaymentGatewayType.LAVA]: ['apiKey', 'webhookApiKey'],
  [PaymentGatewayType.CRYPTOPAY]: ['apiToken'],
  // Internal wallet method — the partner balance is debited in-process and no
  // external provider is ever called, so there is no credential to protect.
  // Listed explicitly (rather than left to a lookup default) so this map stays
  // exhaustive over the enum and a newly added gateway fails the build until
  // someone has decided which of its fields are secret.
  [PaymentGatewayType.PARTNER_BALANCE]: [],
} as const;

export function isSecretSettingKey(gatewayType: PaymentGatewayType, key: string): boolean {
  return (GATEWAY_SECRET_SETTING_KEYS[gatewayType] ?? []).includes(key);
}

function deriveKey(cryptKey: string): Buffer {
  return createHash('sha256').update(`rezeis-admin:payment-gateway:${cryptKey}`).digest();
}

/**
 * Key material, most-preferred first.
 *
 * `PAYMENT_GATEWAY_CRYPT_KEY` is optional and overrides the master key for this
 * one domain — an operator who wants payment credentials on a separate rotation
 * schedule sets it. `REZEIS_CRYPT_KEY` is the fallback and is NOT optional:
 * `env.schema.ts` has always failed the boot without it, which is why this
 * change does not need to add a second hard boot requirement. Making the new
 * variable mandatory would brick every existing install on upgrade, and this is
 * a live payments path.
 *
 * Decryption tries every candidate, so adding `PAYMENT_GATEWAY_CRYPT_KEY` to a
 * panel whose rows were written under the master key keeps those rows readable;
 * the next save rewrites them under the preferred key.
 */
function cryptKeyCandidates(): readonly string[] {
  const candidates = [
    process.env.PAYMENT_GATEWAY_CRYPT_KEY ?? '',
    process.env.REZEIS_CRYPT_KEY ?? '',
  ].filter((candidate) => candidate.trim().length > 0);
  return Array.from(new Set(candidates));
}

export function isEncryptedSettingValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Encrypts one credential.
 *
 * Throws when no key material is configured rather than falling back to a
 * key derived from the empty string. That fallback would produce ciphertext
 * anyone can decrypt while every downstream check reports the value as
 * encrypted — strictly worse than an obvious failure, because it is the one
 * outcome nobody would notice. In a booted app this cannot trigger
 * (`REZEIS_CRYPT_KEY` is validated at startup); it is the guard that makes
 * "a missing key never silently stores plaintext" true by construction.
 */
export function encryptSettingValue(plaintext: string): string {
  const cryptKey = cryptKeyCandidates()[0];
  if (cryptKey === undefined) {
    throw new Error(
      'Cannot encrypt payment gateway secrets: neither PAYMENT_GATEWAY_CRYPT_KEY nor REZEIS_CRYPT_KEY is set',
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(cryptKey), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

/**
 * Decrypts an envelope, or returns `null` when it cannot be read under any
 * configured key. `null` — rather than the raw ciphertext — is what the caller
 * must propagate: handing a provider a ciphertext string as its API key would
 * fail authentication on a live payment while `isGatewayConfigured` still
 * reported the gateway as ready. Dropping the field instead flips readiness to
 * false, which is visible in the panel, and the row is untouched so fixing the
 * key restores it.
 */
export function decryptSettingValue(payload: string): string | null {
  const parts = payload.slice(ENVELOPE_PREFIX.length).split(':');
  if (parts.length !== 3) {
    return null;
  }
  const [ivHex, ciphertextHex, tagHex] = parts;
  const iv = Buffer.from(ivHex!, 'hex');
  const ciphertext = Buffer.from(ciphertextHex!, 'hex');
  const tag = Buffer.from(tagHex!, 'hex');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    return null;
  }
  for (const cryptKey of cryptKeyCandidates()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', deriveKey(cryptKey), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // GCM tag mismatch — wrong key. Try the next candidate before giving up.
    }
  }
  return null;
}

/**
 * Renders the value the ordinary `payment_gateways:view` holder sees.
 *
 * Last-4 rather than a bare blob: an operator running several projects needs to
 * confirm that the key installed here is the one from the right merchant
 * account, and the provider's own dashboard shows the same tail. A pure
 * `********` forces them to re-paste a working credential to be sure, and every
 * needless re-paste of a live payment secret is a chance to paste the wrong one.
 */
export function maskSecretValue(plaintext: string): string {
  if (plaintext.length < MASK_SUFFIX_MIN_LENGTH) {
    return MASK_BODY;
  }
  return `${MASK_BODY}${plaintext.slice(-MASK_SUFFIX_LENGTH)}`;
}

/**
 * True when `candidate` is exactly the mask this module would render for
 * `storedPlaintext`. This exact form is the contract the admin UI implements:
 * echo the value back unchanged and the stored credential is kept.
 */
export function isMaskOf(candidate: string, storedPlaintext: string): boolean {
  return candidate === maskSecretValue(storedPlaintext);
}

/**
 * True for anything carrying the mask body, not just the exact rendering of the
 * current stored value.
 *
 * The two ways to get this wrong are not equally bad. Mistaking a real new
 * credential for a mask means the operator's key silently fails to save.
 * Mistaking a mask for a real credential means a live gateway's key is replaced
 * by `********` and payments stop. The second is the one to design against, so
 * mask recognition is deliberately the more permissive side — and a value
 * beginning with eight literal asterisks is not a credential any provider
 * issues, so nothing legitimate is caught by it.
 */
export function looksLikeMask(value: string): boolean {
  return value.startsWith(MASK_BODY);
}

/** Rejects operator input that impersonates the storage envelope. */
export function looksLikeEnvelopeSentinel(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}
