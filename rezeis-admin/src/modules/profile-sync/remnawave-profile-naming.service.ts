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

@Injectable()
export class RemnawaveProfileNamingService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Generates the Remnawave profile username and description for a new subscription.
   *
   * @param userId - The rezeis-admin user ID (cuid)
   */
  public async generateProfileName(userId: string): Promise<ProfileNamingResult> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        name: true,
        telegramId: true,
        email: true,
      },
    });

    if (!user) {
      throw new Error(`User ${userId} not found for profile naming`);
    }

    const config = await this.loadNamingConfig();
    const userIdentifier = user.username ?? user.telegramId?.toString() ?? user.id.slice(0, 8);

    // Count existing subscriptions to determine suffix
    const existingSubCount = await this.prismaService.subscription.count({
      where: { userId },
    });

    const suffix = existingSubCount === 0
      ? config.suffixBase
      : `${config.suffixBase}${config.separator}${existingSubCount}`;

    const username = [config.prefix, userIdentifier, suffix]
      .filter(Boolean)
      .join(config.separator);

    // Build description with internal identifiers
    const descriptionLines: string[] = [];
    if (user.name) descriptionLines.push(`name: ${user.name}`);
    if (user.username) descriptionLines.push(`username: ${user.username}`);
    descriptionLines.push(`reiwa_id: ${user.id}`);

    return {
      username,
      description: descriptionLines.join('\n'),
    };
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
      select: { telegramId: true, email: true },
    });
    return {
      telegramId: user?.telegramId?.toString() ?? null,
      email: user?.email ?? null,
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
