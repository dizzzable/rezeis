/**
 * «Название» on «Страница подписки» → «Основное» may be left empty, and empty
 * means "the brand".
 *
 * The editor was loaded with the config the page is SERVED, whose title the
 * panel fills with the brand while none is saved. So the field showed the
 * brand as if somebody had typed it, and the first «Сохранить» on any of these
 * tabs stored it for good: a later brand rename never reached the customer's
 * page again.
 *
 * Now the field shows only a title somebody SAVED, offers the brand as its
 * placeholder and says so, and saves an empty field as empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import SubpageConfigPage from '@/features/subpage-config/subpage-config-page'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))
// The cabinet-screen tab and its switch read APIs of their own; neither has
// anything to do with the external page's title.
vi.mock('@/features/connect-page/connect-page-editor', () => ({ ConnectPageEditor: () => null }))
vi.mock('@/features/subpage-config/connect-screen-card', () => ({ ConnectScreenCard: () => null }))

function configWithTitle(title: string): Record<string, unknown> {
  return {
    version: '1',
    locales: ['en', 'ru'],
    brandingSettings: { title, logoUrl: '', supportUrl: 'https://t.me/' },
    uiConfig: { subscriptionInfoBlockType: 'cards', installationGuidesBlockType: 'accordion' },
    baseSettings: {
      metaTitle: 'Subscription',
      metaDescription: 'Subscription',
      showConnectionKeys: false,
      hideGetLinkButton: false,
    },
    baseTranslations: {},
    svgLibrary: {},
    platforms: {},
  }
}

/** `GET /admin/subpage-config` as the panel answers it. */
function mockEditorView(title: string, stored: boolean): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/subpage-config') {
      return { data: { config: configWithTitle(title), stored, titleFallback: 'Acme VPN' } }
    }
    return { data: {} }
  })
}

async function openGeneralTab(): Promise<ReturnType<typeof userEvent.setup>> {
  renderWithProviders(<SubpageConfigPage />)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('tab', { name: 'General' }))
  return user
}

beforeEach(async () => {
  await loadFeatureBundle('subpageConfig')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the subscription page title in the editor', () => {
  it('is empty when none was saved, and says the brand heads the page instead', async () => {
    mockEditorView('', false)
    await openGeneralTab()

    const field = (await screen.findByLabelText('Name')) as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('Acme VPN')
    expect(screen.getByText(/your brand \(currently “Acme VPN”\)/)).toBeInTheDocument()
  })

  it('saves with the title left empty', async () => {
    mockEditorView('', false)
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: { config: configWithTitle('') } })
    const user = await openGeneralTab()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1)
    })
    expect(put.mock.calls[0]?.[0]).toBe('/admin/subpage-config')
    expect(put.mock.calls[0]?.[1]).toMatchObject({ config: { brandingSettings: { title: '' } } })
  })

  it('shows and keeps a title that was saved', async () => {
    mockEditorView('Acme Premium', true)
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: { config: configWithTitle('Acme Premium') } })
    const user = await openGeneralTab()

    expect(((await screen.findByLabelText('Name')) as HTMLInputElement).value).toBe('Acme Premium')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1)
    })
    expect(put.mock.calls[0]?.[1]).toMatchObject({ config: { brandingSettings: { title: 'Acme Premium' } } })
  })
})
