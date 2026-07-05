import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'
import { Calendar } from './calendar'

/**
 * Regression guard for the month-navigation arrows. A styling change once left
 * the nav chevrons invisible (blank buttons) and the calendar appeared "stuck".
 * These assertions prove the arrows render, are reachable by their accessible
 * name, and actually change the visible month.
 */
describe('Calendar month navigation', () => {
  it('opens on the selected month and switches months via the nav arrows', async () => {
    const user = userEvent.setup()
    // August 2026 (month index 7).
    renderWithProviders(
      <Calendar mode="single" selected={new Date(2026, 7, 13)} defaultMonth={new Date(2026, 7, 13)} />,
    )

    expect(screen.getByText('August 2026')).toBeInTheDocument()

    // Previous-month arrow → July 2026.
    await user.click(screen.getByRole('button', { name: /previous/i }))
    expect(screen.getByText('July 2026')).toBeInTheDocument()

    // Next-month arrow twice → September 2026.
    const next = screen.getByRole('button', { name: /next/i })
    await user.click(next)
    await user.click(next)
    expect(screen.getByText('September 2026')).toBeInTheDocument()
  })
})
