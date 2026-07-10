import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
import { CreateQuestDto, ReorderQuestsDto, UpdateQuestDto } from '../dto/quest-payload.dto';
import { QuestIconAssetInterface } from '../interfaces/quest-icon.interface';
import { QuestInterface } from '../interfaces/quest.interface';
import { QuestIconService } from '../services/quest-icon.service';
import { QuestService } from '../services/quest.service';

@ApiTags('admin/quests')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('quests', 'view')
@Controller('admin/quests')
export class AdminQuestController {
  public constructor(
    private readonly questService: QuestService,
    private readonly questIconService: QuestIconService,
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
  @ApiOperation({ summary: 'List quests (display order)' })
  public list(): Promise<readonly QuestInterface[]> {
    return this.questService.list();
  }

  @Get(':questId')
  @ApiOperation({ summary: 'Get a quest by id' })
  public getById(@Param('questId') questId: string): Promise<QuestInterface> {
    return this.questService.getById(questId);
  }

  @Post()
  @RequirePermission('quests', 'create')
  @ApiOperation({ summary: 'Create a quest' })
  public async create(
    @Body() dto: CreateQuestDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<QuestInterface> {
    const quest = await this.questService.create({ dto, currentAdmin });
    await this.audit(req, currentAdmin, 'quests.created', { questId: quest.id, type: quest.type });
    return quest;
  }

  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('quests', 'edit')
  @ApiOperation({ summary: 'Persist a new quest display order' })
  public async reorder(
    @Body() dto: ReorderQuestsDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<readonly QuestInterface[]> {
    const quests = await this.questService.reorder(dto.orderedIds);
    await this.audit(req, currentAdmin, 'quests.reordered', { count: dto.orderedIds.length });
    return quests;
  }

  @Patch(':questId')
  @RequirePermission('quests', 'edit')
  @ApiOperation({ summary: 'Patch a quest' })
  public async update(
    @Param('questId') questId: string,
    @Body() dto: UpdateQuestDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<QuestInterface> {
    const quest = await this.questService.update(questId, dto);
    await this.audit(req, currentAdmin, 'quests.updated', { questId });
    return quest;
  }

  @Delete(':questId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('quests', 'delete')
  @ApiOperation({ summary: 'Delete a quest' })
  public async delete(
    @Param('questId') questId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<void> {
    await this.questService.delete(questId);
    await this.audit(req, currentAdmin, 'quests.deleted', { questId });
  }

  // ── Icons ─────────────────────────────────────────────────────────────────

  @Get('icons/list')
  @ApiOperation({ summary: 'List uploaded quest SVG icon assets' })
  public listIcons(): Promise<readonly QuestIconAssetInterface[]> {
    return this.questIconService.list();
  }

  @Post('icons')
  @RequirePermission('quests', 'edit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 } }))
  @ApiOperation({ summary: 'Upload + sanitize a custom SVG icon' })
  public async uploadIcon(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<QuestIconAssetInterface> {
    if (!file) {
      throw new NotFoundException('No file uploaded');
    }
    const icon = await this.questIconService.store({
      raw: file.buffer.toString('utf8'),
      name: file.originalname,
      uploadedBy: currentAdmin.id,
    });
    await this.audit(req, currentAdmin, 'quests.icon.uploaded', { iconId: icon.id });
    return icon;
  }

  @Get('icons/:iconId')
  @Header('Content-Type', 'image/svg+xml')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  @ApiOperation({ summary: 'Serve a sanitized quest SVG icon (admin preview)' })
  public async serveIcon(@Param('iconId') iconId: string): Promise<string> {
    const svg = await this.questIconService.getSvg(iconId);
    if (svg === null) {
      throw new NotFoundException('Icon not found');
    }
    return svg;
  }
}
