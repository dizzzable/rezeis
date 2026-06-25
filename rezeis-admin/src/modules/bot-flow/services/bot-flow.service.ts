import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BotFlow, BotFlowStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

type FlowWithScreens = Prisma.BotFlowGetPayload<{
  include: { screens: { include: { buttons: true } } };
}>;

/**
 * The bot's standard built-in screens. Single source of truth shared by the
 * first-open seed and the "Fetch all blocks" restore action. `shortId`s are
 * the stable keys the bot's callback handlers (help / rules / invite) resolve.
 */
const STANDARD_SCREEN_SEEDS: ReadonlyArray<{
  readonly shortId: string;
  readonly name: string;
  readonly textRu: string;
  readonly textEn: string;
  readonly positionX: number;
  readonly positionY: number;
}> = [
  {
    shortId: 'sc_help',
    name: 'help',
    textRu: '🆘 Поддержка\n\nНажмите кнопку ниже — мы ответим в личных сообщениях.',
    textEn: '🆘 Support\n\nTap the button below — we reply in DMs.',
    positionX: 480,
    positionY: 60,
  },
  {
    shortId: 'sc_rules',
    name: 'rules',
    textRu: '📜 Правила сервиса\n\nНажмите кнопку ниже чтобы открыть полный текст. Если что-то не понятно — напишите в поддержку.',
    textEn: '📜 Service rules\n\nTap the button below to open the full text. If anything is unclear, message support.',
    positionX: 480,
    positionY: 280,
  },
  {
    shortId: 'sc_invite',
    name: 'invite',
    textRu:
      '🔗 Реферальная программа\n\nПоделитесь ссылкой с друзьями — за каждого, кто оформит подписку, вы получите бонус.\n\nВаша ссылка:\n{{link}}',
    textEn:
      '🔗 Referral program\n\nShare this link with your friends — for every one who subscribes, you earn a bonus.\n\nYour link:\n{{link}}',
    positionX: 480,
    positionY: 500,
  },
];

@Injectable()
export class BotFlowService {
  public constructor(private readonly prisma: PrismaService) {}

  /** List all flows (latest version per name). */
  public async listFlows(): Promise<BotFlow[]> {
    return this.prisma.botFlow.findMany({
      orderBy: [{ name: 'asc' }, { version: 'desc' }],
    });
  }

  /**
   * Get the current draft for a flow name. Creates one if none exists.
   *
   * On fresh creation the policy is:
   *   1. If a PUBLISHED version exists → clone its screens + buttons
   *      into the new DRAFT so the operator sees what's currently
   *      live and can iterate from there. The original PUBLISHED
   *      flow stays untouched until the next Publish action.
   *   2. Otherwise → seed three placeholder screens (`help`, `rules`,
   *      `invite`) so the canvas is populated with the bot's
   *      built-in sub-menus from the start.
   *
   * Either way the result is non-empty, which means the bot-flow
   * page never has to render a confusing empty canvas with the
   * abstract instruction "drag a node from the palette".
   *
   * The seed only fires on flow creation — never resurrects deleted
   * screens, never overwrites operator edits.
   */
  public async getDraft(name: string): Promise<FlowWithScreens> {
    let draft = await this.prisma.botFlow.findFirst({
      where: { name, status: BotFlowStatus.DRAFT },
      include: { screens: { include: { buttons: true } } },
      orderBy: { version: 'desc' },
    });

    if (!draft) {
      const previousPublished = await this.prisma.botFlow.findFirst({
        where: { name, status: BotFlowStatus.PUBLISHED },
        include: { screens: { include: { buttons: true } } },
        orderBy: { version: 'desc' },
      });
      const nextVersion = previousPublished
        ? previousPublished.version + 1
        : 1;
      draft = await this.prisma.botFlow.create({
        data: {
          name,
          status: BotFlowStatus.DRAFT,
          version: nextVersion,
          // Carry the canvas layout (incl. the read-only map-node positions
          // stored under `layoutData.mapNodePositions`) from the published
          // flow so publishing and then re-opening doesn't reset the
          // operator's manual arrangement. Screen positionX/Y are cloned
          // per-row by cloneScreensInto; this preserves the rest.
          ...(previousPublished?.layoutData != null
            ? { layoutData: previousPublished.layoutData as Prisma.InputJsonValue }
            : {}),
        },
        include: { screens: { include: { buttons: true } } },
      });
      if (previousPublished !== null) {
        await this.cloneScreensInto(draft.id, previousPublished.screens);
      } else {
        await this.seedDefaultScreens(draft.id);
      }
      // Re-read so the returned payload includes the seeded /
      // cloned screens.
      const reloaded = await this.prisma.botFlow.findUnique({
        where: { id: draft.id },
        include: { screens: { include: { buttons: true } } },
      });
      if (reloaded === null) throw new NotFoundException('Flow vanished mid-seed');
      draft = reloaded;
    } else if (draft.screens.length === 0) {
      await this.seedDefaultScreens(draft.id);
      const reloaded = await this.prisma.botFlow.findUnique({
        where: { id: draft.id },
        include: { screens: { include: { buttons: true } } },
      });
      if (reloaded === null) throw new NotFoundException('Flow vanished mid-seed');
      draft = reloaded;
    }

    return draft;
  }

