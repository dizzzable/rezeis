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
import {
  InternalBotConfigButtonInterface,
  InternalBotConfigFeaturesInterface,
  InternalBotConfigInterface,
  InternalBotConfigScreenButtonInterface,
  InternalBotConfigScreenInterface,
  InternalBotConfigVisualInterface,
  InternalBotEmojiMap,
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

    const emojiMap = mapEmojiCustomIds(emojis);
    const textMap = mapTexts(texts);

    return {
      buttons: buttons.map(mapButton),
      visual: { ...DEFAULT_VISUAL, bannerUrl: readBannerUrl(textMap) },
      features: DEFAULT_FEATURES,
      botEmojis: emojiMap,
      menuTextCustomEmojiIds: emojiMap,
      translations: textMap,
      screens: mapFlowScreens(activeFlow),
      screensVersion: activeFlow
        ? `${activeFlow.id}:${activeFlow.version}:${activeFlow.status}`
        : '',
    };
  }

  private async ensureDefaultsSeeded(): Promise<void> {
    if (this.seedAttempted) return;
    this.seedAttempted = true;
    try {
      const existingCount = await this.prismaService.botButton.count();
      if (existingCount > 0) return;
      await this.seedDefaultButtons();
      await this.seedDefaultBannerText();
      this.logger.log('Seeded default reiwa bot keyboard (4 buttons + banner).');
    } catch (err: unknown) {
      // Don't poison the cached `seedAttempted` flag on error — let the
      // next request retry rather than ship a degraded payload forever.
      this.seedAttempted = false;
      this.logger.warn(
        `Bot keyboard seed failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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

function mapEmojiCustomIds(emojis: readonly BotEmoji[]): InternalBotEmojiMap {
  const map: Record<string, string> = {};
  for (const emoji of emojis) {
    if (emoji.tgEmojiId !== null && emoji.tgEmojiId.length > 0) {
      map[emoji.key] = emoji.tgEmojiId;
    }
  }
  return map;
}

function mapTexts(texts: readonly BotText[]): InternalBotTextMap {
  const map: Record<string, string> = {};
  for (const text of texts) {
    map[text.key] = text.value;
  }
  return map;
}

function readBannerUrl(textMap: InternalBotTextMap): string | null {
  const raw = textMap[BANNER_URL_KEY];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const DEFAULT_VISUAL: Omit<InternalBotConfigVisualInterface, 'bannerUrl'> = {
  welcomeMessage: 'Привет, {{firstName}}! 👋\n\nДобро пожаловать в Rezeis VPN.',
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
