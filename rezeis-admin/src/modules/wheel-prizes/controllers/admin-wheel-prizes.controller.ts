import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildAdminAuditLogData } from '../../../common/utils/admin-audit-log.util';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  IssueManualPrizeDto,
  ListManualPrizesDto,
  RefuseManualPrizeDto,
} from '../dto/settle-manual-prize.dto';
import {
  ManualPrizePage,
  ManualPrizeRow,
  WheelManualPrizeService,
} from '../services/wheel-manual-prize.service';

/**
 * The operator's queue of prizes a human has to hand over.
 *
 * Handing over and refusing are both `wheel:resolve` rather than `wheel:edit`:
 * editing the wheel changes what MIGHT be won, and settling a prize decides
 * whether a particular person gets a particular thing. The two deserve to be
 * grantable apart — a support operator who settles jackpots has no business
 * reweighting the sectors, and whoever tunes the odds need not be able to
 * refuse somebody their prize.
 */
@ApiTags('admin/wheel/prizes')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('wheel', 'view')
@Controller('admin/wheel/prizes')
export class AdminWheelPrizesController {
  public constructor(
    private readonly manualPrizes: WheelManualPrizeService,
    private readonly prismaService: PrismaService,
  ) {}

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

  @Get()
  @ApiOperation({ summary: 'Призы с колеса, которые вручает человек' })
  public list(@Query() query: ListManualPrizesDto): Promise<ManualPrizePage> {
    return this.manualPrizes.list({
      status: query.status ?? null,
      cursor: query.cursor ?? null,
      limit: query.limit ?? null,
    });
  }

  @Get(':spinId')
  @ApiOperation({ summary: 'Карточка одного приза' })
  public findOne(@Param('spinId') spinId: string): Promise<ManualPrizeRow> {
    return this.manualPrizes.findOne(spinId);
  }

  @Post(':spinId/issue')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('wheel', 'resolve')
  @ApiOperation({ summary: 'Отметить приз вручённым' })
  public async issue(
    @Param('spinId') spinId: string,
    @Body() dto: IssueManualPrizeDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<ManualPrizeRow> {
    const settled = await this.manualPrizes.issue({
      spinId,
      adminId: currentAdmin.id,
      note: dto.note?.trim() ? dto.note.trim() : null,
    });
    // 409 and not 200: the operator is looking at a screen that says this
    // prize is still owed, and it is not. Telling them so is the difference
    // between "already handled by a colleague" and "your click did nothing".
    if (!settled.settled) {
      throw new ConflictException('Этот приз уже не ждёт выдачи');
    }
    await this.audit(req, currentAdmin, 'wheel.prize.issued', { spinId });
    return this.manualPrizes.findOne(spinId);
  }

  @Post(':spinId/refuse')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('wheel', 'resolve')
  @ApiOperation({ summary: 'Отказать в призе, указав причину' })
  public async refuse(
    @Param('spinId') spinId: string,
    @Body() dto: RefuseManualPrizeDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<ManualPrizeRow> {
    const settled = await this.manualPrizes.refuse({
      spinId,
      adminId: currentAdmin.id,
      reason: dto.reason.trim(),
    });
    if (!settled.settled) {
      throw new ConflictException('Этот приз уже не ждёт выдачи');
    }
    await this.audit(req, currentAdmin, 'wheel.prize.refused', { spinId });
    return this.manualPrizes.findOne(spinId);
  }
}
