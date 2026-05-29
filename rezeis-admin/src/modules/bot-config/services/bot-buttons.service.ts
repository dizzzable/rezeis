import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BotButton, BotButtonAction, BotButtonStyle, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

interface CreateButtonInput {
  readonly buttonId: string;
  readonly label: string;
  readonly style?: BotButtonStyle;
  readonly iconCustomEmojiId?: string | null;
  readonly visible?: boolean;
  readonly onePerRow?: boolean;
  readonly orderIndex?: number;
  readonly actionType?: BotButtonAction;
  readonly actionTarget?: string | null;
}

interface UpdateButtonInput {
  readonly id: string;
  readonly label?: string;
  readonly style?: BotButtonStyle;
  readonly iconCustomEmojiId?: string | null;
  readonly visible?: boolean;
  readonly onePerRow?: boolean;
  readonly orderIndex?: number;
  readonly actionType?: BotButtonAction;
  readonly actionTarget?: string | null;
}

const BUTTON_ID_REGEX = /^[a-z0-9._-]+$/i;

/**
 * Validate an `actionTarget` against its `actionType`. Returns the
 * sanitised value to persist (empty → null) or throws BadRequest with
 * a clear message so the SPA can surface it inline. Centralised here
 * so the create / update paths share the contract.
 */
function validateAction(
  actionType: BotButtonAction | undefined,
  actionTarget: string | null | undefined,
): string | null | undefined {
  if (actionType === undefined) return undefined;
  const trimmed = (actionTarget ?? '').trim();
  switch (actionType) {
    case BotButtonAction.URL:
    case BotButtonAction.WEBAPP: {
      if (trimmed.length === 0) {
        // Empty target is allowed at the model level — reiwa falls
        // back to its env-driven `publicWebUrl` / `miniAppUrl` default
        // when actionTarget is null. Operators creating buttons in
        // the SPA still see client-side validation that nudges them
        // to type a URL; this branch covers programmatic seeds and
        // the "cabinet defaults" case where the URL is admin-managed
        // via REIWA_DOMAIN rather than per-button.
        return null;
      }
      if (!/^https?:\/\//i.test(trimmed)) {
        throw new BadRequestException(
          `actionTarget must start with http:// or https:// (got "${trimmed}")`,
        );
      }
      if (actionType === BotButtonAction.WEBAPP && !/^https:\/\//i.test(trimmed)) {
        throw new BadRequestException(
          'actionTarget for WEBAPP buttons must use https:// (Telegram refuses non-HTTPS web_app)',
        );
      }
      return trimmed;
    }
    case BotButtonAction.SCREEN: {
      if (trimmed.length === 0) {
        throw new BadRequestException(
          'actionTarget is required when actionType=SCREEN (must be a BotFlowScreen shortId)',
        );
      }
      if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
        throw new BadRequestException(
          `actionTarget for SCREEN must be an alphanumeric shortId (got "${trimmed}")`,
        );
      }
      return trimmed;
    }
    case BotButtonAction.CALLBACK:
    case BotButtonAction.SUPPORT_URL:
    default:
      // No payload — the bot resolves these at runtime.
      return null;
  }
}

