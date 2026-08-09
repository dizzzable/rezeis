/**
 * What an operator sees when a list endpoint answers with something that is
 * not a list.
 *
 * Two bodies are exercised, because they fail differently:
 *
 *   • `{}` — the shape a half-configured backend returns. `.map` throws.
 *   • `'<!doctype html>…'` — what `web/nginx.conf` returns for a stale `/api`
 *     path, with status 200. A string has a working `.length`, so it walks
 *     past every `length === 0` guard in this codebase before dying at `.map`.
 *
 * These specs assert THE SURVIVING PAGE, not merely the absence of a throw —
 * following `dashboard-system-health-partial.test.tsx`, which made the same
 * choice for `MetricsUnavailable`. "Nothing threw" is satisfied by a route
 * that renders an empty card and lies to the operator about their
 * infrastructure; that is the regression these branches exist to prevent.
 *
 * Nothing here reaches the network: `api.get` is stubbed, and the real
 * endpoint function, the real `expectArray`, and the real components run.
 */
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { i18n } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import PanelIconsTab from '@/features/settings/panel-icons-tab'
import { InfraSquadsSection } from '@/features/remnawave/infra/infra-squads-section'
import { CatalogTab } from '@/features/remnawave/catalog/catalog-tab'
import { CostsTab } from '@/features/remnawave/costs/costs-tab'
import { PlanForm } from '@/features/plans/plan-form'
import WebhooksPage from '@/features/webhooks/webhooks-page'

const HTML_200 =
  '<!doctype html><html><head><title>Rezeis Admin</title></head><body><div id="root"></div></body></html>'

/** Feature-bundle keys render as the raw key under test; core keys resolve. */
const label = (key: string) => i18n.t(key)

function stubEverythingWith(body: unknown) {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: body }) as never)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a non-array list response', () => {
  it('defeats a length guard but not expectArray', () => {
    // The reason the string case needed its own branch: this is what every
    // `data.length === 0` check in the tree sees.
    expect(HTML_200.length).toBeGreaterThan(0)
    expect(Array.isArray(HTML_200)).toBe(false)
  })

  it.each([
    ['an empty object', {} as unknown],
    ['an HTML page served with HTTP 200', HTML_200 as unknown],
  ])('leaves the Remnawave squads page standing and says "unavailable" — %s', async (_name, body) => {
    stubEverythingWith(body)
    renderWithProviders(<InfraSquadsSection />)

    expect(
      await screen.findByText(label('remnaWavePage.squads.internalUnavailable')),
    ).toBeInTheDocument()
    expect(screen.getByText(label('remnaWavePage.squads.externalUnavailable'))).toBeInTheDocument()
    // The surviving page: both cards, their headings and the retry are still
    // there. A bare throw would have taken the whole route instead.
    expect(screen.getByText(label('remnaWavePage.squads.internal'))).toBeInTheDocument()
    expect(screen.getByText(label('remnaWavePage.squads.external'))).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2)
    // And it does NOT claim the panel has no squads.
    expect(screen.queryByText(label('remnaWavePage.squads.noInternal'))).not.toBeInTheDocument()
    expect(screen.queryByText(label('remnaWavePage.squads.noExternal'))).not.toBeInTheDocument()
  })

  it('marks all four Remnawave catalog sections unavailable rather than empty', async () => {
    stubEverythingWith({})
    renderWithProviders(<CatalogTab />)

    await waitFor(() =>
      expect(
        screen.getAllByText(label('remnaWavePage.catalog.sectionUnavailable')),
      ).toHaveLength(4),
    )
    expect(screen.queryByText(label('remnaWavePage.catalog.profiles.empty'))).not.toBeInTheDocument()
    expect(screen.queryByText(label('remnaWavePage.catalog.snippets.empty'))).not.toBeInTheDocument()
  })

  it('does not tell the operator they have no infrastructure providers', async () => {
    stubEverythingWith(HTML_200)
    renderWithProviders(<CostsTab />)

    expect(
      await screen.findByText(label('remnaWavePage.costs.providers.unavailable')),
    ).toBeInTheDocument()
    expect(screen.queryByText(label('remnaWavePage.costs.providers.empty'))).not.toBeInTheDocument()
  })

  it('does not tell the operator their panel has no squads while they create a plan', async () => {
    // `/admin/plans` answers correctly so the rest of the form renders; only
    // the two squad endpoints are broken. That is the realistic shape — one
    // upstream is down, not the whole backend.
    vi.spyOn(api, 'get').mockImplementation(async (path: string) =>
      (path === '/admin/plans' ? { data: [] } : { data: {} }) as never,
    )
    renderWithProviders(<PlanForm onSubmit={vi.fn()} isLoading={false} />)

    // Both squad queries set `retry: 1` on themselves, which overrides the
    // test client's `retry: false`, so the failure is only final after the
    // second attempt's backoff.
    await waitFor(
      () => expect(screen.getAllByText(label('planForm.squadsUnavailable')).length).toBeGreaterThan(0),
      { timeout: 6000 },
    )
    expect(screen.queryByText(label('planForm.noSquads'))).not.toBeInTheDocument()
    // The form itself survived and is still submittable.
    expect(screen.getByRole('button', { name: 'Create plan' })).toBeInTheDocument()
  })

  it('says the webhook event catalogue is unreachable instead of showing none', async () => {
    stubEverythingWith({})
    renderWithProviders(<WebhooksPage />)

    expect(
      await screen.findByText(label('webhooksPage.subscriptions.catalogUnavailable')),
    ).toBeInTheDocument()
    // The create form is still usable — a subscription can be made by hand.
    expect(screen.getByPlaceholderText('Slack alerts')).toBeInTheDocument()
  })
})

/**
 * The icon library is the serious one. Its Save `PUT`s the local draft as the
 * WHOLE library, and the draft starts empty — so on a failed load, uploading
 * one icon used to enable Save and replace every stored icon with a
 * one-element library. Asserting "no throw" would not have caught that: the
 * old code never threw. It quietly offered a destructive button.
 */
describe('the icon library never lets an operator save over a library it never read', () => {
  it.each([
    ['an empty object', {} as unknown],
    ['an HTML page served with HTTP 200', HTML_200 as unknown],
  ])('refuses to expose the editor at all — %s', async (_name, body) => {
    stubEverythingWith(body)
    renderWithProviders(<PanelIconsTab />)

    expect(await screen.findByText(label('panelIcons.loadFailed'))).toBeInTheDocument()

    // The two controls that together formed the data-loss path are gone: no
    // drop zone to add an icon to an empty draft, and no Save to write it.
    expect(screen.queryByRole('button', { name: 'Choose icon files' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    // And it does not claim the library is empty.
    expect(screen.queryByText(label('panelIcons.empty'))).not.toBeInTheDocument()
  })

  it('still shows the editor when the library really is an empty list', async () => {
    // The counterpart assertion: an honestly empty library must stay editable,
    // or the fix would have traded a data-loss bug for a dead feature.
    stubEverythingWith([])
    renderWithProviders(<PanelIconsTab />)

    expect(await screen.findByRole('button', { name: 'Choose icon files' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.getByText(label('panelIcons.empty'))).toBeInTheDocument()
    expect(screen.queryByText(label('panelIcons.loadFailed'))).not.toBeInTheDocument()
  })
})