  /**
   * Deep-clone every screen + button from a published flow into a new
   * draft. Buttons that NAVIGATE to other screens by `targetScreenId`
   * (which holds the source flow's `shortId`) work without
   * remapping — `shortId` is unique per `(flowId, shortId)` and we
   * preserve those, so the navigate target lands inside the new draft
   * automatically.
   */
  private async cloneScreensInto(
    targetFlowId: string,
    sourceScreens: ReadonlyArray<
      Prisma.BotFlowScreenGetPayload<{ include: { buttons: true } }>
    >,
  ): Promise<void> {
    for (const source of sourceScreens) {
      try {
        await this.prisma.botFlowScreen.create({
          data: {
            flowId: targetFlowId,
            shortId: source.shortId,
            name: source.name,
            textRu: source.textRu,
            textEn: source.textEn,
            parseMode: source.parseMode,
            mediaType: source.mediaType,
            mediaFileId: source.mediaFileId,
            mediaUrl: source.mediaUrl,
            positionX: source.positionX,
            positionY: source.positionY,
            isRoot: source.isRoot,
            buttons: {
              create: source.buttons.map((btn) => ({
                labelRu: btn.labelRu,
                labelEn: btn.labelEn,
                row: btn.row,
                col: btn.col,
                actionType: btn.actionType,
                targetScreenId: btn.targetScreenId,
                url: btn.url,
                webAppUrl: btn.webAppUrl,
                callbackAction: btn.callbackAction,
                style: btn.style,
                iconCustomEmojiId: btn.iconCustomEmojiId,
              })),
            },
          },
        });
      } catch {
        // Race on (flowId, shortId) unique constraint → skip.
      }
    }
  }

  /**
   * Pre-seed `help` / `rules` / `invite` placeholder screens. Idempotent:
   * caller guards with `screens.length === 0`, but we also rely on the
   * unique `(flowId, shortId)` constraint so concurrent first opens
   * don't double-insert.
   *
   * Built-in callback handlers (help-callback / rules / invite) read
   * `findScreenByName` and substitute runtime placeholders into the
   * text before rendering. The seeded copy below uses the *exact*
   * placeholder names those handlers support so operators see live
   * variables rendered when they don't customise.
   */
  private async seedDefaultScreens(flowId: string): Promise<void> {
    for (const seed of STANDARD_SCREEN_SEEDS) {
      try {
        await this.prisma.botFlowScreen.create({
          data: {
            flowId,
            shortId: seed.shortId,
            name: seed.name,
            textRu: seed.textRu,
            textEn: seed.textEn,
            positionX: seed.positionX,
            positionY: seed.positionY,
          },
        });
      } catch {
        // Race / unique-constraint → skip silently. Other operators
        // already created the screen; the next read will pick it up.
      }
    }
  }

  /** Get the published version of a flow by name. */
  public async getPublished(name: string): Promise<FlowWithScreens | null> {
    return this.prisma.botFlow.findFirst({
      where: { name, status: BotFlowStatus.PUBLISHED },
      include: { screens: { include: { buttons: true } } },
      orderBy: { version: 'desc' },
    });
  }

  /**
   * Get the *active* flow that the bot runtime should render. Resolution
   * order:
   *   1. Latest PUBLISHED version (the explicit "freeze for production"
   *      target).
   *   2. Latest DRAFT version (operator hasn't published yet — show
   *      live edits anyway so they don't have to click Publish for
   *      every iteration).
   *
   * Returns `null` only when neither status exists for the named flow,
   * which means the operator has never created a flow at all. Reiwa
   * then falls back to its built-in sub-menus.
   */
  public async getActive(name: string): Promise<FlowWithScreens | null> {
    const published = await this.prisma.botFlow.findFirst({
      where: { name, status: BotFlowStatus.PUBLISHED },
      include: { screens: { include: { buttons: true } } },
      orderBy: { version: 'desc' },
    });
    if (published !== null) return published;
    const draft = await this.prisma.botFlow.findFirst({
      where: { name, status: BotFlowStatus.DRAFT },
      include: { screens: { include: { buttons: true } } },
      orderBy: { version: 'desc' },
    });
    return draft;
  }

