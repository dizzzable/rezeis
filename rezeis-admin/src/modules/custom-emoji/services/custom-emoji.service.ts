import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Settings } from '@prisma/client';
import { gunzipSync } from 'fflate';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SettingsService } from '../../settings/services/settings.service';
import {
  CustomEmojiInterface,
  CustomEmojiPackInterface,
} from '../interfaces/custom-emoji-pack.interface';
import {
  indexEmojisBySlug,
  readCustomEmojiPacks,
  slugify,
} from '../utils/custom-emoji-packs.util';
import { EmojiAssetUploadService } from './emoji-asset-upload.service';

/** Hard cap so a careless multi-hundred-sticker zip can't blow up settings. */
const MAX_EMOJIS_PER_IMPORT = 400;

export interface UpdateEmojiPatch {
  readonly name?: string;
  readonly fallback?: string | null;
  readonly customEmojiId?: string | null;
}

@Injectable()
export class CustomEmojiService {
  private readonly logger = new Logger(CustomEmojiService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly assetUpload: EmojiAssetUploadService,
    private readonly settingsService: SettingsService,
  ) {}

  public async listPacks(): Promise<CustomEmojiPackInterface[]> {
    const settings = await this.getSettings();
    return readCustomEmojiPacks(settings?.systemNotifications);
  }

  /**
   * Replace `:slug:` custom-emoji shortcodes with their fallback glyph (or drop
   * them when no fallback is set). Used to sanitize broadcast text before it
   * goes to Telegram, where the custom images can't render. Cheap no-op when
   * the text has no `:` at all.
   */
  public async substituteFallbacks(text: string): Promise<string> {
    if (!text.includes(':')) return text;
    const index = indexEmojisBySlug(await this.listPacks());
    if (index.size === 0) return text;
    return text.replace(/:([a-z0-9_]+):/g, (whole, slug: string) => {
      const emoji = index.get(slug);
      if (!emoji) return whole;
      return emoji.fallback ?? '';
    });
  }

  /**
   * Replace `:slug:` shortcodes for delivery as Telegram **HTML** (`parse_mode:
   * HTML`). When the emoji has both a `customEmojiId` and a fallback glyph, it
   * is emitted as a `<tg-emoji emoji-id="…">glyph</tg-emoji>` tag — Telegram
   * renders the premium custom emoji for capable bots (Fragment username) and
   * silently shows the fallback glyph for everyone else. Without a premium id
   * it degrades to the plain glyph; unknown slugs are left untouched.
   *
   * NOTE: only safe to send with `parse_mode: HTML`. The glyph is a literal
   * emoji (no HTML-escaping needed); the numeric id is digits-only by origin
   * but we still strip anything non-numeric defensively.
   */
  public async substituteTelegramHtml(text: string): Promise<string> {
    if (!text.includes(':')) return text;
    const index = indexEmojisBySlug(await this.listPacks());
    if (index.size === 0) return text;
    return text.replace(/:([a-z0-9_]+):/g, (whole, slug: string) => {
      const emoji = index.get(slug);
      if (!emoji) return whole;
      const glyph = emoji.fallback ?? '';
      const id = emoji.customEmojiId !== null ? emoji.customEmojiId.replace(/[^0-9]/g, '') : '';
      if (id.length > 0 && glyph.length > 0) {
        return `<tg-emoji emoji-id="${id}">${glyph}</tg-emoji>`;
      }
      return glyph;
    });
  }

