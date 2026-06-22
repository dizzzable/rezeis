import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  BotButton,
  BotButtonAction,
  BotButtonStyle,
  BotEmoji,
  BotFlow,
  BotFlowButton,
  BotFlowButtonAction,
  BotFlowButtonStyle,
  BotFlowMediaType,
  BotFlowParseMode,
  BotFlowScreen,
  BotText,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { getProcessRole } from '../../../common/runtime/process-role.util';
import { BotFlowService } from '../../bot-flow/services/bot-flow.service';
import { CustomEmojiPackInterface } from '../../custom-emoji/interfaces/custom-emoji-pack.interface';
import { readCustomEmojiPacks } from '../../custom-emoji/utils/custom-emoji-packs.util';
import {
  InternalBotConfigButtonInterface,
  InternalBotConfigFeaturesInterface,
  InternalBotConfigInterface,
  InternalBotConfigScreenButtonInterface,
  InternalBotConfigScreenInterface,
  InternalBotConfigVisualInterface,
  InternalBotEmojiMap,
  InternalCustomEmojiIdMap,
  InternalCustomEmojiMap,
  InternalBotTextMap,
} from '../interfaces/internal-bot-config.interface';
import { BotButtonsService } from './bot-buttons.service';
import { BotEmojisService } from './bot-emojis.service';
import { BotTextsService } from './bot-texts.service';

/**
 * InternalBotConfigService
 * ────────────────────────
 * Composes the runtime bot configuration payload consumed by reiwa over
 * the `/api/internal/bot-config` route. Source of truth for buttons /
 * emojis / texts is the `BotButton` / `BotEmoji` / `BotText` Prisma
 * tables.
 *
 * On first run (`BotButton` table empty) we seed the default reiwa
 * keyboard layout — "Мой кабинет" (primary, opens the web app), invite,
 * rules + help row. Operators then customise these through the existing
 * `admin/bot-config` UI; we never re-seed once a single button exists,
 * so an operator who deletes everything and starts from scratch isn't
 * surprised by reset values.
 *
 * `bannerUrl` is read from a `BotText` row keyed `bot.banner_url`. The
 * same admin UI ("Тексты бота") manages it, no separate migration.
 *
 * `visual` and `features` keep static defaults today — when the admin
 * panel grows a "Bot visual" / "Bot features" UI we'll back them with
 * new columns on `Settings` and override the defaults from there. The
 * shape is fixed by the reiwa client, so adding new optional fields
 * stays additive.
 */
