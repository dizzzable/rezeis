import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { publishTariffConstructor, saveTariffConstructorDraft, tariffConstructorOptions, toggleTariffConstructor } from './tariff-constructor-api'

afterEach(() => vi.restoreAllMocks())

describe('tariff constructor API', () => {
  it('uses the singleton endpoints and sends amounts unchanged', async () => {
    const draft = { basePlanId: 'plan-1', durations: [{ days: 30, currency: 'USD', baseAmount: '10.00' }], modules: [{ type: 'TRAFFIC' as const, minValue: 1, maxValue: 1, defaultValue: 1, step: 1, prices: [{ days: 30, currency: 'USD', perStepAmount: '0.00' }] }, { type: 'DEVICES' as const, minValue: 1, maxValue: 1, defaultValue: 1, step: 1, prices: [{ days: 30, currency: 'USD', perStepAmount: '0.00' }] }] }
    vi.spyOn(api, 'put').mockResolvedValue({ data: draft })
    vi.spyOn(api, 'post').mockResolvedValue({ data: {} })

    await saveTariffConstructorDraft(draft)
    await publishTariffConstructor()
    await toggleTariffConstructor(true)

    expect(api.put).toHaveBeenNthCalledWith(1, '/admin/tariff-constructors/default/draft', draft)
    expect(api.post).toHaveBeenCalledWith('/admin/tariff-constructors/default/publish')
    expect(api.put).toHaveBeenNthCalledWith(2, '/admin/tariff-constructors/default/enabled', { enabled: true })
  })

  it('queries the default constructor', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { id: 'constructor-1' } })
    const queryFn = tariffConstructorOptions().queryFn
    expect(queryFn).toBeDefined()
    await queryFn!({ signal: new AbortController().signal } as never)
    expect(api.get).toHaveBeenCalledWith('/admin/tariff-constructors/default', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
})
