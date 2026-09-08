import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * PICKING THE CABINET'S OWN LOOK IS A CHOICE, NOT A RESET.
 *
 * It started as a button beside the gallery that saved the moment it was
 * pressed. That reads as "undo" — and undo makes a different promise: it puts
 * back what was there. This picks a look, and it is the look most installs run,
 * so it belongs in the row with the other looks, chosen the same way.
 *
 * Moving it into the gallery exposed a state bug that the button had hidden.
 * "Nothing picked yet" and "picked: the cabinet's own" were the same value, so
 * choosing the cabinet's own could never count as a change — the Apply button
 * would never appear and a stored concept could never be cleared through the
 * gallery. Three states, not two, and these cases are the reason.
 */

const setTheme = vi.fn(async (theme: unknown) => ({ theme: theme ?? null }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// Partial: `query-client.ts` reaches for the real `QueryClient` on import, so a
// bare replacement takes the whole module tree down before a test runs.
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: ({ mutationFn }: { mutationFn: (v: unknown) => Promise<unknown> }) => ({
    mutate: (value: unknown) => void mutationFn(value),
    isPending: false,
  }),
}))
vi.mock('./connect-page-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./connect-page-api')
  return { ...actual, connectPageApi: { setTheme } }
})

const { ConnectThemeCard } = await import('./connect-theme-card')

const SAVED_ICON = '<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>'
const PASTED_ICON = '<svg viewBox="0 0 1 1"><path d="M0 0h1v1z" id="unsaved"/></svg>'

function configWith(icons: Record<string, string>, iconKey: string | null) {
  return {
    version: 2,
    icons,
    platforms: [
      {
        id: 'windows',
        title: { ru: 'Windows' },
        iconKey: null,
        apps: [{ id: 'happ', name: 'Happ', iconKey, featured: true, steps: [] }],
      },
    ],
  } as never
}

const CONFIG = configWith({}, null)

let root: Root | null = null
let host: HTMLDivElement | null = null

function render(
  theme: { presetId: string | null } | null,
  config: unknown = CONFIG,
  sanitized: Record<string, string> = {},
): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root?.render(
      <ConnectThemeCard
        config={config as never}
        sanitized={sanitized}
        theme={theme as never}
        canEdit
      />,
    ),
  )
  return host
}

const inheritTile = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>("[data-testid='connect-theme-inherit']")
const conceptTile = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>("[role='option']:not([data-testid])")
const applyButton = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('connectPageEditor.theme.apply'),
  )

beforeEach(() => setTheme.mockClear())

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('the cabinet appearance is one of the options', () => {
  it('sits in the same list as the concepts, with the same selected state', () => {
    const el = render(null)
    const tile = inheritTile(el)
    expect(tile, 'the cabinet appearance is not in the gallery').not.toBeNull()
    expect(tile?.getAttribute('role')).toBe('option')
    expect(tile?.getAttribute('aria-selected')).toBe('true')
  })

  it('is not selected while a concept is stored', () => {
    const el = render({ presetId: 'concept-ba' })
    expect(inheritTile(el)?.getAttribute('aria-selected')).toBe('false')
  })
})

