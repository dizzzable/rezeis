import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BotFlowButton, BotFlowButtonAction, BotFlowButtonStyle, BotFlowMediaType, BotFlowParseMode, BotFlowScreen, BotFlowStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

function generateShortId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export interface CreateScreenInput {
  readonly flowId: string;
  readonly name?: string;
  readonly textRu?: string;
  readonly textEn?: string;
  readonly parseMode?: BotFlowParseMode;
  readonly mediaType?: BotFlowMediaType | null;
  readonly mediaFileId?: string | null;
  readonly mediaUrl?: string | null;
  readonly positionX?: number;
  readonly positionY?: number;
  readonly isRoot?: boolean;
}

export interface UpdateScreenInput {
  readonly name?: string;
  readonly textRu?: string;
  readonly textEn?: string;
  readonly parseMode?: BotFlowParseMode;
  readonly mediaType?: BotFlowMediaType | null;
  readonly mediaFileId?: string | null;
  readonly mediaUrl?: string | null;
  readonly positionX?: number;
  readonly positionY?: number;
  readonly isRoot?: boolean;
}

export interface CreateButtonInput {
  readonly screenId: string;
  readonly labelRu: string;
  readonly labelEn: string;
  readonly row?: number;
  readonly col?: number;
  readonly actionType: BotFlowButtonAction;
  readonly targetScreenId?: string | null;
  readonly url?: string | null;
  readonly webAppUrl?: string | null;
  readonly callbackAction?: string | null;
  readonly style?: BotFlowButtonStyle;
  readonly iconCustomEmojiId?: string | null;
}

export interface UpdateButtonInput {
  readonly labelRu?: string;
  readonly labelEn?: string;
  readonly row?: number;
  readonly col?: number;
  readonly actionType?: BotFlowButtonAction;
  readonly targetScreenId?: string | null;
  readonly url?: string | null;
  readonly webAppUrl?: string | null;
  readonly callbackAction?: string | null;
  readonly style?: BotFlowButtonStyle;
  readonly iconCustomEmojiId?: string | null;
}

type ScreenWithButtons = BotFlowScreen & { buttons: BotFlowButton[] };

@Injectable()
export class BotFlowScreenService {
  public constructor(private readonly prisma: PrismaService) {}

  /** Create a new screen in a draft flow. */
  public async createScreen(input: CreateScreenInput): Promise<ScreenWithButtons> {
    await this.assertFlowIsDraft(input.flowId);

    const shortId = generateShortId();
    return this.prisma.botFlowScreen.create({
      data: {
        flowId: input.flowId,
        shortId,
        name: input.name ?? 'New Screen',
        textRu: input.textRu ?? '',
        textEn: input.textEn ?? '',
        parseMode: input.parseMode ?? BotFlowParseMode.HTML,
        mediaType: input.mediaType ?? null,
        mediaFileId: input.mediaFileId ?? null,
        mediaUrl: input.mediaUrl ?? null,
        positionX: input.positionX ?? 0,
        positionY: input.positionY ?? 0,
        isRoot: input.isRoot ?? false,
      },
      include: { buttons: true },
    });
  }

  /** Update a screen's content or position. */
  public async updateScreen(screenId: string, input: UpdateScreenInput): Promise<ScreenWithButtons> {
    const screen = await this.prisma.botFlowScreen.findUnique({
      where: { id: screenId },
      select: { flowId: true },
    });
    if (!screen) throw new NotFoundException('Screen not found');
    await this.assertFlowIsDraft(screen.flowId);

    const data: Prisma.BotFlowScreenUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.textRu !== undefined) data.textRu = input.textRu;
    if (input.textEn !== undefined) data.textEn = input.textEn;
    if (input.parseMode !== undefined) data.parseMode = input.parseMode;
    if (input.mediaType !== undefined) data.mediaType = input.mediaType;
    if (input.mediaFileId !== undefined) data.mediaFileId = input.mediaFileId;
    if (input.mediaUrl !== undefined) data.mediaUrl = input.mediaUrl;
    if (input.positionX !== undefined) data.positionX = input.positionX;
    if (input.positionY !== undefined) data.positionY = input.positionY;
    if (input.isRoot !== undefined) data.isRoot = input.isRoot;

