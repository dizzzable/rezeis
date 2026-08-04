import { Currency, PaymentGatewayType } from '@prisma/client';

export interface AdminPaymentGatewayInterface {
  readonly id: string;
  readonly type: PaymentGatewayType;
  readonly orderIndex: number;
  readonly currency: Currency;
  readonly isActive: boolean;
  /**
   * Gateway settings, decrypted. Secret-bearing values (see
   * `GATEWAY_SECRET_SETTING_KEYS`) are returned in the clear only when the
   * caller holds `payment_gateways:view_secrets`; otherwise each is replaced by
   * `********` followed by its real last 4 characters — `********f3a1` — or a
   * bare `********` when the stored value is shorter than 8 characters.
   * Non-secret values (`shopId`, `paymentMethod`, `vat`, public keys, …) are
   * always returned as stored.
   *
   * A key that is ABSENT means the setting is not configured; a key present
   * with a masked value means it is configured but hidden. Blank values are
   * stripped on save, so there is no third "present but empty" state.
   */
  readonly settings: Record<string, unknown>;
  /**
   * `true` when `settings` carries real secret values, `false` when they are
   * masked. Lets the form decide whether a secret field can be shown/copied,
   * without inspecting the values.
   */
  readonly secretsVisible: boolean;
  /**
   * Secret-bearing keys that currently hold a stored value — i.e. exactly the
   * keys masked in `settings` when `secretsVisible` is `false`. Reported the
   * same way regardless of permission, so the form renders "configured" state
   * identically for both audiences.
   *
   * The rule the UI must implement on save: send a secret field back UNCHANGED
   * to keep the stored credential, send a new value to replace it, and send it
   * blank (or omit it) to clear it. Echoing the mask is what "unchanged" means
   * on the wire, which is what lets an operator who cannot read the secrets
   * still edit everything else on the form without wiping them.
   */
  readonly configuredSecretKeys: readonly string[];
  /**
   * Backend verdict from `isGatewayConfigured` — the same check that decides
   * whether the gateway can issue a checkout. Exposed because the panel used
   * to compute readiness itself ("any non-empty field"), which showed green
   * for gateways the runtime would refuse.
   */
  readonly isConfigured: boolean;
  /**
   * Absolute callback URL the provider must be pointed at. Built from the
   * same `REZEIS_DOMAIN` the checkout code hands to `buildWebhookUrl`, so the
   * operator copies exactly what the provider will be called back on.
   */
  readonly webhookUrl: string;
  readonly isUsedInPricing: boolean;
  readonly activePlanDurationCount: number;
  readonly updatedAt: string;
}
