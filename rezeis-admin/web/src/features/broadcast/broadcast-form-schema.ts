import { z } from 'zod'

export const BROADCAST_AUDIENCES = ['ALL', 'ACTIVE_SUBSCRIBERS', 'UNSUBSCRIBED', 'EXPIRED', 'TRIAL'] as const
export const BROADCAST_MEDIA_TYPES = ['none', 'photo', 'video'] as const
export const BROADCAST_MEDIA_SOURCE_MODES = ['upload', 'url', 'fileId'] as const

export interface BroadcastFormDraft {
  readonly audience: string
  readonly title: string
  readonly text: string
  readonly promoCode: string
  readonly mediaType: 'none' | 'photo' | 'video'
  readonly mediaSourceMode: 'upload' | 'url' | 'fileId'
  readonly mediaValue: string
  readonly emailEnabled: boolean
  readonly telegramChannelChatId: string
}

export interface BroadcastCreateRequest {
  readonly audience: (typeof BROADCAST_AUDIENCES)[number]
  readonly promoCode?: string
  readonly payload: {
    readonly title?: string
    readonly text?: string
    readonly mediaType: 'none' | 'photo' | 'video'
    readonly mediaFileId?: string
    readonly emailEnabled?: boolean
    readonly telegramChannelChatId?: string
  }
}

export interface BroadcastFormValidationMessages {
  readonly audienceInvalid: string
  readonly titleTooLong: string
  readonly textRequired: string
  readonly textTooLong: string
  readonly promoCodeTooLong: string
  readonly promoCodeInvalid: string
  readonly mediaTypeInvalid: string
  readonly mediaRequired: string
  readonly mediaTooLong: string
  readonly mediaUrlInvalid: string
  readonly mediaFileIdInvalid: string
  readonly telegramChannelChatIdInvalid: string
  readonly captionTooLong: string
}

/**
 * Telegram's caption limit for a photo or video — a quarter of what a plain
 * message allows. Mirrors `TELEGRAM_CAPTION_LIMIT` on the API, which refuses
 * the same payload; this copy is only so the operator hears it while typing
 * rather than after pressing send.
 */
export const TELEGRAM_CAPTION_LIMIT = 1024

const PROMO_CODE_PATTERN = /^[A-Z0-9._-]+$/
// Telegram chat ids: numeric (incl. negative supergroup/channel ids like
// -1001234567890) or an @username (5-32 chars, letters/digits/underscore).
const TELEGRAM_CHAT_ID_PATTERN = /^(-?\d+|@[A-Za-z0-9_]{5,32})$/

export function createBroadcastFormSchema(messages: BroadcastFormValidationMessages) {
  return z
    .object({
      audience: z.enum(BROADCAST_AUDIENCES, { error: messages.audienceInvalid }),
      title: z.string().trim().max(128, messages.titleTooLong),
      text: z.string().trim().max(4096, messages.textTooLong),
      promoCode: z.string().trim().max(64, messages.promoCodeTooLong),
      mediaType: z.enum(BROADCAST_MEDIA_TYPES, { error: messages.mediaTypeInvalid }),
      mediaSourceMode: z.enum(BROADCAST_MEDIA_SOURCE_MODES),
      mediaValue: z.string().trim().max(256, messages.mediaTooLong),
      emailEnabled: z.boolean(),
      telegramChannelChatId: z.string().trim().max(64),
    })
    .superRefine((values, ctx) => {
      const hasText = values.text.trim().length > 0

      const promo = values.promoCode.trim().toUpperCase()
      if (promo.length > 0 && !PROMO_CODE_PATTERN.test(promo)) {
        ctx.addIssue({ code: 'custom', path: ['promoCode'], message: messages.promoCodeInvalid })
      }

      const channelChatId = values.telegramChannelChatId.trim()
      if (channelChatId.length > 0 && !TELEGRAM_CHAT_ID_PATTERN.test(channelChatId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['telegramChannelChatId'],
          message: messages.telegramChannelChatIdInvalid,
        })
      }

      if (values.mediaType === 'none') {
        if (!hasText) {
          ctx.addIssue({ code: 'custom', path: ['text'], message: messages.textRequired })
        }
        return
      }

      // Attached to media the text is a CAPTION, and Telegram takes a quarter
      // as much. Over the limit it refuses the send once per recipient, so the
      // panel filled with hundreds of delivery failures that were really one
      // caption that was too long.
      const title = values.title.trim()
      const captionLength = (title.length > 0 ? title.length + 2 : 0) + values.text.length
      if (captionLength > TELEGRAM_CAPTION_LIMIT) {
        ctx.addIssue({
          code: 'custom',
          path: ['text'],
          message: messages.captionTooLong.replace('{{count}}', String(captionLength)),
        })
      }

      const mediaValue = values.mediaValue.trim()
      if (mediaValue.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['mediaValue'], message: messages.mediaRequired })
        return
      }

      if (values.mediaSourceMode === 'url') {
        if (!isHttpUrl(mediaValue)) {
          ctx.addIssue({ code: 'custom', path: ['mediaValue'], message: messages.mediaUrlInvalid })
        }
        return
      }

      if (/\s/.test(mediaValue)) {
        ctx.addIssue({ code: 'custom', path: ['mediaValue'], message: messages.mediaFileIdInvalid })
      }
    })
    .transform((values): BroadcastCreateRequest => {
      const title = values.title.trim()
      const text = values.text.trim()
      const promoCode = values.promoCode.trim().toUpperCase()
      const mediaValue = values.mediaValue.trim()
      const channelChatId = values.telegramChannelChatId.trim()
      // ── EVERY KEY, ALWAYS ────────────────────────────────────────────
      //
      // This body is used for CREATE and for PATCH, and the update merges only
      // the keys it is given. Omitting an empty field therefore meant "keep
      // whatever is stored", so switching the email channel OFF, clearing the
      // channel id, removing the promo tag or blanking the title all reported
      // success and shipped the old value — the operator turned email off and
      // every recipient with an address was still mailed.
      //
      // An explicit empty value is how each of these is cleared: the update DTO
      // documents `promoCode: ''` for exactly that, and `mergePayload` writes
      // whatever key it receives.
      const payload: BroadcastCreateRequest['payload'] = {
        mediaType: values.mediaType,
        title,
        text,
        mediaFileId: values.mediaType !== 'none' ? mediaValue : '',
        emailEnabled: values.emailEnabled,
        telegramChannelChatId: channelChatId,
      }

      return {
        audience: values.audience,
        promoCode,
        payload,
      }
    })
}

export function flattenBroadcastFormErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const issue of error.issues) {
    const path = issue.path.length === 0 ? 'form' : issue.path.join('.')
    errors[path] ??= issue.message
  }
  return errors
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}