  /**
   * Import a whole emoji/sticker set from its link or name (e.g.
   * `https://t.me/addemoji/NewsEmoji` → `NewsEmoji`). One `getStickerSet` call
   * returns every sticker; we download + map them just like `importByIds`.
   * Simplest path — no id list needed.
   */
  public async importBySetLink(input: {
    readonly packName: string;
    readonly link: string;
    readonly builtin?: boolean;
  }): Promise<CustomEmojiPackInterface> {
    const setName = extractSetName(input.link);
    if (!setName) {
      throw new BadRequestException('Could not read a sticker set name from the link');
    }
    const token = await this.settingsService.getDecryptedBotToken();
    if (!token) {
      throw new BadRequestException('Configure the bot token in platform settings first');
    }
    const set = await tgApi<{ title?: string; stickers?: TgSticker[] }>(token, 'getStickerSet', {
      name: setName,
    });
    const stickers = (set?.stickers ?? []).slice(0, MAX_EMOJIS_PER_IMPORT);
    if (stickers.length === 0) {
      throw new BadRequestException('The set has no stickers (or it is not accessible)');
    }
    const name = input.packName.trim() || set?.title?.trim() || setName;
    const packSlug = slugify(name) || 'pack';
    const usedSlugs = new Set(indexEmojisBySlug(await this.listPacks()).keys());

    // Pre-assign deterministic slugs (by set order) so downloads can run in
    // parallel without racing on slug uniqueness.
    const planned = stickers.map((sticker, i) => {
      const slug = uniqueSlug(`${packSlug}_${i + 1}`, usedSlugs);
      usedSlugs.add(slug);
      return { sticker, slug, name: `${name} ${i + 1}` };
    });

    // Download assets with bounded concurrency — a 30-emoji set otherwise
    // serializes ~60 Telegram round-trips and blows past the client timeout.
    const resolved = await mapWithConcurrency(planned, 6, async (item) => {
      const { imageUrl, lottieUrl, videoUrl } = await this.stickerAssets(token, item.sticker);
      return { ...item, imageUrl, lottieUrl, videoUrl };
    });

    const emojis: CustomEmojiInterface[] = [];
    for (const item of resolved) {
      if (!item.imageUrl) continue;
      emojis.push({
        slug: item.slug,
        name: item.name,
        imageUrl: item.imageUrl,
        lottieUrl: item.lottieUrl,
        videoUrl: item.videoUrl,
        fallback: typeof item.sticker.emoji === 'string' ? item.sticker.emoji : null,
        customEmojiId:
          typeof item.sticker.custom_emoji_id === 'string' ? item.sticker.custom_emoji_id : null,
      });
    }
    if (emojis.length === 0) {
      throw new BadRequestException('Could not resolve any sticker from the set');
    }
    const pack: CustomEmojiPackInterface = {
      id: randomBytes(8).toString('hex'),
      name,
      setName,
      builtin: input.builtin ?? false,
      emojis,
    };
    await this.savePacks([...(await this.listPacks()), pack]);
    this.logger.log(`Imported emoji set "${name}" (${setName}): ${emojis.length} emojis`);
    return pack;
  }

