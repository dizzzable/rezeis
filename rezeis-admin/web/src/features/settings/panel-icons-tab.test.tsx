import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/test-utils'
import PanelIconsTab from './panel-icons-tab'
import { getCustomIcons, saveCustomIcons, uploadCustomIconFile } from './custom-icons-api'

vi.mock('./custom-icons-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./custom-icons-api')>()
  return {
    ...actual,
    getCustomIcons: vi.fn(),
    saveCustomIcons: vi.fn(),
    uploadCustomIconFile: vi.fn(),
  }
})

describe('PanelIconsTab accessibility', () => {
  beforeEach(() => {
    vi.mocked(getCustomIcons).mockResolvedValue([])
    vi.mocked(saveCustomIcons).mockResolvedValue([])
    vi.mocked(uploadCustomIconFile).mockResolvedValue('/uploads/icons/icon.svg')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('makes the custom icon upload drop-zone keyboard-operable and named', async () => {
    renderWithProviders(<PanelIconsTab />)

    expect(await screen.findByRole('button', { name: 'Choose icon files' })).toBeInTheDocument()
    expect(screen.getByLabelText('Choose icon files', { selector: 'input' })).toBeInTheDocument()
  })
})
