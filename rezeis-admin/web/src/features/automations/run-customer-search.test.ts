/**
 * The customer search behind «Кому показать».
 *
 * An operator copies a handle as the panel shows it — with the "@" — and the
 * users list matches the bare username it stores, so "@ivan" found nobody.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { customerSearchTerm, searchCustomers } from './run-customer-search'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('customerSearchTerm', () => {
  it('drops a leading "@", and the spaces around it', () => {
    expect(customerSearchTerm('@ivan')).toBe('ivan')
    expect(customerSearchTerm('  @@ivan ')).toBe('ivan')
    expect(customerSearchTerm('@ ivan')).toBe('ivan')
  })

  it('keeps everything else as typed', () => {
    expect(customerSearchTerm('ivan@mail.ru')).toBe('ivan@mail.ru')
    expect(customerSearchTerm('Иван')).toBe('Иван')
    expect(customerSearchTerm('@')).toBe('')
  })
})

describe('searchCustomers', () => {
  it('asks the users list for the handle without its "@", eight rows at a time', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: { items: [], total: 0 } } as never)

    await searchCustomers('@ivan')

    expect(get).toHaveBeenCalledWith('/admin/users', {
      params: { search: 'ivan', limit: 8 },
      signal: undefined,
    })
  })

  it('reads the rows, and an answer without them as nobody', async () => {
    const row = { id: 'cm-1', telegramId: null, username: 'ivan', email: null, name: 'Иван', login: null, isBlocked: false }
    vi.spyOn(api, 'get').mockResolvedValueOnce({ data: { items: [row], total: 1 } } as never)
    await expect(searchCustomers('ivan')).resolves.toEqual([row])

    vi.spyOn(api, 'get').mockResolvedValueOnce({ data: {} } as never)
    await expect(searchCustomers('ivan')).resolves.toEqual([])
  })
})
