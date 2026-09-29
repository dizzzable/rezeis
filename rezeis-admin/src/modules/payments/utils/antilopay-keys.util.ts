import { createPrivateKey } from 'node:crypto';

import { signAntilopayBody, toAntilopayPrivateKeyPem } from './antilopay-api.util';
import { createWebhookPublicKey } from './webhook-public-key.util';

/**
 * What is wrong with the two keys of the Antilopay settings, checked when they
 * are SAVED.
 *
 * The keys are two long strings from the same page of Antilopay's cabinet, and
 * the form used to store whatever was pasted. A pair pasted into the wrong
 * fields, or a key cut short by the clipboard, came to light only on the first
 * payment (the private key: the signature is refused) or on the first callback
 * (the public key: a 403, the money taken and the payment stuck PENDING).
 *
 * Neither check asks Antilopay: they read the keys exactly as the code that
 * uses them will.
 *   - the private key is accepted when it SIGNS the way a checkout signs, so
 *     "accepted" is "usable", whatever armor or line wrapping it came with;
 *   - the public key is accepted when the webhook check can read it, and it
 *     must NOT read as a private key. `createPublicKey` alone would accept a
 *     private key in PEM form (it derives the public half), so a private key
 *     pasted into the public field would be stored, would verify callbacks,
 *     and would sit there, in the clear, in a field nobody guards.
 *
 * No prefix is enforced: a public key usually starts with «MF» (a short one),
 * a 2048-bit one with «MIIB», and neither is a rule.
 */
export type AntilopayKeyProblem =
  | 'PRIVATE_KEY_UNREADABLE'
  | 'PRIVATE_KEY_IS_PUBLIC'
  | 'PUBLIC_KEY_UNREADABLE'
  | 'PUBLIC_KEY_IS_PRIVATE';

/**
 * The product code each problem is refused with. Restated as literals in the
 * exception filter's allowlist (`SAFE_PRODUCT_CODES`) and in the settings page,
 * which words each in Russian and English; `admin-safe-exception.filter.spec.ts`
 * checks the correspondence by value.
 */
export const ANTILOPAY_KEY_REFUSAL_CODES: Readonly<Record<AntilopayKeyProblem, string>> = {
  PRIVATE_KEY_UNREADABLE: 'ANTILOPAY_PRIVATE_KEY_UNREADABLE',
  PRIVATE_KEY_IS_PUBLIC: 'ANTILOPAY_PRIVATE_KEY_IS_PUBLIC',
  PUBLIC_KEY_UNREADABLE: 'ANTILOPAY_PUBLIC_KEY_UNREADABLE',
  PUBLIC_KEY_IS_PRIVATE: 'ANTILOPAY_PUBLIC_KEY_IS_PRIVATE',
};

/** Signs what a checkout signs: the private key as Antilopay's requests will use it. */
export function signsLikeCheckout(value: string): boolean {
  try {
    signAntilopayBody('{}', toAntilopayPrivateKeyPem(value));
    return true;
  } catch {
    return false;
  }
}

/** Reads as a private key, in any of the forms a checkout accepts. */
function isPrivateKey(value: string): boolean {
  try {
    createPrivateKey(toAntilopayPrivateKeyPem(value));
    return true;
  } catch {
    return false;
  }
}

/** Reads the way the callback check reads the public key (PEM or bare base64 DER). */
function isPublicKey(value: string): boolean {
  try {
    createWebhookPublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function readKey(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The first problem with the keys about to be stored, or null. A key that is
 * absent is not a problem here: what makes a gateway usable is
 * `isGatewayConfigured`, and an operator saving the project id alone is saving
 * a draft.
 */
export function findAntilopayKeyProblem(settings: {
  readonly privateKey?: unknown;
  readonly publicKey?: unknown;
}): AntilopayKeyProblem | null {
  const privateKey = readKey(settings.privateKey);
  if (privateKey.trim().length > 0 && !signsLikeCheckout(privateKey)) {
    return !isPrivateKey(privateKey) && isPublicKey(privateKey) ? 'PRIVATE_KEY_IS_PUBLIC' : 'PRIVATE_KEY_UNREADABLE';
  }
  const publicKey = readKey(settings.publicKey);
  if (publicKey.trim().length > 0) {
    if (isPrivateKey(publicKey)) return 'PUBLIC_KEY_IS_PRIVATE';
    if (!isPublicKey(publicKey)) return 'PUBLIC_KEY_UNREADABLE';
  }
  return null;
}
