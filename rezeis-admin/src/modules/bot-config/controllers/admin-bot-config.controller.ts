import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import {
  CreateBotButtonDto,
  CreateBotEmojiDto,
  CreateBotTextDto,
  ReorderBotButtonsDto,
  UpdateBotButtonDto,
  UpdateBotEmojiDto,
  UpdateBotTextDto,
  parseBotButtonAction,
  parseBotButtonStyle,
} from '../dto/bot-config.dto';
import { ReiwaCacheInvalidateInterceptor } from '../interceptors/reiwa-cache-invalidate.interceptor';
import { BotBannerUploadService } from '../services/bot-banner-upload.service';
import { BotBannerService, type BotBannerView } from '../services/bot-banner.service';
import { BotButtonsService } from '../services/bot-buttons.service';
import { BotEmojisService } from '../services/bot-emojis.service';
import { BotTextsService } from '../services/bot-texts.service';
import { ReiwaCacheInvalidatorService } from '../services/reiwa-cache-invalidator.service';

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
    private readonly cacheInvalidator: ReiwaCacheInvalidatorService,
    private readonly bannerUploadService: BotBannerUploadService,
    private readonly bannerService: BotBannerService,
  ) {}

  // ── Buttons ────────────────────────────────────────────────────────────────

  @Get('buttons')
  @ApiOperation({ summary: 'List all bot menu buttons in render order' })
  public listButtons() {
    return this.botButtonsService.listAll();
  }

  @Post('buttons')
  @UseInterceptors(ReiwaCacheInvalidateInterceptor)
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
      actionType: parseBotButtonAction(body.actionType),
      actionTarget: body.actionTarget ?? null,
    });
  }

  @Patch('buttons/:id')
  @UseInterceptors(ReiwaCacheInvalidateInterceptor)
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
      actionType: parseBotButtonAction(body.actionType),
      actionTarget: body.actionTarget,
    });
  }

  @Post('buttons/:id/delete')
  @UseInterceptors(ReiwaCacheInvalidateInterceptor)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a bot menu button (POST form for legacy clients)' })
  public deleteButtonPost(@Param('id') id: string): Promise<void> {
    return this.botButtonsService.delete(id);
  }

  @Post('buttons/reorder')
  @UseInterceptors(ReiwaCacheInvalidateInterceptor)
  @ApiOperation({ summary: 'Atomically reorder bot menu buttons by id list' })
  public reorderButtons(@Body() body: ReorderBotButtonsDto) {
    return this.botButtonsService.reorder(body.ids);
  }

  // ── Emojis ─────────────────────────────────────────────────────────────────

  @Get('emojis')
  @ApiOperation({ summary: 'List all bot emoji entries' })
  public listEmojis() {
    return this.botEmojisService.listAll();
  }

  @Post('emojis')
  @UseInterceptors(ReiwaCacheInvalidateInterceptor)
  @ApiOperation({ summary: 'Create a new emoji entry' })
  public createEmoji(@Body() body: CreateBotEmojiDto) {
    return this.botEmojisService.create({
      key: body.key,
      unicode: body.unicode,
      tgEmojiId: body.tgEmojiId ?? null,
    });
  }

  @Patch('emojis/:id')
  @UseInterceptors(ReiwaCacheInvalidateInterceptor)
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
  @UseInterceptors(ReiwaCacheInvalidateInterceptor)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an emoji entry' })
  public deleteEmojiPost(@Param('id') id: string): Promise<void> {
    return this.botEmojisService.delete(id);
  }

  // ── Texts ──────────────────────────────────────────────────────────────────

  @Get('texts')
  @ApiOperation({ summary: 'List all bot copy entries' })
  public listTexts() {
    return this.botTextsService.listForAdmin();
  }

  @Post('texts')
  @UseInterceptors(ReiwaCacheInvalidateInterceptor)
  @ApiOperation({ summary: 'Create a new bot copy entry' })
  public createText(@Body() body: CreateBotTextDto) {
    return this.botTextsService.create({
      key: body.key,
      value: body.value,
      visible: body.visible,
      valueEn: body.valueEn,
    });
  }

  @Patch('texts/:id')
  @UseInterceptors(ReiwaCacheInvalidateInterceptor)
  @ApiOperation({ summary: 'Update a bot copy entry' })
  public updateText(@Param('id') id: string, @Body() body: UpdateBotTextDto) {
    return this.botTextsService.update({
      id,
      key: body.key,
      value: body.value,
      visible: body.visible,
      valueEn: body.valueEn,
    });
  }

  @Post('texts/:id/delete')
  @UseInterceptors(ReiwaCacheInvalidateInterceptor)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a bot copy entry' })
  public deleteTextPost(@Param('id') id: string): Promise<void> {
    return this.botTextsService.delete(id);
  }

  // ── Manual refresh ─────────────────────────────────────────────────────────

  @Post('refresh-bot')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually push a cache-bust to reiwa-bot',
    description:
      'Use this when bot-config data was changed outside the admin UI ' +
      '(SQL, scripts) or when the operator suspects the bot is serving ' +
      'stale data. Returns `{ ok: true }` when the push succeeded, ' +
      '`{ ok: false }` when reiwa-bot is unreachable / misconfigured.',
  })
  public async refreshBot(): Promise<{ readonly ok: boolean }> {
    const ok = await this.cacheInvalidator.invalidate('admin-manual');
    return { ok };
  }

  // ── Banner upload ──────────────────────────────────────────────────────────

  @Post('banner')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
      fileFilter: (_req, file, cb) => {
        const allowed = /^image\/(png|jpeg|webp|gif)$/;
        cb(null, allowed.test(file.mimetype));
      },
    }),
    ReiwaCacheInvalidateInterceptor,
  )
  @ApiOperation({
    summary: 'Upload the welcome banner image',
    description:
      'Stores the file under `data/uploads/bot-banners/` and writes ' +
      'the public URL to the `bot.banner_url` BotText row, replacing ' +
      'whatever was there before. The cache-bust interceptor pushes ' +
      'the new URL to reiwa-bot so the next /start renders the fresh ' +
      'banner.',
  })
  public async uploadBanner(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ readonly url: string; readonly size: number }> {
    if (file === undefined) {
      throw new BadRequestException(
        'Banner file is required (image/png, image/jpeg, image/webp, image/gif; max 8 MB).',
      );
    }
    const persisted = await this.bannerUploadService.persist({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });
    // Anchor the served URL on the admin's PUBLIC_HOST so reiwa-bot
    // (and Telegram, when it pulls the image to send) can reach it.
    // PUBLIC_HOST defaults to the request host; for local dev we keep
    // the URL relative — reiwa-bot inside the docker network resolves
    // `rezeis:8000<url>` via `reiwa.config.resolveRezeisAdminUrl`.
    const fullUrl = this.resolvePublicBannerUrl(persisted.url);
    await this.botTextsService.upsert({
      key: 'bot.banner_url',
      value: fullUrl,
      visible: false,
    });
    return { url: fullUrl, size: persisted.size };
  }

  // ── Banner library (reusable banners) ───────────────────────────────────────

  @Get('banners')
  @ApiOperation({ summary: 'List the reusable banner library' })
  public listBanners(): Promise<readonly BotBannerView[]> {
    return this.bannerService.listAll();
  }

  @Post('banners')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 8 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed = /^image\/(png|jpeg|webp|gif)$/;
        cb(null, allowed.test(file.mimetype));
      },
    }),
    ReiwaCacheInvalidateInterceptor,
  )
  @ApiOperation({ summary: 'Upload a banner into the reusable library' })
  public async createBanner(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('name') name?: string,
  ): Promise<BotBannerView> {
    if (file === undefined) {
      throw new BadRequestException(
        'Banner file is required (image/png, image/jpeg, image/webp, image/gif; max 8 MB).',
      );
    }
    return this.bannerService.createFromUpload({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      name,
    });
  }

  @Post('banners/:id/delete')
  @UseInterceptors(ReiwaCacheInvalidateInterceptor)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a banner from the library (assignments keep their URL)' })
  public deleteBanner(@Param('id') id: string): Promise<void> {
    return this.bannerService.delete(id);
  }

  private resolvePublicBannerUrl(relativeUrl: string): string {
    const publicHost = (process.env.ADMIN_PUBLIC_HOST ?? '').trim();
    if (publicHost.length === 0) {
      // Dev / docker-compose: reiwa-bot resolves this to
      // `http://rezeis:8000/uploads/bot-banners/<file>` because its
      // `REZEIS_ADMIN_URL` env var points at the admin container DNS.
      // Telegram pulls the image through reiwa-bot on /start; the
      // bot proxies the bytes to the API, no public hostname needed.
      return relativeUrl;
    }
    const trimmedHost = publicHost.replace(/\/+$/, '');
    return `${trimmedHost}${relativeUrl}`;
  }
}
