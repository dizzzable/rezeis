/**
 * «Кабинет не принял часть оформления» on the branding page.
 *
 * The cabinet takes every field of a save it can and keeps the previous value
 * of each field it refuses; its report reaches the panel within seconds. This
 * card is where the operator learns which fields, why, and where to fix them.
 * Pinned here:
 *
 *   - each field is named the way this page labels it, with the reason in
 *     plain words and what was saved, and a field on this page offers its tab;
 *   - a field edited elsewhere names that place and offers no tab; a key this
 *     panel has never heard of still shows, as the key;
 *   - no report, an empty report or an answer it cannot read shows NOTHING;
 *   - after a save the page asks again over ~40 s, and stops;
 *   - every label and reason the card can print resolves in both languages.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import api from '@/lib/api'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import {
  BRANDING_DELIVERY_FIELD_LABELS,
  BRANDING_DELIVERY_REASONS,
  DELIVERY_RECHECKS_AFTER_SAVE_MS,
  brandingDeliveryFieldOf,
  brandingDeliveryReasonText,
  brandingFormFieldOf,
  readBrandingDeliveryNotice,
} from './branding-delivery-fields'
import { BrandingDeliveryNotice } from './branding-delivery-notice'

const VERSION = 'b'.repeat(32)

function answer(rejected: unknown) {
  return { data: { report: { version: VERSION, reportedAt: '2026-09-24T20:00:00.000Z', rejected } } }
}

beforeAll(async () => {
  await i18nReady
  await loadFeatureBundle('branding')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('reading the answer', () => {
  it('keeps the fields and nothing else', () => {
    const field = { path: 'branding.primary', reason: 'not-a-hex-colour', value: '"red"' }
    expect(readBrandingDeliveryNotice(answer([field, { path: 1 }, null]).data)).toEqual([field])
    expect(readBrandingDeliveryNotice({ report: null })).toEqual([])
    expect(readBrandingDeliveryNotice({ brandName: 'Reiwa' })).toEqual([])
    expect(readBrandingDeliveryNotice(undefined)).toEqual([])
  })

  it('finds the field a key is about', () => {
    expect(brandingDeliveryFieldOf('branding.navItems[1]')).toBe('branding.navItems')
    expect(brandingDeliveryFieldOf('branding.themeVariants.subscriptionCardText')).toBe('branding.themeVariants')
    expect(brandingDeliveryFieldOf('customIcons[0]')).toBe('customIcons')
    expect(brandingDeliveryFieldOf('defaultCurrency')).toBe('defaultCurrency')
    expect(brandingFormFieldOf('branding.navItems')).toBe('navItems')
    expect(brandingFormFieldOf('customIcons')).toBeNull()
  })

  it('reads the bounds out of the two reasons that carry them', () => {
    expect(brandingDeliveryReasonText('out-of-range[0.05..1]')).toEqual({
      key: 'brandingPage.deliveryNotice.reasons.outOfRange',
      values: { min: '0.05', max: '1' },
    })
    expect(brandingDeliveryReasonText('too-many-entries[max=20]')).toEqual({
      key: 'brandingPage.deliveryNotice.reasons.tooManyEntries',
      values: { max: '20' },
    })
    expect(brandingDeliveryReasonText('a-reason-from-a-newer-cabinet')).toEqual({
      key: 'brandingPage.deliveryNotice.reasons.unknown',
    })
  })
})

describe('every word the card can print', () => {
  const says = (key: string): string => {
    const text = i18n.t(key, { min: '0', max: '1', tab: 'x' })
    expect(text, `${key} does not resolve`).not.toBe(key)
    return text
  }

  it.each(['en', 'ru'])('resolves in %s', async (language) => {
    await i18n.changeLanguage(language)
    await loadFeatureBundle('branding')
    const labels = Object.values(BRANDING_DELIVERY_FIELD_LABELS)
    expect(labels.length).toBeGreaterThan(40)
    for (const label of labels) says(label.labelKey)
    for (const reason of [...BRANDING_DELIVERY_REASONS, 'out-of-range[0..24]', 'too-many-entries[max=9]', 'x']) {
      says(brandingDeliveryReasonText(reason).key)
    }
    for (const key of ['title', 'body', 'sent', 'openTab']) says(`brandingPage.deliveryNotice.${key}`)
    says('brandingPage.sections.pwaIcon.installedHint')
    await i18n.changeLanguage('en')
  })
})

function renderNotice(savedAt: number | null, props: { onOpenField?: (field: string) => void } = {}) {
  const onOpenField = props.onOpenField ?? vi.fn()
  const view = renderWithProviders(
    <BrandingDeliveryNotice
      savedAt={savedAt}
      tabLabelOf={(field) => (field === 'primary' ? 'Colors & layout' : 'Brand')}
      onOpenField={onOpenField}
    />,
  )
  return { ...view, onOpenField }
}

describe('the card', () => {
  it('names each field as this page labels it, says why and what was saved, and opens its tab', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(
      answer([
        { path: 'branding.primary', reason: 'not-a-hex-colour', value: '"rebeccapurple"' },
        { path: 'branding.cardEffectOpacity', reason: 'out-of-range[0.05..1]', value: '0' },
      ]),
    )
    const user = userEvent.setup()
    const { onOpenField } = renderNotice(null)

    const card = await screen.findByTestId('branding-delivery-notice')
    expect(within(card).getByText('The cabinet did not accept part of the appearance')).toBeInTheDocument()
    const fields = within(card).getAllByTestId('branding-delivery-field')
    expect(fields).toHaveLength(2)
    expect(within(fields[0]!).getByText('Primary')).toBeInTheDocument()
    expect(within(fields[0]!).getByText('not a colour written as #RRGGBB')).toBeInTheDocument()
    expect(within(fields[0]!).getByText('"rebeccapurple"')).toBeInTheDocument()
    expect(within(fields[1]!).getByText('out of range: from 0.05 to 1')).toBeInTheDocument()

    await user.click(within(fields[0]!).getByRole('button', { name: 'Open the “Colors & layout” tab' }))
    expect(onOpenField).toHaveBeenCalledWith('primary')
  })

  it('names a field edited elsewhere without a tab, and an unknown key as the key', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(
      answer([
        { path: 'defaultCurrency', reason: 'not-a-string', value: '42' },
        { path: 'branding.somethingNew', reason: 'not-a-string', value: '1' },
      ]),
    )
    renderNotice(null)

    const fields = await screen.findAllByTestId('branding-delivery-field')
    expect(within(fields[0]!).getByText('Default currency (platform settings)')).toBeInTheDocument()
    expect(within(fields[0]!).queryByRole('button')).toBeNull()
    expect(within(fields[1]!).getByText('branding.somethingNew')).toBeInTheDocument()
    expect(within(fields[1]!).queryByRole('button')).toBeNull()
  })

  it.each([
    ['no report', { data: { report: null } }],
    ['a report with nothing refused', answer([])],
    ['an answer it cannot read', { data: { brandName: 'Reiwa' } }],
  ])('shows nothing for %s', async (_label, response) => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(response)
    const { container } = renderNotice(null)
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith('/admin/settings/branding/delivery'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(container).toBeEmptyDOMElement()
  })

  it('asks again over ~40 s after a save, then stops', async () => {
    vi.useFakeTimers()
    const get = vi.spyOn(api, 'get').mockResolvedValue(answer([]))
    const { rerender } = renderNotice(null)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(get).toHaveBeenCalledTimes(1)

    // A save lands; nothing is asked again until the first re-check is due.
    rerender(<BrandingDeliveryNotice savedAt={1} tabLabelOf={() => 'Brand'} onOpenField={() => undefined} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999)
    })
    expect(get).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(get).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000)
    })
    expect(DELIVERY_RECHECKS_AFTER_SAVE_MS).toEqual([2_000, 6_000, 12_000, 20_000, 30_000, 42_000])
    expect(get).toHaveBeenCalledTimes(1 + DELIVERY_RECHECKS_AFTER_SAVE_MS.length)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(get).toHaveBeenCalledTimes(1 + DELIVERY_RECHECKS_AFTER_SAVE_MS.length)
  })
})
