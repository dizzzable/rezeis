import { act, useState } from 'react'
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
 *
 * ── The pick itself now belongs to the editor ────────────────────────────────
 *
 * This card is presentational: it is handed the pending pick and hands back the
 * gesture. The state moved up because the operator's report was "тема выбрана,
 * но не применилась" — the concept was ticked here while the loud primary
 * button at the top of the page saved the CATALOG and left it behind. What that
 * write actually sends is therefore asserted against the real editor, in
 * `connect-page-editor.test.tsx`; what is asserted here is what this card puts
 * on screen.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

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
/** What the card asked the editor to remember, in call order. */
let picked: (string | null)[] = []
let applied = 0

/**
 * The card with the one piece of state its owner holds.
 *
 * A stand-in for the editor rather than a copy of it: it remembers the pick and
 * nothing else, so these cases can see the gallery react while the question of
 * WHAT gets written stays where it is actually answered.
 */
function Harness({
  theme,
  config,
  sanitized,
  featuredColor,
}: {
  theme: { presetId: string | null } | null
  config: unknown
  sanitized: Record<string, string>
  featuredColor: string | null
}) {
  const [pending, setPending] = useState<string | null | undefined>(undefined)
  return (
    <ConnectThemeCard
      config={config as never}
      sanitized={sanitized}
      theme={theme as never}
      canEdit
      pending={pending}
      onPick={(next) => {
        picked.push(next)
        setPending(next)
      }}
      applying={false}
      onApply={() => {
        applied += 1
      }}
      featuredColor={featuredColor}
      onFeaturedColorChange={vi.fn()}
    />
  )
}

function render(
  theme: { presetId: string | null } | null,
  config: unknown = CONFIG,
  sanitized: Record<string, string> = {},
  featuredColor: string | null = null,
): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root?.render(
      <Harness theme={theme} config={config} sanitized={sanitized} featuredColor={featuredColor} />,
    ),
  )
  return host
}

const inheritTile = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>("[data-testid='connect-theme-inherit']")
const conceptTile = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>("[role='option']:not([data-testid])")
const unsavedBar = (el: HTMLElement) =>
  el.querySelector<HTMLElement>("[data-testid='connect-theme-unsaved']")
const applyButton = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('connectPageEditor.theme.apply'),
  )

beforeEach(() => {
  picked = []
  applied = 0
})

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

describe('picking, and only then applying', () => {
  it('does not apply on the click itself', () => {
    // A preview is a question. Applying on selection would make every idle
    // click on the gallery a live change to what customers see.
    const el = render(null)
    act(() => conceptTile(el)?.click())
    expect(applied).toBe(0)
    expect(unsavedBar(el), 'nothing says the pick is unsaved').not.toBeNull()
  })

  it('says out loud that the pick has not been applied', () => {
    // The gallery is tall enough to scroll a plain button row off the bottom of
    // the card, and that is how a picked concept ended up looking saved and
    // being unsaved. The bar is sticky, tinted and worded.
    const el = render(null)
    act(() => conceptTile(el)?.click())
    const bar = unsavedBar(el)
    expect(bar?.className).toContain('sticky')
    expect(bar?.textContent).toContain('connectPageEditor.theme.unsaved')
  })

  it('offers Apply when the cabinet appearance is picked over a stored concept', () => {
    // The case the two-state version could not express: this pick IS a change,
    // and without it a stored concept can never be cleared from the gallery.
    const el = render({ presetId: 'concept-ba' })
    expect(unsavedBar(el)).toBeNull()
    act(() => inheritTile(el)?.click())
    expect(unsavedBar(el), 'picking the cabinet appearance counted as no change').not.toBeNull()
  })

  it('hands the pick up as null when the cabinet appearance is chosen', () => {
    // `null` is the value that deletes the stored row. `undefined` — "nothing
    // picked" — would leave the concept in place and look identical here.
    const el = render({ presetId: 'concept-ba' })
    act(() => inheritTile(el)?.click())
    expect(picked).toEqual([null])
  })

  it('hands the pick up as a preset id when a concept is chosen', () => {
    const el = render(null)
    act(() => conceptTile(el)?.click())
    expect(picked[0]).toMatch(/^concept-/)
  })

  it('offers nothing to apply when the pick matches what is stored', () => {
    const el = render(null)
    act(() => inheritTile(el)?.click())
    expect(unsavedBar(el)).toBeNull()
  })

  it('asks its owner to write when Apply is pressed', () => {
    const el = render(null)
    act(() => conceptTile(el)?.click())
    act(() => applyButton(el)?.click())
    expect(applied).toBe(1)
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

describe('the recommendation dot in the preview', () => {
  /** What the browser makes of a colour, so the assertion is not about spelling. */
  function asRendered(colour: string): string {
    const probe = document.createElement('div')
    probe.style.background = colour
    return probe.style.background
  }

  it('is amber, not the accent, when the operator has set nothing', () => {
    // The chosen chip is FILLED with the accent, so an accent-coloured dot on
    // it is invisible — which is what the cabinet was reported for, and this
    // preview has to show the same thing or it is worth less than nothing.
    const el = render(null)
    const dot = el.querySelector<HTMLElement>("[data-testid='connect-preview-featured']")
    expect(dot, 'the preview does not mark the recommended app').not.toBeNull()
    expect(dot?.style.background).toBe(asRendered('#FACC15'))
  })

  it('follows the operator into the corner they will actually see', () => {
    const el = render(null, CONFIG, {}, '#00FF7F')
    const dot = el.querySelector<HTMLElement>("[data-testid='connect-preview-featured']")
    expect(dot?.style.background).toBe(asRendered('#00FF7F'))
    expect(dot?.className).toContain('absolute')
    expect(dot?.className).toContain('left-')
    expect(dot?.className).toContain('top-')
  })
})
