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
