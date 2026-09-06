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
