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
  /**
   * Routing kind for this reply-keyboard button. Lowercase string so
   * reiwa can switch on it directly without an enum import:
   *   - `callback`    → emit callback_data; reiwa handler resolves
   *   - `url`         → external URL (actionTarget)
   *   - `webapp`      → Telegram Mini App URL (actionTarget)
   *   - `screen`      → BotFlowScreen.shortId (actionTarget)
   *   - `support_url` → t.me/<handle>?text=<prefill> (target unused;
   *                     reiwa resolves handle at render time)
   */
  readonly actionType: 'callback' | 'url' | 'webapp' | 'screen' | 'support_url';
  /**
   * Action payload — interpretation depends on `actionType`. `null`
   * for `callback` / `support_url`.
   */
  readonly actionTarget: string | null;
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
  /**
   * Optional English welcome message. Sourced from the
   * `bot.welcome_message@en` sibling row (managed via the bot-text
   * editor's "English version" toggle). `null` when the operator has not
   * provided an EN greeting — reiwa then serves the base `welcomeMessage`
   * to EN users.
   */
  readonly welcomeMessageEn: string | null;
  /**
   * Operator override for the support handle reiwa deep-links to, from the
   * `bot.support_username` row. ALWAYS A STRING, never undefined: reiwa calls
   * `.replace()` on it directly, and an empty value is how it is told to fall
   * back to its own `BOT_SUPPORT_USERNAME`.
   *
   * Two neighbours were REMOVED here rather than left unread:
   *   • `botDescription` — a constant nothing consumed. The real thing is
   *     `profile.description`, which reaches Telegram.
   *   • `channelUsername` — a constant duplicating the LIVE field of the same
   *     name in platform branding (`Settings.channelUsername`), which is what
   *     the channel gate actually reads. A second control for it would have
   *     been a switch that changes nothing.
   */
  readonly supportUsername: string;
  /** Used by reiwa to choose between `full` (default — full mini-profile),
   *  `compact` (status line only) or `minimal` (greeting alone) layouts of
   *  the subscription summary appended to the welcome screen. */
  readonly subscriptionInfoFormat: 'compact' | 'full' | 'minimal';
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
  /**
   * When `true`, reiwa uses the global `bannerUrl` as the banner on every
   * dynamic screen that doesn't carry its own media. When `false` (default),
   * only screens with their own media show a banner. Sourced from the
   * `bot.banner_apply_all` BotText row (managed via the main-menu inspector
   * in Bot Studio). Additive — older reiwa builds ignore it.
   */
  readonly bannerApplyAll: boolean;
}

/**
 * Feature switches shipped to reiwa.
 *
 * Only TWO of these are read by reiwa, and only those two are
 * operator-controlled (`bot.feature.*` rows). The rest are emitted from a
 * constant and have deliberately no control anywhere: grep reiwa for them and
 * you find the type declaration and nothing else. Wiring a switch to one of
 * them would produce a setting that visibly does nothing, which is worse than
 * an absent one — so if you are about to add that switch, wire the READER
 * first.
 */
export interface InternalBotConfigFeaturesInterface {
  /** Read by the invite hub and by inline mode. Operator-controlled. */
  readonly referralsEnabled: boolean;
  /** Read by `/start` and the menu. Operator-controlled. */
  readonly miniAppEnabled: boolean;
  /** Not read by reiwa. Constant. */
  readonly promoCodesEnabled: boolean;
  /** Not read by reiwa. Constant. */
  readonly trialEnabled: boolean;
  /** Not read by reiwa. Constant. */
  readonly activityFeedEnabled: boolean;
  /** Not read by reiwa. Constant. */
  readonly partnersEnabled: boolean;
}

/**
 * The bot's own Telegram profile, as the operator wants it.
 *
 * Storage only — the panel never calls Bot API for these. Reiwa owns the
 * user-facing token and applies them with `setMyName` / `setMyDescription` /
 * `setMyShortDescription`, comparing against what Telegram currently reports
 * so an unchanged value costs no call. The panel’s own bot token is for admin
 * notifications and is not guaranteed to be the same bot.
 *
 * An EMPTY string means "leave whatever is set in Telegram alone". That is not
 * the same as clearing a field, and it is the right default: an install that
 * has never opened the bot card must not wipe a profile someone set up in
 * @BotFather.
 */