@Injectable()
export class BotButtonsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public listAll(): Promise<BotButton[]> {
    return this.prismaService.botButton.findMany({
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    });
  }

  public async create(input: CreateButtonInput): Promise<BotButton> {
    if (!BUTTON_ID_REGEX.test(input.buttonId)) {
      throw new BadRequestException('buttonId must be alphanumeric (._- allowed)');
    }
    const existing = await this.prismaService.botButton.findUnique({
      where: { buttonId: input.buttonId },
    });
    if (existing !== null) {
      throw new BadRequestException(`Button with id "${input.buttonId}" already exists`);
    }
    const tail = await this.prismaService.botButton.findFirst({
      orderBy: { orderIndex: 'desc' },
      select: { orderIndex: true },
    });
    const actionType = input.actionType ?? BotButtonAction.CALLBACK;
    const actionTarget = validateAction(actionType, input.actionTarget) ?? null;
    return this.prismaService.botButton.create({
      data: {
        buttonId: input.buttonId,
        label: input.label,
        style: input.style ?? BotButtonStyle.PRIMARY,
        iconCustomEmojiId: input.iconCustomEmojiId ?? null,
        visible: input.visible ?? true,
        onePerRow: input.onePerRow ?? false,
        orderIndex: input.orderIndex ?? (tail?.orderIndex ?? -1) + 1,
        actionType,
        actionTarget,
      },
    });
  }

  public async update(input: UpdateButtonInput): Promise<BotButton> {
    const existing = await this.prismaService.botButton.findUnique({ where: { id: input.id } });
    if (existing === null) {
      throw new NotFoundException('Bot button not found');
    }
    const data: Prisma.BotButtonUpdateInput = {};
    if (input.label !== undefined) data.label = input.label;
    if (input.style !== undefined) data.style = input.style;
    if (input.iconCustomEmojiId !== undefined) {
      data.iconCustomEmojiId = input.iconCustomEmojiId === '' ? null : input.iconCustomEmojiId;
    }
    if (input.visible !== undefined) data.visible = input.visible;
    if (input.onePerRow !== undefined) data.onePerRow = input.onePerRow;
    if (input.orderIndex !== undefined) data.orderIndex = input.orderIndex;
    if (input.actionType !== undefined) {
      data.actionType = input.actionType;
      // When the operator switches actionType but doesn't supply a
      // matching target, validate against the new type with whatever
      // existing target is on file (so toggling URL→CALLBACK clears
      // the now-irrelevant target, but URL→URL with a fresh string
      // round-trips through validation).
      const target = input.actionTarget !== undefined ? input.actionTarget : existing.actionTarget;
      const sanitised = validateAction(input.actionType, target);
      if (sanitised !== undefined) data.actionTarget = sanitised;
    } else if (input.actionTarget !== undefined) {
      // Target changed but type didn't — re-validate with existing type.
      const sanitised = validateAction(existing.actionType, input.actionTarget);
      if (sanitised !== undefined) data.actionTarget = sanitised;
    }
    return this.prismaService.botButton.update({ where: { id: input.id }, data });
  }

  public async delete(id: string): Promise<void> {
    const existing = await this.prismaService.botButton.findUnique({ where: { id } });
    if (existing === null) {
      throw new NotFoundException('Bot button not found');
    }
    await this.prismaService.botButton.delete({ where: { id } });
  }

  /**
   * Atomically rewrite `orderIndex` for the supplied button ids in the
   * order they appear. Used by the admin SPA's drag-and-drop list so the
   * 4-button keyboard reorders in a single transactional write rather
   * than four sequential PATCH calls (which would interleave with
   * concurrent reads from reiwa's 5-minute refresh loop).
   *
   * Validates that the input set matches the current row set — passing a
   * partial list, an unknown id, or a duplicate id is rejected before
   * any write happens. The transaction commits with stable indices
   * 0..N-1; gaps in `orderIndex` (e.g. from manual UI drags long ago)
   * are normalised here.
   */
  public async reorder(ids: readonly string[]): Promise<BotButton[]> {
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('reorder ids must be unique');
    }
    const existing = await this.prismaService.botButton.findMany({ select: { id: true } });
    const existingIds = new Set(existing.map((row) => row.id));
    if (ids.length !== existingIds.size) {
      throw new BadRequestException('reorder ids must cover every bot button');
    }
    for (const id of ids) {
      if (!existingIds.has(id)) {
        throw new BadRequestException(`reorder ids contain unknown button id "${id}"`);
      }
    }
    await this.prismaService.$transaction(
      ids.map((id, index) =>
        this.prismaService.botButton.update({
          where: { id },
          data: { orderIndex: index },
        }),
      ),
    );
    return this.listAll();
  }
}
