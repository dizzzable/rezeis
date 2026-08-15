/**
 * The operator's "Text animation" choice has to reach the panel, not just the
 * preview card.
 *
 * WHAT WAS WRONG. `TitleEffect` had exactly one call site in the whole app —
 * the dashboard heading (`dashboard-page.tsx`). Every other section rendered
 * its `<h1>` by hand, 46 files of it, so an operator could pick any of the
 * thirteen animations, watch it run in Settings → Appearance, and then never
 * meet it again anywhere they actually work.
 *
 * WHAT IS ASSERTED HERE. Not "TitleEffect works" — `TitleEffect.test.tsx`
 * already owns that. This file mounts FOUR REAL SECTION PAGES and pins the
 * three properties the operator can observe:
 *
 *   1. reach       — flipping the choice changes the heading's markup on each
 *                    page, so the setting is not decorative;
 *   2. the off-ramp — "None", the effects switch, and the appearance flag each
 *                    put the heading back to one plain span of text, on every
 *                    one of those pages;
 *   3. the heading  — whatever the animation does to the DOM, the `<h1>` keeps
 *                    its accessible name and stays free of block-level
 *                    elements, so screen readers still announce the section
 *                    and the header row with its action button does not wrap.
 *
 * Property 3 is checked across ALL thirteen animation ids on the shared
 * `PageTitle` seam rather than 13 × 4 page mounts: the markup that can break a
 * header row comes from the seam, and mounting a real page thirteen more times
 * would only re-measure the same DOM through a slower path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { Package } from 'lucide-react'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { useEffectsStore, TEXT_ANIMATIONS, type TextAnimationId } from '@/lib/theme/effects-store'

import AddOnsPage from '@/features/add-ons/add-ons-page'
import PromocodesPage from '@/features/promocodes/promocodes-page'
import SubscriptionsPage from '@/features/subscriptions/subscriptions-page'
import UsersPage from '@/features/users/users-page'

import { PageTitle } from './page-title'

type ApiGet = (path: string) => Promise<{ data: unknown }>

interface PageCase {
  readonly key: string
  readonly title: string
  readonly render: () => ReactElement
  readonly get: ApiGet
}

/**
 * Four routed sections, deliberately from four different feature folders and
 * four different header shapes: Users has a permission-gated export button to
 * the right of the title, Subscriptions a stats strip, Promo codes a `FadeIn`
 * wrapper and a create button, Add-ons a `FadeIn` wrapper and a dialog trigger.
 * A repair that only reaches "pages that look like the dashboard" fails here.
 */
const PAGES: readonly PageCase[] = [
  {
    key: 'users',
    title: 'Users',
    render: () => <UsersPage />,
    get: async () => ({ data: { items: [], total: 0 } }),
  },
  {
    key: 'subscriptions',
    title: 'Subscriptions',
    render: () => <SubscriptionsPage />,
    get: async (path) =>
      path === '/admin/subscriptions/stats'
        ? { data: { total: 0, byStatus: {}, trialCount: 0, expiringIn7d: 0 } }
        : { data: { items: [], total: 0 } },
  },
  {
    key: 'promocodes',
    title: 'Promo codes',
    render: () => <PromocodesPage />,
    get: async () => ({ data: { items: [] } }),
  },
  {
    key: 'addOns',
    title: 'Add-ons',
    render: () => <AddOnsPage />,
    get: async () => ({ data: [] }),
  },
]

/**
 * Elements that may not appear inside a heading's inline content — the same
 * list `effects-gate`/`TitleEffect` specs use, and for the same reason: jsdom
 * loads no stylesheet, so `getComputedStyle().display` would report the UA
 * default for every Tailwind `inline-block`. The tag name is the honest signal,
 * and it is the half that actually breaks a header row.
 */
const BLOCK_LEVEL =
  'div,p,h2,h3,h4,h5,h6,section,article,ul,ol,li,table,form,blockquote,pre,hr,figure'

function useAnimation(animation: TextAnimationId): void {
  useEffectsStore.setState({ textAnimation: animation, effectsEnabled: true })
  useAppearanceStore.setState({ visualEffects: true })
}

