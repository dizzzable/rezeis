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
import { RbacService } from '../../rbac/services/rbac.service';
import { CreateKeyPoolDto, ListKeysDto, LoadKeysDto, UpdateKeyPoolDto } from '../dto/key-pool.dto';
import {
  KeyPage,
  KeyPoolSummary,
  LoadKeysResult,
  WheelKeyPoolService,
} from '../services/wheel-key-pool.service';

/**
 * The batches of one-use secrets a KEY sector hands out.
 *
 * Reading a key back is `wheel:view_secrets` and not `wheel:view`, because an
 * unclaimed key is a bearer secret: whoever reads it can redeem it before its
 * winner. Unlike a payment gateway's stored credential, though, this is a
 * permission a real operator needs — a winner writes in to say the key does
 * not work and somebody has to look — so it is granted to the admin preset
 * rather than to nobody.
 */
@ApiTags('admin/wheel/key-pools')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('wheel', 'view')
@Controller('admin/wheel/key-pools')
export class AdminWheelKeyPoolsController {
  public constructor(
    private readonly keyPools: WheelKeyPoolService,
    private readonly rbacService: RbacService,
    private readonly prismaService: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Пулы ключей: сколько загружено, выдано и осталось' })
  public listPools(): Promise<readonly KeyPoolSummary[]> {
    return this.keyPools.listPools();
  }

  @Post()
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Завести пул' })
  public async createPool(
    @Body() dto: CreateKeyPoolDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<KeyPoolSummary> {
    const pool = await this.keyPools.createPool({
      name: dto.name.trim(),
      note: dto.note?.trim() ? dto.note.trim() : null,
      createdBy: currentAdmin.id,
    });
    await this.audit(req, currentAdmin, 'wheel.keyPool.created', { poolId: pool.id });
    return pool;
  }

  @Patch(':poolId')
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Переименовать пул или поправить заметку' })
  public async updatePool(
    @Param('poolId') poolId: string,
    @Body() dto: UpdateKeyPoolDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<KeyPoolSummary> {
    const pool = await this.keyPools.updatePool(poolId, {
      ...(dto.name === undefined ? {} : { name: dto.name.trim() }),
      ...(dto.note === undefined ? {} : { note: dto.note.trim() === '' ? null : dto.note.trim() }),
    });
    await this.audit(req, currentAdmin, 'wheel.keyPool.updated', { poolId });
    return pool;
  }

  @Delete(':poolId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Удалить пул, из которого ещё ничего не выдавали' })
  public async deletePool(
    @Param('poolId') poolId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<void> {
    await this.keyPools.deletePool(poolId);
    await this.audit(req, currentAdmin, 'wheel.keyPool.deleted', { poolId });
  }

  @Post(':poolId/keys')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Загрузить партию ключей' })
  public async loadKeys(
    @Param('poolId') poolId: string,
    @Body() dto: LoadKeysDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<LoadKeysResult> {
    const result = await this.keyPools.loadKeys(poolId, dto.values);
    // The audit row counts, never the keys themselves: an audit log an
    // operator can read is not a place to copy a batch of secrets into.
    await this.audit(req, currentAdmin, 'wheel.keyPool.keysLoaded', {
      poolId,
      received: result.received,
      added: result.added,
      duplicates: result.duplicates,
    });
    return result;
  }

  @Get(':poolId/keys')
  @ApiOperation({ summary: 'Ключи пула: кто какой получил' })
  public async listKeys(
    @Param('poolId') poolId: string,
    @Query() query: ListKeysDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<KeyPage> {
    // Asking to reveal is not the same as being allowed to: a caller without
    // the permission is served masked values rather than refused, so the list
    // still works for everybody who only wanted to count what is left.
    const reveal =
      query.reveal === true &&
      (await this.rbacService.hasPermission(
        { id: currentAdmin.id, role: currentAdmin.role, rbacRoleId: currentAdmin.rbacRoleId },
        'wheel',
        'view_secrets',
      ));
    if (reveal) {
      await this.audit(req, currentAdmin, 'wheel.keyPool.keysRevealed', { poolId });
    }
    return this.keyPools.listKeys({
      poolId,
      claimed: query.claimed ?? null,
      cursor: query.cursor ?? null,
      limit: query.limit ?? null,
      reveal,
    });
  }

  @Delete(':poolId/keys/:keyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('wheel', 'edit')
  @ApiOperation({ summary: 'Убрать из пула ещё не выданный ключ' })
  public async deleteKey(
    @Param('poolId') poolId: string,
    @Param('keyId') keyId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<void> {
    await this.keyPools.deleteKey(poolId, keyId);
    await this.audit(req, currentAdmin, 'wheel.keyPool.keyRemoved', { poolId, keyId });
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
