import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '@/test/test-utils'
import { PlanForm } from './plan-form'

describe('PlanForm validation', () => {
  it('blocks invalid plan payloads before submit', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()

    renderWithProviders(<PlanForm onSubmit={onSubmit} isLoading={false} />)

    await user.type(screen.getByPlaceholderText('Premium 50GB'), 'Premium')
    await user.clear(screen.getByDisplayValue('50'))
    await user.click(screen.getByRole('button', { name: 'Create plan' }))

    expect(await screen.findByText('Enter a whole number of GB, or 0 for unlimited.')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('PlanForm accessibility', () => {
  it('names dynamic pricing controls', async () => {
    const user = userEvent.setup()

    renderWithProviders(<PlanForm onSubmit={vi.fn()} isLoading={false} />)

    expect(screen.getByRole('spinbutton', { name: 'Duration 1 days' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Duration 1 price 1 currency' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Duration 1 price 1 amount' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add currency to duration 1' }))
    expect(screen.getByRole('button', { name: 'Remove duration 1 price 2' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add duration' }))
    expect(screen.getByRole('button', { name: 'Remove duration 2' })).toBeInTheDocument()
  })
})
