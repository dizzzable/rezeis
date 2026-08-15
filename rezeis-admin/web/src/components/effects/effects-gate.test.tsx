/**
 * Two defects with one symptom: the operator's choices in Settings → Appearance
 * did not reach the screen.
 *
 * PART 1 — the switch that switched nothing. Two flags gate effects:
 * `appearance-store.visualEffects` and `effects-store.effectsEnabled`. Nothing
 * in the UI ever calls `setVisualEffects`, so the first is permanently true;
 * the second is the switch the operator actually sees. Six components read only
 * the first, so turning effects off left the KPI tiles glowing, the quick
 * actions glinting, the sign-in aurora running and the wordmark animating per
 * character. Every spec below therefore sets `visualEffects: true` and only
 * `effectsEnabled: false` — a gate that reads the wrong flag has no way to pass.
 *
 * PART 2 — the category that was never wired. `hoverEffect` had a `<Select>`,
 * a store slot and a renderer (`HoverEffect`) that was rendered nowhere. The
 * dashboard called `SpotlightCard` and `GlareHover` directly, so all six
 * combinations of menu item × switch drew the same pixels.
 *
 * WHAT IS ASSERTED. Not the flag, and not "the layer is hidden": a layer can be
 * transparent while its handlers still run rect math and schedule frames on
 * every mouse move, which is the CPU cost an operator turns effects off to
 * avoid. So each spec below watches something the effect DOES — a scheduled
 * animation frame, a DOM layer, per-character elements, a wrapper around a list
 * item — and the positive half of each pair pins that the repair did not simply
 * disable the feature for everyone.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'

import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { useEffectsStore, type HoverEffectId } from '@/lib/theme/effects-store'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { DashboardKpiGrid } from '@/features/dashboard/dashboard-kpi-grid'
import { DashboardQuickActions } from '@/features/dashboard/dashboard-quick-actions'
import type { DashboardSummaryInterface } from '@/features/dashboard/dashboard-api'

import { AnimatedList } from './AnimatedList'
import { Aurora } from './Aurora'
import { GlareHover } from './GlareHover'
import { Noise } from './Noise'
import { SplitText } from './SplitText'
import { SpotlightCard } from './SpotlightCard'

/**
 * The operator flipped the switch off — and nothing else. `visualEffects` stays
 * ON so a component that still reads it cannot pass by accident.
 */
function switchedOff(): void {
  useAppearanceStore.setState({ visualEffects: true })
  useEffectsStore.setState({ effectsEnabled: false })
}

/** jsdom lays everything out at 0×0; both hover effects divide by the rect. */
function withLayout(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, width: 200, height: 100, top: 0, left: 0, right: 200, bottom: 100,
    toJSON: () => ({}),
  } as DOMRect)
}

/** Every frame the component under test asked the browser for. */
function frameLedger() {
  return vi.spyOn(window, 'requestAnimationFrame')
}

