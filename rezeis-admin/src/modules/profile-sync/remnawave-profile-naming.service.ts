import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { verifiedTelegramUsername } from '../users/utils/verified-telegram-username.util';
import { descriptionFieldValue, ownerMarkerLine } from './panel-owner-marker';

export { readProfileOwnerMarker } from './panel-owner-marker';

/**
 * Remnawave Profile Naming Service
 * ─────────────────────────────────
 * Generates the username and description for a Remnawave profile.
 *
 * Naming pattern:
 *   `{prefix}{sep}{identity}{sep}{suffix}` — `rz_johnny_sub`, `rz_johnny_sub_1`
 *
 * The identity of a NEW profile (owner's decision of 18.09.2026), first that
 * exists wins:
 *   1. the @username of the customer's LINKED Telegram account — as Telegram
 *      itself reported it (`User.telegramUsername`, valid only while its
 *      `telegramUsernameTgId` is the account linked now), never
 *      `User.username`, which importers and the admin form write too;
 *   2. the web-cabinet login;
 *   3. the numeric Telegram id;
 *   4. the first eight characters of the reiwa_id.
 *
 * The rule before it put the login first. A profile's name is fixed when it is
 * created — no Remnawave version renames a user through its API (`PATCH`
 * ignores a new username) — so every profile made under that rule keeps its
 * name for good. This service therefore also reports the name the previous
 * rule gives ({@link ProfileNamingResult.legacyUsernames}), so a lookup can
 * still find such a profile, and two fallback names for when the name belongs
 * to somebody else ({@link ProfileNamingResult.fallbackUsernames}). Nothing
 * here renames anything; the CREATE path only ever LOOKS UP the extra names.
 *
 * Description format (rewritten on every sync, one field per line):
 *   ```
 *   name: {user.name}
 *   login: {webAccount.login}
 *   username: {user.username}
 *   reiwa_id: {user.id}
 *   ```
 * The `reiwa_id` line is the ownership marker: the CREATE path adopts an
 * existing profile only when it names this customer (see
 * {@link readProfileOwnerMarker}), and the Remnawave importer resolves identity
 * by it.
 */

/** The three operator-set parts of a profile name. */
export interface NamingConfig {
  readonly prefix: string;
  readonly separator: string;
  readonly suffixBase: string;
}

export interface ProfileNamingResult {
  /**
   * The name a NEW profile for this subscription gets, before the panel's
   * length clamp (`clampPanelUsername`).
   */
  readonly username: string;
  /** Description field for Remnawave. */
  readonly description: string;
  /**
   * Names this subscription's profile may ALREADY carry because it was created
   * under the login-first rule. For lookups only — never created, never renamed
   * to. Empty when the previous rule gives the same name, or a name the panel
   * could never have accepted. Absent means none.
   */
  readonly legacyUsernames?: readonly string[];
  /**
   * Names a new profile takes, in order, when `username` belongs to a profile
   * that is not provably this customer's. Derived from the subscription id, so
   * every retry offers the same names and finds a profile an earlier attempt
   * created under one of them. Absent means none.
   */
  readonly fallbackUsernames?: readonly string[];
}

const DEFAULT_CONFIG: NamingConfig = {
  prefix: 'rz',
  separator: '_',
  suffixBase: 'sub',
};

/**
 * The longest stored value each part keeps. The same limits as
 * `readProfileNaming` in `branding-settings.util.ts` — the reader the settings
 * page loads — so the form and the names it produces agree: a longer stored
 * value reads as the default in both places.
 */
const PART_MAX_LENGTH: Readonly<Record<keyof NamingConfig, number>> = {
  prefix: 16,
  separator: 2,
  suffixBase: 32,
};

/** Remnawave's username alphabet, identical on 2.x and 3.x. */
const PANEL_USERNAME_ALPHABET = /^[A-Za-z0-9_-]+$/;

/** How many fallback names a subscription is offered. */
const FALLBACK_COUNT = 2;
/** Hex characters of the tag that sets a fallback name apart. */
const FALLBACK_TAG_LENGTH = 6;
/**
 * Versioned on purpose: the tag has to come out the same on every retry and in
 * every release, or a CREATE retried across a deploy could not find the
 * profile its first attempt made.
 */
