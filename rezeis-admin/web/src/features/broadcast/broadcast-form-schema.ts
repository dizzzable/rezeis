import { z } from 'zod'

export const BROADCAST_AUDIENCES = ['ALL', 'ACTIVE_SUBSCRIBERS', 'UNSUBSCRIBED', 'EXPIRED', 'TRIAL'] as const
export const BROADCAST_MEDIA_TYPES = ['none', 'photo', 'video'] as const
export const BROADCAST_MEDIA_SOURCE_MODES = ['upload', 'url', 'fileId'] as const

export interface BroadcastFormDraft {
  readonly audience: string
  readonly title: string
  readonly text: string
  readonly mediaType: 'none' | 'photo' | 'video'
  readonly mediaSourceMode: 'upload' | 'url' | 'fileId'
  readonly mediaValue: string
}

export interface BroadcastCreateRequest {
  readonly audience: (typeof BROADCAST_AUDIENCES)[number]
  readonly payload: {
    readonly title?: string
    readonly text?: string
    readonly mediaType: 'none' | 'photo' | 'video'
    readonly mediaFileId?: string
  }
}

export interface BroadcastFormValidationMessages {
  readonly audienceInvalid: string
  readonly titleTooLong: string
  readonly textRequired: string
  readonly textTooLong: string
  readonly mediaTypeInvalid: string
  readonly mediaRequired: string
  readonly mediaTooLong: string
  readonly mediaUrlInvalid: string
  readonly mediaFileIdInvalid: string
}

export function createBroadcastFormSchema(messages: BroadcastFormValidationMessages) {
  return z
    .object({
      audience: z.enum(BROADCAST_AUDIENCES, { error: messages.audienceInvalid }),
      title: z.string().trim().max(128, messages.titleTooLong),
      text: z.string().trim().max(4096, messages.textTooLong),
      mediaType: z.enum(BROADCAST_MEDIA_TYPES, { error: messages.mediaTypeInvalid }),
      mediaSourceMode: z.enum(BROADCAST_MEDIA_SOURCE_MODES),
      mediaValue: z.string().trim().max(256, messages.mediaTooLong),
    })
    .superRefine((values, ctx) => {
      const hasText = values.text.trim().length > 0

      if (values.mediaType === 'none') {
        if (!hasText) {
          ctx.addIssue({ code: 'custom', path: ['text'], message: messages.textRequired })
        }
        return
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
      const mediaValue = values.mediaValue.trim()
      const payload: BroadcastCreateRequest['payload'] = {
        mediaType: values.mediaType,
        ...(title ? { title } : {}),
        ...(text ? { text } : {}),
        ...(values.mediaType !== 'none' ? { mediaFileId: mediaValue } : {}),
      }

      return {
        audience: values.audience,
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
