import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { CustomEmojiPackInterface } from '../interfaces/custom-emoji-pack.interface';
import { CustomEmojiService } from '../services/custom-emoji.service';

/**
 * Read-only custom emoji packs for the reiwa edge — the cabinet feed uses
 * these to render `:slug:` tokens as inline images / Lottie animations.
 */
@ApiTags('internal/custom-emoji')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/custom-emoji')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalCustomEmojiController {
  public constructor(private readonly customEmojiService: CustomEmojiService) {}

  @Get('packs')
  @ApiOperation({ summary: 'List custom emoji packs (internal, for reiwa cabinet rendering)' })
  public listPacks(): Promise<CustomEmojiPackInterface[]> {
    return this.customEmojiService.listPacks();
  }
}
