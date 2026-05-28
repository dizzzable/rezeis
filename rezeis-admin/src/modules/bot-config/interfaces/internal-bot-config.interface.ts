/**
 * Read-only payload returned by `GET /api/internal/bot-config`.
 *
 * Mirrors the shape that `reiwa/src/bot/main.ts` already expects via its
 * `BotConfig` type — keep the names and layout in sync. Reiwa uses this on
 * every bot-config refresh (every 5 minutes) and on bootstrap. The whole
 * payload is *user-safe*: there are no secrets, IDs, or admin-only fields.
 */
export interface InternalBotConfigButtonInterface {
  readonly id: string;
  readonly emoji: string;
  readonly label: string;
  readonly visible: boolean;
  readonly order: number;
  readonly style: 'default' | 'primary' | 'success' | 'danger';
  readonly onePerRow: boolean;
  /**
   * Optional Telegram custom-emoji id (premium emoji) used as the button
   * icon via `icon_custom_emoji_id`. `null` when the operator did not pin
   * a premium emoji to the button.
   */
  readonly iconCustomEmojiId: string | null;
}

/**
 * What kind of Telegram inline-keyboard button each well-known reiwa
 * `buttonId` should render as.
 *
 *  - `url`     — opens an external URL (in-app Telegram browser). The
 *                URL is built from the canonical `reiwaPublicUrl`
 *                (see `bot.banner_url` rules below). Used for the
 *                "Мой кабинет" CTA — the Mini App lives at the same
 *                origin, but operators want the user kicked out of
 *                Telegram into a real browser session for the
 *                credential flow.
 *  - `webapp`  — opens the Mini App (HTTPS-only). Telegram refuses the
 *                button entirely if the URL is not HTTPS, so the bot
 *                gates on `reiwaWebAppUrl` rather than `reiwaPublicUrl`.
 *  - `callback` (default) — emits the button id as `callback_data` so
 *                the bot's existing `bot.callbackQuery(id)` handlers
 *                pick it up.
 *
 * Reiwa hardcodes this mapping; the admin panel only controls visual
 * properties (label / order / style / emoji / one-per-row).
 */

export interface InternalBotConfigVisualInterface {
  readonly welcomeMessage: string;
  readonly botDescription: string;
  readonly supportUsername: string;
  readonly channelUsername: string;
  /** Used by reiwa to choose between "compact" / "full" layout of the
   *  subscription status card on the welcome screen. */
  readonly subscriptionInfoFormat: 'compact' | 'full';
  /**
   * Optional URL (or Telegram `file_id`) of the banner image sent before
   * the welcome text on `/start`.
   *
   * Operators set this through the admin bot editor (`admin/bot-config`,
   * `BotText` row with `key === 'bot.banner_url'`). When unset, reiwa
   * falls back to the bundled default at `${reiwaPublicUrl}/banner.png`.
   * Setting an empty string disables the banner entirely so a deployment
   * that hasn't customised it doesn't accidentally ship the default.
   */
  readonly bannerUrl: string | null;
}

export interface InternalBotConfigFeaturesInterface {
  readonly referralsEnabled: boolean;
  readonly promoCodesEnabled: boolean;
  readonly trialEnabled: boolean;
  readonly miniAppEnabled: boolean;
  readonly activityFeedEnabled: boolean;
  readonly partnersEnabled: boolean;
}

/**
 * Map of `EMOJI_KEY → custom_emoji_id` used by reiwa to inject premium
 * emoji into bot copy as `MessageEntity[]`. Operators manage these via
 * `admin/bot-config/emojis`. When an emoji has no `tgEmojiId` it is
 * omitted from this map (reiwa falls back to the unicode glyph).
 */
export type InternalBotEmojiMap = Readonly<Record<string, string>>;

/**
 * Map of `text_key → translated_value` for arbitrary copy strings. Reiwa
 * consumes this as a fallback translation table — `setTranslations(...)`
 * in `bot/i18n.ts` handles per-locale suffixes (e.g. `welcome.title.en`).
 */
export type InternalBotTextMap = Readonly<Record<string, string>>;

/**
 * A button rendered inside a dynamic screen. Mirrors the
 * `BotFlowButton` Prisma model 1:1, with action types translated to
 * the strings reiwa understands at runtime.
 *
 * `targetShortId` for `navigate` actions points at another screen's
 * `shortId` in the same `screens` array — reiwa renders that screen
 * when the user presses the button.
 */
export interface InternalBotConfigScreenButtonInterface {
  readonly id: string;
  readonly labelRu: string;
  readonly labelEn: string;
  readonly row: number;
  readonly col: number;
  readonly action: 'navigate' | 'url' | 'webapp' | 'callback' | 'back' | 'start_over';
  readonly targetShortId: string | null;
  readonly url: string | null;
  readonly webAppUrl: string | null;
  readonly callbackAction: string | null;
  readonly style: 'default' | 'primary' | 'success' | 'danger';
  readonly iconCustomEmojiId: string | null;
}

/**
 * Operator-managed bot screen rendered as a Telegram message with
 * an optional inline keyboard. When the user presses a reply-keyboard
 * button or an inline button whose `targetShortId` points at this
 * screen, reiwa renders the screen via `editMessageContent`.
 *
 * Sourced from the `bot_flows` (PUBLISHED) → `bot_flow_screens` table
 * tree on the admin side. When the table is empty / no flow is
 * published, reiwa falls back to its hardcoded sub-menu (help / rules
 * / invite) so the bot keeps working out of the box.
 */
export interface InternalBotConfigScreenInterface {
  readonly id: string;
  readonly shortId: string;
  readonly name: string;
  readonly textRu: string;
  readonly textEn: string;
  readonly parseMode: 'html' | 'markdown' | 'plain';
  readonly mediaType: 'photo' | 'video' | 'document' | 'animation' | null;
  readonly mediaFileId: string | null;
  readonly mediaUrl: string | null;
  readonly isRoot: boolean;
  readonly buttons: readonly InternalBotConfigScreenButtonInterface[];
}

export interface InternalBotConfigInterface {
  readonly buttons: readonly InternalBotConfigButtonInterface[];
  readonly visual: InternalBotConfigVisualInterface;
  readonly features: InternalBotConfigFeaturesInterface;
  readonly botEmojis: InternalBotEmojiMap;
  /**
   * Subset of `botEmojis` that reiwa renders inside menu copy text rather
   * than on buttons. Currently identical to `botEmojis`; the field stays
   * separate so we can diverge if the operator marks emojis as
   * "button-only" / "text-only" in a future bot-config UI revision.
   */
  readonly menuTextCustomEmojiIds: InternalBotEmojiMap;
  readonly translations: InternalBotTextMap;
  /**
   * Operator-managed dynamic screens. Empty when no flow is
   * published — reiwa then falls back to its built-in sub-menus.
   * The first screen with `isRoot=true` (if any) is the entry point
   * that overrides reiwa's `/start` welcome screen.
   */
  readonly screens: readonly InternalBotConfigScreenInterface[];
  /**
   * Identifier of the published flow version that produced `screens`.
   * Used by reiwa for cache-key validation. Empty string when no flow
   * is published (built-in fallback in effect).
   */
  readonly screensVersion: string;
}