    return this.prisma.botFlowScreen.update({
      where: { id: screenId },
      data,
      include: { buttons: true },
    });
  }

  /** Batch-update screen positions (for drag-and-drop on canvas). */
  public async updatePositions(positions: Array<{ id: string; x: number; y: number }>): Promise<void> {
    if (positions.length === 0) return;

    // Verify all screens belong to the same draft flow
    const first = await this.prisma.botFlowScreen.findUnique({
      where: { id: positions[0].id },
      select: { flowId: true },
    });
    if (!first) throw new NotFoundException('Screen not found');
    await this.assertFlowIsDraft(first.flowId);

    await this.prisma.$transaction(
      positions.map((pos) =>
        this.prisma.botFlowScreen.update({
          where: { id: pos.id },
          data: { positionX: pos.x, positionY: pos.y },
        }),
      ),
    );
  }

  /** Delete a screen and all its buttons. */
  public async deleteScreen(screenId: string): Promise<void> {
    const screen = await this.prisma.botFlowScreen.findUnique({
      where: { id: screenId },
      select: { flowId: true },
    });
    if (!screen) throw new NotFoundException('Screen not found');
    await this.assertFlowIsDraft(screen.flowId);
    await this.prisma.botFlowScreen.delete({ where: { id: screenId } });
  }

  // ── Buttons ─────────────────────────────────────────────────────────────────

  /** Add a button to a screen. */
  public async createButton(input: CreateButtonInput): Promise<BotFlowButton> {
    const screen = await this.prisma.botFlowScreen.findUnique({
      where: { id: input.screenId },
      select: { flowId: true },
    });
    if (!screen) throw new NotFoundException('Screen not found');
    await this.assertFlowIsDraft(screen.flowId);

    return this.prisma.botFlowButton.create({
      data: {
        screenId: input.screenId,
        labelRu: input.labelRu,
        labelEn: input.labelEn,
        row: input.row ?? 0,
        col: input.col ?? 0,
        actionType: input.actionType,
        targetScreenId: input.targetScreenId ?? null,
        url: input.url ?? null,
        webAppUrl: input.webAppUrl ?? null,
        callbackAction: input.callbackAction ?? null,
        style: input.style ?? BotFlowButtonStyle.DEFAULT,
        iconCustomEmojiId: input.iconCustomEmojiId ?? null,
      },
    });
  }

  /** Update a button. */
  public async updateButton(buttonId: string, input: UpdateButtonInput): Promise<BotFlowButton> {
    const button = await this.prisma.botFlowButton.findUnique({
      where: { id: buttonId },
      include: { screen: { select: { flowId: true } } },
    });
    if (!button) throw new NotFoundException('Button not found');
    await this.assertFlowIsDraft(button.screen.flowId);

    const data: Prisma.BotFlowButtonUpdateInput = {};
    if (input.labelRu !== undefined) data.labelRu = input.labelRu;
    if (input.labelEn !== undefined) data.labelEn = input.labelEn;
    if (input.row !== undefined) data.row = input.row;
    if (input.col !== undefined) data.col = input.col;
    if (input.actionType !== undefined) data.actionType = input.actionType;
    if (input.targetScreenId !== undefined) data.targetScreenId = input.targetScreenId;
    if (input.url !== undefined) data.url = input.url;
    if (input.webAppUrl !== undefined) data.webAppUrl = input.webAppUrl;
    if (input.callbackAction !== undefined) data.callbackAction = input.callbackAction;
    if (input.style !== undefined) data.style = input.style;
    if (input.iconCustomEmojiId !== undefined) data.iconCustomEmojiId = input.iconCustomEmojiId;

    return this.prisma.botFlowButton.update({ where: { id: buttonId }, data });
  }

  /** Delete a button. */
  public async deleteButton(buttonId: string): Promise<void> {
    const button = await this.prisma.botFlowButton.findUnique({
      where: { id: buttonId },
      include: { screen: { select: { flowId: true } } },
    });
    if (!button) throw new NotFoundException('Button not found');
    await this.assertFlowIsDraft(button.screen.flowId);
    await this.prisma.botFlowButton.delete({ where: { id: buttonId } });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async assertFlowIsDraft(flowId: string): Promise<void> {
    const flow = await this.prisma.botFlow.findUnique({
      where: { id: flowId },
      select: { status: true },
    });
    if (!flow) throw new NotFoundException('Flow not found');
    if (flow.status !== BotFlowStatus.DRAFT) {
      throw new BadRequestException('Can only edit draft flows');
    }
  }
}