export interface InternalBotConfigProfileInterface {
  /** Display name (`setMyName`). Telegram rate-limits changes hard. */
  readonly name: string;
  /** Shown on the empty-chat screen before the first message. */
  readonly description: string;
  /** Shown on the profile page and in link previews. */
  readonly shortDescription: string;
}

/**
 * Per-key emoji entry consumed by reiwa: the unicode glyph (always rendered)
 * plus the optional Telegram Premium `custom_emoji_id` overlaid on top of it
 * as a `MessageEntity`. Mirrors reiwa's `BotEmojiEntry` shape exactly — reiwa
 * reads `botEmojis[key].unicode` / `.tgEmojiId`, so the payload MUST send
 * objects (not bare id strings) for operator overrides + premium to apply.
 */
export interface InternalBotEmojiEntry {
  readonly unicode: string;
  readonly tgEmojiId: string | null;
}

/**
 * Map of `EMOJI_KEY → { unicode, tgEmojiId }` used by reiwa to render bot copy
 * and inject premium custom-emoji entities. Operators manage these via
 * `admin/bot-config/emojis`.
 */
export type InternalBotEmojiMap = Readonly<Record<string, InternalBotEmojiEntry>>;

/** Flat `EMOJI_KEY → custom_emoji_id` map (premium ids only). */
export type InternalCustomEmojiIdMap = Readonly<Record<string, string>>;

/**
 * Operator custom-emoji library (imported packs) projected for bot copy.
 * Keyed by `slug` (the `:slug:` shortcode operators insert in texts). Each
 * entry carries the Telegram `custom_emoji_id` (when the pack was imported
 * from a Telegram emoji set — renders as a premium animated emoji) and a
 * `fallback` unicode glyph (shown when premium can't render). reiwa replaces
 * `:slug:` tokens in welcome / screen copy with the fallback glyph plus a
 * custom-emoji entity when `id` is present.
 */
export interface InternalCustomEmojiEntry {
  readonly id: string | null;
  readonly fallback: string | null;
}
export type InternalCustomEmojiMap = Readonly<Record<string, InternalCustomEmojiEntry>>;

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
  readonly action: 'navigate' | 'url' | 'webapp' | 'callback' | 'back' | 'start_over' | 'support_url';
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
  /**
   * Operator-managed Telegram profile. Additive — an older reiwa ignores it,
   * and a reiwa newer than the panel sees it absent and applies nothing.
   */
  readonly profile: InternalBotConfigProfileInterface;
  readonly botEmojis: InternalBotEmojiMap;
  /**
   * Subset of `botEmojis` that reiwa renders inside menu copy text rather
   * than on buttons. Currently identical to `botEmojis`; the field stays
   * separate so we can diverge if the operator marks emojis as
   * "button-only" / "text-only" in a future bot-config UI revision.
   */
  readonly menuTextCustomEmojiIds: InternalCustomEmojiIdMap;
  readonly translations: InternalBotTextMap;
  /**
   * Operator custom-emoji library (`:slug:` shortcodes → id/fallback).
   * Empty when no packs are configured. Additive — older reiwa ignores it.
   */
  readonly customEmojis: InternalCustomEmojiMap;
  /**
   * Panel-managed flag: whether the bot owner's account has Telegram Premium.
   * When `false`, reiwa strips `custom_emoji` entities from rendered copy so a
   * non-premium owner's messages never fail to send. Additive — defaults to
   * `true` when absent (older reiwa ignores it).
   */
  readonly botEmojiOwnerHasPremium: boolean;
  /**
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
  /**
   * Operator-assigned premium-emoji icons for the bot's built-in system
   * buttons (back / invite_share / rules_open / help_contact …), keyed by
   * a stable system-button id → Telegram `custom_emoji_id`. reiwa applies
   * these as `icon_custom_emoji_id` so operators can brand the otherwise
   * code-generated buttons. Sourced from `bot.sysbtn_icon.<key>` BotText
   * rows. Empty when none assigned. Additive — older reiwa ignores it.
   */
  readonly systemButtonIcons: Readonly<Record<string, string>>;
}
