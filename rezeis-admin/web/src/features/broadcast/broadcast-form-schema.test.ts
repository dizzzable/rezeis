import { describe, expect, it } from 'vitest'

import {
  createBroadcastFormSchema,
  flattenBroadcastFormErrors,
  type BroadcastFormDraft,
} from './broadcast-form-schema'

const messages = {
  audienceInvalid: 'audience invalid',
  titleTooLong: 'title too long',
  textRequired: 'text required',
  textTooLong: 'text too long',
  mediaTypeInvalid: 'media type invalid',
  mediaRequired: 'media required',
  mediaTooLong: 'media too long',
  mediaUrlInvalid: 'media url invalid',
  mediaFileIdInvalid: 'media file id invalid',
} as const

describe('broadcast form schema', () => {
  it('normalizes a valid text and URL media payload before submit', () => {
    const result = createBroadcastFormSchema(messages).safeParse({
      ...validDraft(),
      audience: 'ACTIVE_SUBSCRIBERS',
      text: '  Hello subscribers  ',
      mediaType: 'photo',
      mediaSourceMode: 'url',
      mediaValue: '  https://cdn.example.com/banner.jpg?version=1  ',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({
      audience: 'ACTIVE_SUBSCRIBERS',
      payload: {
        text: 'Hello subscribers',
        mediaType: 'photo',
        mediaFileId: 'https://cdn.example.com/banner.jpg?version=1',
      },
    })
  })

  it('allows media-only broadcasts with uploaded Telegram file IDs', () => {
    const result = createBroadcastFormSchema(messages).safeParse({
      ...validDraft(),
      text: '  ',
      mediaType: 'video',
      mediaSourceMode: 'upload',
      mediaValue: 'BAACAgIAAxkBAAIB12345',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({
      audience: 'ALL',
      payload: {
        mediaType: 'video',
        mediaFileId: 'BAACAgIAAxkBAAIB12345',
      },
    })
  })

  it('rejects unsupported audiences', () => {
    const result = createBroadcastFormSchema(messages).safeParse({
      ...validDraft(),
      audience: 'SUBSCRIBED',
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(flattenBroadcastFormErrors(result.error).audience).toBe('audience invalid')
  })

  it('rejects empty text-only payloads', () => {
    const result = createBroadcastFormSchema(messages).safeParse({
      ...validDraft(),
      text: ' ',
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(flattenBroadcastFormErrors(result.error).text).toBe('text required')
  })

  it('rejects malformed media references before submit', () => {
    const invalidUrl = createBroadcastFormSchema(messages).safeParse({
      ...validDraft(),
      mediaType: 'photo',
      mediaSourceMode: 'url',
      mediaValue: 'ftp://example.com/image.jpg',
    })
    const invalidFileId = createBroadcastFormSchema(messages).safeParse({
      ...validDraft(),
      mediaType: 'photo',
      mediaSourceMode: 'fileId',
      mediaValue: 'telegram file id',
    })

    expect(invalidUrl.success).toBe(false)
    if (!invalidUrl.success) {
      expect(flattenBroadcastFormErrors(invalidUrl.error).mediaValue).toBe('media url invalid')
    }
    expect(invalidFileId.success).toBe(false)
    if (!invalidFileId.success) {
      expect(flattenBroadcastFormErrors(invalidFileId.error).mediaValue).toBe('media file id invalid')
    }
  })
})

function validDraft(): BroadcastFormDraft {
  return {
    audience: 'ALL',
    title: '',
    text: 'Hello',
    mediaType: 'none',
    mediaSourceMode: 'upload',
    mediaValue: '',
  }
}
