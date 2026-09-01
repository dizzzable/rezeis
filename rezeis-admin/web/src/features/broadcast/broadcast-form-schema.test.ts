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
  promoCodeTooLong: 'promo too long',
  promoCodeInvalid: 'promo invalid',
  mediaTypeInvalid: 'media type invalid',
  mediaRequired: 'media required',
  mediaTooLong: 'media too long',
  mediaUrlInvalid: 'media url invalid',
  mediaFileIdInvalid: 'media file id invalid',
  telegramChannelChatIdInvalid: 'telegram channel chat id invalid',
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
    // EVERY key, including the empty ones. This body is also the PATCH body,
    // and the update merges only the keys it receives — so an omitted empty
    // field meant "keep what is stored", and switching the email channel off or
    // clearing the promo tag silently kept the old value.
    expect(result.data).toEqual({
      audience: 'ACTIVE_SUBSCRIBERS',
      promoCode: '',
      payload: {
        title: '',
        text: 'Hello subscribers',
        mediaType: 'photo',
        mediaFileId: 'https://cdn.example.com/banner.jpg?version=1',
        emailEnabled: false,
        telegramChannelChatId: '',
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
      promoCode: '',
      payload: {
        title: '',
        text: '',
        mediaType: 'video',
        mediaFileId: 'BAACAgIAAxkBAAIB12345',
        emailEnabled: false,
        telegramChannelChatId: '',
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

  it('uppercases and forwards a promo code tag', () => {
    const result = createBroadcastFormSchema(messages).safeParse({
      ...validDraft(),
      promoCode: '  summer-25  ',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.promoCode).toBe('SUMMER-25')
  })

  it('sends an EMPTY promo code rather than omitting it', () => {
    // The update DTO documents `promoCode: ''` as the way to clear the tag.
    // Omitting the key instead is indistinguishable from "leave it alone", so
    // removing a promo from a draft used to report success and ship the button
    // anyway.
    const result = createBroadcastFormSchema(messages).safeParse(validDraft())

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.promoCode).toBe('')
  })

  it('rejects promo codes with illegal characters', () => {
    const result = createBroadcastFormSchema(messages).safeParse({
      ...validDraft(),
      promoCode: 'bad code!',
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(flattenBroadcastFormErrors(result.error).promoCode).toBe('promo invalid')
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

  it('forwards emailEnabled and telegramChannelChatId when set', () => {
    const result = createBroadcastFormSchema(messages).safeParse({
      ...validDraft(),
      emailEnabled: true,
      telegramChannelChatId: '  -1001234567890  ',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.payload.emailEnabled).toBe(true)
    expect(result.data.payload.telegramChannelChatId).toBe('-1001234567890')
  })

  it('accepts a channel @username and omits channel fields when unset', () => {
    const withUsername = createBroadcastFormSchema(messages).safeParse({
      ...validDraft(),
      telegramChannelChatId: '@my_channel',
    })
    expect(withUsername.success).toBe(true)
    if (withUsername.success) {
      expect(withUsername.data.payload.telegramChannelChatId).toBe('@my_channel')
    }

    const unset = createBroadcastFormSchema(messages).safeParse(validDraft())
    expect(unset.success).toBe(true)
    if (unset.success) {
      // Present and explicitly off, not absent: an absent key on the PATCH
      // path means "keep the stored value", so switching the channel off
      // would never take effect.
      expect(unset.data.payload.emailEnabled).toBe(false)
      expect(unset.data.payload.telegramChannelChatId).toBe('')
    }
  })

  it('rejects a malformed Telegram channel chat id', () => {
    const result = createBroadcastFormSchema(messages).safeParse({
      ...validDraft(),
      telegramChannelChatId: 'not a valid chat id',
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(flattenBroadcastFormErrors(result.error).telegramChannelChatId).toBe(
      'telegram channel chat id invalid',
    )
  })
})

function validDraft(): BroadcastFormDraft {
  return {
    audience: 'ALL',
    title: '',
    text: 'Hello',
    promoCode: '',
    mediaType: 'none',
    mediaSourceMode: 'upload',
    mediaValue: '',
    emailEnabled: false,
    telegramChannelChatId: '',
  }
}
