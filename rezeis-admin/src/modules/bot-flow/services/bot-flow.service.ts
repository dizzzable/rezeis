import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BotFlow, BotFlowStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

type FlowWithScreens = Prisma.BotFlowGetPayload<{
  include: { screens: { include: { buttons: true } } };
}>;

@Injectable()
export class BotFlowService {
  public constructor(private readonly prisma: PrismaService) {}

  /** List all flows (latest version per name). */
  public async listFlows(): Promise<BotFlow[]> {
    return this.prisma.botFlow.findMany({
      orderBy: [{ name: 'asc' }, { version: 'desc' }],
    });
  }

  /** Get the current draft for a flow name. Creates one if none exists. */
  public async getDraft(name: string): Promise<FlowWithScreens> {
    let draft = await this.prisma.botFlow.findFirst({
      where: { name, status: BotFlowStatus.DRAFT },
      include: { screens: { include: { buttons: true } } },
      orderBy: { version: 'desc' },
    });

    if (!draft) {
      draft = await this.prisma.botFlow.create({
        data: { name, status: BotFlowStatus.DRAFT },
        include: { screens: { include: { buttons: true } } },
      });
    }

    return draft;
  }

  /** Get the published version of a flow by name. */
  public async getPublished(name: string): Promise<FlowWithScreens | null> {
    return this.prisma.botFlow.findFirst({
      where: { name, status: BotFlowStatus.PUBLISHED },
      include: { screens: { include: { buttons: true } } },
      orderBy: { version: 'desc' },
    });
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

    // Validate: must have at least one root screen
    const rootCount = await this.prisma.botFlowScreen.count({
      where: { flowId: id, isRoot: true },
    });
    if (rootCount === 0) {
      throw new BadRequestException('Flow must have at least one root (start) screen');
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
