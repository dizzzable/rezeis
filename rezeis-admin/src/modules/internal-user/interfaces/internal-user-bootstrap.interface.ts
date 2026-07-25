/**
 * Inputs accepted by `POST /api/internal/user/bootstrap`.
 *
 * The reiwa bot calls this on every `/start`. We treat the call as
 * idempotent: if the user already exists, we refresh `username`/`name`/
 * `language` from the latest Telegram payload (so renames / locale changes
 * propagate without operator action). Otherwise we create the row.
 */
export interface InternalBootstrapUserInput {
  readonly telegramId: string;
  readonly username?: string | null;
  readonly name: string;
  readonly language?: string | null;
  /**
   * Referral token from a `ref_<token>` bot deep-link. Bound to the
   * inviter only when this call creates a brand-new user. Best-effort.
   */
  readonly referralCode?: string | null;
}