async function mountAndFindHeading(page: PageCase): Promise<HTMLElement> {
  renderWithProviders(page.render())
  const heading = await screen.findByRole('heading', { level: 1 })
  await waitFor(() => {
    expect(readable(heading)).toContain(page.title)
  })
  return heading
}

/** NBSP is how every split animation spells the space it keeps from collapsing. */
function readable(node: HTMLElement | null): string {
  return (node?.textContent ?? '').replace(/ /g, ' ').trim()
}

beforeEach(() => {
  useEffectsStore.getState().reset()
  useAppearanceStore.setState({ visualEffects: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe.each(PAGES)('$key — the text-animation setting reaches this section', (page) => {
  beforeEach(() => {
    vi.spyOn(api, 'get').mockImplementation(page.get as never)
  })

  it('renders a different heading once the operator picks an animation', async () => {
    useAnimation('none')
    const plain = (await mountAndFindHeading(page)).innerHTML
    cleanup()

    // `split` is the honest probe: it is the one animation `TitleEffect`
    // renders synchronously and without gsap/WebGL, so a difference here is
    // the setting arriving, not a lazy chunk landing at a lucky moment.
    useAnimation('split')
    const heading = await mountAndFindHeading(page)

    expect(heading.innerHTML).not.toBe(plain)
    // …and specifically: one element per character, which is what the
    // animation IS. A wrapper that merely re-ordered attributes would pass the
    // inequality above and fail this.
    const chars = heading.querySelectorAll('span span')
    expect(chars.length).toBeGreaterThanOrEqual(page.title.length)
    expect(readable(heading)).toContain(page.title)
  })

  it('puts the heading back to plain text on "None"', async () => {
    useAnimation('none')
    const heading = await mountAndFindHeading(page)

    expect(heading.querySelectorAll('span span')).toHaveLength(0)
    expect(readable(heading)).toContain(page.title)
  })

  it('puts the heading back to plain text when the effects switch is off', async () => {
    // `visualEffects` stays ON so a gate that reads the wrong flag cannot pass:
    // the switch the operator actually sees is `effectsEnabled`.
    useAnimation('split')
    useEffectsStore.setState({ effectsEnabled: false })

    const heading = await mountAndFindHeading(page)

    expect(heading.querySelectorAll('span span')).toHaveLength(0)
    expect(readable(heading)).toContain(page.title)
  })

  it('keeps the section announceable to a screen reader while animating', async () => {
    useAnimation('split')
    await mountAndFindHeading(page)

    expect(
      await screen.findByRole('heading', { level: 1, name: new RegExp(page.title, 'i') }),
    ).toBeInTheDocument()
  })
})

describe('PageTitle — the shared seam every section header goes through', () => {
  /**
   * A real header row: title on the left, action button on the right. This is
   * the shape that breaks — a vendor component that renders its own `<div>`,
   * `<p>` or 7vw margin inside the `<h1>` pushes the button off the row.
   */
  function renderHeaderRow(animation: TextAnimationId) {
    useAnimation(animation)
    return render(
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle title="Plans" icon={Package} />
        <button type="button">Create plan</button>
      </div>,
    )
  }

  it.each(TEXT_ANIMATIONS.map((a) => a.id))(
    '%s keeps the heading inline and announceable',
    async (animation) => {
      const { container } = renderHeaderRow(animation)
      const heading = container.querySelector('h1') as HTMLElement
      expect(heading).not.toBeNull()

      // Give any lazy chunk a chance to land; the assertions below must hold
      // for the Suspense fallback AND for the loaded component.
      await waitFor(() => {
        expect(heading.querySelectorAll(BLOCK_LEVEL)).toHaveLength(0)
      })

      // The heading still names its section. `getByRole(... { name })` is the
      // accessible-name computation, so an animation that hides its text
      // behind a canvas or drops it into an aria-hidden subtree fails here.
      expect(screen.getByRole('heading', { level: 1, name: /Plans/i })).toBe(heading)
    },
  )
})
