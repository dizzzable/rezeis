import { Body, Controller, Delete, Get, Param, Post, Put, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, IsBoolean, IsEnum, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { BotFlowButtonAction, BotFlowButtonStyle, BotFlowMediaType, BotFlowParseMode } from '@prisma/client';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { BotFlowService } from '../services/bot-flow.service';
import { BotFlowScreenService } from '../services/bot-flow-screen.service';

// ── DTOs ────────────────────────────────────────────────────────────────────

class SaveLayoutDto {
  layoutData!: unknown;
}

class CreateScreenDto {
  @IsString()
  flowId!: string

  @IsOptional() @IsString()
  name?: string

  @IsOptional() @IsString()
  textRu?: string

  @IsOptional() @IsString()
  textEn?: string

  @IsOptional() @IsEnum(BotFlowParseMode)
  parseMode?: BotFlowParseMode

  @IsOptional() @IsString()
  mediaType?: BotFlowMediaType | null

  @IsOptional() @IsString()
  mediaFileId?: string | null

  @IsOptional() @IsString()
  mediaUrl?: string | null

  @IsOptional() @IsNumber()
  positionX?: number

  @IsOptional() @IsNumber()
  positionY?: number

  @IsOptional() @IsBoolean()
  isRoot?: boolean
}

class UpdateScreenDto {
  @IsOptional() @IsString()
  name?: string

  @IsOptional() @IsString()
  textRu?: string

  @IsOptional() @IsString()
  textEn?: string

  @IsOptional() @IsEnum(BotFlowParseMode)
  parseMode?: BotFlowParseMode

  @IsOptional() @IsString()
  mediaType?: BotFlowMediaType | null

  @IsOptional() @IsString()
  mediaFileId?: string | null

  @IsOptional() @IsString()
  mediaUrl?: string | null

  @IsOptional() @IsNumber()
  positionX?: number

  @IsOptional() @IsNumber()
  positionY?: number

  @IsOptional() @IsBoolean()
  isRoot?: boolean
}

class PositionItem {
  @IsString()
  id!: string

  @IsNumber()
  x!: number

  @IsNumber()
  y!: number
}

class UpdatePositionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PositionItem)
  positions!: PositionItem[]
}

class CreateButtonDto {
  @IsString()
  screenId!: string

  @IsString()
  labelRu!: string

  @IsString()
  labelEn!: string

  @IsOptional() @IsNumber()
  row?: number

  @IsOptional() @IsNumber()
  col?: number

  @IsEnum(BotFlowButtonAction)
  actionType!: BotFlowButtonAction

  @IsOptional() @IsString()
  targetScreenId?: string | null

  @IsOptional() @IsString()
  url?: string | null

  @IsOptional() @IsString()
  webAppUrl?: string | null

  @IsOptional() @IsString()
  callbackAction?: string | null

  @IsOptional() @IsEnum(BotFlowButtonStyle)
  style?: BotFlowButtonStyle

  @IsOptional() @IsString()
  iconCustomEmojiId?: string | null
}

class UpdateButtonDto {
  @IsOptional() @IsString()
  labelRu?: string

  @IsOptional() @IsString()
  labelEn?: string

  @IsOptional() @IsNumber()
  row?: number

  @IsOptional() @IsNumber()
  col?: number

  @IsOptional() @IsEnum(BotFlowButtonAction)
  actionType?: BotFlowButtonAction

  @IsOptional() @IsString()
  targetScreenId?: string | null

  @IsOptional() @IsString()
  url?: string | null

  @IsOptional() @IsString()
  webAppUrl?: string | null

  @IsOptional() @IsString()
  callbackAction?: string | null

  @IsOptional() @IsEnum(BotFlowButtonStyle)
  style?: BotFlowButtonStyle

  @IsOptional() @IsString()
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

  // ── Media Upload ──────────────────────────────────────────────────────────

  @Post('screens/:id/media')
  @ApiOperation({ summary: 'Upload media for a screen' })
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
    fileFilter: (_req, file, cb) => {
      const allowed = /^(image|video)\//;
      cb(null, allowed.test(file.mimetype));
    },
  }))
  public async uploadMedia(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('File is required (image or video, max 20MB)');
    }
    return this.screenService.uploadMedia(id, file);
  }
}
