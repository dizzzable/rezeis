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
  readonly role: string;
  readonly language: string;
  readonly isBlocked: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminUserListResultInterface {
  readonly items: readonly AdminUserListItemInterface[];
  readonly total: number;
}
