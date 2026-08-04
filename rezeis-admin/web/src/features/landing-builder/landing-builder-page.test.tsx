/**
 * Regression tests for the landing builder's save/load state machine.
 *
 * Every case here is a way the editor used to lose work that had already been
 * typed, so the fake server below is stateful on purpose: it bumps the version
 * on every stored write and rejects a stale one with a 409, exactly like
 * `AdminLandingConfigController`. A fake that always accepts would let the
 * version bugs pass unnoticed, which is how they shipped.
 */
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router'
import { toast } from 'sonner'

import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import LandingBuilderPage from './landing-builder-page'
import {
  LANDING_BUILDER_KEYS,
  LandingDraftConflictError,
  landingBuilderApi,
  type LandingConfig,
  type LandingDraftResponse,
} from './landing-builder-api'

// A forced sign-out is a 401 → cleared session → `window.location.href`, and
// jsdom cannot perform that navigation. Only the flag the editor reads matters
// here, so it is faked rather than driven through axios; everything else in the
// module (which `lib/api` also imports) stays real.
const session = vi.hoisted(() => ({ forcedLogout: false }))
vi.mock('@/lib/admin-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin-session')>()),
  isForceLogoutInProgress: () => session.forcedLogout,
}))

// The real preview portals into an iframe and mounts the whole vendored landing
// kit; none of that is under test here. The stub keeps the one prop these tests
// care about observable.
vi.mock('./preview/landing-preview', () => ({
  LandingPreview: ({ locale }: { locale: string }) => (
    <div data-testid="preview-locale">{locale}</div>
  ),
}))

function makeConfig(overrides: Partial<LandingConfig> = {}): LandingConfig {
  return {
    schemaVersion: 1,
    enabled: true,
    theme: { inherit: true },
    locales: ['en', 'ru'],
    defaultLocale: 'en',
    meta: { title: { en: 'Title', ru: 'Заголовок' }, description: { en: 'Desc', ru: 'Описание' } },
    sections: [],
    ...overrides,
  }
}

// ── Fake server ─────────────────────────────────────────────────────────────
let storedConfig: LandingConfig
let storedVersion: number

function storedResponse(): LandingDraftResponse {
  return {
    draft: storedConfig,
    published: null,
    version: storedVersion,
    stored: true,
    hasDraftChanges: false,
  }
}

function renderPage(client?: QueryClient): { queryClient: QueryClient; unmount: () => void } {
  const queryClient =
    client ??
    new QueryClient({
      defaultOptions: {
        // Mirrors src/lib/query-client.ts — `staleTime` is load-bearing for the
        // "leave and come back" case.
        queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
        mutations: { retry: false },
      },
    })
  const ui: ReactElement = (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LandingBuilderPage />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>
  )
  const { unmount } = render(ui)
  return { queryClient, unmount }
}

/**
 * Advances fake timers and drains the promise jobs they release.
 *
 * The trailing millisecond is not padding: react-query notifies its observers
 * through a timer of its own, and that timer is only scheduled once the
 * mutation the first advance released has actually started.
 */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await vi.advanceTimersByTimeAsync(1)
  })
}

/** The autosave debounce, plus a tick for the round trip. */
const DEBOUNCE_MS = 800

function enabledSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: 'Landing enabled' })
}

function openTab(name: string): void {
  fireEvent.mouseDown(screen.getByRole('tab', { name }))
}