  /** Get a flow by ID with all screens and buttons. */
  public async getById(id: string): Promise<FlowWithScreens> {
    const flow = await this.prisma.botFlow.findUnique({
      where: { id },
      include: { screens: { include: { buttons: true } } },
    });
    if (!flow) throw new NotFoundException('Flow not found');
    return flow;
  }

  /**
   * The bot's standard built-in blocks (help / rules / invite) annotated with
   * whether each already exists as a screen in the given flow. Powers the
   * "Fetch all blocks" dialog so the operator can see and restore any standard
   * screen they removed. These blocks are defined here (rezeis owns the bot's
   * built-in screen contract); the Telegram bot token cannot enumerate them.
   */
  public async getStandardBlocks(
    flowId: string,
  ): Promise<ReadonlyArray<{ key: string; name: string; present: boolean }>> {
    const flow = await this.getById(flowId);
    const present = new Set(flow.screens.map((s) => s.shortId));
    return STANDARD_SCREEN_SEEDS.map((seed) => ({
      key: seed.shortId,
      name: seed.name,
      present: present.has(seed.shortId),
    }));
  }

  /**
   * Ensure all standard built-in screens exist in the draft flow. Creates only
   * the missing ones (matched by `shortId`); never overwrites an operator-edited
   * screen. Returns the number of screens newly created.
   */
  public async ensureStandardBlocks(flowId: string): Promise<{ added: number }> {
    const flow = await this.prisma.botFlow.findUnique({
      where: { id: flowId },
      include: { screens: { select: { shortId: true } } },
    });
    if (!flow) throw new NotFoundException('Flow not found');
    if (flow.status !== BotFlowStatus.DRAFT) {
      throw new BadRequestException('Can only edit draft flows');
    }
    const present = new Set(flow.screens.map((s) => s.shortId));
    let added = 0;
    for (const seed of STANDARD_SCREEN_SEEDS) {
      if (present.has(seed.shortId)) continue;
      try {
        await this.prisma.botFlowScreen.create({
          data: {
            flowId,
            shortId: seed.shortId,
            name: seed.name,
            textRu: seed.textRu,
            textEn: seed.textEn,
            positionX: seed.positionX,
            positionY: seed.positionY,
          },
        });
        added += 1;
      } catch {
        // Race on (flowId, shortId) unique constraint → another writer added it.
      }
    }
    return { added };
  }

  /** Save layout data (viewport, positions are on screens). */
  public async saveLayout(id: string, layoutData: unknown): Promise<BotFlow> {
    const flow = await this.prisma.botFlow.findUnique({ where: { id } });
    if (!flow) throw new NotFoundException('Flow not found');
    if (flow.status !== BotFlowStatus.DRAFT) {
      throw new BadRequestException('Can only edit draft flows');
    }
    return this.prisma.botFlow.update({
      where: { id },
      data: { layoutData: layoutData as Prisma.InputJsonValue },
    });
  }

  /** Publish a draft: set status=PUBLISHED, archive previous published version. */
  public async publish(id: string): Promise<BotFlow> {
    const flow = await this.prisma.botFlow.findUnique({ where: { id } });
    if (!flow) throw new NotFoundException('Flow not found');
    if (flow.status !== BotFlowStatus.DRAFT) {
      throw new BadRequestException('Only draft flows can be published');
    }

    // Validate: must have at least one screen. (We intentionally do NOT
    // require an `isRoot` screen — the bot resolves screens by shortId via
    // callbacks / by name for built-in overrides, so `isRoot` is advisory
    // only and must not block publishing a flow of sub-screens.)
    const screenCount = await this.prisma.botFlowScreen.count({
      where: { flowId: id },
    });
    if (screenCount === 0) {
      throw new BadRequestException('Flow must have at least one screen');
    }

    // Archive previous published version of the same flow name
    await this.prisma.botFlow.updateMany({
      where: { name: flow.name, status: BotFlowStatus.PUBLISHED },
      data: { status: BotFlowStatus.ARCHIVED },
    });

    return this.prisma.botFlow.update({
      where: { id },
      data: { status: BotFlowStatus.PUBLISHED, publishedAt: new Date() },
    });
  }

  /** Delete a draft flow. Published/archived flows cannot be deleted. */
  public async deleteDraft(id: string): Promise<void> {
    const flow = await this.prisma.botFlow.findUnique({ where: { id } });
    if (!flow) throw new NotFoundException('Flow not found');
    if (flow.status !== BotFlowStatus.DRAFT) {
      throw new BadRequestException('Only draft flows can be deleted');
    }
    await this.prisma.botFlow.delete({ where: { id } });
  }
}
