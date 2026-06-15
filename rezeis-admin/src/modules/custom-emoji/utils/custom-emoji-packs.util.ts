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
  return { id, name, emojis };
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
