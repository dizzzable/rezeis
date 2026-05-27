import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { BotButton, BotButtonStyle, BotEmoji, BotText } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { getProcessRole } from '../../../common/runtime/process-role.util';
import {
  InternalBotConfigButtonInterface,
  InternalBotConfigFeaturesInterface,
  InternalBotConfigInterface,
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

    const [buttons, emojis, texts] = await Promise.all([
      this.botButtonsService.listAll(),
      this.botEmojisService.listAll(),
      this.botTextsService.listAll(),
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
          visible: true,
          onePerRow: seed.onePerRow,
          orderIndex: seed.orderIndex,
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

interface DefaultButtonSeed {
  readonly buttonId: string;
  readonly label: string;
  readonly style: BotButtonStyle;
  readonly onePerRow: boolean;
  readonly orderIndex: number;
}

/**
 * Default reiwa keyboard layout.
 *
 *   ┌──────────────────────────┐
 *   │       Мой кабинет        │  ← url, primary  (one row)
 *   ├──────────────────────────┤
 *   │        Пригласить        │  ← callback,     (one row)
 *   ├─────────────┬────────────┤
 *   │   Правила   │   Помощь   │  ← callback × 2  (shared row)
 *   └─────────────┴────────────┘
 *
 * `kind` (url / callback) is hardcoded in the reiwa bot side so the
 * admin panel only needs to manage visual properties. The button ids
 * line up with reiwa's `bot.callbackQuery(id, ...)` handlers and the
 * static URL-button table in `bot/main.ts`.
 */
const DEFAULT_BUTTONS: readonly DefaultButtonSeed[] = [
  {
    buttonId: 'cabinet',
    label: 'Мой кабинет',
    style: BotButtonStyle.PRIMARY,
    onePerRow: true,
    orderIndex: 0,
  },
  {
    buttonId: 'invite',
    label: 'Пригласить',
    style: BotButtonStyle.DEFAULT,
    onePerRow: true,
    orderIndex: 1,
  },
  {
    buttonId: 'rules',
    label: 'Правила',
    style: BotButtonStyle.DEFAULT,
    onePerRow: false,
    orderIndex: 2,
  },
  {
    buttonId: 'help',
    label: 'Помощь',
    style: BotButtonStyle.DEFAULT,
    onePerRow: false,
    orderIndex: 3,
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
  };
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
