/**
 * «Правила вывода» → «Минимальная сумма вывода (копейки)», now that the panel
 * enforces it.
 *
 * For years the field was stored and never applied, under a hint promising a
 * default of 500 ₽ that did not exist anywhere: nothing wrote it and nothing
 * read it. The withdraw route now refuses below the stored value, so two
 * things about this form stop being harmless:
 *
 *   • THE HINT. An empty field means no minimum at all, and the hint says so.
 *   • CLEARING. An empty field used to be OMITTED from the save, which left the
 *     stored value in place — a minimum could be set but never removed. It is
 *     now sent as an explicit `null`, asserted on the body after JSON
 *     serialisation, because "omitted" and "null" are different requests and
 *     only the wire says which one went out.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18nReady } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import PartnerSettingsPage from './partner-settings-page'

const LABEL = 'Minimum withdrawal amount (kopecks)'
const EMPTY_HINT = 'Empty — no minimum: a partner can withdraw any amount'

beforeAll(async () => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto['hasPointerCapture'] ??= () => false
  proto['setPointerCapture'] ??= () => {}
  proto['releasePointerCapture'] ??= () => {}
  proto['scrollIntoView'] ??= () => {}
  await i18nReady
})

beforeEach(() => {
  vi.restoreAllMocks()
})

type Json = Record<string, unknown>

async function mount(partnerSettings: Json) {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { partnerSettings: { enabled: true, accrualStrategy: 'ON_EACH_PAYMENT', ...partnerSettings } },
  })
  vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
  renderWithProviders(<PartnerSettingsPage />)
  const user = userEvent.setup()
  await screen.findByText('Accrual mode per level')
  return user
}

/** Saves, and returns the body as it goes over the wire. */
async function save(user: ReturnType<typeof userEvent.setup>): Promise<Json> {
  await user.click(screen.getByRole('button', { name: 'Save' }))
  const patch = api.patch as unknown as ReturnType<typeof vi.fn>
  await vi.waitFor(() => expect(patch).toHaveBeenCalled())
  const [url, body] = patch.mock.calls[0] as [string, Json]
  expect(url).toBe('/admin/settings/partner')
  return JSON.parse(JSON.stringify(body)) as Json
}

describe('the minimum withdrawal field', () => {
  it('says an empty field is no minimum — not a 500 ₽ default nobody applies', async () => {
    await mount({})

    expect((screen.getByLabelText(LABEL) as HTMLInputElement).value).toBe('')
    expect(screen.getByText(EMPTY_HINT)).toBeInTheDocument()
    expect(screen.queryByText(/500 ₽/)).toBeNull()
  })

  it('clearing a stored minimum sends an explicit null, so it is really removed', async () => {
    const user = await mount({ minWithdrawalAmount: 30_700 })
    const field = screen.getByLabelText(LABEL) as HTMLInputElement
    expect(field.value).toBe('30700')

    await user.clear(field)
    expect(screen.getByText(EMPTY_HINT)).toBeInTheDocument()
    const body = await save(user)

    expect('minWithdrawalAmount' in body, 'the key was omitted, so the stored minimum stays').toBe(true)
    expect(body['minWithdrawalAmount']).toBeNull()
  })

  it('a typed minimum is sent as the whole number of kopecks', async () => {
    const user = await mount({})
    const field = screen.getByLabelText(LABEL) as HTMLInputElement

    await user.type(field, '45600')
    const body = await save(user)

    expect(body['minWithdrawalAmount']).toBe(45_600)
  })
})
