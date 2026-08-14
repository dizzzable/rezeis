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
  readBotEmojiOwnerHasPremium,
  readCustomEmojiPacks,
  slugify,
} from '../utils/custom-emoji-packs.util';
import { EmojiAssetUploadService } from './emoji-asset-upload.service';

/** Hard cap so a careless multi-hundred-sticker zip can't blow up settings. */
const MAX_EMOJIS_PER_IMPORT = 400;

/**
 * A Telegram `custom_emoji_id` is a decimal 64-bit id — digits only.
 * `substituteTelegramHtml` strips everything else before emitting the tag, so
 * a value that fails this test contributes nothing and does so silently.
 */
const CUSTOM_EMOJI_ID_PATTERN = /^[0-9]{1,32}$/;

/**
 * Carrier glyph for an entry that has a `custom_emoji_id` but no fallback of
 * its own. Telegram draws a custom emoji only *over* a glyph, so something has
 * to sit inside the `<tg-emoji>` tag — but "no glyph" is not the same as "not
 * deliverable": the operator's artwork is still what the user ends up seeing,
 * and the star is only what it is painted on.
 *
 * This is reiwa's rule, applied identically by all three of its renderers
 * (`applyCustomEmojiTokens`, `renderBotCopyHtml` and `renderButtonLabel` in
 * `src/infrastructure/bot-config/emoji-utils.ts`). The panel used to drop such
 * an entry instead, so one pack entry delivered the emoji in bot copy and an
 * empty string in a broadcast. One rule, both sides.
 */
const ID_ONLY_CARRIER = '⭐';

