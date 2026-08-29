import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, UserHint } from '@prisma/client';
import type { Request } from 'express';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  HINT_FORM_FACTORS,
  HINT_ROUTE_TARGETS,
  HINT_SURFACES,
  RENDERABLE_HINT_MODES,
  UpsertUserHintDto,
} from '../dto/user-hint.dto';
import { UserHintService } from '../services/user-hint.service';

/**
 * Authoring surface for in-cabinet hints.
 *
 * Every write is audited. Hint copy is customer-facing text an operator can
 * change without deploying, and "who put that on our customers' screens" needs
 * an answer that does not depend on somebody remembering.
 */
@ApiTags('Admin — User hints')
@ApiBearerAuth()
@Controller('admin/user-hints')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
export class AdminUserHintsController {
  public constructor(
    private readonly hints: UserHintService,
    private readonly prismaService: PrismaService,
  ) {}

  /**
   * The vocabulary the editor builds its pickers from.
   *
   * Served rather than duplicated in the SPA: the route list, the surfaces and
   * the renderable modes all have exactly one true source, and a second copy in
   * the front-end is a second thing to forget when one of them changes.
   */
  @Get('vocabulary')
  @RequirePermission('user_hints', 'view')
  @ApiOperation({ summary: 'Routes, surfaces and modes an operator may choose' })
  public vocabulary(): {
    routes: readonly string[];
    surfaces: readonly string[];
    formFactors: readonly string[];
    modes: readonly string[];
  } {
    return {
      routes: HINT_ROUTE_TARGETS,
      surfaces: HINT_SURFACES,
      formFactors: HINT_FORM_FACTORS,
      modes: RENDERABLE_HINT_MODES,
    };
  }

  @Get()
  @RequirePermission('user_hints', 'view')
  @ApiOperation({ summary: 'List every authored hint' })
  public list(): Promise<UserHint[]> {
    return this.hints.listAll();
  }

  @Get(':id')
  @RequirePermission('user_hints', 'view')
  public getOne(@Param('id') id: string): Promise<UserHint> {
    return this.hints.getById(id);
  }

  @Post()
  @RequirePermission('user_hints', 'create')
  @ApiOperation({ summary: 'Author a new hint' })
  public async create(
    @Body() dto: UpsertUserHintDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<UserHint> {
    const hint = await this.hints.create(dto);
    await this.audit(admin, req, 'user_hint.created', { hintId: hint.id, key: hint.key });
    return hint;
  }

  @Put(':id')
  @RequirePermission('user_hints', 'edit')
  @ApiOperation({ summary: 'Rewrite a hint' })
  public async update(
    @Param('id') id: string,
    @Body() dto: UpsertUserHintDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<UserHint> {
    const hint = await this.hints.update(id, dto);
    await this.audit(admin, req, 'user_hint.updated', {
      hintId: hint.id,
      key: hint.key,
      isActive: hint.isActive,
    });
    return hint;
  }

  @Delete(':id')
  @RequirePermission('user_hints', 'delete')
  @ApiOperation({ summary: 'Delete a hint and every delivery of it' })
  public async remove(
    @Param('id') id: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<{ deletedDeliveries: number }> {
    const outcome = await this.hints.remove(id);
    // The delivery count is in the row because deleting a hint destroys the
    // record of who was shown it, and how much was destroyed is the part an
    // operator will want back and cannot have.
    await this.audit(admin, req, 'user_hint.deleted', {
      hintId: id,
      deletedDeliveries: outcome.deletedDeliveries,
    });
    return outcome;
  }

  private async audit(
    admin: CurrentAdminInterface,
    req: Request,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const rm = extractRequestMetadata(req);
    await this.prismaService.adminAuditLog.create({
      data: {
        action,
        ipAddress: rm.remoteAddress,
        userAgent: rm.userAgent,
        metadata: { requestId: rm.requestId, ...metadata } as Prisma.InputJsonObject,
        adminUser: { connect: { id: admin.id } },
      },
    });
  }
}