  /**
   * Resolve a sticker's static image + optional Lottie animation. Animated
   * `.tgs` is gunzipped to Lottie JSON (preview from the thumbnail); video uses
   * the thumbnail; static is stored as-is. Returns `{ imageUrl: null }` when
   * nothing could be downloaded.
   */
  private async stickerAssets(
    token: string,
    sticker: TgSticker,
  ): Promise<{ imageUrl: string | null; lottieUrl: string | null; videoUrl: string | null }> {
    let imageUrl: string | null = null;
    let lottieUrl: string | null = null;
    let videoUrl: string | null = null;
    try {
      if (sticker.is_animated) {
        const tgs = await this.downloadTgFile(token, sticker.file_id);
        const json = Buffer.from(gunzipSync(new Uint8Array(tgs)));
        lottieUrl = (await this.assetUpload.persist({ buffer: json, kind: 'lottie' })).url;
        imageUrl = await this.downloadThumb(token, sticker);
      } else if (sticker.is_video) {
        // Store the actual VP9 .webm so the admin can play the real animated
        // emoji (not just a frozen thumbnail). Thumbnail stays as the poster /
        // fallback for browsers that can't decode the clip.
        try {
          const webm = await this.downloadTgFile(token, sticker.file_id);
          videoUrl = (await this.assetUpload.persist({ buffer: Buffer.from(webm), kind: 'webm' })).url;
        } catch (err: unknown) {
          this.logger.warn(
            `Video emoji download failed for ${sticker.custom_emoji_id ?? sticker.file_id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        imageUrl = await this.downloadThumb(token, sticker);
      } else {
        const webp = await this.downloadTgFile(token, sticker.file_id);
        imageUrl = (await this.assetUpload.persist({ buffer: Buffer.from(webp), kind: 'webp' })).url;
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Asset download failed for ${sticker.custom_emoji_id ?? sticker.file_id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!imageUrl) {
      imageUrl = await this.downloadThumb(token, sticker).catch(() => null);
    }
    return { imageUrl, lottieUrl, videoUrl };
  }

  /** Download a Telegram file by file_id; returns its raw bytes. */
  private async downloadTgFile(token: string, fileId: string): Promise<ArrayBuffer> {
    const file = await tgApi<{ file_path?: string }>(token, 'getFile', { file_id: fileId });
    if (!file?.file_path) {
      throw new Error('getFile returned no file_path');
    }
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!res.ok) {
      throw new Error(`file download failed: ${res.status}`);
    }
    return res.arrayBuffer();
  }

  /** Download a sticker's static thumbnail (webp/jpeg) and store it. */
  private async downloadThumb(token: string, sticker: TgSticker): Promise<string | null> {
    const thumbId = sticker.thumbnail?.file_id ?? sticker.thumb?.file_id;
    if (!thumbId) return null;
    const file = await tgApi<{ file_path?: string }>(token, 'getFile', { file_id: thumbId });
    if (!file?.file_path) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const kind = file.file_path.toLowerCase().endsWith('.jpg') ? 'jpeg' : 'webp';
    return (await this.assetUpload.persist({ buffer, kind })).url;
  }

  public async deletePack(packId: string): Promise<void> {
    const packs = await this.listPacks();
    const target = packs.find((p) => p.id === packId);
    if (!target) {
      throw new NotFoundException('Pack not found');
    }
    await this.savePacks(packs.filter((p) => p.id !== packId));
    // Reap assets outside the settings write (best-effort).
    await Promise.all(
      target.emojis.flatMap((e) => [
        this.assetUpload.remove(e.imageUrl),
        this.assetUpload.remove(e.lottieUrl),
        this.assetUpload.remove(e.videoUrl),
      ]),
    );
  }

  public async updateEmoji(input: {
    readonly packId: string;
    readonly slug: string;
    readonly patch: UpdateEmojiPatch;
  }): Promise<CustomEmojiPackInterface> {
    const packs = await this.listPacks();
    const pack = packs.find((p) => p.id === input.packId);
    if (!pack) {
      throw new NotFoundException('Pack not found');
    }
    const emojis = pack.emojis.map((e) =>
      e.slug === input.slug
        ? {
            ...e,
            name: input.patch.name?.trim() || e.name,
            fallback:
              input.patch.fallback === undefined ? e.fallback : normalize(input.patch.fallback),
            customEmojiId:
              input.patch.customEmojiId === undefined
                ? e.customEmojiId
                : normalize(input.patch.customEmojiId),
          }
        : e,
    );
    const next = packs.map((p) => (p.id === input.packId ? { ...pack, emojis } : p));
    await this.savePacks(next);
    return { ...pack, emojis };
  }

  // ── builtin defaults (boot seeder support) ──────────────────────────────

  /** Flag an existing pack as a builtin default. Returns false if not found. */
  public async markPackBuiltin(packId: string): Promise<boolean> {
    const packs = await this.listPacks();
    const target = packs.find((p) => p.id === packId);
    if (!target) return false;
    if (target.builtin === true) return true;
    await this.savePacks(packs.map((p) => (p.id === packId ? { ...p, builtin: true } : p)));
    return true;
  }

  /** Read the marker list of builtin pack ids already seeded on this instance. */
  public async readSeededDefaults(): Promise<string[]> {
    const settings = await this.getSettings();
    const sn = asObject(settings?.systemNotifications);
    const raw = sn.seededEmojiDefaults;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  }

  /** Append a builtin id to the seeded-defaults marker (idempotent). */
  public async addSeededDefault(id: string): Promise<void> {
    await this.prismaService.$transaction(async (tx) => {
      const existing = await tx.settings.findFirst({ orderBy: { updatedAt: 'asc' } });
      const settings = existing ?? (await tx.settings.create({ data: {} }));
      const sn = asObject(settings.systemNotifications);
      const raw = Array.isArray(sn.seededEmojiDefaults)
        ? (sn.seededEmojiDefaults as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];
      if (!raw.includes(id)) raw.push(id);
      sn.seededEmojiDefaults = raw as unknown as Prisma.InputJsonValue;
      await tx.settings.update({
        where: { id: settings.id },
        data: { systemNotifications: sn as Prisma.InputJsonValue },
      });
    });
  }

  // ── persistence ────────────────────────────────────────────────────────

  private async savePacks(packs: readonly CustomEmojiPackInterface[]): Promise<void> {
    await this.prismaService.$transaction(async (tx) => {
      const existing = await tx.settings.findFirst({ orderBy: { updatedAt: 'asc' } });
      const settings = existing ?? (await tx.settings.create({ data: {} }));
      const systemNotifications = asObject(settings.systemNotifications);
      systemNotifications.customEmojiPacks = packs as unknown as Prisma.InputJsonValue;
      await tx.settings.update({
        where: { id: settings.id },
        data: { systemNotifications: systemNotifications as Prisma.InputJsonValue },
      });
    });
  }

  private async getSettings(): Promise<Settings | null> {
    return this.prismaService.settings.findFirst({ orderBy: { updatedAt: 'asc' } });
  }
}

function uniqueSlug(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/**
 * Map over `items` running at most `limit` async tasks at once, preserving
 * input order in the result. Keeps large set imports fast without flooding the
 * Telegram API with hundreds of simultaneous downloads.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

interface TgSticker {
  readonly custom_emoji_id?: string;
  readonly emoji?: string;
  readonly is_animated?: boolean;
  readonly is_video?: boolean;
  readonly file_id: string;
  readonly thumbnail?: { readonly file_id: string };
  readonly thumb?: { readonly file_id: string };
}

/** Call a Telegram Bot API method and return the unwrapped `result`. */
async function tgApi<T>(token: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!res.ok || !data?.ok) {
    throw new Error(`Telegram ${method} failed: ${data?.description ?? res.status}`);
  }
  return data.result as T;
}

/** Extract a sticker/emoji set name from a t.me link or a bare name. */
function extractSetName(input: string): string | null {
  const match = /(?:addemoji|addstickers)\/([A-Za-z0-9_]+)/i.exec(input);
  if (match) return match[1]!;
  const trimmed = input.trim();
  return /^[A-Za-z0-9_]{1,64}$/.test(trimmed) ? trimmed : null;
}

function normalize(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
