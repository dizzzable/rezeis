import {
  CustomEmojiInterface,
  CustomEmojiPackInterface,
} from '../interfaces/custom-emoji-pack.interface';

/**
 * Read + normalize the custom emoji packs stored under
 * `Settings.systemNotifications.customEmojiPacks`. Tolerant of legacy/partial
 * shapes — anything malformed is dropped rather than throwing.
 */
export function readCustomEmojiPacks(systemNotifications: unknown): CustomEmojiPackInterface[] {
  const root = asObject(systemNotifications);
  const raw = root.customEmojiPacks;
  if (!Array.isArray(raw)) return [];
  const packs: CustomEmojiPackInterface[] = [];
  for (const entry of raw) {
    const pack = readPack(entry);
    if (pack !== null) packs.push(pack);
  }
  return packs;
}

function readPack(value: unknown): CustomEmojiPackInterface | null {
  const obj = asObject(value);
  const id = readString(obj.id);
  const name = readString(obj.name);
  if (id === null || name === null) return null;
  const emojisRaw = Array.isArray(obj.emojis) ? obj.emojis : [];
  const emojis: CustomEmojiInterface[] = [];
  for (const e of emojisRaw) {
    const emoji = readEmoji(e);
    if (emoji !== null) emojis.push(emoji);
  }
  const setName = readString(obj.setName);
  return {
    id,
    name,
    ...(setName === null ? {} : { setName }),
    ...(obj.builtin === true ? { builtin: true } : {}),
    emojis,
  };
}

function readEmoji(value: unknown): CustomEmojiInterface | null {
  const obj = asObject(value);
  const slug = readString(obj.slug);
  const imageUrl = readString(obj.imageUrl);
  if (slug === null || imageUrl === null) return null;
  return {
    slug,
    name: readString(obj.name) ?? slug,
    imageUrl,
    lottieUrl: readString(obj.lottieUrl),
    videoUrl: readString(obj.videoUrl),
    fallback: readString(obj.fallback),
    customEmojiId: readString(obj.customEmojiId),
  };
}

/**
 * Read the operator's "the bot owner has Telegram Premium" switch out of the
 * same `Settings.systemNotifications` blob the packs live in — written by
 * `BotEmojiStudioService.setOwnerHasPremium` under `botEmoji.ownerHasPremium`.
 *
 * Defaults to **true** when unset, matching reiwa's own default
 * (`renderBotCopyHtml(…, ownerHasPremium = true)`) and the two readers already
 * in the bot-config module (`bot-emoji-studio.service.ts`,
 * `internal-bot-config.service.ts`). An instance that never touched the switch
 * therefore keeps rendering premium emoji exactly as it does today; only an
 * operator who declared "no Premium" changes behaviour.
 *
 * It lives here, beside `readCustomEmojiPacks`, because both answers come out
 * of the same JSON column: a renderer that needs the packs already holds the
 * row that carries the flag.
 */
export function readBotEmojiOwnerHasPremium(systemNotifications: unknown): boolean {
  const botEmoji = asObject(asObject(systemNotifications).botEmoji);
  const flag = botEmoji.ownerHasPremium;
  return typeof flag === 'boolean' ? flag : true;
}

/** Builds a slug→emoji lookup across all packs (last write wins on collision). */
export function indexEmojisBySlug(
  packs: readonly CustomEmojiPackInterface[],
): Map<string, CustomEmojiInterface> {
  const index = new Map<string, CustomEmojiInterface>();
  for (const pack of packs) {
    for (const emoji of pack.emojis) {
      index.set(emoji.slug, emoji);
    }
  }
  return index;
}

/** Normalize a free-form name into a token-safe slug: `[a-z0-9_]`. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
