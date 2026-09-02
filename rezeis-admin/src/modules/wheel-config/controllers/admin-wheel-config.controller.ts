import {
  Body,
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
import {
  ReorderSectorsDto,
  UpdateWheelSettingsDto,
  WheelSectorDto,
} from '../dto/wheel-sector.dto';
import { WheelOverview, WheelSectorService } from '../services/wheel-sector.service';

/**
 * The wheel as the operator builds it: sectors, odds, and the two switches.
 *
 * Every write answers with the whole overview rather than with the row it
 * touched. The numbers that matter here are all derived from the SET —
 * every percentage moves when one weight changes, and so does the guard on
 * whether the spins can ever run out — so answering with one row would leave
 * the page showing figures that are no longer true.
 */
@ApiTags('admin/wheel')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('wheel', 'view')
@Controller('admin/wheel')
export class AdminWheelConfigController {
  public constructor(
    private readonly sectors: WheelSectorService,
    private readonly prismaService: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Колесо целиком: секторы, живые проценты, экономика' })
  public overview(): Promise<WheelOverview> {
    return this.sectors.overview();
  }

  @Post('sectors')
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Добавить сектор' })
  public async create(
    @Body() dto: WheelSectorDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<WheelOverview> {
    const overview = await this.sectors.create(toPayload(dto), currentAdmin.id);
    await this.audit(req, currentAdmin, 'wheel.sector.created', { kind: dto.kind });
    return overview;
  }

  @Patch('sectors/:sectorId')
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Изменить сектор' })
  public async update(
    @Param('sectorId') sectorId: string,
    @Body() dto: WheelSectorDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<WheelOverview> {
    const overview = await this.sectors.update(sectorId, toPayload(dto));
    await this.audit(req, currentAdmin, 'wheel.sector.updated', { sectorId, kind: dto.kind });
    return overview;
  }

  @Delete('sectors/:sectorId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Удалить сектор (история прокрутов остаётся)' })
  public async remove(
    @Param('sectorId') sectorId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<WheelOverview> {
    const overview = await this.sectors.remove(sectorId);
    await this.audit(req, currentAdmin, 'wheel.sector.deleted', { sectorId });
    return overview;
  }

  @Post('sectors/reorder')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Переставить секторы' })
  public async reorder(
    @Body() dto: ReorderSectorsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<WheelOverview> {
    const overview = await this.sectors.reorder(dto.orderedIds);
    await this.audit(req, currentAdmin, 'wheel.sectors.reordered', { count: dto.orderedIds.length });
    return overview;
  }

  @Patch('settings')
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Выключатель колеса, бесплатный прокрут и цена в баллах' })
  public async updateSettings(
    @Body() dto: UpdateWheelSettingsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<WheelOverview> {
    const overview = await this.sectors.updateSettings({
      ...(dto.enabled === undefined ? {} : { enabled: dto.enabled }),
      ...(dto.freeSpinCooldownHours === undefined
        ? {}
        : { freeSpinCooldownHours: dto.freeSpinCooldownHours }),
      ...(dto.spinPricePoints === undefined ? {} : { spinPricePoints: dto.spinPricePoints }),
    });
    await this.audit(req, currentAdmin, 'wheel.settings.updated', {
      enabled: overview.settings.enabled,
    });
    return overview;
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

/**
 * An omitted optional field means "not set", not "leave alone".
 *
 * The sector form always submits every field it owns, so a `PATCH` that
 * carried the old value forward for anything absent would make clearing a
 * ceiling impossible: the operator empties the box, the field is omitted, and
 * the old number survives. Absent is null here, deliberately.
 */
function toPayload(dto: WheelSectorDto) {
  return {
    kind: dto.kind,
    title: dto.title as Prisma.InputJsonValue,
    ...(dto.iconKind === undefined ? {} : { iconKind: dto.iconKind }),
    ...(dto.iconRef === undefined ? {} : { iconRef: dto.iconRef }),
    ...(dto.rarity === undefined ? {} : { rarity: dto.rarity }),
    weight: dto.weight,
    amount: dto.amount,
    promoRewardType: dto.promoRewardType ?? null,
    promoPlanId: dto.promoPlanId ?? null,
    promoPlanIds: dto.promoPlanIds ?? [],
    promoLifetime: dto.promoLifetime ?? null,
    keyPoolId: dto.keyPoolId ?? null,
    manualInstructions: dto.manualInstructions ?? null,
    maxWinsPerUser: dto.maxWinsPerUser ?? null,
    maxWinsTotal: dto.maxWinsTotal ?? null,
    ...(dto.enabled === undefined ? {} : { enabled: dto.enabled }),
  };
}
