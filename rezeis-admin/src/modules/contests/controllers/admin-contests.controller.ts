import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Request } from 'express';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildAdminAuditLogData } from '../../../common/utils/admin-audit-log.util';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { ContestDto, RefuseContestWinnerDto, SettleContestWinnerDto } from '../dto/contest.dto';
import { ContestService, type ContestInput, type ContestSummary, type DrawResult } from '../services/contest.service';
import { ContestWinnerService, type ContestWinnerRow } from '../services/contest-winner.service';

/**
 * Contests, for the operator.
 *
 * Gated on the wheel's permissions rather than a resource of their own: a
 * contest is the wheel's temporary sibling, run by the same people, and its
 * prizes are settled in the same queue. `wheel:edit` builds and publishes,
 * `wheel:resolve` hands prizes over — the same split, for the same reason.
 */
@ApiTags('admin/contests')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('wheel', 'view')
@Controller('admin/contests')
export class AdminContestsController {
  public constructor(
    private readonly contests: ContestService,
    private readonly winners: ContestWinnerService,
    private readonly prismaService: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Все конкурсы' })
  public list(): Promise<readonly ContestSummary[]> {
    return this.contests.list();
  }

  @Get('winners/pending')
  @ApiOperation({ summary: 'Призы конкурсов, которые ждут вручения человеком' })
  public pendingWinners(): Promise<readonly ContestWinnerRow[]> {
    return this.winners.listPending();
  }

  @Get(':contestId')
  @ApiOperation({ summary: 'Один конкурс' })
  public get(@Param('contestId') contestId: string): Promise<ContestSummary> {
    return this.contests.get(contestId);
  }

  @Get(':contestId/winners')
  @ApiOperation({ summary: 'Победители конкурса по местам' })
  public contestWinners(@Param('contestId') contestId: string): Promise<readonly ContestWinnerRow[]> {
    return this.winners.listForContest(contestId);
  }

  @Post()
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Создать черновик конкурса' })
  public async create(
    @Body() dto: ContestDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<ContestSummary> {
    const contest = await this.contests.create(toInput(dto), currentAdmin.id);
    await this.audit(req, currentAdmin, 'contests.created', { contestId: contest.id });
    return contest;
  }

  @Patch(':contestId')
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Изменить конкурс (условия — только у черновика)' })
  public async update(
    @Param('contestId') contestId: string,
    @Body() dto: ContestDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<ContestSummary> {
    const contest = await this.contests.update(contestId, toInput(dto));
    await this.audit(req, currentAdmin, 'contests.updated', { contestId });
    return contest;
  }

  @Delete(':contestId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Удалить черновик' })
  public async remove(
    @Param('contestId') contestId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<void> {
    await this.contests.remove(contestId);
    await this.audit(req, currentAdmin, 'contests.deleted', { contestId });
  }

  @Post(':contestId/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Опубликовать: открыть заявки' })
  public async publish(
    @Param('contestId') contestId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<ContestSummary> {
    const contest = await this.contests.publish(contestId);
    await this.audit(req, currentAdmin, 'contests.published', { contestId });
    return contest;
  }

  @Post(':contestId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Отменить идущий конкурс без розыгрыша' })
  public async cancel(
    @Param('contestId') contestId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<ContestSummary> {
    const contest = await this.contests.cancel(contestId);
    await this.audit(req, currentAdmin, 'contests.cancelled', { contestId });
    return contest;
  }

  @Post(':contestId/draw')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Провести розыгрыш сейчас (конкурс должен быть окончен)' })
  public async draw(
    @Param('contestId') contestId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<DrawResult> {
    const result = await this.contests.draw({ contestId });
    if (result.drawn) {
      await this.audit(req, currentAdmin, 'contests.drawn', { contestId, winners: result.winners });
      // The conversations for prizes a human hands over open here as well as
      // in the sweep, so the operator who pressed the button sees them at once.
      await this.winners.openMissingTickets().catch(() => undefined);
    }
    return result;
  }

  @Post('winners/:winnerId/issue')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('wheel', 'resolve')
  @ApiOperation({ summary: 'Отметить приз конкурса вручённым' })
  public async issue(
    @Param('winnerId') winnerId: string,
    @Body() dto: SettleContestWinnerDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<ContestWinnerRow> {
    const settled = await this.winners.issue({
      winnerId,
      adminId: currentAdmin.id,
      note: dto.note?.trim() ? dto.note.trim() : null,
    });
    if (!settled.settled) throw new ConflictException('Этот приз уже не ждёт выдачи');
    await this.audit(req, currentAdmin, 'contests.prize.issued', { winnerId });
    return this.winners.findOne(winnerId);
  }

  @Post('winners/:winnerId/refuse')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('wheel', 'resolve')
  @ApiOperation({ summary: 'Отказать в призе конкурса, указав причину' })
  public async refuse(
    @Param('winnerId') winnerId: string,
    @Body() dto: RefuseContestWinnerDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<ContestWinnerRow> {
    const settled = await this.winners.refuse({ winnerId, adminId: currentAdmin.id, reason: dto.reason.trim() });
    if (!settled.settled) throw new ConflictException('Этот приз уже не ждёт выдачи');
    await this.audit(req, currentAdmin, 'contests.prize.refused', { winnerId });
    return this.winners.findOne(winnerId);
  }

  private async audit(
    req: Request,
    admin: CurrentAdminInterface,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.prismaService.adminAuditLog
      .create({
        data: buildAdminAuditLogData({
          action,
          actorId: admin.id,
          requestMetadata: extractRequestMetadata(req),
          metadata,
        }),
      })
      .catch(() => undefined);
  }
}

function toInput(dto: ContestDto): ContestInput {
  return {
    title: dto.title as Prisma.InputJsonValue,
    description: (dto.description ?? {}) as Prisma.InputJsonValue,
    startAt: dto.startAt,
    endAt: dto.endAt,
    audienceFilter:
      dto.audienceFilter === undefined || dto.audienceFilter === null
        ? null
        : (dto.audienceFilter as unknown as Prisma.InputJsonValue),
    maxEntries: dto.maxEntries ?? null,
    prizes: dto.prizes.map((prize) => ({
      place: prize.place,
      kind: prize.kind,
      title: prize.title as Prisma.InputJsonValue,
      amount: prize.amount,
      promoRewardType: prize.promoRewardType ?? null,
      promoPlanId: prize.promoPlanId ?? null,
      promoPlanIds: prize.promoPlanIds ?? [],
      promoLifetime: prize.promoLifetime ?? null,
      keyPoolId: prize.keyPoolId ?? null,
      manualInstructions: prize.manualInstructions ?? null,
    })),
  };
}
