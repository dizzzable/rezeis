import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '@/test/test-utils'
import { TariffConstructorForm } from './tariff-constructor-form'

describe('TariffConstructorForm', () => {
  it('keeps decimal input as a string and submits through its handler', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    const draft = { basePlanId: '', durations: [{ days: 30, currency: 'USD', baseAmount: '' }], modules: [{ type: 'TRAFFIC' as const, minValue: 0, maxValue: 0, defaultValue: 0, step: 1, prices: [{ days: 30, currency: 'USD', perStepAmount: '' }] }, { type: 'DEVICES' as const, minValue: 0, maxValue: 0, defaultValue: 0, step: 1, prices: [{ days: 30, currency: 'USD', perStepAmount: '' }] }] }

    renderWithProviders(<TariffConstructorForm draft={draft} plans={[]} disabled={false} error={null} onChange={onChange} onSubmit={onSubmit} />)
    await user.type(screen.getByRole('textbox', { name: 'Duration 1 base amount' }), '7')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ durations: [expect.objectContaining({ baseAmount: '7' })] }))
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(onSubmit).toHaveBeenCalledOnce()
  })
})