@Injectable()
export class InternalBotConfigService implements OnApplicationBootstrap {
  private readonly logger = new Logger(InternalBotConfigService.name);
  private seedAttempted = false;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly botButtonsService: BotButtonsService,
    private readonly botEmojisService: BotEmojisService,
    private readonly botTextsService: BotTextsService,
    private readonly botFlowService: BotFlowService,
  ) {}

  /**
   * Pre-seed the default keyboard + banner placeholder during application
   * bootstrap so operators see real rows in the admin panel before the
   * first reiwa request arrives. The seed is idempotent (skips when at
   * least one BotButton row exists), so re-runs across multiple replicas
   * or restarts are safe.
   *
   * Gated to roles `api` and `all` — the worker container shares the
   * same DB so letting both processes race the seed would risk one of
   * them blowing the unique-buttonId constraint mid-insert. Workers
   * still get the seeded payload via the same DB read path; they just
   * don't drive the seeding.
   */
  public async onApplicationBootstrap(): Promise<void> {
    const role = getProcessRole();
    if (role === 'worker') return;
    await this.ensureDefaultsSeeded();
  }

  public async getConfig(): Promise<InternalBotConfigInterface> {
    await this.ensureDefaultsSeeded();

    const [buttons, emojis, texts, activeFlow] = await Promise.all([
      this.botButtonsService.listAll(),
      this.botEmojisService.listAll(),
      this.botTextsService.listAll(),
      // The active flow that drives dynamic screens. Prefer PUBLISHED;
      // fall back to DRAFT so operator edits go live immediately
      // without an explicit Publish step. `null` when neither status
      // exists — reiwa falls back to its built-in sub-menus.
      this.botFlowService.getActive(DEFAULT_FLOW_NAME),
    ]);
    // Custom-emoji packs + owner-premium flag are best-effort: a read failure
    // shouldn't blank the whole bot-config payload. Read directly from
    // Settings (pure util) to avoid a CustomEmojiModule import cycle.
    const settingsRow = await this.prismaService.settings
      .findFirst({ orderBy: { updatedAt: 'asc' } })
      .catch(() => null);
    const customEmojiPacks = readCustomEmojiPacks(settingsRow?.systemNotifications);
    const botEmojiOwnerHasPremium = readOwnerHasPremium(settingsRow?.systemNotifications);

    const emojiMap = withDefaultPremiumIds(mapEmojiEntries(emojis));
    // Full map (every row) — used by config-style readers (banner URL,
    // subscription format) whose rows are intentionally `visible:false`.
    const textMap = mapTexts(texts);
    // Copy-override map — excludes rows the operator hid (`visible:false`)
    // and their `@en` siblings, so a disabled text falls back to the
    // built-in i18n default on reiwa instead of still being served.
    const visibleTextMap = mapTexts(visibleCopyTexts(texts));

    const welcomeRow = texts.find((row) => row.key === WELCOME_MESSAGE_KEY);
    const welcomeEnRow = texts.find(
      (row) => row.key === `${WELCOME_MESSAGE_KEY}${EN_KEY_SUFFIX}`,
    );

    return {
      buttons: buttons.map(mapButton),
      visual: {
        welcomeMessage: resolveWelcomeMessage(welcomeRow),
        welcomeMessageEn: resolveWelcomeMessageEn(welcomeRow, welcomeEnRow),
        botDescription: DEFAULT_VISUAL.botDescription,
        supportUsername: DEFAULT_VISUAL.supportUsername,
        channelUsername: DEFAULT_VISUAL.channelUsername,
        subscriptionInfoFormat: readSubscriptionInfoFormat(textMap),
        bannerUrl: readBannerUrl(textMap),
        bannerApplyAll: readBannerApplyAll(textMap),
      },
      features: DEFAULT_FEATURES,
      botEmojis: emojiMap,
      menuTextCustomEmojiIds: toCustomEmojiIdMap(emojiMap),
      translations: visibleTextMap,
      customEmojis: mapCustomEmojis(customEmojiPacks),
      botEmojiOwnerHasPremium,
      screens: mapFlowScreens(activeFlow),
      screensVersion: activeFlow
        ? `${activeFlow.id}:${activeFlow.version}:${activeFlow.status}`
        : '',
      systemButtonIcons: readSystemButtonIcons(textMap),
    };
  }

  private async ensureDefaultsSeeded(): Promise<void> {
    if (this.seedAttempted) return;
    this.seedAttempted = true;
    try {
      // Emoji + text catalogs are seeded additively (each row is upserted
      // only when its key is missing) so existing deployments that already
      // have buttons still get the new mini-profile keys after upgrade,
      // and operator-edited values are never overwritten.
      await this.seedDefaultEmojis();
      await this.seedDefaultTexts();

      const existingButtonCount = await this.prismaService.botButton.count();
      if (existingButtonCount === 0) {
        await this.seedDefaultButtons();
        await this.seedDefaultBannerText();
        this.logger.log('Seeded default reiwa bot keyboard (5 buttons + banner).');
      }
    } catch (err: unknown) {
      // Don't poison the cached `seedAttempted` flag on error — let the
      // next request retry rather than ship a degraded payload forever.
      this.seedAttempted = false;
      this.logger.warn(
        `Bot config seed failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Upserts the canonical reiwa-side emoji slot list. Each entry is
   * inserted only if the key is missing, so operator overrides survive.
   * Mirrors {@link DEFAULT_EMOJIS} (kept in lockstep with reiwa's
   * `DEFAULT_PREMIUM_IDS` / `DEFAULT_UNICODE`).
   */
  private async seedDefaultEmojis(): Promise<void> {
    for (const seed of DEFAULT_EMOJIS) {
      const existing = await this.prismaService.botEmoji.findUnique({
        where: { key: seed.key },
        select: { id: true },
      });
      if (existing !== null) continue;
      try {
        await this.botEmojisService.create({
          key: seed.key,
          unicode: seed.unicode,
          tgEmojiId: seed.tgEmojiId ?? null,
        });
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to seed bot emoji "${seed.key}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Upserts the canonical reiwa-side i18n keys (mini-profile labels) so
   * operators can edit them in the admin "Тексты" panel out of the box.
   * Idempotent: existing rows are skipped.
   */
  private async seedDefaultTexts(): Promise<void> {
    for (const seed of DEFAULT_TEXTS) {
      const existing = await this.prismaService.botText.findUnique({
        where: { key: seed.key },
        select: { id: true },
      });
      if (existing !== null) continue;
      try {
        await this.botTextsService.create({
          key: seed.key,
          value: seed.value,
          visible: true,
        });
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to seed bot text "${seed.key}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private async seedDefaultButtons(): Promise<void> {
    // Sequential `create` (not `createMany`) so the duplicate-buttonId
    // guard inside `BotButtonsService.create` keeps protecting us. We
    // only end up here once when the table is empty, so the per-row
    // overhead is irrelevant.
    for (const seed of DEFAULT_BUTTONS) {
      try {
        await this.botButtonsService.create({
          buttonId: seed.buttonId,
          label: seed.label,
          style: seed.style,
          iconCustomEmojiId: seed.iconCustomEmojiId,
          visible: true,
          onePerRow: seed.onePerRow,
          orderIndex: seed.orderIndex,
          actionType: seed.actionType,
          actionTarget: seed.actionTarget,
        });
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to seed bot button "${seed.buttonId}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private async seedDefaultBannerText(): Promise<void> {
    const existing = await this.prismaService.botText.findUnique({
      where: { key: BANNER_URL_KEY },
      select: { id: true },
    });
    if (existing !== null) return;
    try {
      await this.botTextsService.create({
        key: BANNER_URL_KEY,
        value: '',
        visible: false,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to seed banner placeholder: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

const BANNER_URL_KEY = 'bot.banner_url';
const BANNER_APPLY_ALL_KEY = 'bot.banner_apply_all';
const SYSBTN_ICON_PREFIX = 'bot.sysbtn_icon.';
const WELCOME_MESSAGE_KEY = 'bot.welcome_message';
const SUBSCRIPTION_INFO_FORMAT_KEY = 'bot.subscription_info_format';

/**
 * Reserved suffix for the per-text English sibling row, mirrored from
 * {@link BotTextsService}. `mapTexts` rewrites `<key>@en` rows into
 * `<key>.en` translation entries.
 */
const EN_KEY_SUFFIX = '@en';

type SubscriptionInfoFormat = InternalBotConfigVisualInterface['subscriptionInfoFormat'];

const VALID_SUBSCRIPTION_INFO_FORMATS: readonly SubscriptionInfoFormat[] = [
  'full',
  'compact',
  'minimal',
];

/**
 * Name of the BotFlow that owns the user-facing dynamic screens. We
 * pin reiwa to a single named flow so operators can't accidentally
 * publish a "Marketing campaign" flow over the live navigation.
 *
 * Future: expose multi-flow selection per use-case (welcome,
 * onboarding, support tree). For now there's exactly one.
 */
const DEFAULT_FLOW_NAME = 'Main Flow';

interface DefaultButtonSeed {
  readonly buttonId: string;
  readonly label: string;
  readonly style: BotButtonStyle;
  readonly onePerRow: boolean;
  readonly orderIndex: number;
  readonly iconCustomEmojiId: string | null;
  readonly actionType: BotButtonAction;
  readonly actionTarget: string | null;
}

/**
 * Default reiwa keyboard layout (v0.5.0 — Wave A bot pruning).
 *
 *   ┌───────────────────────────────────────────────────────┐
 *   │  Открыть приложение                                    │  WEBAPP, primary
 *   ├───────────────────────────────────────────────────────┤
 *   │  Кабинет                                               │  URL → REIWA_DOMAIN
 *   ├───────────────────────────────────────────────────────┤
 *   │  Пригласить                                            │  CALLBACK, success
 *   ├──────────────────────────┬────────────────────────────┤
 *   │  Правила                 │  Помощь                     │  CALLBACK / SUPPORT_URL
 *   └──────────────────────────┴────────────────────────────┘
 *
 *  - WebApp opens the Mini App inline. `actionType=WEBAPP` makes reiwa
 *    forward the operator-supplied target if any; with the seed leaving
 *    `actionTarget=null`, reiwa falls back to `${reiwaWebAppUrl}` from
 *    its env (`REIWA_DOMAIN`).
 *  - Кабинет opens the same SPA in the in-app Telegram browser. Wave C
 *    will swap the URL for a magic-link `?signin=<token>` so the
 *    browser session is auto-authenticated.
 *  - Пригласить emits the `invite` callback that fetches a referral
 *    token from admin and shows the share screen.
 *  - Правила emits the `rules` callback (admin-managed screen).
 *  - Помощь is `support_url` so reiwa renders a direct
 *    `t.me/<support>?text=…` deep-link — one tap into support DM.
 *
 *  Premium custom emoji ids only render when the bot owner has Telegram
 *  Premium; for everyone else Telegram silently ignores the field and
 *  shows the label without an icon. The ids are fixed here so deployments
 *  with a Premium owner share the same brand iconography out of the box.
 */
const DEFAULT_BUTTONS: readonly DefaultButtonSeed[] = [
  {
    buttonId: 'webapp',
    label: 'Открыть приложение',
    style: BotButtonStyle.PRIMARY,
    onePerRow: true,
    orderIndex: 0,
    iconCustomEmojiId: '5276127848644503161',
    actionType: BotButtonAction.WEBAPP,
    actionTarget: null,
  },
  {
    buttonId: 'cabinet',
    label: 'Кабинет',
    style: BotButtonStyle.DEFAULT,
    onePerRow: true,
    orderIndex: 1,
    iconCustomEmojiId: '5278589204207528856',
    actionType: BotButtonAction.URL,
    actionTarget: null,
  },
  {
    buttonId: 'invite',
    label: 'Пригласить',
    style: BotButtonStyle.SUCCESS,
    onePerRow: true,
    orderIndex: 2,
    iconCustomEmojiId: '5298668674532538341',
    actionType: BotButtonAction.CALLBACK,
    actionTarget: null,
  },
  {
    buttonId: 'rules',
    label: 'Правила',
    style: BotButtonStyle.DEFAULT,
    onePerRow: false,
    orderIndex: 3,
    iconCustomEmojiId: '5276314275994954605',
    actionType: BotButtonAction.CALLBACK,
    actionTarget: null,
  },
  {
    buttonId: 'help',
    label: 'Помощь',
    style: BotButtonStyle.DEFAULT,
    onePerRow: false,
    orderIndex: 4,
    iconCustomEmojiId: '5276229330131772747',
    actionType: BotButtonAction.SUPPORT_URL,
    actionTarget: null,
  },
];

function mapButton(button: BotButton): InternalBotConfigButtonInterface {
  return {
    id: button.buttonId,
    emoji: '',
    label: button.label,
    visible: button.visible,
    order: button.orderIndex,
    style: mapButtonStyle(button.style),
    onePerRow: button.onePerRow,
    iconCustomEmojiId: button.iconCustomEmojiId,
    actionType: mapButtonAction(button.actionType),
    actionTarget: button.actionTarget,
  };
}

function mapButtonAction(
  action: BotButtonAction,
): InternalBotConfigButtonInterface['actionType'] {
  switch (action) {
    case BotButtonAction.URL:
      return 'url';
    case BotButtonAction.WEBAPP:
      return 'webapp';
    case BotButtonAction.SCREEN:
      return 'screen';
    case BotButtonAction.SUPPORT_URL:
      return 'support_url';
    case BotButtonAction.CALLBACK:
    default:
      return 'callback';
  }
}

function mapButtonStyle(
  style: BotButtonStyle,
): InternalBotConfigButtonInterface['style'] {
  switch (style) {
    case BotButtonStyle.PRIMARY:
      return 'primary';
    case BotButtonStyle.SUCCESS:
      return 'success';
    case BotButtonStyle.DANGER:
      return 'danger';
    case BotButtonStyle.DEFAULT:
    default:
      return 'default';
  }
}

/** Read the panel-managed owner-premium flag from settings JSON (default true). */
function readOwnerHasPremium(systemNotifications: unknown): boolean {
  if (typeof systemNotifications !== 'object' || systemNotifications === null) return true;
  const botEmoji = (systemNotifications as Record<string, unknown>).botEmoji;
  if (typeof botEmoji !== 'object' || botEmoji === null) return true;
  const flag = (botEmoji as Record<string, unknown>).ownerHasPremium;
  return typeof flag === 'boolean' ? flag : true;
}

function mapEmojiEntries(emojis: readonly BotEmoji[]): InternalBotEmojiMap {
  const map: Record<string, { unicode: string; tgEmojiId: string | null }> = {};
  for (const emoji of emojis) {
    map[emoji.key] = {
      unicode: emoji.unicode ?? '',
      tgEmojiId: emoji.tgEmojiId !== null && emoji.tgEmojiId.length > 0 ? emoji.tgEmojiId : null,
    };
  }
  return map;
}

/**
 * Canonical default premium custom-emoji ids by semantic key, derived from
 * {@link DEFAULT_EMOJIS}. reiwa no longer bakes these in (single source =
 * rezeis), so we merge them into the payload here: an operator-configured
 * `tgEmojiId` always wins, and keys the operator never set (or cleared on an
 * instance whose `BotEmoji` rows predate the tgEmojiId defaults) still get the
 * sensible premium glyph instead of degrading to plain unicode.
 */
function withDefaultPremiumIds(map: InternalBotEmojiMap): InternalBotEmojiMap {
  const merged: Record<string, { unicode: string; tgEmojiId: string | null }> = {};
  for (const [key, entry] of Object.entries(map)) {
    merged[key] = { unicode: entry.unicode, tgEmojiId: entry.tgEmojiId };
  }
  for (const seed of DEFAULT_EMOJIS) {
    if (!seed.tgEmojiId) continue;
    const existing = merged[seed.key];
    if (existing === undefined) {
      merged[seed.key] = { unicode: seed.unicode, tgEmojiId: seed.tgEmojiId };
    } else if (existing.tgEmojiId === null) {
      merged[seed.key] = {
        unicode: existing.unicode.length > 0 ? existing.unicode : seed.unicode,
        tgEmojiId: seed.tgEmojiId,
      };
    }
  }
  return merged;
}

/** Flatten the emoji map to a `key → custom_emoji_id` map (premium ids only). */
function toCustomEmojiIdMap(map: InternalBotEmojiMap): InternalCustomEmojiIdMap {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(map)) {
    if (entry.tgEmojiId !== null && entry.tgEmojiId.length > 0) out[key] = entry.tgEmojiId;
  }
  return out;
}

/**
 * Project operator custom-emoji packs into a `slug → { id, fallback }` map
 * for bot copy. `id` is the Telegram `custom_emoji_id` (premium render);
 * `fallback` is the unicode glyph reiwa shows when premium can't render.
 */
function mapCustomEmojis(packs: readonly CustomEmojiPackInterface[]): InternalCustomEmojiMap {
  const map: Record<string, { id: string | null; fallback: string | null }> = {};
  for (const pack of packs) {
    for (const emoji of pack.emojis) {
      map[emoji.slug] = { id: emoji.customEmojiId, fallback: emoji.fallback };
    }
  }
  return map;
}

/**
 * Drop hidden copy rows so disabled texts fall back to the built-in i18n
 * default on reiwa. A base row with `visible:false` removes both itself and
 * its `<key>@en` sibling (Property: a hidden base disables both locales).
 */
function visibleCopyTexts(texts: readonly BotText[]): BotText[] {
  const hiddenBaseKeys = new Set<string>();
  for (const text of texts) {
    if (!text.key.endsWith(EN_KEY_SUFFIX) && text.visible === false) {
      hiddenBaseKeys.add(text.key);
    }
  }
  return texts.filter((text) => {
    if (text.visible === false) return false;
    const baseKey = text.key.endsWith(EN_KEY_SUFFIX)
      ? text.key.slice(0, -EN_KEY_SUFFIX.length)
      : text.key;
    return !hiddenBaseKeys.has(baseKey);
  });
}

function mapTexts(texts: readonly BotText[]): InternalBotTextMap {
  const map: Record<string, string> = {};
  for (const text of texts) {
    if (text.key.endsWith(EN_KEY_SUFFIX)) {
      // Project the English sibling `<key>@en` as `<key>.en` so reiwa's
      // translator dispatches it into the EN pack via its existing
      // `<i18n key>.<lang>` suffix convention — no reiwa resolver change
      // needed, and already-deployed bots pick it up.
      const baseKey = text.key.slice(0, -EN_KEY_SUFFIX.length);
      map[`${baseKey}.en`] = text.value;
    } else {
      map[text.key] = text.value;
    }
  }
  return map;
}

function readBannerUrl(textMap: InternalBotTextMap): string | null {
  const raw = textMap[BANNER_URL_KEY];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read the `bot.banner_apply_all` flag (managed via the main-menu inspector).
 * Truthy only for the literal `'true'` (case-insensitive); anything else —
 * including the unset / empty / seed default — is `false`.
 */
function readBannerApplyAll(textMap: InternalBotTextMap): boolean {
  const raw = textMap[BANNER_APPLY_ALL_KEY];
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}

/**
 * Collect operator-assigned system-button icons. Each `bot.sysbtn_icon.<key>`
 * BotText row whose value is a non-empty Telegram `custom_emoji_id` becomes a
 * `<key> → id` entry. Empty / blank values are skipped (operator cleared the
 * icon). The `<key>` is the stable system-button id reiwa matches on.
 */
function readSystemButtonIcons(
  textMap: InternalBotTextMap,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(textMap)) {
    if (!key.startsWith(SYSBTN_ICON_PREFIX)) continue;
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (id.length === 0) continue;
    const buttonKey = key.slice(SYSBTN_ICON_PREFIX.length);
    if (buttonKey.length > 0) out[buttonKey] = id;
  }
  return out;
}

/**
 * Resolve the operator-managed welcome greeting from its `BotText` row.
 *   - row absent (never configured) → built-in default (fresh deploy).
 *   - row hidden (`visible === false`) → empty string: the operator
 *     explicitly suppressed the greeting (reiwa renders no greeting line
 *     rather than reverting to the built-in default).
 *   - row shown → exactly the operator's value.
 */
function resolveWelcomeMessage(row: BotText | undefined): string {
  if (row === undefined) return DEFAULT_VISUAL.welcomeMessage;
  if (row.visible === false) return '';
  return row.value;
}

/**
 * Resolve the English welcome override. A hidden base row suppresses EN too
 * (the whole greeting is off). Otherwise use the `@en` sibling when non-empty.
 */
function resolveWelcomeMessageEn(
  baseRow: BotText | undefined,
  enRow: BotText | undefined,
): string | null {
  if (baseRow !== undefined && baseRow.visible === false) return null;
  if (enRow === undefined) return null;
  return enRow.value.trim().length > 0 ? enRow.value : null;
}

/**
 * Resolve the operator-managed `subscriptionInfoFormat`. Accepts
 * `full | compact | minimal` (case-insensitive); anything else falls
 * back to `full` so a typo doesn't break the greeting layout.
 */
function readSubscriptionInfoFormat(
  textMap: InternalBotTextMap,
): SubscriptionInfoFormat {
  const raw = textMap[SUBSCRIPTION_INFO_FORMAT_KEY];
  if (typeof raw === 'string') {
    const normalised = raw.trim().toLowerCase() as SubscriptionInfoFormat;
    if (VALID_SUBSCRIPTION_INFO_FORMATS.includes(normalised)) {
      return normalised;
    }
  }
  return DEFAULT_VISUAL.subscriptionInfoFormat;
}

const DEFAULT_VISUAL: Omit<
  InternalBotConfigVisualInterface,
  'bannerUrl' | 'bannerApplyAll'
> = {
  welcomeMessage: 'Привет, {{firstName}}! 👋\n\nДобро пожаловать в Rezeis VPN.',
  welcomeMessageEn: null,
  botDescription: 'Быстрый и надёжный VPN',
  supportUsername: '',
  channelUsername: '',
  subscriptionInfoFormat: 'full',
};

const DEFAULT_FEATURES: InternalBotConfigFeaturesInterface = {
  referralsEnabled: true,
  promoCodesEnabled: true,
  trialEnabled: false,
  miniAppEnabled: true,
  activityFeedEnabled: true,
  partnersEnabled: false,
};

interface DefaultEmojiSeed {
  readonly key: string;
  readonly unicode: string;
  readonly tgEmojiId: string | null;
}

/**
 * Canonical reiwa-side emoji slots surfaced to the admin "Эмодзи" editor.
 *
 * This is now the SINGLE source of truth for the bot's semantic premium
 * emoji (mini-profile icons 👤 📱 📈 📅) and status / traffic unicode glyphs —
 * reiwa no longer carries any baked-in ids. The seed is additive (each row is
 * inserted only when its key is missing), so operator edits win forever and a
 * cleared `tgEmojiId` correctly degrades the bot to the unicode glyph.
 */
const DEFAULT_EMOJIS: readonly DefaultEmojiSeed[] = [
  // Mini-profile (greeting summary)
  { key: 'SUB_PROFILE', unicode: '👤', tgEmojiId: '5275979556308674886' },
  { key: 'SUB_DEVICES', unicode: '📱', tgEmojiId: '5278647306525108244' },
  { key: 'SUB_TRAFFIC', unicode: '📈', tgEmojiId: '5278778882848220741' },
  { key: 'SUB_EXPIRY',  unicode: '📅', tgEmojiId: '5206222720416643915' },
  // Status indicators (subscription card / mini-profile)
  { key: 'STATUS_ACTIVE',   unicode: '🟢', tgEmojiId: null },
  { key: 'STATUS_LIMITED',  unicode: '🟡', tgEmojiId: null },
  { key: 'STATUS_EXPIRED',  unicode: '🔴', tgEmojiId: null },
  { key: 'STATUS_DISABLED', unicode: '⚫', tgEmojiId: null },
  // Traffic activity dots (≤80% / ≥80% / 100% or LIMITED)
  { key: 'TRAFFIC_OK',   unicode: '🟢', tgEmojiId: null },
  { key: 'TRAFFIC_WARN', unicode: '🟠', tgEmojiId: null },
  { key: 'TRAFFIC_FULL', unicode: '🔴', tgEmojiId: null },

  // Free-trial CTA (bot keyboard "try for free" button icon). The reiwa
  // trial button resolves its premium icon from this key (TRIAL → GIFT →
  // PROMO). Ships a TranslucentPack gift glyph so the button renders premium
  // out of the box; degrades to the 🆓 unicode when the owner lacks premium.
  { key: 'TRIAL', unicode: '🆓', tgEmojiId: '5276422526350681413' },
];

interface DefaultTextSeed {
  readonly key: string;
  readonly value: string;
}

/**
 * Canonical reiwa-side i18n keys surfaced to the admin "Тексты" editor.
 * Mirrors the RU pack reiwa ships with — operators can edit values without
 * a redeploy. Adding a new key here makes it appear in the admin out of
 * the box; existing rows are never overwritten.
 */
const DEFAULT_TEXTS: readonly DefaultTextSeed[] = [
  // Greeting (admin-editable). `{{firstName}}` is substituted by reiwa.
  {
    key: WELCOME_MESSAGE_KEY,
    value: 'Привет, {{firstName}}! 👋\n\nДобро пожаловать в Rezeis VPN.',
  },
  // Layout of the per-subscription summary appended to the welcome:
  //   `full`    — profile / devices / traffic bar / expiry (default)
  //   `compact` — status line only
  //   `minimal` — greeting alone, no summary
  { key: SUBSCRIPTION_INFO_FORMAT_KEY, value: 'full' },
  // Mini-profile (greeting summary)
  { key: 'profile.subscription',       value: 'Подписка' },
  { key: 'profile.devices',            value: 'Устройств: {{count}} доступно' },
  { key: 'profile.devices_unlimited',  value: 'Устройств: безлимит' },
  { key: 'profile.traffic',            value: 'Трафик' },
  { key: 'profile.until',              value: 'До' },
  { key: 'profile.unlimited',          value: 'Безлимит' },
  // Generic fallbacks shared across the bot
  { key: 'common.not_available',       value: 'Н/Д' },
  // Platform access-mode kill-switch banners (used by /start when the
  // operator switches the platform out of PUBLIC). Editable copy so
  // operators can soften / expand the wording without redeploying.
  {
    key: 'access_mode.restricted',
    value:
      '🛠 Сервис временно недоступен — ведутся технические работы. Существующие подключения VPN продолжают работать. Попробуйте позже.',
  },
  {
    key: 'access_mode.reg_blocked_new',
    value: '🚫 Регистрация в сервисе временно отключена. Свяжитесь с поддержкой, если у вас уже есть аккаунт.',
  },
  {
    key: 'access_mode.invited_no_code',
    value: '✉️ Сейчас регистрация только по приглашению. Откройте бота по invite-ссылке от друга или партнёра.',
  },
  {
    key: 'access_mode.purchase_blocked',
    value: '🛒 Покупка временно недоступна. Действующие подписки можно продлевать как обычно.',
  },
  // Channel-subscription gate (used by /start + the "I subscribed" button
  // when the operator requires a channel subscription). Editable copy.
  {
    key: 'channel.required',
    value:
      'Для доступа к боту подпишитесь на наш канал, затем нажмите «Я подписался».',
  },
  { key: 'channel.join_button', value: '📢 Перейти в канал' },
  { key: 'channel.check_button', value: '✅ Я подписался' },
  {
    key: 'channel.not_subscribed',
    value: '❌ Вы ещё не подписаны на канал. Подпишитесь и попробуйте снова.',
  },
  { key: 'channel.verified', value: '✅ Подписка подтверждена!' },
  // Referral / Partner hub (bot "Пригласить" button). Editable so operators
  // can localize / rebrand the program copy without a redeploy.
  { key: 'referral.hub.title', value: '🔗 Реферальная программа' },
  {
    key: 'referral.hub.description',
    value:
      'Приглашайте друзей по своей ссылке — за каждого, кто оформит подписку, вы получаете баллы. Баллы можно обменять в кабинете.',
  },
  { key: 'referral.hub.stat_invited', value: '👥 Приглашено: {{count}}' },
  { key: 'referral.hub.stat_qualified', value: '✅ Оформили подписку: {{count}}' },
  { key: 'referral.hub.stat_pending', value: '⏳ В ожидании: {{count}}' },
  { key: 'referral.hub.stat_points', value: '⭐ Баллов: {{count}}' },
  { key: 'referral.hub.link_label', value: '🔗 Ваша реферальная ссылка:' },
  { key: 'referral.hub.open_cabinet', value: '👤 Профиль в кабинете' },
  { key: 'referral.hub.open_exchange', value: '💱 Обменять баллы' },
  { key: 'partner.hub.title', value: '🤝 Партнёрская программа' },
  {
    key: 'partner.hub.description',
    value:
      'Вы участник партнёрской программы. Получайте вознаграждение за приглашённых пользователей. Вывод средств — в кабинете.',
  },
  { key: 'partner.hub.stat_balance', value: '💰 Баланс: {{amount}}' },
  { key: 'partner.hub.stat_earned', value: '📈 Всего заработано: {{amount}}' },
  { key: 'partner.hub.stat_referred', value: '👥 Рефералов: {{count}}' },
  { key: 'partner.hub.open_cabinet', value: '🤝 Партнёрский кабинет' },
];

type FlowWithScreens = BotFlow & {
  readonly screens: readonly (BotFlowScreen & {
    readonly buttons: readonly BotFlowButton[];
  })[];
};

/**
 * Project a `BotFlow` row tree into the flat shape reiwa consumes.
 * `null` flow → empty array (built-in fallback in effect on the bot
 * side). Buttons inside each screen are sorted by `(row, col)` so
 * the inline-keyboard layout is deterministic.
 */
function mapFlowScreens(
  flow: FlowWithScreens | null,
): readonly InternalBotConfigScreenInterface[] {
  if (flow === null || flow.screens.length === 0) return [];
  return flow.screens.map((screen) => ({
    id: screen.id,
    shortId: screen.shortId,
    name: screen.name,
    textRu: screen.textRu,
    textEn: screen.textEn,
    parseMode: mapParseMode(screen.parseMode),
    mediaType: mapMediaType(screen.mediaType),
    mediaFileId: screen.mediaFileId,
    mediaUrl: screen.mediaUrl,
    isRoot: screen.isRoot,
    buttons: [...screen.buttons]
      .sort((a, b) => a.row - b.row || a.col - b.col)
      .map(mapFlowButton),
  }));
}

function mapFlowButton(button: BotFlowButton): InternalBotConfigScreenButtonInterface {
  return {
    id: button.id,
    labelRu: button.labelRu,
    labelEn: button.labelEn,
    row: button.row,
    col: button.col,
    action: mapFlowButtonAction(button.actionType),
    targetShortId: button.targetScreenId,
    url: button.url,
    webAppUrl: button.webAppUrl,
    callbackAction: button.callbackAction,
    style: mapFlowButtonStyle(button.style),
    iconCustomEmojiId: button.iconCustomEmojiId,
  };
}

function mapFlowButtonAction(
  action: BotFlowButtonAction,
): InternalBotConfigScreenButtonInterface['action'] {
  switch (action) {
    case BotFlowButtonAction.NAVIGATE:
      return 'navigate';
    case BotFlowButtonAction.URL:
      return 'url';
    case BotFlowButtonAction.WEBAPP:
      return 'webapp';
    case BotFlowButtonAction.CALLBACK:
      return 'callback';
    case BotFlowButtonAction.BACK:
      return 'back';
    case BotFlowButtonAction.START_OVER:
      return 'start_over';
    default:
      return 'callback';
  }
}

function mapFlowButtonStyle(
  style: BotFlowButtonStyle,
): InternalBotConfigScreenButtonInterface['style'] {
  switch (style) {
    case BotFlowButtonStyle.PRIMARY:
      return 'primary';
    case BotFlowButtonStyle.SUCCESS:
      return 'success';
    case BotFlowButtonStyle.DANGER:
      return 'danger';
    case BotFlowButtonStyle.DEFAULT:
    default:
      return 'default';
  }
}

function mapParseMode(
  mode: BotFlowParseMode,
): InternalBotConfigScreenInterface['parseMode'] {
  switch (mode) {
    case BotFlowParseMode.HTML:
      return 'html';
    case BotFlowParseMode.MARKDOWN:
      return 'markdown';
    case BotFlowParseMode.PLAIN:
    default:
      return 'plain';
  }
}

function mapMediaType(
  type: BotFlowMediaType | null,
): InternalBotConfigScreenInterface['mediaType'] {
  if (type === null) return null;
  switch (type) {
    case BotFlowMediaType.PHOTO:
      return 'photo';
    case BotFlowMediaType.VIDEO:
      return 'video';
    case BotFlowMediaType.DOCUMENT:
      return 'document';
    case BotFlowMediaType.ANIMATION:
      return 'animation';
    default:
      return null;
  }
}