describe('picking, and only then saving', () => {
  it('does not save on the click itself', () => {
    // A preview is a question. Saving on selection makes every idle click on
    // the gallery a live change to what customers see.
    const el = render(null)
    act(() => conceptTile(el)?.click())
    expect(setTheme).not.toHaveBeenCalled()
    expect(applyButton(el), 'no way to confirm the pick').toBeDefined()
  })

  it('offers Apply when the cabinet appearance is picked over a stored concept', () => {
    // The case the two-state version could not express: this pick IS a change,
    // and without it a stored concept can never be cleared from the gallery.
    const el = render({ presetId: 'concept-ba' })
    expect(applyButton(el)).toBeUndefined()
    act(() => inheritTile(el)?.click())
    expect(applyButton(el), 'picking the cabinet appearance counted as no change').toBeDefined()
  })

  it('clears the stored theme with null rather than an empty one', () => {
    // The server treats an empty theme as a clear too, but sending one would
    // leave a row that says nothing. `null` deletes it.
    const el = render({ presetId: 'concept-ba' })
    act(() => inheritTile(el)?.click())
    act(() => applyButton(el)?.click())
    expect(setTheme).toHaveBeenCalledWith(null)
  })

  it('sends a resolved theme, not a preset id, when a concept is picked', () => {
    // The cabinet has no concept book — it cannot resolve an id, so an id on
    // the wire would arrive as an appearance nobody can paint.
    const el = render(null)
    act(() => conceptTile(el)?.click())
    act(() => applyButton(el)?.click())
    const sent = setTheme.mock.calls[0]?.[0] as { tokens?: unknown; presetId?: unknown } | null
    expect(sent?.presetId, 'no preset id came back for the gallery to show').toBeTruthy()
    expect(sent?.tokens, 'the cabinet was sent an id it cannot resolve').toBeTruthy()
  })

  it('offers nothing to apply when the pick matches what is stored', () => {
    const el = render(null)
    act(() => inheritTile(el)?.click())
    expect(applyButton(el)).toBeUndefined()
  })
})

describe('the preview never injects markup the server has not seen', () => {
  /**
   * The editor hands this card `draft ?? data.config`, so `config.icons` can
   * hold a string an operator pasted seconds ago. The sanitizer runs on the
   * SERVER, on save. Injecting the draft would put unsanitized SVG into the
   * panel's own DOM — where the admin token lives in `localStorage` and the CSP
   * is report-only in production.
   *
   * This is not a hypothetical risk. It is the defect the icon library two
   * cards down was fixed for, and this preview reintroduced it: the same
   * `draft ?? data.config` source, the same `dangerouslySetInnerHTML`, the same
   * `startsWith('<svg')` as the only check.
   */
  it('renders an icon the server has confirmed', () => {
    const el = render(null, configWith({ mark: SAVED_ICON }, 'mark'), { mark: SAVED_ICON })
    expect(el.querySelector("[data-testid='connect-theme-preview'] svg")).not.toBeNull()
  })

  it('refuses one that has only been pasted', () => {
    // Same key, different bytes: the operator edited it and has not saved.
    const el = render(null, configWith({ mark: PASTED_ICON }, 'mark'), { mark: SAVED_ICON })
    const preview = el.querySelector("[data-testid='connect-theme-preview']")
    // The pasted bytes never reach the DOM. Scoped to the marker rather than to
    // "no svg anywhere": the preview draws its own lucide glyphs, and asserting
    // their absence would pass for the wrong reason the day one is removed.
    expect(preview?.innerHTML).not.toContain('unsaved')
    expect(preview?.textContent).toContain('H')
  })

  it('refuses one the server has never seen at all', () => {
    const el = render(null, configWith({ mark: PASTED_ICON }, 'mark'), {})
    const preview = el.querySelector("[data-testid='connect-theme-preview']")
    expect(preview?.innerHTML).not.toContain('unsaved')
    // …and falls back to the initial, exactly as an app with no icon does.
    expect(preview?.textContent).toContain('H')
  })
})

describe('the preview stands for the cabinet, not for the panel', () => {
  it('uses the cabinet accent when no concept is chosen', () => {
    // `var(--primary)` resolved against the PANEL's root, where the accent is a
    // monochrome near-black in light mode. With "as in the cabinet" selected —
    // the default and the state most installs run — the preview was painting
    // the admin panel's own accent as the customer's brand colour.
    const el = render(null)
    const preview = el.querySelector<HTMLElement>("[data-testid='connect-theme-preview']")
    const accent = preview?.style.getPropertyValue('--brand-primary')
    expect(accent).toBe('#22c55e')
    expect(accent).not.toContain('var(')
  })
})
