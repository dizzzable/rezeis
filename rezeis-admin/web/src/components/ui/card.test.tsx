import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Card, CardTitle } from './card'

afterEach(cleanup)

describe('Card concept semantics', () => {
  it('marks the surface and heading for generated concept CSS', () => {
    render(
      <Card data-testid="card">
        <CardTitle>Subscription health</CardTitle>
      </Card>,
    )

    expect(screen.getByTestId('card')).toHaveAttribute(
      'data-concept-surface',
      'card',
    )
    expect(screen.getByText('Subscription health')).toHaveAttribute(
      'data-concept-heading',
      '',
    )
  })
})