// THE ONE PLACE THE PANEL DELIBERATELY DOES NOT FOLLOW REIWA — written down so
// it is not rediscovered as a bug for a third time.
//
// When an entry has NEITHER field, all three reiwa renderers return the raw
// `:slug:` unchanged (`emoji-utils.ts:199`, `:313`, `:396`); both panel
// renderers below drop the token instead. Everything else about the two sides
// is now identical — see `ID_ONLY_CARRIER` above.
//
// Kept divergent on purpose. A visible `:tg_ios_macos_icons_25: Перейти в
// канал` is the exact defect this whole area was opened for, and a broadcast
// reaching thousands of people is the worst place to display it. The argument
// for following reiwa was that dropping it hides a dead record from the
// operator — true until the panel began flagging the state where the operator
// actually works: the field overlay draws such a token in destructive styling
// with a "will not be delivered" tooltip
// (`web/src/features/custom-emoji/emoji-field-overlay.tsx`), and
// `assertEmojiIsDeliverable` refuses to create the state at all. The signal
// now lives in the panel, so the message no longer has to carry it.

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
   * Replace `:slug:` custom-emoji shortcodes for delivery as **plain text** —
   * media captions, a non-HTML broadcast edit, and the web-push title/body.
   *
   * No entity and no `<tg-emoji>` tag can travel on this path, so the carrier
   * is not a placeholder sitting behind the artwork: it is the whole of what
   * the recipient sees. That is precisely why it may not be dropped — and why
   * this method is deliberately NOT gated on the owner-premium flag that
   * {@link CustomEmojiService.substituteTelegramHtml} honours: there is nothing
   * here for Telegram to reject, so the gate would only delete a glyph.
   *
   * The carrier rule is the same one
   * {@link CustomEmojiService.substituteTelegramHtml} applies,
   * and the same one reiwa's own text renderer applies (`renderButtonLabel`,
   * `src/infrastructure/bot-config/emoji-utils.ts:391-397`):
   *
   *   carrier = trimmed fallback glyph, else {@link ID_ONLY_CARRIER} when the
   *   entry carries a `customEmojiId`, else nothing.
   *
   * An entry holding only an id used to substitute an empty string here, so a
   * single pack entry arrived through the bot and through an HTML broadcast
   * and silently vanished from a photo caption and a browser push. Unknown
   * slugs are left untouched (operators may type `:foo:` literally). Cheap
   * no-op when the text has no `:` at all.
   */
  public async substituteFallbacks(text: string): Promise<string> {
    if (!text.includes(':')) return text;
    const index = indexEmojisBySlug(await this.listPacks());
    if (index.size === 0) return text;
    return text.replace(/:([a-z0-9_]+):/g, (whole, slug: string) => {
      const emoji = index.get(slug);
      if (!emoji) return whole;
      const glyph = emoji.fallback?.trim() ?? '';
      if (glyph.length > 0) return glyph;
      const rawId = emoji.customEmojiId?.trim() ?? '';
      return rawId.length > 0 ? ID_ONLY_CARRIER : '';
    });
  }

  /**
   * Replace `:slug:` shortcodes for delivery as Telegram **HTML** (`parse_mode:
   * HTML`). The emoji is emitted as a `<tg-emoji emoji-id="…">carrier</tg-emoji>`
   * tag, but ONLY when the bot's owner has Telegram Premium. Without a usable
   * id it degrades to the plain glyph; unknown slugs are left untouched.
   *
   * ## Why the premium gate is not optional
   *
   * A `<tg-emoji>` tag under `parse_mode: HTML` *is* a custom-emoji entity, and
   * Telegram **rejects the whole message** when the bot's owner has no Premium
   * — it does not quietly fall back to the glyph inside the tag. reiwa has
   * always gated on this: `renderBotCopy` strips the entities and
   * `renderBotCopyHtml` builds no tag at all
   * (`src/infrastructure/bot-config/emoji-utils.ts:256-264`, `:303`, `:314`,
   * and `tgEmojiTag` is marked "premium owners only" at `:274`).
   *
   * The panel is not a separate sender: broadcasts and user notifications go
   * out through the SAME bot token
   * (`broadcast-delivery.service.ts:472,724,731`,
   * `user-notifications.service.ts:489-491`). An ungated tag therefore does not
   * cost a non-premium operator their artwork — it can cost them the broadcast.
   *
   * The flag is read HERE rather than passed in by the four callers: it lives
   * in the same `Settings.systemNotifications` blob as the packs
   * (`readBotEmojiOwnerHasPremium`), so the row this method already fetches for
   * the packs answers both questions in one read, and no present or future
   * caller can forget to gate. Unset means `true`, so nothing changes for an
   * instance whose operator never touched the switch.
   *
   * The carrier is the operator's fallback glyph when there is one, and
   * {@link ID_ONLY_CARRIER} when the entry carries only a `customEmojiId` —
   * the tag needs *a* glyph to wrap, not necessarily a configured one. When the
   * gate closes that carrier is delivered as plain text, exactly as
   * `renderBotCopyHtml` does: the operator loses the emoji, never the message.
   * The rule mirrors reiwa's, so the same pack entry cannot deliver an emoji
   * through the bot and an empty string through a broadcast.
   *
   * NOTE: only safe to send with `parse_mode: HTML`. The glyph is a literal
   * emoji (no HTML-escaping needed); the numeric id is digits-only by origin
   * but we still strip anything non-numeric defensively — an id that does not
   * survive that leaves the carrier behind as plain text, exactly as reiwa's
   * `tgEmojiTag` does.
   */
  public async substituteTelegramHtml(text: string): Promise<string> {
    if (!text.includes(':')) return text;
    const settings = await this.getSettings();
    const index = indexEmojisBySlug(readCustomEmojiPacks(settings?.systemNotifications));
    if (index.size === 0) return text;
    const ownerHasPremium = readBotEmojiOwnerHasPremium(settings?.systemNotifications);
    return text.replace(/:([a-z0-9_]+):/g, (whole, slug: string) => {
      const emoji = index.get(slug);
      if (!emoji) return whole;
      const glyph = emoji.fallback?.trim() ?? '';
      const rawId = emoji.customEmojiId?.trim() ?? '';
      const carrier = glyph.length > 0 ? glyph : rawId.length > 0 ? ID_ONLY_CARRIER : '';
      if (carrier.length === 0) return '';
      if (!ownerHasPremium) return carrier;
      const id = rawId.replace(/[^0-9]/g, '');
      if (id.length > 0) {
        return `<tg-emoji emoji-id="${id}">${carrier}</tg-emoji>`;
      }
      return carrier;
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
    const packs = await this.listPacks();
    const existing = packs.find((pack) => matchesStickerSet(pack, setName, stickers));
    if (existing) {
      // `setName` was not retained by an older settings normalizer. Besides
      // preventing a duplicate on the next import, backfilling it lets a
      // database restore re-download the pack's files automatically.
      //
      // Re-importing the same link is also the operator's only repair tool for
      // a pack already on record, so this must mend the delivery fields as well
      // as the files — otherwise a pack imported without `custom_emoji_id` /
      // `fallback` can only be fixed by retyping every emoji by hand.
      const restored = await this.rehydratePackAssets(token, existing, stickers);
      const recovered = {
        ...restored.pack,
        setName,
        ...(input.builtin === true ? { builtin: true } : {}),
      };
      const changed =
        restored.changed ||
        recovered.setName !== existing.setName ||
        recovered.builtin !== existing.builtin;
      if (changed) {
        await this.savePacks(packs.map((pack) => (pack.id === existing.id ? recovered : pack)));
      }
      this.logger.log(
        `Reused emoji set "${recovered.name}" (${setName}); restored ${restored.recoveredEmojiCount} missing asset(s), repaired ${restored.repairedEmojiCount} emoji id/fallback record(s)`,
      );
      return recovered;
    }
    const packSlug = slugify(name) || 'pack';
    const usedSlugs = new Set(indexEmojisBySlug(packs).keys());

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
    await this.savePacks([...packs, pack]);
    this.logger.log(`Imported emoji set "${name}" (${setName}): ${emojis.length} emojis`);
    return pack;
  }

  /**
   * Recreate custom-emoji files after restoring a database-only backup.
   *
   * The pack catalogue belongs to PostgreSQL but image/Lottie/video files are
   * deliberately stored in the persistent uploads volume. When only the
   * database is restored, every original URL points to a non-existent file.
   * The Telegram set name retained on the pack gives us a safe source for
   * rebuilding only those missing files. Individual pack errors are isolated:
   * a restore remains successful even if a particular Telegram set disappeared.
   */
  public async rehydrateMissingAssets(): Promise<{
    readonly recoveredEmojiCount: number;
    readonly skippedPacks: number;
  }> {
    const packs = await this.listPacks();
    const sourceCandidates = packs.filter(
      (pack) => typeof pack.setName === 'string' && pack.setName.length > 0,
    );
    // This routine also runs during API boot to repair an older database-only
    // restore. Avoid Telegram requests for every healthy pack on every start.
    const candidates: CustomEmojiPackInterface[] = [];
    for (const pack of sourceCandidates) {
      if (await this.packHasMissingAssets(pack)) candidates.push(pack);
    }
    if (candidates.length === 0) {
      return { recoveredEmojiCount: 0, skippedPacks: 0 };
    }

    const token = await this.settingsService.getDecryptedBotToken();
    if (!token) {
      this.logger.warn('Skipped custom emoji asset recovery: bot token is not configured');
      return { recoveredEmojiCount: 0, skippedPacks: candidates.length };
    }

    let recoveredEmojiCount = 0;
    let skippedPacks = 0;
    let changed = false;
    const next = [...packs];
    for (let index = 0; index < next.length; index += 1) {
      const pack = next[index]!;
      if (!pack.setName) continue;
      try {
        const set = await tgApi<{ stickers?: TgSticker[] }>(token, 'getStickerSet', { name: pack.setName });
        const stickers = (set?.stickers ?? []).slice(0, MAX_EMOJIS_PER_IMPORT);
        if (stickers.length === 0) {
          skippedPacks += 1;
          this.logger.warn(`Skipped custom emoji recovery for "${pack.name}": empty Telegram set`);
          continue;
        }
        const restored = await this.rehydratePackAssets(token, pack, stickers);
        if (restored.changed) {
          next[index] = restored.pack;
          changed = true;
          recoveredEmojiCount += restored.recoveredEmojiCount;
        }
      } catch (err: unknown) {
        skippedPacks += 1;
        this.logger.warn(
          `Skipped custom emoji recovery for "${pack.name}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (changed) await this.savePacks(next);
    return { recoveredEmojiCount, skippedPacks };
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

  /**
   * Restore one pack from a fetched sticker set: the missing files, and the two
   * delivery fields a record may be missing.
   *
   * Files and identity are repaired independently. Only `customEmojiId` and
   * `fallback` ever reach Telegram — a record holding neither makes the bot
   * emit the raw `:slug:` token — and a re-import is the one route an operator
   * has to repair a pack that was stored without them. Their recovery must
   * therefore not sit behind the "some file is missing" test: a pack whose
   * images are all present is exactly the pack that lost only its ids.
   */
  private async rehydratePackAssets(
    token: string,
    pack: CustomEmojiPackInterface,
    stickers: readonly TgSticker[],
  ): Promise<{
    readonly pack: CustomEmojiPackInterface;
    readonly changed: boolean;
    readonly recoveredEmojiCount: number;
    readonly repairedEmojiCount: number;
  }> {
    // Pairing is one decision over the whole pack, taken before any record is
    // touched — a per-record lookup cannot see that the sticker a record wants
    // to take by position already belongs to a different record.
    const pairs = pairStickers(pack.emojis, stickers);
    let changed = false;
    let recoveredEmojiCount = 0;
    let repairedEmojiCount = 0;
    const emojis = await mapWithConcurrency(pack.emojis, 6, async (emoji, index) => {
      const sticker = pairs[index];
      if (sticker === undefined && index < stickers.length) {
        // A position WAS available and was refused. Saying nothing here is the
        // silence the id swap used to hide behind — and the existing "cannot
        // recover" warning below only fires when a file is missing too.
        this.logger.warn(
          `Left emoji "${emoji.slug}" of pack "${pack.name}" as it is: its sticker is gone from the Telegram set and position ${
            index + 1
          } now belongs to another record`,
        );
      }
      const current = sticker === undefined ? emoji : applyStickerIdentity(emoji, sticker);
      if (current !== emoji) {
        changed = true;
        repairedEmojiCount += 1;
      }

      const [hasImage, hasLottie, hasVideo] = await Promise.all([
        this.assetUpload.exists(emoji.imageUrl),
        this.assetUpload.exists(emoji.lottieUrl),
        this.assetUpload.exists(emoji.videoUrl),
      ]);
      if (hasImage && hasLottie && hasVideo) return current;

      if (sticker === undefined) {
        this.logger.warn(
          `Cannot recover emoji "${emoji.slug}": sticker is no longer in the Telegram set`,
        );
        return current;
      }
      const assets = await this.stickerAssets(token, sticker);
      const next = {
        ...current,
        imageUrl: hasImage ? current.imageUrl : (assets.imageUrl ?? current.imageUrl),
        lottieUrl: hasLottie ? current.lottieUrl : (assets.lottieUrl ?? current.lottieUrl),
        videoUrl: hasVideo ? current.videoUrl : (assets.videoUrl ?? current.videoUrl),
      };
      if (
        next.imageUrl === current.imageUrl &&
        next.lottieUrl === current.lottieUrl &&
        next.videoUrl === current.videoUrl
      ) {
        return current;
      }
      changed = true;
      recoveredEmojiCount += 1;
      return next;
    });
    return { pack: { ...pack, emojis }, changed, recoveredEmojiCount, repairedEmojiCount };
  }

  private async packHasMissingAssets(pack: CustomEmojiPackInterface): Promise<boolean> {
    for (const emoji of pack.emojis) {
      const [hasImage, hasLottie, hasVideo] = await Promise.all([
        this.assetUpload.exists(emoji.imageUrl),
        this.assetUpload.exists(emoji.lottieUrl),
        this.assetUpload.exists(emoji.videoUrl),
      ]);
      if (!hasImage || !hasLottie || !hasVideo) return true;
    }
    return false;
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

  /**
   * Edit the two delivery fields of one emoji (plus its display name).
   *
   * This endpoint can only touch `name` / `fallback` / `customEmojiId` — never
   * the stored image — so `assertEmojiIsDeliverable` refuses the combinations
   * that provably deliver nothing to Telegram. Records that already sit in a
   * dead state (imported that way) are left alone: the guard only inspects the
   * result of a patch that actually touches those fields, so a rename never
   * fails and repairing a broken record is always possible.
   */
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
    const target = pack.emojis.find((e) => e.slug === input.slug);
    if (!target) {
      // Previously a typo in the slug saved the pack unchanged and answered
      // 200, so the operator was told an edit landed that never existed.
      throw new NotFoundException('Emoji not found in this pack');
    }
    const patched = applyEmojiPatch(target, input.patch);
    assertEmojiIsDeliverable(patched, input.patch);
    const emojis = pack.emojis.map((e) => (e.slug === input.slug ? patched : e));
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

  /**
   * Attach an authoritative Telegram source to a known existing pack. This
   * repairs records created before `setName` survived settings normalization;
   * it deliberately changes metadata only and never downloads files itself.
   */
  public async backfillPackSource(
    packId: string,
    input: { readonly setName: string; readonly builtin?: boolean },
  ): Promise<boolean> {
    const packs = await this.listPacks();
    const target = packs.find((pack) => pack.id === packId);
    if (!target) return false;
    const setName = input.setName.trim();
    if (setName.length === 0) return false;
    const builtin = input.builtin === true ? true : target.builtin;
    if (target.setName === setName && builtin === target.builtin) return true;
    await this.savePacks(
      packs.map((pack) =>
        pack.id === packId
          ? { ...pack, setName, ...(builtin === true ? { builtin: true } : {}) }
          : pack,
      ),
    );
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

/** True when a saved pack is known to represent this Telegram sticker set. */
function matchesStickerSet(
  pack: CustomEmojiPackInterface,
  setName: string,
  stickers: readonly TgSticker[],
): boolean {
  if (pack.setName?.trim().toLowerCase() === setName.trim().toLowerCase()) return true;

  // Legacy saved records may have lost `setName` while being normalized. A
  // complete custom-emoji-id match is still an unambiguous source identity and
  // lets a user repair a restored pack simply by importing the same link again.
  const remoteIds = stickers
    .map((sticker) => sticker.custom_emoji_id)
    .filter((id): id is string => typeof id === 'string');
  const packIds = pack.emojis
    .map((emoji) => emoji.customEmojiId)
    .filter((id): id is string => typeof id === 'string');
  if (remoteIds.length === 0 || remoteIds.length !== packIds.length) return false;
  const remoteIdSet = new Set(remoteIds);
  return new Set(packIds).size === packIds.length && packIds.every((id) => remoteIdSet.has(id));
}

/**
 * Pair every saved record of a pack with the sticker it was made from — one
 * decision over the whole pack, shared by every repair path (re-import, the
 * boot seeder, and a backup restore).
 *
 * Two passes, and the order is the point:
 *
 *   1. **Identity.** A record whose stored `custom_emoji_id` is still in the
 *      set takes that sticker, wherever it now sits. The id is what the record
 *      *is*; its slot is only where it happened to be.
 *   2. **Position.** Whatever is left falls back to `stickers[index]` — but
 *      only onto a sticker whose id no pass-1 record already claimed.
 *
 * Position stays because it is the only handle a record whose id was never
 * stored has left, and that is precisely the record a re-import exists to
 * repair (the first import numbered slugs `pack_1`, `pack_2`, … in set order).
 * What it may no longer do is *reassign* an id.
 *
 * When the set's author deletes a sticker, everything below it moves up a slot,
 * so the position of a record whose own sticker is gone points at its
 * NEIGHBOUR. Following it stamped the record with the neighbour's id while it
 * kept its own image and glyph: the panel showed one emoji, Telegram delivered
 * a different one, and the pack came out holding the same `customEmojiId`
 * twice — silently, on a path a database restore reaches on its own.
 *
 * Reserving the claimed ids makes that impossible by construction rather than
 * by an after-the-fact duplicate sweep: an id can only be handed to a record if
 * no other record already owns it, so no re-import can create a duplicate.
 * A record left unpaired keeps every field it has — nothing is swapped for a
 * neighbour's, and {@link CustomEmojiService.rehydratePackAssets} logs the
 * records it had to leave alone.
 */
function pairStickers(
  emojis: readonly CustomEmojiInterface[],
  stickers: readonly TgSticker[],
): ReadonlyArray<TgSticker | undefined> {
  const byId = new Map<string, TgSticker>();
  for (const sticker of stickers) {
    const id = readStickerId(sticker);
    // First wins: a set that repeats an id must not let the copy be handed out
    // a second time below.
    if (id !== null && !byId.has(id)) byId.set(id, sticker);
  }

  const paired: Array<TgSticker | undefined> = emojis.map(() => undefined);
  const claimedIds = new Set<string>();

  emojis.forEach((emoji, index) => {
    if (emoji.customEmojiId === null) return;
    const match = byId.get(emoji.customEmojiId);
    if (match === undefined) return;
    paired[index] = match;
    claimedIds.add(emoji.customEmojiId);
  });

  emojis.forEach((_emoji, index) => {
    if (paired[index] !== undefined) return;
    const candidate: TgSticker | undefined = stickers[index];
    if (candidate === undefined) return;
    const id = readStickerId(candidate);
    if (id !== null && claimedIds.has(id)) return;
    paired[index] = candidate;
    if (id !== null) claimedIds.add(id);
  });

  return paired;
}

/** A sticker's `custom_emoji_id`, or `null` for a plain (non-emoji) sticker. */
function readStickerId(sticker: TgSticker): string | null {
  return typeof sticker.custom_emoji_id === 'string' && sticker.custom_emoji_id.length > 0
    ? sticker.custom_emoji_id
    : null;
}

/**
 * Carry the delivery fields of a freshly fetched sticker into a saved record.
 * Returns the record unchanged (same reference) when nothing moves, so callers
 * can decide on a write with an identity check.
 *
 * The two fields are treated differently on purpose:
 *
 *   - `customEmojiId` follows the source. The record *is* that sticker, so an
 *     id the set no longer contains is stale rather than a preference, and
 *     leaving it would mean the operator has to retype ids one by one — the
 *     very chore this import is supposed to end. That only holds because
 *     {@link pairStickers} hands over the record's OWN sticker or one no other
 *     record claims; called with a neighbour's sticker, this line is exactly
 *     how a pack ends up with one id on two records.
 *   - `fallback` is only filled when absent. Any glyph is deliverable, so a
 *     glyph differing from `sticker.emoji` is a deliberate `updateEmoji` edit,
 *     and a routine re-import must not quietly revert the operator's choice.
 *
 * Neither field is ever replaced by an empty one: a set answering without
 * `custom_emoji_id` (a plain sticker set, or a trimmed API response) must not
 * blank an id that already works.
 */
function applyStickerIdentity(
  emoji: CustomEmojiInterface,
  sticker: TgSticker,
): CustomEmojiInterface {
  const freshId =
    typeof sticker.custom_emoji_id === 'string' && sticker.custom_emoji_id.length > 0
      ? sticker.custom_emoji_id
      : null;
  const freshFallback =
    typeof sticker.emoji === 'string' && sticker.emoji.length > 0 ? sticker.emoji : null;
  const customEmojiId = freshId ?? emoji.customEmojiId;
  const fallback = emoji.fallback ?? freshFallback;
  if (customEmojiId === emoji.customEmojiId && fallback === emoji.fallback) return emoji;
  return { ...emoji, customEmojiId, fallback };
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

/** Apply an operator patch to one emoji; absent fields keep their value. */
function applyEmojiPatch(
  emoji: CustomEmojiInterface,
  patch: UpdateEmojiPatch,
): CustomEmojiInterface {
  return {
    ...emoji,
    name: patch.name?.trim() || emoji.name,
    fallback: patch.fallback === undefined ? emoji.fallback : normalize(patch.fallback),
    customEmojiId:
      patch.customEmojiId === undefined ? emoji.customEmojiId : normalize(patch.customEmojiId),
  };
}

/**
 * Refuse a save whose result cannot reach a Telegram user.
 *
 * The rules are read straight off {@link CustomEmojiService.substituteTelegramHtml}
 * — the only renderer the panel controls — and off the `slug → { id, fallback }`
 * projection handed to reiwa for bot copy, which carries the same two fields:
 *
 *   - a `customEmojiId` that is not digits-only is stripped to nothing before
 *     the `<tg-emoji>` tag is built, so the operator silently gets the glyph
 *     (or nothing) instead of the emoji they pasted an id for;
 *   - with neither field set there is nothing left to send at all — the stored
 *     image is a panel/cabinet asset that never travels to Telegram.
 *
 * An id with no fallback glyph is deliberately NOT refused: both renderers put
 * {@link ID_ONLY_CARRIER} inside the tag for it, so the user receives the
 * custom emoji. Refusing it here rejected a setting that demonstrably works in
 * the bot.
 *
 * Only checked when the patch touches the delivery fields, so renaming a
 * legacy record keeps working and a dead record can always be repaired.
 */
function assertEmojiIsDeliverable(emoji: CustomEmojiInterface, patch: UpdateEmojiPatch): void {
  if (patch.fallback === undefined && patch.customEmojiId === undefined) return;
  const { customEmojiId, fallback } = emoji;
  if (customEmojiId !== null && !CUSTOM_EMOJI_ID_PATTERN.test(customEmojiId)) {
    throw new BadRequestException(
      'custom_emoji_id must be the numeric Telegram id (digits only) — a non-numeric value is dropped before the message is sent',
    );
  }
  if (customEmojiId === null && fallback === null) {
    throw new BadRequestException(
      'Set a fallback glyph or a custom_emoji_id: with neither, the :slug: shortcode delivers nothing to the bot (the stored image is only used inside the panel and the web cabinet)',
    );
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
