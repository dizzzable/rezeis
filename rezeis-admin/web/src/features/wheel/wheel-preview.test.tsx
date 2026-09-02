import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { WheelPreview } from './wheel-preview'
import type { WheelSector } from './wheel-config-api'

/**
 * The operator's diagram of the wheel.
 *
 * What is worth pinning is that the picture cannot disagree with the numbers:
 * a sector nobody can land on must not appear on it, and a slice's size must
 * follow its weight rather than its position in the list. Both are the kind of
 * thing that looks fine on the two examples somebody tries by hand.
 */
function sector(overrides: Partial<WheelSector> & { id: string }): WheelSector {
  return {
    kind: 'POINTS',
    title: { ru: overrides.id },
    iconKind: 'PRESET',
    iconRef: '',
    rarity: 'COMMON',
    weight: 10,
    amount: 1,
    promoRewardType: null,
    promoPlanId: null,
    promoPlanIds: [],
    promoLifetime: null,
    keyPoolId: null,
    manualInstructions: null,
    maxWinsPerUser: null,
    maxWinsTotal: null,
    wonCount: 0,
    order: 0,
    enabled: true,
    chancePercent: 0,
    keysAvailable: null,
    ...overrides,
  }
}

/** Every `<path>` the diagram drew, as its `d` attribute. */
function slicePaths(container: HTMLElement): string[] {
  return [...container.querySelectorAll('path')].map((path) => path.getAttribute('d') ?? '')
}

describe('the wheel preview', () => {
  it('says so when there is nothing to draw', () => {
    render(<WheelPreview sectors={[]} />)

    // Rendered outside an i18n provider, so `t()` echoes the key — which is
    // the assertion that survives a copy change.
    expect(screen.getByText('wheelConfigPage.preview.empty')).toBeInTheDocument()
  })

  it('leaves out sectors nobody can land on', () => {
    // Disabled and zero-weight sectors are absent from the draw, so a diagram
    // that showed them would promise a wheel that does not exist.
    const { container } = render(
      <WheelPreview
        sectors={[
          sector({ id: 'a', weight: 50, chancePercent: 100 }),
          sector({ id: 'b', weight: 50, enabled: false }),
          sector({ id: 'c', weight: 0 }),
        ]}
      />,
    )

    // One drawable sector is a full circle, not an arc: an arc whose start and
    // end coincide collapses to nothing at all.
    expect(slicePaths(container)).toHaveLength(0)
    expect(container.querySelectorAll('circle').length).toBeGreaterThan(0)
    expect(screen.getByText('100 %')).toBeInTheDocument()
  })

  it('draws one slice per drawable sector', () => {
    const { container } = render(
      <WheelPreview
        sectors={[
          sector({ id: 'a', weight: 70, chancePercent: 70 }),
          sector({ id: 'b', weight: 25, chancePercent: 25 }),
          sector({ id: 'c', weight: 5, chancePercent: 5 }),
        ]}
      />,
    )

    expect(slicePaths(container)).toHaveLength(3)
  })

  it('sizes a slice by its weight, not by its place in the list', () => {
    // A big sector uses the large-arc flag; a small one does not. That flag is
    // the one part of the path that says, in the markup, how wide the slice is.
    const { container } = render(
      <WheelPreview
        sectors={[
          sector({ id: 'big', weight: 80, chancePercent: 80 }),
          sector({ id: 'small', weight: 20, chancePercent: 20 }),
        ]}
      />,
    )

    const [big, small] = slicePaths(container)
    expect(big).toMatch(/A .* 1 1 /) // large-arc = 1: more than half the wheel
    expect(small).toMatch(/A .* 0 1 /) // large-arc = 0
  })

  it('labels a slice with room for it and leaves a sliver bare', () => {
    // A label that does not fit overlaps its neighbours and makes the whole
    // diagram unreadable.
    render(
      <WheelPreview
        sectors={[
          sector({ id: 'wide', weight: 99, chancePercent: 99 }),
          sector({ id: 'sliver', weight: 1, chancePercent: 1 }),
        ]}
      />,
    )

    expect(screen.getByText('99 %')).toBeInTheDocument()
    expect(screen.queryByText('1.0 %')).not.toBeInTheDocument()
  })

  it('paints by rarity, so the table and the diagram agree', () => {
    const { container } = render(
      <WheelPreview
        sectors={[
          sector({ id: 'gold', weight: 50, rarity: 'LEGENDARY', chancePercent: 50 }),
          sector({ id: 'grey', weight: 50, rarity: 'COMMON', chancePercent: 50 }),
        ]}
      />,
    )

    const fills = [...container.querySelectorAll('path')].map((path) => path.getAttribute('fill'))
    expect(fills).toEqual(['#fbbf24', '#94a3b8'])
  })
})
