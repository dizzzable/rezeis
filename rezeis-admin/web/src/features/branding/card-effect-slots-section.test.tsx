import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/test-utils'

import { CardEffectSlotsSection } from './card-effect-slots-section'

describe('CardEffectSlotsSection', () => {
  it('keeps effect inheritance distinct from a per-slot gradient override', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const cardGradient = 'linear-gradient(135deg, #172554, #2563eb)'

    const { rerender } = renderWithProviders(
      <CardEffectSlotsSection
        slots={[{ mode: 'inherit', cardGradient }]}
        onChange={onChange}
      />,
    )

    expect(screen.getByText('Using global effect')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This changes only the animation. A slot gradient stays independent until reset.',
      ),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Customize separately' }))
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        mode: 'override',
        cardGradient,
      }),
    ])

    rerender(
      <CardEffectSlotsSection
        slots={onChange.mock.lastCall?.[0] ?? []}
        onChange={onChange}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Use global' }))
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        mode: 'inherit',
        cardGradient,
      }),
    ])
  })
})
