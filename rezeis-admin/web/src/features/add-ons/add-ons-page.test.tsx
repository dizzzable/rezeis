import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import AddOnsPage from './add-ons-page'

describe('AddOnsPage accessibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('names dynamic price row controls', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/add-ons') return { data: [] }
      if (path === '/admin/plans') return { data: [] }
      if (path === '/admin/settings/icons') return { data: [] }
      return { data: {} }
    })

    renderWithProviders(<AddOnsPage />)

    await user.click(await screen.findByRole('button', { name: 'Create add-on' }))

    expect(await screen.findByRole('combobox', { name: 'Price 1 currency' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Price 1 amount' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add currency' }))

    expect(screen.getByRole('button', { name: 'Remove price 2' })).toBeInTheDocument()
  })
})
