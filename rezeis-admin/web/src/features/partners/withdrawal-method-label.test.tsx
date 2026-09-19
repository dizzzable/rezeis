/**
 * «Выплаты партнёрам» names a withdrawal's payout method in words.
 *
 * The cabinet's withdrawal dialog sends one of four codes as `method` — `card`,
 * `sbp`, `crypto`, `other` — and the operator used to read exactly that code in
 * the «Метод» column. The operator pays by hand from this table, so the column
 * says «Банковская карта / СБП / Криптовалюта / Другой способ» (and the English
 * equivalents), while anything this panel does not know — a donor system's
 * value, a future cabinet's — is shown exactly as it came, never guessed at.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'

import { coreDictionaryReady, i18n, i18nReady } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { withdrawalMethodLabel } from './partner-formatters'
import PartnersWithdrawalsTab from './partners-withdrawals-tab'
import { partnersAdminApi, type PartnerWithdrawal } from './partners-api'

beforeAll(async () => {
  await i18nReady
  // Both core dictionaries in the store, whichever language the run starts in.
  await coreDictionaryReady('ru')
  await coreDictionaryReady('en')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await i18n.changeLanguage('en')
})

function withdrawal(id: string, method: string): PartnerWithdrawal {
  return {
    id,
    partnerId: 'partner-1',
    amount: 150_050,
    status: 'PENDING',
    method,
    requisites: '2200 1234 5678 9012',
    adminComment: null,
    processedBy: null,
    processedAt: null,
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: '2026-09-19T10:00:00.000Z',
    partner: {
      id: 'partner-1',
      isActive: true,
      user: { id: 'user-1', name: `Partner ${id}`, username: null, telegramId: '424242' },
    },
  }
}

describe('withdrawalMethodLabel', () => {
  it('names the four methods the cabinet sends, in Russian and in English', async () => {
    await i18n.changeLanguage('ru')
    const ru = i18n.getFixedT('ru')
    expect(['card', 'sbp', 'crypto', 'other'].map((method) => withdrawalMethodLabel(method, ru))).toEqual([
      'Банковская карта',
      'СБП',
      'Криптовалюта',
      'Другой способ',
    ])
    const en = i18n.getFixedT('en')
    expect(['card', 'sbp', 'crypto', 'other'].map((method) => withdrawalMethodLabel(method, en))).toEqual([
      'Bank card',
      'SBP (Faster Payments)',
      'Cryptocurrency',
      'Another method',
    ])
  })

  it('shows a value it does not know as it came, and nothing as a dash', () => {
    const en = i18n.getFixedT('en')
    expect(withdrawalMethodLabel('tron-usdt', en)).toBe('tron-usdt')
    expect(withdrawalMethodLabel('constructor', en)).toBe('constructor')
    expect(withdrawalMethodLabel('Card', en)).toBe('Card')
    expect(withdrawalMethodLabel('', en)).toBe('—')
    expect(withdrawalMethodLabel(null, en)).toBe('—')
  })
})

describe('«Выплаты партнёрам» — the «Метод» column', () => {
  it('reads «Банковская карта», not `card`, and a donor value as it came', async () => {
    await i18n.changeLanguage('ru')
    vi.spyOn(partnersAdminApi, 'getStats').mockReturnValue(new Promise(() => {}))
    vi.spyOn(partnersAdminApi, 'listWithdrawals').mockResolvedValue([
      withdrawal('a', 'card'),
      withdrawal('b', 'sbp'),
      withdrawal('c', 'tron-usdt'),
    ])

    renderWithProviders(<PartnersWithdrawalsTab />)

    const rows = await screen.findAllByRole('row')
    const bodyRows = rows.filter((row) => within(row).queryByText(/Partner [abc]/) !== null)
    expect(bodyRows).toHaveLength(3)
    const methodCell = (row: HTMLElement, raw: string) =>
      within(row).getAllByRole('cell').find((cell) => cell.getAttribute('title') === raw)
    expect(methodCell(bodyRows[0]!, 'card')?.textContent).toBe('Банковская карта')
    expect(methodCell(bodyRows[1]!, 'sbp')?.textContent).toBe('СБП')
    expect(methodCell(bodyRows[2]!, 'tron-usdt')?.textContent).toBe('tron-usdt')
    // The raw code is not what the operator reads anywhere in the row.
    expect(within(bodyRows[0]!).queryByText('card', { exact: true })).toBeNull()
  })
})
