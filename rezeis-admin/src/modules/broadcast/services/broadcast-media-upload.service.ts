import { Buffer } from 'node:buffer';

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { paymentsConfig } from '../../../common/config/payments.config';
import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Broadcast media upload — accepts a raw file buffer from the operator,
 * forwards it to Telegram via the bot's `sendPhoto` / `sendVideo` API to
 * obtain a `file_id`, and returns that id back to the frontend.
 *
 * Why route through Telegram?
 *   The broadcast worker sends each message via Telegram Bot API which
 *   accepts only `file_id` (cached upload), URL, or InputFile. Reusing
 *   a `file_id` is by far the cheapest option for high-volume broadcasts
 *   (no re-upload, no URL fetch). So we upload once via the bot and use
 *   the returned `file_id` in every subsequent send.
 *
 * Stash chat resolution priority:
 *   1. `Settings.systemNotifications.telegram.chatId` (the chat where
 *      operator events are routed) — preferred so files don't leak to
 *      end users.
 *   2. `Settings.paymentOpsAlerts.chatId` (payment ops chat) — fallback.
 *
 * Limits (Telegram Bot API):
 *   - Photo: 10 MB max, JPEG/PNG/WEBP/GIF
 *   - Video: 50 MB max
 *   - Document fallback: 50 MB max
 */

const MAX_PHOTO_BYTES = 10 * 1024 * 1024
const MAX_VIDEO_BYTES = 50 * 1024 * 1024
const ACCEPTED_PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
const ACCEPTED_VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo'] as const

export interface UploadedMediaInterface {
  readonly mediaType: 'photo' | 'video'
  readonly fileId: string
  readonly fileName: string
  readonly mimeType: string
  readonly sizeBytes: number
}

interface UploadInput {
  readonly buffer: Buffer
  readonly originalName: string
  readonly mimeType: string
  readonly mediaType: 'photo' | 'video'
}

@Injectable()
export class BroadcastMediaUploadService {
  private readonly logger = new Logger(BroadcastMediaUploadService.name)

  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(paymentsConfig.KEY)
    private readonly paymentConfiguration: ConfigType<typeof paymentsConfig>,
  ) {}

  public async upload(input: UploadInput): Promise<UploadedMediaInterface> {
    this.assertSize(input)
    this.assertMimeType(input)

    const botToken = this.paymentConfiguration.botToken
    if (!botToken) {
      throw new ServiceUnavailableException('BOT_TOKEN is not configured')
    }

    const chatId = await this.resolveStashChatId()
    if (!chatId) {
      throw new ServiceUnavailableException(
        'Telegram stash chat is not configured. Open Notifications → Delivery settings and set Chat ID.',
      )
    }

    const formData = new FormData()
    formData.append('chat_id', chatId)
    const blob = new Blob([new Uint8Array(input.buffer)], { type: input.mimeType })
    if (input.mediaType === 'photo') {
      formData.append('photo', blob, input.originalName)
    } else {
      formData.append('video', blob, input.originalName)
      formData.append('supports_streaming', 'true')
    }
    formData.append('disable_notification', 'true')
    formData.append('caption', `[broadcast media stash] ${input.originalName}`)

    const endpoint = input.mediaType === 'photo' ? 'sendPhoto' : 'sendVideo'
    const url = `https://api.telegram.org/bot${botToken}/${endpoint}`

    let responsePayload: TelegramResponse
    try {
      const response = await fetch(url, { method: 'POST', body: formData })
      responsePayload = (await response.json()) as TelegramResponse
    } catch (err) {
      this.logger.error(`Telegram ${endpoint} failed: ${(err as Error).message}`)
      throw new ServiceUnavailableException('Failed to upload media to Telegram')
    }

    if (!responsePayload.ok || !responsePayload.result) {
      this.logger.error(
        `Telegram ${endpoint} returned error: ${responsePayload.description ?? 'unknown'}`,
      )
      throw new BadRequestException(
        `Telegram rejected the upload: ${responsePayload.description ?? 'unknown error'}`,
      )
    }

    const fileId = this.extractFileId(responsePayload.result, input.mediaType)
    if (!fileId) {
      throw new ServiceUnavailableException('Telegram response did not include a file_id')
    }

    return {
      mediaType: input.mediaType,
      fileId,
      fileName: input.originalName,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.length,
    }
  }

  private assertSize(input: UploadInput): void {
    const limit = input.mediaType === 'photo' ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES
    if (input.buffer.length > limit) {
      const limitMb = Math.round(limit / (1024 * 1024))
      throw new BadRequestException(
        `File too large. ${input.mediaType === 'photo' ? 'Photos' : 'Videos'} must be ≤ ${limitMb} MB.`,
      )
    }
    if (input.buffer.length === 0) {
      throw new BadRequestException('Empty file')
    }
  }

  private assertMimeType(input: UploadInput): void {
    const accepted: readonly string[] =
      input.mediaType === 'photo' ? ACCEPTED_PHOTO_MIME : ACCEPTED_VIDEO_MIME
    if (!accepted.includes(input.mimeType)) {
      throw new BadRequestException(
        `Unsupported file type: ${input.mimeType}. Allowed: ${accepted.join(', ')}`,
      )
    }
  }

  private async resolveStashChatId(): Promise<string | null> {
    const settings = await this.prismaService.settings.findFirst({
      select: { systemNotifications: true, paymentOpsAlerts: true },
    })
    if (!settings) return null

    const sysJson = (settings.systemNotifications ?? {}) as Record<string, unknown>
    const tgConfig = (sysJson.telegram ?? {}) as Record<string, unknown>
    if (typeof tgConfig.chatId === 'string' && tgConfig.chatId.trim().length > 0) {
      return tgConfig.chatId.trim()
    }

    const paymentJson = (settings.paymentOpsAlerts ?? {}) as Record<string, unknown>
    const paymentOps = (paymentJson.paymentOps ?? {}) as Record<string, unknown>
    if (typeof paymentOps.chatId === 'string' && paymentOps.chatId.trim().length > 0) {
      return paymentOps.chatId.trim()
    }

    return null
  }

  private extractFileId(
    result: Record<string, unknown>,
    mediaType: 'photo' | 'video',
  ): string | null {
    if (mediaType === 'photo') {
      const photos = result.photo as Array<{ file_id: string; file_size?: number }> | undefined
      if (!Array.isArray(photos) || photos.length === 0) return null
      // Telegram returns multiple sizes — pick the largest.
      const largest = photos.reduce((acc, p) => ((p.file_size ?? 0) > (acc.file_size ?? 0) ? p : acc))
      return largest.file_id ?? null
    }
    const video = result.video as { file_id?: string } | undefined
    return typeof video?.file_id === 'string' ? video.file_id : null
  }
}

interface TelegramResponse {
  readonly ok: boolean
  readonly result?: Record<string, unknown>
  readonly description?: string
}
