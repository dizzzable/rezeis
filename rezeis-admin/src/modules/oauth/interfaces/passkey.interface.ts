/**
 * Passkey registration options sent to the browser.
 */
export interface PasskeyRegistrationOptions {
  readonly challenge: string;
  readonly rp: { readonly name: string; readonly id: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly pubKeyCredParams: readonly { readonly type: 'public-key'; readonly alg: number }[];
  readonly timeout: number;
  readonly attestation: string;
  readonly authenticatorSelection: {
    readonly authenticatorAttachment?: string;
    readonly residentKey: string;
    readonly userVerification: string;
  };
}

/**
 * Passkey authentication options sent to the browser.
 */
export interface PasskeyAuthenticationOptions {
  readonly challenge: string;
  readonly rpId: string;
  readonly timeout: number;
  readonly userVerification: string;
  readonly allowCredentials: readonly {
    readonly id: string;
    readonly type: 'public-key';
    readonly transports?: readonly string[];
  }[];
}

/**
 * Stored passkey credential (public view — no secrets).
 */
export interface PasskeyCredentialInfo {
  readonly id: string;
  readonly name: string;
  readonly credentialId: string;
  readonly transports: readonly string[];
  readonly backedUp: boolean;
  readonly registeredAt: string;
  readonly lastUsedAt: string | null;
}

/**
 * Which second proof a passkey enrolment has to carry, on top of the bearer
 * token that got the request past `AdminJwtAuthGuard`.
 *
 * `'totp'` when the admin has 2FA on — the same proof `TwoFactorService.disable`
 * demands, TOTP or a recovery code. `'password'` when they do not, because then
 * the password is the only factor left that a stolen session does not already
 * hold.
 */
export type PasskeyReauthFactor = 'totp' | 'password';

/**
 * The proof itself, as it arrives on `POST admin/passkey/register/options`.
 *
 * Both fields are optional on the wire and exactly one is read, chosen by the
 * account's 2FA state rather than by the caller — a caller that could pick
 * would pick the one it has.
 */
export interface PasskeyReauthInput {
  readonly code?: string | null;
  readonly password?: string | null;
}

/**
 * What removing a passkey returns.
 *
 * `accessToken` is non-null exactly when a credential was actually removed:
 * removal bumps `tokenVersion`, which invalidates every outstanding JWT for
 * that admin INCLUDING the one that made this call. The replacement is minted
 * here so the caller can stay signed in; a client that ignores it is signed
 * out on its next request, which is the safe direction to fail.
 */
export interface PasskeyRemovalResult {
  readonly removed: boolean;
  readonly accessToken: string | null;
}
