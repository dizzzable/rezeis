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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import api from '@/lib/api'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import {
  BRANDING_DELIVERY_ENTRY_REASONS,
  BRANDING_DELIVERY_FIELD_LABELS,
  BRANDING_DELIVERY_REASONS,
  DELIVERY_RECHECKS_AFTER_SAVE_MS,
  brandingDeliveryEntryIdOf,
  brandingDeliveryEntryOf,
  brandingDeliveryEntryReasonText,
  brandingDeliveryFieldOf,
  brandingDeliveryReasonText,
  brandingFormFieldOf,
  readBrandingDeliveryNotice,
} from './branding-delivery-fields'
import { BrandingDeliveryNotice } from './branding-delivery-notice'

const VERSION = 'b'.repeat(32)

/** The cabinet's guard, in the sibling checkout (`../reiwa` next to this repo). */
const REIWA_PORT = join(
  __dirname,
  ...Array<string>(6).fill('..'),
  'reiwa',
  'src',
  'application',
  'ports',
  'public-config-persistence.port.ts',
)

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

/**
 * The cabinet takes five fields entry by entry and reports a refused entry by
 * its OWN path (reiwa `PUBLIC_CONFIG_KEYED_FIELDS`, `delivery-report.ts`):
 * `branding.planCardStyles.<planId>`, `branding.iconDecor.<key>`,
 * `customIcons[i]`, `branding.cardEffectsByIndex[i]`, `branding.navItems[i]`.
 * The card names that entry — the plan, the icon, the item — and says why in
 * words about it, not in the whole field's («…одной из тарифных карточек…»).
 */
