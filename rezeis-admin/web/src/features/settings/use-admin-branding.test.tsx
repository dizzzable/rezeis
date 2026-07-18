import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/test-utils'
import { api } from '@/lib/api'

import { useAdminBranding } from './use-admin-branding'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn() },
}))

function Probe() {
  const branding = useAdminBranding()
  return <output>{JSON.stringify(branding)}</output>
}

describe('useAdminBranding', () => {
  it('reads the branding field from the admin settings overview', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        branding: {
          brandName: 'Node Access',
          logoUrl: '/uploads/branding/logo.webp',
          adminPwaIconUrl: '/uploads/branding/icon.webp',
        },
      },
    })

    renderWithProviders(<Probe />, { withRouter: false })

    expect(await screen.findByText(/Node Access/)).toHaveTextContent('/uploads/branding/logo.webp')
  })
})