beforeEach(() => {
  useEffectsStore.getState().reset()
  useAppearanceStore.setState({ visualEffects: true, animationsEnabled: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ── Part 1: the six components that ignored the switch ───────────────────────

describe('SpotlightCard', () => {
  it('draws no spotlight and schedules no frame once the switch is off', () => {
    switchedOff()
    withLayout()
    const raf = frameLedger()

    const { container } = render(
      <SpotlightCard className="probe">
        <b data-testid="card">card</b>
      </SpotlightCard>,
    )
    const root = container.querySelector('.spotlight-effect') as HTMLElement

    fireEvent.mouseEnter(root)
    fireEvent.mouseMove(root, { clientX: 40, clientY: 30 })
    fireEvent.mouseLeave(root)

    // No gradient layer to light up…
    expect(root.querySelector('.pointer-events-none')).toBeNull()
    // …and, the half a hidden-layer patch would miss, no per-move rect math and
    // no frame queued behind it.
    expect(raf).not.toHaveBeenCalled()
    // The card itself is untouched — this gate hides decoration, not content.
    expect(root.querySelector('[data-testid="card"]')).not.toBeNull()
  })

  it('still follows the cursor while the switch is on', () => {
    withLayout()
    const raf = frameLedger()

    const { container } = render(
      <SpotlightCard className="probe">
        <b data-testid="card">card</b>
      </SpotlightCard>,
    )
    const root = container.querySelector('.spotlight-effect') as HTMLElement
    const overlay = root.querySelector('.pointer-events-none') as HTMLElement
    expect(overlay).not.toBeNull()

    fireEvent.mouseEnter(root)
    expect(overlay.style.opacity).toBe('1')

    fireEvent.mouseMove(root, { clientX: 40, clientY: 30 })
    expect(raf).toHaveBeenCalledTimes(1)
    act(() => {
      raf.mock.calls[0][0](0)
    })
    expect(overlay.style.background).toContain('radial-gradient')
  })
})

describe('GlareHover', () => {
  it('draws no glare and schedules no frame once the switch is off', () => {
    switchedOff()
    withLayout()
    const raf = frameLedger()

    const { container } = render(
      <GlareHover className="probe">
        <b data-testid="button">action</b>
      </GlareHover>,
    )
    const root = container.querySelector('.glare-hover-effect') as HTMLElement

    fireEvent.mouseEnter(root)
    fireEvent.mouseMove(root, { clientX: 40, clientY: 30 })
    fireEvent.mouseLeave(root)

    expect(root.querySelector('.pointer-events-none')).toBeNull()
    expect(raf).not.toHaveBeenCalled()
    expect(root.querySelector('[data-testid="button"]')).not.toBeNull()
  })

  it('still follows the cursor while the switch is on', () => {
    withLayout()
    const raf = frameLedger()

    const { container } = render(
      <GlareHover className="probe">
        <b data-testid="button">action</b>
      </GlareHover>,
    )
    const root = container.querySelector('.glare-hover-effect') as HTMLElement
    const glare = root.querySelector('.pointer-events-none') as HTMLElement
    expect(glare).not.toBeNull()

    fireEvent.mouseEnter(root)
    expect(glare.style.opacity).toBe('1')

    fireEvent.mouseMove(root, { clientX: 40, clientY: 30 })
    expect(raf).toHaveBeenCalledTimes(1)
    act(() => {
      raf.mock.calls[0][0](0)
    })
    expect(glare.style.background).toContain('radial-gradient')
  })
})

describe('Noise', () => {
  it('renders no texture once the switch is off', () => {
    switchedOff()

    const { container } = render(<Noise />)

    expect(container).toBeEmptyDOMElement()
  })

  it('still renders its turbulence filter while the switch is on', () => {
    const { container } = render(<Noise />)

    expect(container.querySelector('feTurbulence')).not.toBeNull()
  })
})

describe('Aurora', () => {
  it('renders no blobs once the switch is off', () => {
    switchedOff()

    const { container } = render(<Aurora />)

    // The blobs are driven by CSS keyframes (`animate-aurora-*`). There is no
    // JS frame loop to stop, so absence from the DOM is the whole of "stopped".
    expect(container).toBeEmptyDOMElement()
  })

  it('still renders three animated blobs while the switch is on', () => {
    const { container } = render(<Aurora />)

    expect(container.querySelectorAll('.aurora-blob')).toHaveLength(3)
    expect(container.querySelector('.animate-aurora-1')).not.toBeNull()
  })
})

describe('SplitText', () => {
  const WORDMARK = 'Rezeis'

  it('leaves the text whole once the switch is off', () => {
    switchedOff()

    const { container } = render(<SplitText text={WORDMARK} />)

    // One span, holding the string — not one span per character, each with its
    // own staggered transition.
    expect(container.querySelectorAll('span')).toHaveLength(1)
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0)
    expect(container.textContent).toBe(WORDMARK)
  })

  it('still animates character by character while the switch is on', () => {
    const { container } = render(<SplitText text={WORDMARK} />)

    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(WORDMARK.length)
    expect(container.textContent).toBe(WORDMARK)
  })
})

describe('AnimatedList', () => {
  const items = [
    <span key="a" data-testid="item-a">a</span>,
    <span key="b" data-testid="item-b">b</span>,
  ]

  it('mounts its children bare once the switch is off', () => {
    switchedOff()

    const { container } = render(<AnimatedList className="probe">{items}</AnimatedList>)
    const root = container.querySelector('.probe') as HTMLElement

    // No per-item motion wrapper means no staggered entrance to run.
    expect(root.firstElementChild?.getAttribute('data-testid')).toBe('item-a')
    expect(root.querySelectorAll('div')).toHaveLength(0)
  })

  it('still wraps each child for its staggered entrance while the switch is on', () => {
    const { container } = render(<AnimatedList className="probe">{items}</AnimatedList>)
    const root = container.querySelector('.probe') as HTMLElement

    expect(root.firstElementChild?.getAttribute('data-testid')).not.toBe('item-a')
    expect(root.querySelector('[data-testid="item-a"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="item-b"]')).not.toBeNull()
  })
})

// ── Part 2: the hover-effect category reaching the dashboard ─────────────────

const SUMMARY: DashboardSummaryInterface = {
  checkedAt: '2026-08-15T12:00:00.000Z',
  users: { total: 42, blocked: 3, recentRegistered7d: 5 },
  subscriptions: { active: 11, limited: 2, expired: 7, expiring7d: 8 },
  transactions: { completed: 9, pending: 4, failed: 1, grossVolume: '125.50' },
  operations: { broadcastDrafts: 6, importDryRunAvailable: true },
  financeOps: {
    refundRequests: 2, executedRefunds: 1, correctionNotes: 3,
    correctionRequests: 4, disputeRecords: 5, reconciliationExceptions: 6,
  },
  metrics: [],
  operationsTimeline: [],
  financeOpsTimeline: [],
  attentionItems: [],
}

/** The grid renders one wrapper per KPI; the count is part of the contract. */
const KPI_COUNT = 8

/**
 * `useId` numbers per root, so Noise's filter id differs between two renders of
 * an identical tree (`_r_0_` → `_r_8_`). Normalising it is what keeps the
 * comparison below a statement about the hover wrapper instead of about the
 * order the specs happened to run in — without it this file reported the KPI
 * grid's three markups as "different" while the grid still hard-coded
 * `<SpotlightCard>` and every byte that mattered was identical.
 *
 * The pattern is React 19's spelling. React 18 emitted `:r0:`; both are matched
 * so an upgrade cannot quietly restore that false pass.
 */
function markupOf(container: HTMLElement): string {
  return container.innerHTML.replace(/_r_[0-9a-z]+_|:r[0-9a-z]+:/gi, 'REACT_ID')
}

function renderKpiGrid(hoverEffect: HoverEffectId) {
  useEffectsStore.setState({ hoverEffect })
  return renderWithProviders(<DashboardKpiGrid summary={SUMMARY} />)
}

function renderQuickActions(hoverEffect: HoverEffectId) {
  useEffectsStore.setState({ hoverEffect })
  return renderWithProviders(<DashboardQuickActions />)
}

describe('the dashboard honours the hover effect the operator picked', () => {
  beforeAll(async () => {
    // The dashboard bundle is lazy-loaded by the router; these specs bypass it.
    await loadFeatureBundle('dashboard')
  })

  beforeEach(() => {
    // CountUp eases its numbers over ~700 ms of real frames, which would make
    // two renders of the same grid differ for a reason that has nothing to do
    // with hover effects. Off, it jumps straight to the final value.
    useAppearanceStore.setState({ animationsEnabled: false })
  })

  it('gives the KPI grid three different markups for the three choices', () => {
    const spotlight = markupOf(renderKpiGrid('spotlight').container)
    cleanup()
    const glare = markupOf(renderKpiGrid('glare').container)
    cleanup()
    const none = markupOf(renderKpiGrid('none').container)

    // Byte-identical today: the grid hard-coded `<SpotlightCard>`, so the menu
    // was decoration on a value nothing read.
    expect(spotlight).not.toEqual(glare)
    expect(glare).not.toEqual(none)
    expect(spotlight).not.toEqual(none)
  })

  it.each([
    ['spotlight' as const, KPI_COUNT, 0],
    ['glare' as const, 0, KPI_COUNT],
    ['none' as const, 0, 0],
  ])('KPI grid under %s renders %i spotlight and %i glare wrappers', (choice, spots, glares) => {
    const { container } = renderKpiGrid(choice)

    expect(container.querySelectorAll('.spotlight-effect')).toHaveLength(spots)
    expect(container.querySelectorAll('.glare-hover-effect')).toHaveLength(glares)
    // Whichever wrapper wins, the tiles themselves are always there.
    expect(container.querySelectorAll('.grid > *')).toHaveLength(KPI_COUNT)
  })

  it('gives the quick actions three different markups for the three choices', () => {
    const spotlight = markupOf(renderQuickActions('spotlight').container)
    cleanup()
    const glare = markupOf(renderQuickActions('glare').container)
    cleanup()
    const none = markupOf(renderQuickActions('none').container)

    expect(spotlight).not.toEqual(glare)
    expect(glare).not.toEqual(none)
    expect(spotlight).not.toEqual(none)
  })

  it.each([
    ['spotlight' as const, 6, 0],
    ['glare' as const, 0, 6],
    ['none' as const, 0, 0],
  ])('quick actions under %s render %i spotlight and %i glare wrappers', (choice, spots, glares) => {
    const { container } = renderQuickActions(choice)

    expect(container.querySelectorAll('.spotlight-effect')).toHaveLength(spots)
    expect(container.querySelectorAll('.glare-hover-effect')).toHaveLength(glares)
    expect(container.querySelectorAll('button')).toHaveLength(6)
  })

  it('drops both wrappers when the switch is off, whatever the menu says', () => {
    switchedOff()
    useAppearanceStore.setState({ animationsEnabled: false })
    const { container } = renderKpiGrid('spotlight')

    expect(container.querySelectorAll('.spotlight-effect')).toHaveLength(0)
    expect(container.querySelectorAll('.glare-hover-effect')).toHaveLength(0)
    // …and the Noise texture inside each tile goes with them.
    expect(container.querySelector('feTurbulence')).toBeNull()
    expect(container.querySelectorAll('.grid > *')).toHaveLength(KPI_COUNT)
  })
})

// ── Part 3: with effects on and the shipped defaults, nothing moved ──────────

describe('the shipped defaults are unchanged', () => {
  beforeAll(async () => {
    await loadFeatureBundle('dashboard')
  })

  it('keeps the KPI tiles wrapped in a spotlight carrying the layout classes', () => {
    useAppearanceStore.setState({ animationsEnabled: false })
    // No setState at all — this is `reset()` from beforeEach, i.e. what an
    // operator who never opened the settings page has.
    expect(useEffectsStore.getState().hoverEffect).toBe('spotlight')
    expect(useEffectsStore.getState().effectsEnabled).toBe(true)

    const { container } = renderWithProviders(<DashboardKpiGrid summary={SUMMARY} />)

    const wrappers = container.querySelectorAll('.spotlight-effect')
    expect(wrappers).toHaveLength(KPI_COUNT)
    for (const wrapper of wrappers) {
      // The grid sizes its tiles through these two; losing them on the way
      // through the new wrapper would collapse every row.
      expect(wrapper).toHaveClass('h-full', 'rounded-lg')
    }
    expect(container.querySelectorAll('feTurbulence')).toHaveLength(KPI_COUNT)
  })

  it('keeps every quick action a working button inside its rounded wrapper', () => {
    const { container } = renderWithProviders(<DashboardQuickActions />)

    const wrappers = container.querySelectorAll('.spotlight-effect')
    expect(wrappers).toHaveLength(6)
    for (const wrapper of wrappers) expect(wrapper).toHaveClass('rounded-md')
    expect(container.querySelectorAll('button')).toHaveLength(6)
  })
})
