import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Remnawave Profile Naming Service
 * ─────────────────────────────────
 * Generates the username and description for a Remnawave profile based on:
 *   - Global naming template from Settings.
 *   - Per-user override (if configured).
 *   - Auto-increment suffix for multiple subscriptions.
 *
 * Naming pattern:
 *   `{prefix}_{username}_{suffix}`
 *
 * Where:
 *   - prefix: configurable (default "rz"), from Settings.profileNamingSettings JSON
 *   - username: user's login/username or telegramId
 *   - suffix: "sub" for first, "sub_1" for second, "sub_2" for third, etc.
 *
 * Description format (for internal consistency):
 *   ```
 *   name: {user.name}
 *   username: {user.username}
 *   reiwa_id: {user.id}
 *   ```
 *
 * This ensures:
 *   - Unique identification of each subscription on Remnawave
 *   - Reverse lookup from Remnawave → rezeis-admin via reiwa_id
 *   - Safe backup/restore and cross-panel sync
 */

interface NamingConfig {
  prefix: string;
  separator: string;
  suffixBase: string;
}

interface ProfileNamingResult {
  /** Username for Remnawave (e.g. "rz_john_sub", "rz_john_sub_1") */
  readonly username: string;
  /** Description field for Remnawave */
  readonly description: string;
}

const DEFAULT_CONFIG: NamingConfig = {
  prefix: 'rz',
  separator: '_',
  suffixBase: 'sub',
};

/**
 * Reduces an arbitrary identity string (login, username, telegramId) to a
 * Remnawave-safe slug: only `[A-Za-z0-9_-]` survive, runs of disallowed
 * characters collapse to a single `_`, and leading/trailing separators are
 * trimmed. Email-like logins (`john.doe@mail.com`) become `john_doe_mail_com`.
 */
function sanitizePanelIdentifier(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
}

@Injectable()
export class RemnawaveProfileNamingService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Generates the Remnawave profile username and description for a subscription.
   *
   * The suffix is derived from the subscription's **stable ordinal** among the
   * user's subscriptions (ordered by creation), NOT a live total count — so two
   * subscriptions of the same user get distinct, deterministic usernames
   * (`rz_john_sub`, `rz_john_sub_1`) and re-running a sync never collides with
   * an already-provisioned profile on the panel.
   *
   * @param userId - The rezeis-admin user ID (cuid)
   * @param subscriptionId - The subscription being provisioned (for ordinal).
   */
  public async generateProfileName(
    userId: string,
    subscriptionId?: string,
  ): Promise<ProfileNamingResult> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        name: true,
        telegramId: true,
        email: true,
        webAccount: { select: { login: true } },
      },
    });

    if (!user) {
      throw new Error(`User ${userId} not found for profile naming`);
    }

    const config = await this.loadNamingConfig();
    // Identity precedence for the panel username: the user's web-account
    // login (the credential a web-first user actually signs in with) wins,
    // then the Telegram @username, then the numeric telegramId, and finally
    // the reiwa_id prefix as a last resort. Previously `login` was never
    // queried, so pure web users fell through to `id.slice(0,8)` and their
    // panel profile looked like an internal id.
    const rawIdentifier =
      user.webAccount?.login ??
      user.username ??
      user.telegramId?.toString() ??
      user.id.slice(0, 8);
    // Remnawave usernames only allow [A-Za-z0-9_-]. Logins may be email-like
    // (contain `@`, `.`), so sanitise to a safe slug; fall back to the
    // reiwa_id prefix if sanitising leaves nothing usable.
    const userIdentifier = sanitizePanelIdentifier(rawIdentifier) || user.id.slice(0, 8);

    // Determine this subscription's stable ordinal among the user's subs
    // (oldest = 0). Falls back to the live count when no id is supplied.
    const ordinal = await this.resolveSubscriptionOrdinal(userId, subscriptionId);

    const suffix = ordinal === 0
      ? config.suffixBase
      : `${config.suffixBase}${config.separator}${ordinal}`;

    const username = [config.prefix, userIdentifier, suffix]
      .filter(Boolean)
      .join(config.separator);

    // Build description with internal identifiers
    const descriptionLines: string[] = [];
    if (user.name) descriptionLines.push(`name: ${user.name}`);
    if (user.webAccount?.login) descriptionLines.push(`login: ${user.webAccount.login}`);
    if (user.username) descriptionLines.push(`username: ${user.username}`);
    descriptionLines.push(`reiwa_id: ${user.id}`);

    return {
      username,
      description: descriptionLines.join('\n'),
    };
  }

  /**
   * Resolves the 0-based position of `subscriptionId` among the user's
   * subscriptions ordered by creation. Stable across re-runs, so the
   * generated username never changes for a given subscription. When
   * `subscriptionId` is omitted (legacy callers) it falls back to the
   * current subscription count.
   */
  private async resolveSubscriptionOrdinal(
    userId: string,
    subscriptionId?: string,
  ): Promise<number> {
    const subs = await this.prismaService.subscription.findMany({
      where: { userId },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (subscriptionId === undefined) {
      return subs.length === 0 ? 0 : subs.length - 1;
    }
    const index = subs.findIndex((s) => s.id === subscriptionId);
    return index < 0 ? subs.length : index;
  }

  /**
   * Returns the contact info to set on the Remnawave profile.
   */
  public async getContactInfo(userId: string): Promise<{
    telegramId: string | null;
    email: string | null;
  }> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: {
        telegramId: true,
        email: true,
        // The second place an e-mail lives, and for a large share of
        // customers the ONLY place. `User.email` is a unique column that
        // social sign-up deliberately leaves unset — the identity lives on
        // the `WebAccount`, so setting it there too would collide with an
        // imported row carrying the same address.
        //
        // Reading only the first column therefore pushed a NULL e-mail to
        // the VPN panel for every Google / Yandex / Mail.ru customer, and
        // for anybody whose address was added after registration. The panel
        // showed a profile with no contact while the panel screen beside it
        // showed the address.
        webAccount: { select: { email: true, emailNormalized: true } },
      },
    });
    return {
      telegramId: user?.telegramId?.toString() ?? null,
      // Order is deliberate: the canonical column first, then the account
      // the customer actually signs in with. `email` before
      // `emailNormalized` so the panel shows the address as it was typed.
      email:
        user?.email ??
        user?.webAccount?.email ??
        user?.webAccount?.emailNormalized ??
        null,
    };
  }

  private async loadNamingConfig(): Promise<NamingConfig> {
    const settings = await this.prismaService.settings.findFirst({
      select: { brandingSettings: true },
    });
    if (!settings) return DEFAULT_CONFIG;

    // Profile naming lives inside brandingSettings JSON for now
    // (can be moved to its own field later)
    const json = settings.brandingSettings as Record<string, unknown>;
    const naming = (json?.profileNaming ?? {}) as Record<string, unknown>;

    return {
      prefix: typeof naming.prefix === 'string' && naming.prefix.length > 0
        ? naming.prefix
        : DEFAULT_CONFIG.prefix,
      separator: typeof naming.separator === 'string' && naming.separator.length > 0
        ? naming.separator
        : DEFAULT_CONFIG.separator,
      suffixBase: typeof naming.suffixBase === 'string' && naming.suffixBase.length > 0
        ? naming.suffixBase
        : DEFAULT_CONFIG.suffixBase,
    };
  }
}
