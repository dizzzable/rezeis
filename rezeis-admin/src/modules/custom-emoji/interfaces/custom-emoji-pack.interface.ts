/**
 * Custom emoji pack model.
 *
 * A pack is a named group of emojis. Each emoji carries a static image
 * (always — used as the universal render + Telegram/web-push fallback) and an
 * optional Lottie animation (played in the cabinet feed). The `slug` is the
 * shortcode used inside broadcast text as `:slug:`.
 *
 * `customEmojiId` is the Telegram `custom_emoji_id`. It is OPTIONAL and only
 * relevant when a Fragment-username bot (or a bot-owned emoji set) is wired up
 * — for normal delivery the web cabinet renders from `imageUrl`/`lottieUrl`
 * and Telegram receives the `fallback` glyph.
 */
export interface CustomEmojiInterface {
  readonly slug: string;
  readonly name: string;
  readonly imageUrl: string;
  readonly lottieUrl: string | null;
  /** Animated VP9 `.webm` asset (Telegram video emoji). Played as a looping
   *  muted `<video>` in the admin; `null` for static / Lottie emoji. */
  readonly videoUrl: string | null;
  readonly fallback: string | null;
  readonly customEmojiId: string | null;
}

export interface CustomEmojiPackInterface {
  readonly id: string;
  readonly name: string;
  /** Source sticker-set name (from a t.me/addemoji link). Stored so builtin
   *  defaults can be re-imported on a fresh deploy without a manual list. */
  readonly setName?: string;
  /** True for packs provisioned by the on-boot default seeder. */
  readonly builtin?: boolean;
  readonly emojis: readonly CustomEmojiInterface[];
}
