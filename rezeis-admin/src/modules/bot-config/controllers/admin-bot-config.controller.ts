import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import {
  CreateBotButtonDto,
  CreateBotEmojiDto,
  CreateBotTextDto,
  UpdateBotButtonDto,
  UpdateBotEmojiDto,
  UpdateBotTextDto,
  parseBotButtonStyle,
} from '../dto/bot-config.dto';
import { BotButtonsService } from '../services/bot-buttons.service';
import { BotEmojisService } from '../services/bot-emojis.service';
import { BotTextsService } from '../services/bot-texts.service';

/**
 * AdminBotConfigController
 * ────────────────────────
 * Single controller that fronts the three bot-config sub-catalogs (buttons,
 * emojis, texts). The frontend feature `web/src/features/bot-config` is the
 * primary consumer; the path layout matches its mutations 1:1.
 *
 * Note on `/delete` POST routes: the frontend uses `POST .../:id/delete`
 * instead of `DELETE` to side-step proxies that strip the request body
 * from `DELETE`. We expose both forms — `DELETE` for new code, `POST`
 * for the existing UI — and they share the same handler.
 */
@ApiTags('admin/bot-config')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/bot-config')
export class AdminBotConfigController {
  public constructor(
    private readonly botButtonsService: BotButtonsService,
    private readonly botEmojisService: BotEmojisService,
    private readonly botTextsService: BotTextsService,
  ) {}

  // ── Buttons ────────────────────────────────────────────────────────────────

  @Get('buttons')
  @ApiOperation({ summary: 'List all bot menu buttons in render order' })
  public listButtons() {
    return this.botButtonsService.listAll();
  }

  @Post('buttons')
  @ApiOperation({ summary: 'Create a new bot menu button' })
  public createButton(@Body() body: CreateBotButtonDto) {
    return this.botButtonsService.create({
      buttonId: body.buttonId,
      label: body.label,
      style: parseBotButtonStyle(body.style),
      iconCustomEmojiId: body.iconCustomEmojiId ?? null,
      visible: body.visible,
      onePerRow: body.onePerRow,
      orderIndex: body.orderIndex,
    });
  }

  @Patch('buttons/:id')
  @ApiOperation({ summary: 'Update an existing bot menu button' })
  public updateButton(@Param('id') id: string, @Body() body: UpdateBotButtonDto) {
    return this.botButtonsService.update({
      id,
      label: body.label,
      style: parseBotButtonStyle(body.style),
      iconCustomEmojiId: body.iconCustomEmojiId,
      visible: body.visible,
      onePerRow: body.onePerRow,
      orderIndex: body.orderIndex,
    });
  }

  @Post('buttons/:id/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a bot menu button (POST form for legacy clients)' })
  public deleteButtonPost(@Param('id') id: string): Promise<void> {
    return this.botButtonsService.delete(id);
  }

  // ── Emojis ─────────────────────────────────────────────────────────────────

  @Get('emojis')
  @ApiOperation({ summary: 'List all bot emoji entries' })
  public listEmojis() {
    return this.botEmojisService.listAll();
  }

  @Post('emojis')
  @ApiOperation({ summary: 'Create a new emoji entry' })
  public createEmoji(@Body() body: CreateBotEmojiDto) {
    return this.botEmojisService.create({
      key: body.key,
      unicode: body.unicode,
      tgEmojiId: body.tgEmojiId ?? null,
    });
  }

  @Patch('emojis/:id')
  @ApiOperation({ summary: 'Update an emoji entry' })
  public updateEmoji(@Param('id') id: string, @Body() body: UpdateBotEmojiDto) {
    return this.botEmojisService.update({
      id,
      key: body.key,
      unicode: body.unicode,
      tgEmojiId: body.tgEmojiId,
    });
  }

  @Post('emojis/:id/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an emoji entry' })
  public deleteEmojiPost(@Param('id') id: string): Promise<void> {
    return this.botEmojisService.delete(id);
  }

  // ── Texts ──────────────────────────────────────────────────────────────────

  @Get('texts')
  @ApiOperation({ summary: 'List all bot copy entries' })
  public listTexts() {
    return this.botTextsService.listAll();
  }

  @Post('texts')
  @ApiOperation({ summary: 'Create a new bot copy entry' })
  public createText(@Body() body: CreateBotTextDto) {
    return this.botTextsService.create({
      key: body.key,
      value: body.value,
      visible: body.visible,
    });
  }

  @Patch('texts/:id')
  @ApiOperation({ summary: 'Update a bot copy entry' })
  public updateText(@Param('id') id: string, @Body() body: UpdateBotTextDto) {
    return this.botTextsService.update({
      id,
      key: body.key,
      value: body.value,
      visible: body.visible,
    });
  }

  @Post('texts/:id/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a bot copy entry' })
  public deleteTextPost(@Param('id') id: string): Promise<void> {
    return this.botTextsService.delete(id);
  }
}
