import { Injectable, Logger } from '@nestjs/common';
import { AccessMode } from '@prisma/client';

/**
 * Named gates that the access-mode guard discriminates on. Keep the list
 * exhaustive — adding a new gate forces every caller and every
 * `evaluate()` branch to acknowledge it.
 */
export type AccessModeGate =
  /** Any new User row creation (web register or bot bootstrap). */
  | 'register'
  /** Existing user authentication (web login). */
  | 'login'
  /** NEW / ADDITIONAL purchases. */
  | 'purchase.new'
  /** UPGRADE purchases. */
  | 'purchase.upgrade'
  /** Add-on purchases. */
  | 'purchase.addon'
  /** Renewal of an existing subscription. */
  | 'purchase.renewal'
  /** Subscription mutations (delete / regenerate / device revoke). */
  | 'subscription.mutate';

/** Stable machine-readable rejection codes shared with the SPA / bot. */
export type AccessModeRejectionCode =
  | 'REGISTRATION_DISABLED'
  | 'PURCHASES_DISABLED'
  | 'INVITE_REQUIRED'
  | 'SERVICE_RESTRICTED';

export interface AccessModeRejection {
  readonly code: AccessModeRejectionCode;
  readonly status: 403 | 503;
  /** Localised default; clients may override using their own translations. */
  readonly message: string;
}

/**
 * AccessModeGuard
 * ───────────────
 * Pure decision layer for the platform-wide `Settings.accessMode` gate.
 * Callers load the current mode (one DB read, already memoised by
 * {@link SettingsService.getInternalPlatformPolicy}) and ask the guard
 * whether a specific request passes for the given gate.
 *
 * Returns `null` when the request passes; an `AccessModeRejection`
 * otherwise. Translating the rejection into an HTTP response (which
 * Nest exception class to throw) is the caller's responsibility — the
 * guard stays framework-agnostic so the same logic can run in jobs and
 * background processors without throwing.
 *
 * Two-layer enforcement:
 *   - the reiwa edge runs the same logic locally to short-circuit
 *     before hitting admin (see `reiwa/src/api/middleware/access-mode.ts`),
 *   - rezeis-admin runs this guard inside `WebAuthService.register`,
 *     `PaymentsCheckoutService.checkout`, etc. so a direct internal
 *     call cannot bypass the UI gate.
 */
@Injectable()
export class AccessModeGuard {
  private readonly logger = new Logger(AccessModeGuard.name);

  public evaluate(input: {
    readonly gate: AccessModeGate;
    readonly mode: AccessMode;
    /** True when the caller has produced a referral code (for `register`). */
    readonly hasInvite?: boolean;
  }): AccessModeRejection | null {
    const decision = this.decide(input);
    if (decision !== null) {
      this.logger.log(
        `access-mode reject gate=${input.gate} mode=${input.mode} code=${decision.code}`,
      );
    }
    return decision;
  }

  private decide(input: {
    readonly gate: AccessModeGate;
    readonly mode: AccessMode;
    readonly hasInvite?: boolean;
  }): AccessModeRejection | null {
    const { gate, mode, hasInvite = false } = input;

    // RESTRICTED freezes every interactive flow regardless of gate.
    if (mode === AccessMode.RESTRICTED) {
      return SERVICE_RESTRICTED;
    }

    switch (gate) {
      case 'register':
        if (mode === AccessMode.REG_BLOCKED) return REGISTRATION_DISABLED;
        if (mode === AccessMode.INVITED && !hasInvite) return INVITE_REQUIRED;
        return null;

      case 'login':
        // Only RESTRICTED blocks login (handled above).
        return null;

      case 'purchase.new':
      case 'purchase.upgrade':
      case 'purchase.addon':
        if (mode === AccessMode.PURCHASE_BLOCKED) return PURCHASES_DISABLED;
        return null;

      case 'purchase.renewal':
        // Renewal stays open under PURCHASE_BLOCKED so existing customers
        // don't lose VPN. Only RESTRICTED blocks it (handled above).
        return null;

      case 'subscription.mutate':
        // Only RESTRICTED blocks subscription mutations. PURCHASE_BLOCKED
        // does not freeze cancellation or device regeneration.
        return null;

      default: {
        // Exhaustiveness guard. Adding a new `AccessModeGate` value
        // surfaces here as a TS error.
        const _exhaustive: never = gate;
        return _exhaustive;
      }
    }
  }
}

const REGISTRATION_DISABLED: AccessModeRejection = {
  code: 'REGISTRATION_DISABLED',
  status: 403,
  message: 'Registration is currently disabled',
};

const PURCHASES_DISABLED: AccessModeRejection = {
  code: 'PURCHASES_DISABLED',
  status: 403,
  message: 'New purchases are temporarily unavailable',
};

const INVITE_REQUIRED: AccessModeRejection = {
  code: 'INVITE_REQUIRED',
  status: 403,
  message: 'Registration is invite-only — a valid referral code is required',
};

const SERVICE_RESTRICTED: AccessModeRejection = {
  code: 'SERVICE_RESTRICTED',
  status: 503,
  message: 'Service is temporarily unavailable',
};
