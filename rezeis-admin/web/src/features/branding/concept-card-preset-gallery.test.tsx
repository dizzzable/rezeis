import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'

import { ConceptCardPresetGallery } from './concept-card-preset-gallery'
import { CONCEPT_CARD_PRESETS } from './concept-card-presets'

describe('ConceptCardPresetGallery', () => {
  it('renders a progressive accessible page without mounting animated canvases', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ConceptCardPresetGallery onApply={vi.fn()} />)

    expect(
      screen.getByRole('searchbox', {
        name: 'Search concept subscription cards',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Filter by visual family' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Filter by animation effect' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(19)
    expect(screen.getByText('18 of 104 cards')).toBeInTheDocument()
    expect(document.querySelector('canvas')).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Show more cards' }),
    )
    expect(screen.getAllByRole('button')).toHaveLength(37)
    expect(screen.getByText('36 of 104 cards')).toBeInTheDocument()
  })

  it('searches, filters and applies only the selected card visual', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn()
    const polarRed = CONCEPT_CARD_PRESETS.find(
      (preset) => preset.name === 'Polar Red Monolith',
    )
    expect(polarRed).toBeDefined()

    renderWithProviders(
      <ConceptCardPresetGallery
        onApply={onApply}
        presets={CONCEPT_CARD_PRESETS}
      />,
    )

    await user.type(
      screen.getByRole('searchbox', {
        name: 'Search concept subscription cards',
      }),
      'Polar Red Monolith',
    )

    const applyButton = screen.getByRole('button', {
      name: new RegExp(`Apply ${polarRed?.code} Polar Red Monolith`),
    })
    expect(screen.getAllByRole('button')).toHaveLength(1)
    await user.click(applyButton)

    expect(applyButton).toHaveAttribute('aria-pressed', 'true')
    expect(onApply).toHaveBeenCalledOnce()
    expect(onApply).toHaveBeenCalledWith(
      polarRed,
      expect.objectContaining({
        cardGradient: polarRed?.cardGradient,
        cardPattern: polarRed?.cardPattern,
        cardEffect: polarRed?.cardEffect,
        cardEffectProps: polarRed?.cardEffectProps,
        cardEffectOpacity: polarRed?.cardEffectOpacity,
      }),
    )
    const patch = onApply.mock.calls[0]?.[1] as Record<string, unknown>
    expect(Object.keys(patch)).toHaveLength(5)
  })

  it('shows a useful empty state for incompatible combined filters', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ConceptCardPresetGallery onApply={vi.fn()} />)

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by visual family' }),
      'editorial',
    )
    await user.type(
      screen.getByRole('searchbox', {
        name: 'Search concept subscription cards',
      }),
      'definitely-not-a-concept',
    )

    expect(
      screen.getByText('No concept cards match these filters.'),
    ).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