const FALLBACK_TAG_DOMAIN = 'rezeis-profile-name-fallback:v1';

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

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * One part as the settings page reads it: a non-empty string within its limit,
 * else the default. Mirrors `readProfileNaming`.
 */
function storedPart(naming: Record<string, unknown>, key: keyof NamingConfig): string {
  const value = naming[key];
  return typeof value === 'string' && value.length > 0 && value.length <= PART_MAX_LENGTH[key]
    ? value
    : DEFAULT_CONFIG[key];
}

/**
 * One part as it goes into a NEW name.
 *
 * A valid stored value is used exactly as stored. An invalid one — saved
 * before the settings form checked the alphabet, or carried in by a config
 * import — is repaired rather than sent: the panel refuses the whole CREATE
 * for one bad character, so sending it failed every new subscription. Runs of
 * invalid characters become `_` («my shop» → `my_shop`); a separator that is
 * not valid is replaced by the default; a part with nothing valid left falls
 * back to the default. The settings form shows the same repair as a warning.
 */
function usablePart(naming: Record<string, unknown>, key: keyof NamingConfig): string {
  const stored = storedPart(naming, key);
  if (PANEL_USERNAME_ALPHABET.test(stored)) return stored;
  if (key === 'separator') return DEFAULT_CONFIG.separator;
  const repaired = sanitizePanelIdentifier(stored).slice(0, PART_MAX_LENGTH[key]);
  return repaired.length > 0 ? repaired : DEFAULT_CONFIG[key];
}

/**
 * The naming parts a NEW profile is named with, read from
 * `Settings.brandingSettings`. Exported so a test can hold it to the settings
 * page's reader.
 */
export function readProfileNamingConfig(brandingSettings: unknown): NamingConfig {
  const naming = readRecord(readRecord(brandingSettings)['profileNaming']);
  return {
    prefix: usablePart(naming, 'prefix'),
    separator: usablePart(naming, 'separator'),
    suffixBase: usablePart(naming, 'suffixBase'),
  };
}

/**
 * The parts exactly as the reader before 18.09.2026 took them: any non-empty
 * string, no limit, no repair. Only for rebuilding the names existing profiles
 * were created with — a lookup has to reproduce the old name byte for byte.
 */
function readLegacyNamingConfig(brandingSettings: unknown): NamingConfig {
  const naming = readRecord(readRecord(brandingSettings)['profileNaming']);
  const part = (key: keyof NamingConfig): string => {
    const value = naming[key];
    return typeof value === 'string' && value.length > 0 ? value : DEFAULT_CONFIG[key];
  };
  return { prefix: part('prefix'), separator: part('separator'), suffixBase: part('suffixBase') };
}

interface NamingUser {
  readonly id: string;
  /** Read only by the login-first rule below; a new name never uses it. */
  readonly username: string | null;
  readonly name: string;
  readonly telegramId: bigint | null;
  /** The pair only the Telegram-verified bootstrap writes — see `verifiedTelegramUsername`. */
  readonly telegramUsername: string | null;
  readonly telegramUsernameTgId: bigint | null;
  /** `login` is optional on a web account: social sign-up creates none. */
  readonly webAccount: { readonly login: string | null } | null;
}

/**
 * The identity of a NEW profile: the linked account's @username, the login,
 * the Telegram id, the reiwa_id prefix.
 *
 * The @username is the one TELEGRAM reported for the account linked NOW, and
 * nothing else. `User.username` cannot say that: the importers copy a donor's
 * record of it (the Remnawave importer a foreign panel's handle), the admin
 * «create user» form takes free text, and it survives a rebind or a merge still
 * naming the previous account. The verified pair has one writer, the bootstrap
 * that runs on /start and the Mini App sign-in, and counts only while its id is
 * the row's `telegramId` — so a customer no /start has reached since the pair
 * existed is named by their login until their next one.
 */
function currentIdentifier(user: NamingUser): string {
  const candidates = [
    verifiedTelegramUsername(user),
    user.webAccount?.login ?? null,
    user.telegramId?.toString() ?? null,
  ];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const slug = sanitizePanelIdentifier(candidate);
    if (slug.length > 0) return slug;
  }
  return user.id.slice(0, 8);
}

