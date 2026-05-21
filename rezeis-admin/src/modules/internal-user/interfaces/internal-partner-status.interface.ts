/**
 * Lightweight partner-status payload returned to the user-facing edge.
 *
 * Used by reiwa to decide which third bottom-nav tab to render:
 *   - `isActive: false` → "Реферал" tab (referral-only flow)
 *   - `isActive: true`  → "Партнёр" tab (full partner dashboard)
 *
 * Kept intentionally minimal so the SPA can poll it cheaply on every
 * dashboard load without dragging the heavy partner record over the wire.
 */

export interface InternalPartnerStatusInterface {
  /** Whether the user is currently flagged as an active partner. */
  readonly isActive: boolean;
}