describe('LandingBuilderPage — draft persistence', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    await loadFeatureBundle('landingBuilder')
    session.forcedLogout = false
    storedConfig = makeConfig()
    storedVersion = 3
    vi.spyOn(landingBuilderApi, 'get').mockImplementation(async () => storedResponse())
    vi.spyOn(landingBuilderApi, 'saveDraft').mockImplementation(async (config, version) => {
      if (version !== storedVersion) throw new LandingDraftConflictError(storedVersion)
      storedConfig = config
      storedVersion += 1
      return { config, version: storedVersion }
    })
    vi.spyOn(landingBuilderApi, 'publish').mockResolvedValue({ revisionId: 'rev-1' })
  })

  afterEach(async () => {
    // Unmounting flushes a pending save; let it land against the fake server
    // before the spies are torn down.
    cleanup()
    await settle()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ── P1-a ──────────────────────────────────────────────────────────────────
  it('writes the saved draft and version back into the query cache', async () => {
    const { queryClient } = renderPage()
    await settle()

    fireEvent.click(enabledSwitch())
    await settle(DEBOUNCE_MS)

    expect(landingBuilderApi.saveDraft).toHaveBeenCalledTimes(1)
    const cached = queryClient.getQueryData<LandingDraftResponse>(LANDING_BUILDER_KEYS.all)
    expect(cached?.version).toBe(4)
    expect(cached?.draft.enabled).toBe(false)
  })

  it('restores the saved draft after a remount inside staleTime, not the pre-save one', async () => {
    const { queryClient, unmount } = renderPage()
    await settle()

    fireEvent.click(enabledSwitch())
    await settle(DEBOUNCE_MS)
    expect(enabledSwitch()).toHaveAttribute('aria-checked', 'false')

    // Navigate away and back well inside `staleTime`, so nothing is refetched
    // and the editor can only be seeded from the cache.
    unmount()
    await settle()
    renderPage(queryClient)
    await settle()

    expect(landingBuilderApi.get).toHaveBeenCalledTimes(1)
    expect(enabledSwitch()).toHaveAttribute('aria-checked', 'false')
    // The version came back too, so the next keystroke does not 409.
    fireEvent.click(enabledSwitch())
    await settle(DEBOUNCE_MS)
    expect(screen.queryByText('Someone else saved a newer draft')).not.toBeInTheDocument()
  })

  // ── P1-b ──────────────────────────────────────────────────────────────────
  it('saves an edit made while an earlier save was still in flight', async () => {
    let releaseFirst: () => void = () => {}
    const realSave = vi.mocked(landingBuilderApi.saveDraft).getMockImplementation()
    vi.mocked(landingBuilderApi.saveDraft).mockImplementationOnce(
      (config, version) =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(realSave!(config, version))
        }),
    )

    renderPage()
    await settle()

    fireEvent.click(enabledSwitch())
    await settle(DEBOUNCE_MS)
    expect(landingBuilderApi.saveDraft).toHaveBeenCalledTimes(1)

    // Typed while the PUT is in the air — this is what used to be marked clean
    // and then never sent.
    fireEvent.click(screen.getByRole('button', { name: 'Hero' }))
    await settle()

    releaseFirst()
    await settle(DEBOUNCE_MS)

    expect(landingBuilderApi.saveDraft).toHaveBeenCalledTimes(2)
    expect(storedConfig.sections).toHaveLength(1)
    expect(storedConfig.enabled).toBe(false)
  })

  // ── P1-c ──────────────────────────────────────────────────────────────────
  it('reports "Saving…" while the PUT is in flight and "Draft saved" once it lands', async () => {
    let releaseSave: () => void = () => {}
    const realSave = vi.mocked(landingBuilderApi.saveDraft).getMockImplementation()
    vi.mocked(landingBuilderApi.saveDraft).mockImplementationOnce(
      (config, version) =>
        new Promise((resolve) => {
          releaseSave = () => resolve(realSave!(config, version))
        }),
    )

    renderPage()
    await settle()
    expect(screen.getByTestId('save-status')).toHaveTextContent('Draft saved')

    fireEvent.click(enabledSwitch())
    await settle()
    expect(screen.getByTestId('save-status')).toHaveTextContent('Not saved')

    await settle(DEBOUNCE_MS)
    expect(landingBuilderApi.saveDraft).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('save-status')).toHaveTextContent('Saving…')

    releaseSave()
    await settle()
    expect(screen.getByTestId('save-status')).toHaveTextContent('Draft saved')
  })

  it('blocks unload while the draft has not reached the server', async () => {
    renderPage()
    await settle()

    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)

    fireEvent.click(enabledSwitch())
    await settle()

    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
  })

  it('stands down the unload prompt while the app is forcing a sign-out', async () => {
    renderPage()
    await settle()

    fireEvent.click(enabledSwitch())
    await settle()

    const held = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(held)
    expect(held.defaultPrevented).toBe(true)

    // The token expired: the session is already destroyed and the redirect to
    // sign-in is under way. "Leave site? Changes you made may not be saved"
    // argues for the button that cancels it — and no second redirect follows,
    // so taking that offer strands the operator on an editor that 401s.
    session.forcedLogout = true
    const forced = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(forced)
    expect(forced.defaultPrevented).toBe(false)
  })

  it('leaves a corrupted draft free to navigate away from', async () => {
    vi.mocked(landingBuilderApi.get).mockImplementation(async () => ({
      ...storedResponse(),
      corrupted: {
        issues: [{ path: 'sections.0.type', message: 'Invalid enum value' }],
        raw: { sections: [{ type: 'bogus' }] },
      },
    }))

    renderPage()
    await settle()
    expect(screen.getByText('The stored draft is corrupted')).toBeInTheDocument()

    fireEvent.click(enabledSwitch())
    await settle(DEBOUNCE_MS)

    // Frozen by design — autosaving here would overwrite the unparseable row
    // the banner is asking the operator to download.
    expect(landingBuilderApi.saveDraft).not.toHaveBeenCalled()
    // Honest about it, rather than claiming the edit is stored…
    expect(screen.getByTestId('save-status')).toHaveTextContent('Not saved')
    // …but there is no round trip for a prompt to buy time for, so warning is
    // a toll on every reload and every navigation, for good, on exactly the
    // recovery path the banner points at.
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('flushes the pending save when the editor unmounts inside the debounce', async () => {
    const { unmount } = renderPage()
    await settle()

    fireEvent.click(enabledSwitch())
    await settle(200) // still inside the 800 ms debounce
    expect(landingBuilderApi.saveDraft).not.toHaveBeenCalled()

    unmount()
    await settle()

    expect(landingBuilderApi.saveDraft).toHaveBeenCalledTimes(1)
    expect(storedConfig.enabled).toBe(false)
    expect(storedVersion).toBe(4)
  })

  it('does not re-send a snapshot whose save was still in flight at unmount', async () => {
    let releaseSave: () => void = () => {}
    const realSave = vi.mocked(landingBuilderApi.saveDraft).getMockImplementation()
    vi.mocked(landingBuilderApi.saveDraft).mockImplementationOnce(
      (config, version) =>
        new Promise((resolve) => {
          releaseSave = () => resolve(realSave!(config, version))
        }),
    )

    const { unmount } = renderPage()
    await settle()

    fireEvent.click(enabledSwitch())
    await settle(DEBOUNCE_MS)
    expect(landingBuilderApi.saveDraft).toHaveBeenCalledTimes(1)

    // The flush waits the PUT out and then asks whether anything is left to
    // send — but it is a closure frozen at the last render before unmount, so
    // the `savedConfig` it reads is one save behind and the answer used to be
    // "yes", for the snapshot that had just been stored.
    unmount()
    releaseSave()
    await settle()

    expect(landingBuilderApi.saveDraft).toHaveBeenCalledTimes(1)
    expect(storedVersion).toBe(4)
  })

  // ── P1-d ──────────────────────────────────────────────────────────────────
  it('renders an error with a working retry when the initial load fails', async () => {
    vi.mocked(landingBuilderApi.get).mockRejectedValueOnce(new Error('network down'))

    renderPage()
    await settle()

    expect(screen.getByText('Could not load the landing draft.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await settle()

    expect(enabledSwitch()).toBeInTheDocument()
    expect(screen.queryByText('Could not load the landing draft.')).not.toBeInTheDocument()
  })

  // ── P2 ────────────────────────────────────────────────────────────────────
  it('does not resend a rejected save until the operator edits again', async () => {
    vi.mocked(landingBuilderApi.saveDraft).mockRejectedValue(new Error('boom'))

    renderPage()
    await settle()

    fireEvent.click(enabledSwitch())
    await settle(DEBOUNCE_MS)
    expect(landingBuilderApi.saveDraft).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('save-status')).toHaveTextContent('Save failed')

    // Ten seconds of doing nothing used to be ten more identical PUTs.
    await settle(10_000)
    expect(landingBuilderApi.saveDraft).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Hero' }))
    await settle(DEBOUNCE_MS)
    expect(landingBuilderApi.saveDraft).toHaveBeenCalledTimes(2)
  })

  it('sends the rejected snapshot again when undo steps back onto it', async () => {
    vi.mocked(landingBuilderApi.saveDraft).mockRejectedValueOnce(new Error('network blip'))

    renderPage()
    await settle()

    // Edit A — the save is rejected, so A is the gated snapshot.
    fireEvent.click(enabledSwitch())
    await settle(DEBOUNCE_MS)
    expect(screen.getByTestId('save-status')).toHaveTextContent('Save failed')

    // Edit B — stored fine, so nothing on screen says anything is wrong.
    fireEvent.click(screen.getByRole('button', { name: 'Hero' }))
    await settle(DEBOUNCE_MS)
    expect(storedConfig.sections).toHaveLength(1)

    // Ctrl+Z restores the exact object the server rejected: dirty, gated, and
    // reported as "Save failed" for an attempt that never happened again.
    fireEvent.click(screen.getByRole('button', { name: 'Undo (Ctrl+Z)' }))
    await settle(DEBOUNCE_MS)

    expect(landingBuilderApi.saveDraft).toHaveBeenCalledTimes(3)
    expect(storedConfig.sections).toHaveLength(0)
    expect(storedConfig.enabled).toBe(false)
    expect(screen.getByTestId('save-status')).toHaveTextContent('Draft saved')
  })

  it('offers a retry next to a failed save and clears the failure once it lands', async () => {
    vi.mocked(landingBuilderApi.saveDraft).mockRejectedValueOnce(new Error('network blip'))

    renderPage()
    await settle()

    fireEvent.click(enabledSwitch())
    await settle(DEBOUNCE_MS)
    expect(screen.getByTestId('save-status')).toHaveTextContent('Save failed')

    // Without this the only way to reopen the gate is an unrelated edit, which
    // the operator has to guess at.
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))
    await settle()

    expect(landingBuilderApi.saveDraft).toHaveBeenCalledTimes(2)
    expect(storedConfig.enabled).toBe(false)
    expect(screen.getByTestId('save-status')).toHaveTextContent('Draft saved')
    expect(screen.queryByRole('button', { name: 'Retry save' })).not.toBeInTheDocument()
  })

  // ── P3-b ──────────────────────────────────────────────────────────────────
  it('saves the pending edit before publishing and keeps undo history afterwards', async () => {
    const order: string[] = []
    const realSave = vi.mocked(landingBuilderApi.saveDraft).getMockImplementation()
    vi.mocked(landingBuilderApi.saveDraft).mockImplementation(async (config, version) => {
      order.push('save')
      return realSave!(config, version)
    })
    vi.mocked(landingBuilderApi.publish).mockImplementation(async () => {
      order.push('publish')
      return { revisionId: 'rev-1' }
    })

    renderPage()
    await settle()

    fireEvent.click(enabledSwitch())
    // Publish pressed inside the debounce: the edit is on screen but not stored.
    fireEvent.click(screen.getByRole('button', { name: /Publish/ }))
    await settle()

    expect(order).toEqual(['save', 'publish'])
    expect(storedConfig.enabled).toBe(false)

    // The armed autosave must not fire a second, redundant PUT afterwards.
    await settle(DEBOUNCE_MS)
    expect(order).toEqual(['save', 'publish'])
    // Nor may the refetch that publishing triggers reset the editor.
    expect(screen.getByRole('button', { name: 'Undo (Ctrl+Z)' })).toBeEnabled()
  })

  it('reports a publish aborted by a failed save as exactly that', async () => {
    const errorToast = vi.spyOn(toast, 'error')
    vi.mocked(landingBuilderApi.saveDraft).mockRejectedValue(new Error('network blip'))

    renderPage()
    await settle()

    fireEvent.click(enabledSwitch())
    fireEvent.click(screen.getByRole('button', { name: /Publish/ }))
    await settle()

    // The publish request was never sent, so "could not publish" is the one
    // thing that did not happen — and it used to be the only thing said, over
    // a second toast about the save.
    expect(landingBuilderApi.publish).not.toHaveBeenCalled()
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast).toHaveBeenCalledWith(
      'Nothing was published — the draft could not be saved',
    )
  })

  // ── Theme gallery vs. the typography field ────────────────────────────────
  it('keeps the font chosen in Settings when a theme preset is applied', async () => {
    renderPage()
    await settle()

    openTab('Settings')
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: 'Font' }), {
      target: { value: 'Georgia, serif' },
    })
    await settle()

    // A preset replaces the theme wholesale, and every tile used to carry an
    // empty `font` into that replacement.
    openTab('Theme')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Vital Link' }))
    await settle()

    openTab('Settings')
    await settle()
    expect(screen.getByRole('textbox', { name: 'Font' })).toHaveValue('Georgia, serif')
  })

  // ── P3-a ──────────────────────────────────────────────────────────────────
  it('keeps the JSON buffer in step with edits made outside the tab', async () => {
    renderPage()
    await settle()

    openTab('JSON')
    await settle()
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Raw JSON' })
    expect(textarea.value).toContain('"enabled": true')

    // The header and the preview stay live while the JSON tab is open, so a
    // buffer snapshotted at mount goes stale under the operator.
    fireEvent.click(enabledSwitch())
    await settle()

    expect(textarea.value).toContain('"enabled": false')
  })

  // ── Preview locale reconciliation ─────────────────────────────────────────
  it('falls back to the default locale when the previewed locale is removed', async () => {
    renderPage()
    await settle()
    expect(screen.getByTestId('preview-locale')).toHaveTextContent('en')

    openTab('JSON')
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw JSON' }), {
      target: {
        value: JSON.stringify(
          makeConfig({
            locales: ['ru'],
            defaultLocale: 'ru',
            meta: { title: { ru: 'Заголовок' }, description: { ru: 'Описание' } },
          }),
          null,
          2,
        ),
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Load into editor' }))
    await settle()

    expect(screen.getByTestId('preview-locale')).toHaveTextContent('ru')
  })

  // ── P1-c, router blocker ──────────────────────────────────────────────────
  // Mounted through a real data router: `useBlocker` throws without one, which
  // is why the page gates the guard on the data-router context.
  it('holds an in-app navigation while the draft has not reached the server', async () => {
    const router = createMemoryRouter(
      [
        { path: '/', element: <LandingBuilderPage /> },
        { path: '/elsewhere', element: <div>Elsewhere</div> },
      ],
      { initialEntries: ['/'] },
    )
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nextProvider>,
    )
    await settle()

    fireEvent.click(enabledSwitch())
    await settle()

    await act(async () => {
      void router.navigate('/elsewhere')
    })
    expect(screen.getByText('The draft is not saved yet')).toBeInTheDocument()
    expect(screen.queryByText('Elsewhere')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Leave anyway' }))
    await settle()

    expect(screen.getByText('Elsewhere')).toBeInTheDocument()
    // Leaving does not throw the edit away — the unmount flush still sends it.
    expect(storedConfig.enabled).toBe(false)
  })

  it('lets the forced sign-out navigation through instead of holding it', async () => {
    const router = createMemoryRouter(
      [
        { path: '/', element: <LandingBuilderPage /> },
        { path: '/sign-in', element: <div>Sign in</div> },
      ],
      { initialEntries: ['/'] },
    )
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nextProvider>,
    )
    await settle()

    fireEvent.click(enabledSwitch())
    await settle()

    // Clearing the session re-renders `AuthGuard`, which answers with a
    // `<Navigate>` — an in-app navigation, and therefore this blocker's
    // business. Holding it puts a "stay" in front of an operator whose session
    // is already gone.
    session.forcedLogout = true
    await act(async () => {
      void router.navigate('/sign-in')
    })

    expect(screen.queryByText('The draft is not saved yet')).not.toBeInTheDocument()
    expect(screen.getByText('Sign in')).toBeInTheDocument()
  })
})
