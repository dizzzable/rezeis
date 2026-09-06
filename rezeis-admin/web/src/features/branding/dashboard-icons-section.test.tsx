import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'

import { renderWithProviders } from '@/test/test-utils'
import { DashboardIconsSection } from './dashboard-icons-section'
import type { BrandingIconDecorDraft } from './branding-form-schema'

/**
 * The dashboard-icon block.
 *
 * The property worth guarding is not which button paints which colour — it is
 * that an icon returned to its defaults leaves NOTHING behind. A stored `{}`
 * reads as "configured" to every later reader: the form comes up dirty, the
 * cabinet's own reader keeps a key that means nothing, and an operator has no
 * way to see the difference between "reset" and "never touched".
 */

function Harness({ initial = {} }: { initial?: Record<string, BrandingIconDecorDraft> }) {
  const [decor, setDecor] = useState<Record<string, BrandingIconDecorDraft>>(initial)
  return (
    <>
      <DashboardIconsSection decor={decor} onChange={setDecor} />
      <output data-testid="state">{JSON.stringify(decor)}</output>
    </>
  )
}

function state(): Record<string, BrandingIconDecorDraft> {
  return JSON.parse(screen.getByTestId('state').textContent ?? '{}')
}

/**
 * The live preview beside each icon.
 *
 * WHY IT IS ASSERTED HERE. Before this, the section named the effect in words
 * and showed a still glyph — an operator picked "Iridescence" and had no way to
 * see it without opening the cabinet. The preview is the whole answer to that,
 * so the thing worth guarding is that the effect actually reaches the DOM: a
 * wrapper with no class renders exactly like the old still glyph, and nothing
 * else on screen would say so.
 *
 * The colour assertions mirror a rule the cabinet learned the hard way: the
 * class goes on the WRAPPER and the colour on the GLYPH, because a class on a
 * child sets `color` and beats an inline style on its parent. A preview that
 * tinted the wrapper would look right here and do nothing in the cabinet —
 * which is the exact failure this preview exists to make impossible.
 */
describe('DashboardIconsSection live preview', () => {
  /** The wrapper the effect class rides on, for one icon row. */
  function previewWrapper(iconLabel: RegExp): HTMLElement {
    const heading = screen.getByText(iconLabel)
    const row = heading.closest('div.rounded-lg')
    expect(row, 'the icon row moved — this selector no longer finds it').not.toBeNull()
    const wrapper = row?.querySelector('span.relative.inline-flex')
    expect(wrapper, 'no preview wrapper in the row').not.toBeNull()
    return wrapper as HTMLElement
  }

  it('shows a still glyph while no effect is chosen', () => {
    renderWithProviders(<Harness />)
    expect(previewWrapper(/Задания|Quests/).className).not.toContain('icon-effect')
  })

  it.each([
    ['pulse', 'icon-effect-pulse'],
    ['shake', 'icon-effect-shake'],
    ['glow', 'icon-effect-glow'],
    ['glint', 'icon-effect-glint'],
    ['iridescent', 'icon-effect-iridescent'],
  ])('runs the %s effect on the preview', (effect, className) => {
    renderWithProviders(<Harness initial={{ quests: { effect } }} />)
    expect(previewWrapper(/Задания|Quests/).className).toContain(className)
  })

  it('hands the colour to the glyph and the variable to the wrapper', () => {
    renderWithProviders(<Harness initial={{ quests: { effect: 'glow', color: '#ff0055' } }} />)
    const wrapper = previewWrapper(/Задания|Quests/)
    // The halo is a pseudo-element; a CSS variable is the only way to reach it.
    expect(wrapper.getAttribute('style')).toContain('--icon-effect-color')
    const svg = wrapper.querySelector('svg')
    expect(svg?.style.color).toBe('rgb(255, 0, 85)')
  })

  it('decorates only the icon it was told to', () => {
    renderWithProviders(<Harness initial={{ quests: { effect: 'pulse' } }} />)
    expect(previewWrapper(/Колесо|Wheel/).className).not.toContain('icon-effect')
  })

  it('previews nothing for an effect this build does not know', () => {
    // The panel can be older than the settings in front of it after a
    // rollback. An unknown name must leave a plain glyph, not an undefined
    // class name in the DOM.
    renderWithProviders(<Harness initial={{ quests: { effect: 'supernova' } }} />)
    const className = previewWrapper(/Задания|Quests/).className
    expect(className).not.toContain('icon-effect')
    expect(className).not.toContain('undefined')
  })
})

describe('DashboardIconsSection', () => {
  it('stores nothing until the operator touches something', () => {
    renderWithProviders(<Harness />)
    expect(state()).toEqual({})
  })

  it('records a picked glyph under that icon alone', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness />)
    await user.click(screen.getAllByRole('button', { name: /Gift/i })[0])
    expect(state()).toEqual({ quests: { glyph: 'gift' } })
  })

  it('drops the field again when the operator picks the shipped glyph', async () => {
    // "As shipped" is an absence, not a value. Storing `glyph: "default"`
    // would pin the icon to today's picture forever — a later cabinet that
    // changes it would be overridden by a choice nobody made.
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={{ quests: { glyph: 'gift' } }} />)
    await user.click(screen.getAllByRole('button', { name: /As shipped/i })[0])
    expect(state()).toEqual({})
  })

  it('drops the field again when the operator picks "no effect"', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={{ quests: { effect: 'pulse' } }} />)
    await user.click(screen.getAllByRole('button', { name: /^No effect$/i })[0])
    expect(state()).toEqual({})
  })

  it('keeps the other fields when one is cleared', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={{ quests: { glyph: 'gift', effect: 'pulse' } }} />)
    await user.click(screen.getAllByRole('button', { name: /^No effect$/i })[0])
    expect(state()).toEqual({ quests: { glyph: 'gift' } })
  })

  it('offers no reset while nothing is configured', () => {
    renderWithProviders(<Harness />)
    expect(screen.queryByRole('button', { name: /^Reset$/i })).toBeNull()
  })

  it('offers a reset on the one icon that carries something', () => {
    renderWithProviders(<Harness initial={{ quests: { effect: 'glow' } }} />)
    expect(screen.getAllByRole('button', { name: /^Reset$/i })).toHaveLength(1)
  })

  it('removes the whole entry on reset', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Harness initial={{ quests: { glyph: 'gift', effect: 'pulse', color: '#ff0055' } }} />,
    )
    await user.click(screen.getByRole('button', { name: /^Reset$/i }))
    expect(state()).toEqual({})
  })

  it('leaves the other icons alone when one is reset', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Harness initial={{ quests: { effect: 'pulse' }, bell: { effect: 'glow' } }} />,
    )
    const resets = screen.getAllByRole('button', { name: /^Reset$/i })
    await user.click(resets[0])
    expect(state()).toEqual({ bell: { effect: 'glow' } })
  })

  it('names every dashboard icon the cabinet renders', () => {
    renderWithProviders(<Harness />)
    for (const label of ['Quests', 'Wheel', 'Notifications', 'Buy', 'Promo code']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('gives every glyph button an accessible name', () => {
    // The picker is fifteen unlabelled squares otherwise — the same defect
    // the connect-page editor's localized fields had.
    renderWithProviders(<Harness />)
    expect(screen.getAllByRole('button', { name: /Sparkles/i }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /Trophy/i }).length).toBeGreaterThan(0)
  })
})
