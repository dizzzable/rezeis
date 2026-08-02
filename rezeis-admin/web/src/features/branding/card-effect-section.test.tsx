import { describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '@/test/test-utils'

import { CARD_EFFECT_REGISTRY } from './card-effect-registry'
import { CardEffectPicker } from './card-effect-section'

describe('CardEffectPicker thumbnails', () => {
  it('shows every effect palette and animates exactly the selected GPU-free tile', () => {
    const { container } = renderWithProviders(
      <CardEffectPicker
        effect="paperWarp"
        props={{ colors: ['#121212', '#9470ff', '#8838ff'], speed: 1 }}
        opacity={0.72}
        onEffectChange={vi.fn()}
        onPropsChange={vi.fn()}
        onOpacityChange={vi.fn()}
      />,
    )

    const thumbnails = Array.from(
      container.querySelectorAll<HTMLElement>('[data-card-effect-thumbnail]'),
    )
    const active = thumbnails.filter(
      (thumbnail) =>
        thumbnail.dataset.cardEffectThumbnailActive === 'true',
    )

    expect(thumbnails).toHaveLength(CARD_EFFECT_REGISTRY.length)
    expect(active).toHaveLength(1)
    expect(active[0]).toHaveClass('card-effect-preview__picker-artwork')
    expect(active[0]?.style.backgroundImage).toContain('linear-gradient')
    for (const thumbnail of thumbnails) {
      expect(thumbnail.style.backgroundImage).not.toBe('')
    }
    expect(container.querySelector('canvas')).not.toBeInTheDocument()
  })
})