describe('a refused entry is named, not only its field', () => {
  it('reads the entry out of the path — a plan id may hold a dot or a bracket', () => {
    expect(brandingDeliveryEntryOf('branding.planCardStyles.plan-basic')).toEqual({ kind: 'plan', planId: 'plan-basic' })
    expect(brandingDeliveryEntryOf('branding.planCardStyles.pl.an[1]')).toEqual({ kind: 'plan', planId: 'pl.an[1]' })
    expect(brandingDeliveryEntryOf('branding.iconDecor.buy')).toEqual({ kind: 'icon', iconKey: 'buy' })
    expect(brandingDeliveryEntryOf('customIcons[2]')).toEqual({ kind: 'customIcon', position: 3 })
    expect(brandingDeliveryEntryOf('branding.cardEffectsByIndex[0]')).toEqual({ kind: 'cardSlot', position: 1 })
    expect(brandingDeliveryEntryOf('branding.navItems[4]')).toEqual({ kind: 'navItem', position: 5 })
    for (const whole of [
      'branding.planCardStyles',
      'branding.planCardStyles.',
      'branding.primary',
      'branding.themeVariants.subscriptionCardText',
      'customIcons',
      'defaultCurrency',
    ]) {
      expect(brandingDeliveryEntryOf(whole), whole).toBeNull()
    }
  })

  it('reads the id a reported value names, even cut short', () => {
    expect(brandingDeliveryEntryIdOf('{"id":"plans","visible":true}')).toBe('plans')
    expect(brandingDeliveryEntryIdOf('{"id":"my-icon","svg":"<svg viewBox=\\"0 0 24 24\\"…')).toBe('my-icon')
    expect(brandingDeliveryEntryIdOf('{"svg":"<g id=\\"x\\"/>"}')).toBeNull()
    expect(brandingDeliveryEntryIdOf('42')).toBeNull()
  })

  it('words an entry’s reason about the entry, and any other reason as the field does', () => {
    for (const reason of BRANDING_DELIVERY_ENTRY_REASONS) {
      expect(brandingDeliveryEntryReasonText(reason).key).toBe(`brandingPage.deliveryNotice.entryReasons.${reason}`)
    }
    expect(brandingDeliveryEntryReasonText('out-of-range[0..1]')).toEqual(brandingDeliveryReasonText('out-of-range[0..1]'))
  })

  it('names the plan by its name, and a plan no longer in the list by its id', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/plans') return { data: [{ id: 'plan-basic', name: 'Basic' }] }
      return answer([
        { path: 'branding.planCardStyles.plan-basic', reason: 'not-a-valid-plan-card-style-map', value: '{"gradient":1}' },
        { path: 'branding.planCardStyles.plan-gone', reason: 'not-a-valid-plan-card-style-map', value: '{"gradient":1}' },
      ])
    })
    renderNotice(null)

    const fields = await screen.findAllByTestId('branding-delivery-field')
    expect(await within(fields[0]!).findByText('Tariff cards — plan “Basic”')).toBeInTheDocument()
    expect(within(fields[1]!).getByText('Tariff cards — plan with id plan-gone (not in the plan list)')).toBeInTheDocument()
    const entryWords = i18n.t('brandingPage.deliveryNotice.entryReasons.not-a-valid-plan-card-style-map')
    expect(within(fields[0]!).getByText(entryWords)).toBeInTheDocument()
    expect(within(fields[0]!).queryByText(i18n.t('brandingPage.deliveryNotice.reasons.not-a-valid-plan-card-style-map'))).toBeNull()
    expect(get).toHaveBeenCalledWith('/admin/plans', expect.anything())
  })

  it('names the icon, the custom icon, the card and the menu item — and asks for no plans', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(
      answer([
        { path: 'branding.iconDecor.buy', reason: 'not-a-valid-icon-decor-map', value: '{"glyph":7}' },
        { path: 'customIcons[1]', reason: 'not-a-valid-custom-icon', value: '{"id":"star-2","svg":"<svg…' },
        { path: 'branding.cardEffectsByIndex[0]', reason: 'not-a-valid-card-effect-slot', value: '{"mode":"x"}' },
        { path: 'branding.navItems[2]', reason: 'duplicate-destination-id', value: '{"id":"plans","visible":true}' },
      ]),
    )
    renderNotice(null)

    const fields = await screen.findAllByTestId('branding-delivery-field')
    expect(within(fields[0]!).getByText('Dashboard icons — the “Buy” icon')).toBeInTheDocument()
    expect(within(fields[1]!).getByText('Icon library — icon “star-2”')).toBeInTheDocument()
    expect(within(fields[2]!).getByText('Background by card position — card no. 1')).toBeInTheDocument()
    expect(within(fields[3]!).getByText('Cabinet navigation — item 3, “Plans”')).toBeInTheDocument()
    expect(
      within(fields[3]!).getByText(i18n.t('brandingPage.deliveryNotice.entryReasons.duplicate-destination-id')),
    ).toBeInTheDocument()
    // No plan entry, no plan list: the page asks only for the report.
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/admin/settings/branding/delivery'])
  })

  it.skipIf(!existsSync(REIWA_PORT))('reads the entry of every field the cabinet takes entry by entry', () => {
    // reiwa's list, from the sibling checkout when it is there (CI has none).
    const declared = /export const PUBLIC_CONFIG_KEYED_FIELDS: readonly string\[\] = \[([\s\S]*?)\];/.exec(
      readFileSync(REIWA_PORT, 'utf8'),
    )
    const fields = [...(declared?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '')
    expect(fields.length, 'PUBLIC_CONFIG_KEYED_FIELDS moved in reiwa — point this test at it').toBeGreaterThan(0)
    for (const field of fields) {
      const entry = brandingDeliveryEntryOf(`${field}.key`) ?? brandingDeliveryEntryOf(`${field}[0]`)
      expect(entry, `${field}: a refused entry of it would be named as the whole field`).not.toBeNull()
    }
  })

  it.each(['en', 'ru'])('has every word it can print in %s', async (language) => {
    await i18n.changeLanguage(language)
    await loadFeatureBundle('branding')
    const says = (key: string, values: Record<string, unknown> = {}): void => {
      expect(i18n.t(key, values), `${key} does not resolve`).not.toBe(key)
    }
    for (const reason of BRANDING_DELIVERY_ENTRY_REASONS) says(`brandingPage.deliveryNotice.entryReasons.${reason}`)
    for (const key of ['plan', 'planById', 'icon', 'customIcon', 'customIconAt', 'cardSlot', 'navItem', 'navItemAt']) {
      says(`brandingPage.deliveryNotice.entries.${key}`, { name: 'n', id: 'i', position: 1 })
    }
    await i18n.changeLanguage('en')
  })
})