/** The identity the login-first rule gave, reproduced exactly. */
function legacyIdentifier(user: NamingUser): string {
  const rawIdentifier =
    user.webAccount?.login ??
    user.username ??
    user.telegramId?.toString() ??
    user.id.slice(0, 8);
  return sanitizePanelIdentifier(rawIdentifier) || user.id.slice(0, 8);
}

function fallbackTag(key: string, index: number): string {
  return createHash('sha256')
    .update(`${FALLBACK_TAG_DOMAIN}:${key}:${index}`)
    .digest('hex')
    .slice(0, FALLBACK_TAG_LENGTH);
}

/** `{prefix}{sep}{identity}[{sep}{tag}]{sep}{suffix}[{sep}{ordinal}]`. */
function assembleName(
  config: NamingConfig,
  identifier: string,
  ordinal: number,
  tag?: string,
): string {
  const suffix = ordinal === 0
    ? config.suffixBase
    : `${config.suffixBase}${config.separator}${ordinal}`;
  return [config.prefix, identifier, tag, suffix]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(config.separator);
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
   * @param subscriptionId - The subscription being provisioned (for the ordinal
   *   and the fallback names).
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
        telegramUsername: true,
        telegramUsernameTgId: true,
        email: true,
        webAccount: { select: { login: true } },
      },
    });

    if (!user) {
      throw new Error(`User ${userId} not found for profile naming`);
    }

    const settings = await this.prismaService.settings.findFirst({
      select: { brandingSettings: true },
    });
    const storedBranding = settings?.brandingSettings ?? null;
    const config = readProfileNamingConfig(storedBranding);

    // The stable ordinal: this subscription's place among the customer's.
    const subscriptions = await this.prismaService.subscription.findMany({
      where: { userId },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const ordinal = subscriptionOrdinal(subscriptions, subscriptionId);

    const identifier = currentIdentifier(user);
    const username = assembleName(config, identifier, ordinal);

    // The name the login-first rule gave this subscription, with the settings
    // read the way that rule read them. A name the panel cannot hold (an
    // invalid prefix made every such CREATE fail) names no profile and is not
    // worth a lookup.
    const legacyName = assembleName(
      readLegacyNamingConfig(storedBranding),
      legacyIdentifier(user),
      ordinal,
    );
    const legacyUsernames =
      legacyName !== username && PANEL_USERNAME_ALPHABET.test(legacyName) ? [legacyName] : [];

    const fallbackKey = subscriptionId ?? user.id;
    const fallbackUsernames = Array.from({ length: FALLBACK_COUNT }, (_unused, index) =>
      assembleName(config, identifier, ordinal, fallbackTag(fallbackKey, index + 1)),
    );

    // Build description with internal identifiers. Every value on ONE line —
    // `descriptionFieldValue` folds every kind of line break — because the
    // `reiwa_id` line below is the ownership marker, and a display name that
    // could start a line of its own could plant a second one.
    const descriptionLines: string[] = [];
    if (user.name) descriptionLines.push(`name: ${descriptionFieldValue(user.name)}`);
    if (user.webAccount?.login) {
      descriptionLines.push(`login: ${descriptionFieldValue(user.webAccount.login)}`);
    }
    if (user.username) descriptionLines.push(`username: ${descriptionFieldValue(user.username)}`);
    descriptionLines.push(ownerMarkerLine(user.id));

    return {
      username,
      description: descriptionLines.join('\n'),
      legacyUsernames,
      fallbackUsernames,
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
}

/**
 * The 0-based position of `subscriptionId` among the user's subscriptions
 * ordered by creation. Stable across re-runs, so the generated username never
 * changes for a given subscription. When `subscriptionId` is omitted (legacy
 * callers) it falls back to the current subscription count.
 */
function subscriptionOrdinal(
  subscriptions: ReadonlyArray<{ readonly id: string }>,
  subscriptionId: string | undefined,
): number {
  if (subscriptionId === undefined) {
    return subscriptions.length === 0 ? 0 : subscriptions.length - 1;
  }
  const index = subscriptions.findIndex((row) => row.id === subscriptionId);
  return index < 0 ? subscriptions.length : index;
}
