import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BotFlowButtonAction, BotFlowButtonStyle, BotFlowMediaType, BotFlowParseMode } from '@prisma/client';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { BotFlowService } from '../services/bot-flow.service';
import { BotFlowScreenService } from '../services/bot-flow-screen.service';

// ── DTOs (inline for now — extract to dto/ when they grow) ──────────────────

class SaveLayoutDto {
  layoutData!: unknown;
}

class CreateScreenDto {
  flowId!: string
  name?: string
  textRu?: string
  textEn?: string
  parseMode?: BotFlowParseMode
  mediaType?: BotFlowMediaType | null
  mediaFileId?: string | null
  mediaUrl?: string | null
  positionX?: number
  positionY?: number
  isRoot?: boolean
}

class UpdateScreenDto {
  name?: string
  textRu?: string
  textEn?: string
  parseMode?: BotFlowParseMode
  mediaType?: BotFlowMediaType | null
  mediaFileId?: string | null
  mediaUrl?: string | null
  positionX?: number
  positionY?: number
  isRoot?: boolean
}

class UpdatePositionsDto {
  positions!: Array<{ id: string; x: number; y: number }>;
}

class CreateButtonDto {
  screenId!: string
  labelRu!: string
  labelEn!: string
  row?: number
  col?: number
  actionType!: BotFlowButtonAction
  targetScreenId?: string | null
  url?: string | null
  webAppUrl?: string | null
  callbackAction?: string | null
  style?: BotFlowButtonStyle
  iconCustomEmojiId?: string | null
}

class UpdateButtonDto {
  labelRu?: string
  labelEn?: string
  row?: number
  col?: number
  actionType?: BotFlowButtonAction
  targetScreenId?: string | null
  url?: string | null
  webAppUrl?: string | null
  callbackAction?: string | null
  style?: BotFlowButtonStyle
  iconCustomEmojiId?: string | null
}

@ApiTags('Bot Flow Editor')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/bot-flows')
export class AdminBotFlowController {
  public constructor(
    private readonly flowService: BotFlowService,
    private readonly screenService: BotFlowScreenService,
  ) {}

  // ── Flow CRUD ─────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List all bot flows' })
  public listFlows() {
    return this.flowService.listFlows();
  }

  @Get('draft/:name')
  @ApiOperation({ summary: 'Get or create draft flow by name' })
  public getDraft(@Param('name') name: string) {
    return this.flowService.getDraft(name);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get flow by ID with screens and buttons' })
  public getById(@Param('id') id: string) {
    return this.flowService.getById(id);
  }

  @Put(':id/layout')
  @ApiOperation({ summary: 'Save flow layout (viewport, positions)' })
  public saveLayout(@Param('id') id: string, @Body() dto: SaveLayoutDto) {
    return this.flowService.saveLayout(id, dto.layoutData);
  }

  @Post(':id/publish')
  @ApiOperation({ summary: 'Publish a draft flow' })
  public publish(@Param('id') id: string) {
    return this.flowService.publish(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a draft flow' })
  public deleteFlow(@Param('id') id: string) {
    return this.flowService.deleteDraft(id);
  }

  // ── Screen CRUD ───────────────────────────────────────────────────────────

  @Put('screens/positions')
  @ApiOperation({ summary: 'Batch-update screen positions' })
  public updatePositions(@Body() dto: UpdatePositionsDto) {
    return this.screenService.updatePositions(dto.positions);
  }

  @Post('screens')
  @ApiOperation({ summary: 'Create a screen in a flow' })
  public createScreen(@Body() dto: CreateScreenDto) {
    return this.screenService.createScreen(dto);
  }

  @Put('screens/:id')
  @ApiOperation({ summary: 'Update a screen' })
  public updateScreen(@Param('id') id: string, @Body() dto: UpdateScreenDto) {
    return this.screenService.updateScreen(id, dto);
  }

  @Delete('screens/:id')
  @ApiOperation({ summary: 'Delete a screen' })
  public deleteScreen(@Param('id') id: string) {
    return this.screenService.deleteScreen(id);
  }

  // ── Button CRUD ───────────────────────────────────────────────────────────

  @Post('buttons')
  @ApiOperation({ summary: 'Add a button to a screen' })
  public createButton(@Body() dto: CreateButtonDto) {
    return this.screenService.createButton(dto);
  }

  @Put('buttons/:id')
  @ApiOperation({ summary: 'Update a button' })
  public updateButton(@Param('id') id: string, @Body() dto: UpdateButtonDto) {
    return this.screenService.updateButton(id, dto);
  }

  @Delete('buttons/:id')
  @ApiOperation({ summary: 'Delete a button' })
  public deleteButton(@Param('id') id: string) {
    return this.screenService.deleteButton(id);
  }
}
