import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import PanelBrandingTab from './panel-branding-tab'

/**
 * «Panel settings → Customization → Remnawave profile naming».
 *
 * The three fields are glued into a Remnawave username, which the panel only
 * accepts as `^[A-Za-z0-9_-]+$`. A prefix like «my shop» used to be saved
 * without a word, and from then on every new subscription failed to get a
 * profile. The form now refuses it at the field, in words, before anything is
 * sent — and says so when such a value is ALREADY stored.
 */

interface StoredNaming {
  readonly prefix?: string
  readonly separator?: string
  readonly suffixBase?: string
}

function serve(profileNaming: StoredNaming) {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      branding: {
        projectName: 'Rezeis Admin',
        logoUrl: '',
        adminPwaIconUrl: null,
        profileNaming,
      },
    },
  })
  return vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
}

const VALID: StoredNaming = { prefix: 'rz', separator: '_', suffixBase: 'sub' }

describe('PanelBrandingTab — Remnawave profile naming', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('refuses a prefix with a space, says what is allowed, and sends nothing', async () => {
    const user = userEvent.setup()
    const patch = serve(VALID)
    renderWithProviders(<PanelBrandingTab />)

    const prefix = await screen.findByLabelText('Prefix')
    await user.clear(prefix)
    await user.type(prefix, 'my shop')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // On the field itself — its accessible description — not merely somewhere on the page.
    await waitFor(() =>
      expect(prefix).toHaveAccessibleDescription(
        /Prefix: 1 to 16 characters — Latin letters, digits, _ and -/,
      ),
    )
    expect(patch).not.toHaveBeenCalled()
  })

  it('refuses a separator outside the alphabet and an empty suffix', async () => {
    const user = userEvent.setup()
    const patch = serve(VALID)
    renderWithProviders(<PanelBrandingTab />)

    const separator = await screen.findByLabelText('Separator')
    await user.clear(separator)
    await user.type(separator, '.')
    await user.clear(screen.getByLabelText('Subscription suffix'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(separator).toHaveAccessibleDescription(/Separator: 1 or 2 characters/),
    )
    expect(screen.getByLabelText('Subscription suffix')).toHaveAccessibleDescription(
      /Subscription suffix: 1 to 32 characters/,
    )
    expect(patch).not.toHaveBeenCalled()
  })

  it('warns about an invalid value that is ALREADY stored and shows the name new profiles get meanwhile', async () => {
    serve({ prefix: 'my shop', separator: '_', suffixBase: 'sub' })
    renderWithProviders(<PanelBrandingTab />)

    const warning = await screen.findByRole('alert')
    expect(warning).toHaveTextContent('characters Remnawave does not accept')
    expect(warning).toHaveTextContent('my_shop_john_sub')
  })

  it('shows no warning for valid stored naming', async () => {
    serve(VALID)
    renderWithProviders(<PanelBrandingTab />)

    await screen.findByLabelText('Prefix')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('saves valid naming exactly as typed', async () => {
    const user = userEvent.setup()
    const patch = serve(VALID)
    renderWithProviders(<PanelBrandingTab />)

    const prefix = await screen.findByLabelText('Prefix')
    await user.clear(prefix)
    await user.type(prefix, 'my-shop_2')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch.mock.calls[0]?.[0]).toBe('/admin/settings/branding')
    expect((patch.mock.calls[0]?.[1] as { profileNaming?: unknown }).profileNaming).toEqual({
      prefix: 'my-shop_2',
      separator: '_',
      suffixBase: 'sub',
    })
  })

  // ── The save gate is LOUD ──────────────────────────────────────────────────
  //
  // One «Save» covers the whole tab, so an invalid naming value also stops the
  // panel name and the logo from saving. Five silent gates have already been
  // found in this very save; this one has to say, at the button, which field
  // and why, and take the operator to it.

  it('pressing Save with an invalid naming field scrolls to it, focuses it and says at the button what is wrong', async () => {
    const user = userEvent.setup()
    const patch = serve(VALID)
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    renderWithProviders(<PanelBrandingTab />)

    const prefix = await screen.findByLabelText('Prefix')
    await user.clear(prefix)
    await user.type(prefix, 'my shop')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const summary = await screen.findByRole('alert', { name: 'Nothing was saved' })
    expect(summary).toHaveTextContent('Prefix: 1 to 16 characters — Latin letters, digits, _ and -')
    await waitFor(() => expect(prefix).toHaveFocus())
    expect(scroll.mock.contexts).toContain(prefix)
    expect(patch).not.toHaveBeenCalled()
  })

  it('a stored invalid value stops the panel name from saving too — and says so instead of doing nothing', async () => {
    const user = userEvent.setup()
    const patch = serve({ prefix: 'my shop', separator: '_', suffixBase: 'sub' })
    renderWithProviders(<PanelBrandingTab />)

    const panelName = await screen.findByLabelText('Panel name')
    await user.clear(panelName)
    await user.type(panelName, 'My panel')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const summary = await screen.findByRole('alert', { name: 'Nothing was saved' })
    expect(summary).toHaveTextContent('Prefix: 1 to 16 characters')
    await waitFor(() => expect(screen.getByLabelText('Prefix')).toHaveFocus())
    expect(patch).not.toHaveBeenCalled()
  })

  it('a 400 from the server that names a naming field lands on that field, in words, not as a generic failure', async () => {
    const user = userEvent.setup()
    const patch = serve(VALID)
    patch.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 400'), {
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            statusCode: 400,
            message: [
              'profileNaming.prefix must be 1-16 characters: Latin letters, digits, "_" and "-". Remnawave accepts nothing else in a username.',
            ],
            error: 'Bad Request',
          },
        },
      }),
    )
    renderWithProviders(<PanelBrandingTab />)

    const prefix = await screen.findByLabelText('Prefix')
    await user.clear(prefix)
    await user.type(prefix, 'shop')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const summary = await screen.findByRole('alert', { name: 'Nothing was saved' })
    expect(summary).toHaveTextContent('Prefix: 1 to 16 characters — Latin letters, digits, _ and -')
    expect(summary).not.toHaveTextContent('Failed to save settings')
    await waitFor(() => expect(prefix).toHaveFocus())
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it('a 400 the form does not recognise is shown in the server\'s own words', async () => {
    const user = userEvent.setup()
    const patch = serve(VALID)
    patch.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 400'), {
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            statusCode: 400,
            message: ['brandName must be shorter than or equal to 64 characters'],
            error: 'Bad Request',
          },
        },
      }),
    )
    renderWithProviders(<PanelBrandingTab />)

    await screen.findByLabelText('Prefix')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const summary = await screen.findByRole('alert', { name: 'Nothing was saved' })
    expect(summary).toHaveTextContent('brandName must be shorter than or equal to 64 characters')
  })

  it('tells the operator which identity names a new profile and that existing profiles keep their names', async () => {
    serve(VALID)
    renderWithProviders(<PanelBrandingTab />)

    expect(
      await screen.findByText(
        /Telegram @username, as Telegram reported it at their last \/start or Mini App sign-in, when Telegram is linked and has one; otherwise their web login; otherwise their Telegram ID/,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/Profiles that already exist keep their names/)).toBeInTheDocument()
  })

  // ── Only what is true: a save nobody answered may have gone through ────────

  /** A failed PATCH as axios delivers it: `status` absent means no answer arrived at all. */
  function failedSave(status: number | null, message?: string) {
    return Object.assign(new Error(status === null ? 'Network Error' : `Request failed with status code ${status}`), {
      isAxiosError: true,
      ...(status === null
        ? { code: 'ERR_NETWORK' }
        : { response: { status, data: message === undefined ? {} : { statusCode: status, message } } }),
    })
  }

  for (const [label, status] of [
    ['a 408 — the panel\'s 30-second cut, after which the handler goes on and commits', 408],
    ['no answer at all', null],
    ['a 502', 502],
    ['a 500', 500],
  ] as const) {
    it(`${label}: says the save may have gone through and to reload and check — not «Nothing was saved»`, async () => {
      const user = userEvent.setup()
      const patch = serve(VALID)
      patch.mockRejectedValueOnce(failedSave(status))
      renderWithProviders(<PanelBrandingTab />)

      await screen.findByLabelText('Prefix')
      await user.click(screen.getByRole('button', { name: 'Save' }))

      const notice = await screen.findByRole('alert', { name: 'The save was not confirmed' })
      expect(notice).toHaveTextContent(/they may have been\. Reload the page and check the fields/)
      expect(screen.queryByRole('alert', { name: 'Nothing was saved' })).not.toBeInTheDocument()
      expect(screen.queryByText(/Fix the field above/)).not.toBeInTheDocument()
    })
  }

  it('a refusal that names no field says nothing was saved, in the server\'s words, without sending the operator to a field', async () => {
    const user = userEvent.setup()
    const patch = serve(VALID)
    patch.mockRejectedValueOnce(failedSave(403, 'Forbidden resource'))
    renderWithProviders(<PanelBrandingTab />)

    await screen.findByLabelText('Prefix')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const summary = await screen.findByRole('alert', { name: 'Nothing was saved' })
    expect(summary).toHaveTextContent('Forbidden resource')
    expect(summary).not.toHaveTextContent(/Fix the field above/)
    expect(summary).toHaveTextContent(/none of your other changes here were saved either/)
  })

  it('the verdict of a failed save is gone once the next press of Save succeeds', async () => {
    const user = userEvent.setup()
    const patch = serve(VALID)
    patch.mockRejectedValueOnce(failedSave(400, 'brandName must be shorter than or equal to 64 characters'))
    renderWithProviders(<PanelBrandingTab />)

    await screen.findByLabelText('Prefix')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert', { name: 'Nothing was saved' })

    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByRole('alert', { name: 'Nothing was saved' })).not.toBeInTheDocument(),
    )
  })
})
