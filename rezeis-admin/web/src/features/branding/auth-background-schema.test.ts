import { describe, expect, it } from 'vitest'

import {
  DEFAULT_AUTH_BACKGROUND_DRAFT,
  createBrandingDirtyPatch,
  createBrandingFormSchema,
  createInitialBrandingDraft,
  getBrandingChangedFields,
} from './branding-form-schema'

/**
 * `authBackground` — entry-screen background for the WEB cabinet.
 *
 * The block is replaced WHOLE by the API and the cabinet refuses the entire
 * branding snapshot when one value is malformed, so the form has three jobs:
 * read a stored pair back as what the cabinet draws, refuse a `kind`/`url`
 * disagreement before the request leaves the browser, and send the field only
 * when the operator touched it.
 */

const messages = {
  hexInvalid: 'hex invalid',
  imageUrlInvalid: 'image url invalid',
  gradientInvalid: 'gradient invalid',
  qrDarkTooLight: 'qr dark too light',
  qrLogoInvalid: 'qr logo invalid',
  authBackgroundUrlRequired: 'auth background url required',
  authBackgroundUrlInvalid: 'auth background url invalid',
} as const

function parseAuthBackground(value: unknown) {
  return createBrandingFormSchema(messages).safeParse({
    ...createInitialBrandingDraft(),
    authBackground: value,
  })
}

describe('entry-screen background draft', () => {
  it('ships no background, exactly like the API default', () => {
    expect(createInitialBrandingDraft().authBackground).toEqual({
      kind: 'none',
      url: null,
    })
    expect(DEFAULT_AUTH_BACKGROUND_DRAFT).toEqual({ kind: 'none', url: null })
  })

  it('reads a stored image or video block back as written', () => {
    expect(
      createInitialBrandingDraft({
        authBackground: { kind: 'image', url: 'https://cdn.example.com/a.png' },
      }).authBackground,
    ).toEqual({ kind: 'image', url: 'https://cdn.example.com/a.png' })

    expect(
      createInitialBrandingDraft({
        authBackground: { kind: 'video', url: 'https://cdn.example.com/a.mp4' },
      }).authBackground,
    ).toEqual({ kind: 'video', url: 'https://cdn.example.com/a.mp4' })

    // The operator's own uploaded clip is a first-class address now.
    expect(
      createInitialBrandingDraft({
        authBackground: { kind: 'video', url: '/uploads/branding/abc123.mp4' },
      }).authBackground,
    ).toEqual({ kind: 'video', url: '/uploads/branding/abc123.mp4' })
  })

  it('repairs a stored pair whose halves disagree, as the reader does', () => {
    for (const stored of [
      { kind: 'gallery', url: 'https://cdn.example.com/a.png' },
      // The video slot cannot point at a still: the page would render a
      // `<video>` that never decodes.
      { kind: 'video', url: '/uploads/branding/a.png' },
      { kind: 'video', url: 'data:image/png;base64,AA==' },
      { kind: 'image', url: 'data:image/png;base64,AA==' },
      { kind: 'image', url: '' },
      { kind: 'image', url: 'http://cdn.example.com/a.png' },
    ]) {
      expect(
        createInitialBrandingDraft({ authBackground: stored as never }).authBackground,
      ).toEqual({ kind: 'none', url: null })
      expect(parseAuthBackground(stored).success).toBe(false)
    }
  })

  it('accepts both address shapes an image upload can produce', () => {
    for (const url of [
      'https://cdn.example.com/login.jpg',
      '/uploads/branding/login-abc123.png',
    ]) {
      const result = parseAuthBackground({ kind: 'image', url })
      expect(result.success, `expected acceptance for ${url}`).toBe(true)
      if (result.success) expect(result.data.authBackground).toEqual({ kind: 'image', url })
    }
  })

  it('refuses inline data URLs the cabinet would not draw', () => {
    // `resolveAuthBackground` in the cabinet rejects `data:`. Accepting one here
    // would show a wallpaper in the panel and an empty entry screen on the site.
    for (const value of [
      { kind: 'image', url: 'data:image/png;base64,aGVsbG8=' },
      { kind: 'video', url: 'data:image/png;base64,aGVsbG8=' },
    ]) {
      const result = parseAuthBackground(value)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain(
          'authBackground.url',
        )
      }
    }
  })

  it('accepts both address shapes a video upload can produce', () => {
    for (const url of [
      'https://cdn.example.com/login.mp4',
      '/uploads/branding/login-abc123.mp4',
      '/uploads/branding/login-abc123.webm',
    ]) {
      const result = parseAuthBackground({ kind: 'video', url })
      expect(result.success, `expected acceptance for ${url}`).toBe(true)
      if (result.success) expect(result.data.authBackground).toEqual({ kind: 'video', url })
    }
  })

  it('refuses a non-https video, a video slot pointed at a still, and a URL alongside "none"', () => {
    for (const value of [
      { kind: 'video', url: 'http://cdn.example.com/a.mp4' },
      { kind: 'video', url: '/uploads/branding/a.png' },
      { kind: 'video', url: '/uploads/branding/a.mp4.txt' },
      { kind: 'video', url: 'https://cdn.example.com/a b.mp4' },
      { kind: 'none', url: 'https://cdn.example.com/a.png' },
      { kind: 'image' },
    ]) {
      const result = parseAuthBackground(value)
      expect(result.success, `expected a refusal for ${JSON.stringify(value)}`).toBe(false)
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain(
          'authBackground.url',
        )
      }
    }
  })

  it('sends the field only when the operator changed it', () => {
    const schema = createBrandingFormSchema(messages)
    const baseline = createInitialBrandingDraft()
    const untouched = createBrandingDirtyPatch({
      values: baseline,
      dirtyFields: getBrandingChangedFields(baseline, baseline),
      schema,
    })
    expect(untouched.success).toBe(true)
    if (untouched.success) {
      expect('authBackground' in untouched.data).toBe(false)
      expect(untouched.fields).toEqual([])
    }

    const changedValues = {
      ...baseline,
      authBackground: { kind: 'image' as const, url: 'https://cdn.example.com/a.png' },
    }
    const dirtyFields = getBrandingChangedFields(changedValues, baseline)
    expect(dirtyFields.authBackground).toBe(true)
    const changed = createBrandingDirtyPatch({
      values: changedValues,
      dirtyFields,
      schema,
    })
    expect(changed.success).toBe(true)
    if (changed.success) {
      expect(changed.fields).toEqual(['authBackground'])
      expect(changed.data.authBackground).toEqual({
        kind: 'image',
        url: 'https://cdn.example.com/a.png',
      })
    }
  })
})
