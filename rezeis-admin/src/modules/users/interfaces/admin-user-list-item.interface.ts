/**
 * Lightweight projection used by the admin Users list page.
 *
 * The list endpoint intentionally returns a flat row optimized for the
 * left-rail picker — heavy aggregates (subscriptions, transactions,
 * partner state, etc.) live behind the per-user detail endpoint.
 */
export interface AdminUserListItemInterface {
  readonly id: string;
  readonly telegramId: string | null;
  readonly username: string | null;
  readonly email: string | null;
  readonly name: string;
  readonly login: string | null;
  readonly role: string;
  readonly language: string;
  readonly isBlocked: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Latest reported cabinet activity (`User.lastSeenAt`), ISO-8601 or `null`.
   * Drives the list's online/AFK status dot — a real activity signal, unlike
   * `updatedAt` which only bumps when the User row is written.
   */
  readonly lastSeenAt: string | null;
}

export interface AdminUserListResultInterface {
  readonly items: readonly AdminUserListItemInterface[];
  readonly total: number;
}
