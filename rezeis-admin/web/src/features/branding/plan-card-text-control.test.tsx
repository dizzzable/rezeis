/**
 * The per-plan card-text control in the tariff-cards editor.
 *
 * The control is one dropdown, and almost everything that can go wrong with it
 * is about the value that is NOT stored:
 *
 *   - a tariff card inherits `subscriptionCardText` until it is given its own
 *     policy, and inheritance is expressed by the ABSENCE of a `text` field.
 *     So selecting "same as the subscription card" has to leave no trace — an
 *     entry carrying `{ mode: 'inherit' }` would make an install that chose
 *     inherit differ from one that never opened the control, and would leave
 *     the row badge reading "custom" with nothing to show for it;
 *   - a text-only entry is a real configuration. `setStyle` deletes an entry
 *     whose every field is empty, and a plan whose only decision is "this card
 *     gets light text" must not be deleted by that rule;
 *   - the operator must SEE the result. The row thumb previously drew white
 *     copy unconditionally, so a "dark text" choice looked like nothing had
 *     happened — and the mistake would only surface on a subscriber's screen.
 */
import { useState } from 'react'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi, afterEach } from 'vitest'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import type { Plan } from '@/features/plans/plans-api'
import { BrandingPreview } from './branding-preview'
import { PlanCardStylesSection } from './plan-card-styles-section'
import type {
  BrandingSubscriptionCardTextDraft,
  PlanCardStyleDraft,
} from './branding-form-schema'

/** Radix's Select trigger needs these; jsdom ships none of them. */
beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto['hasPointerCapture'] ??= () => false
  proto['setPointerCapture'] ??= () => {}
  proto['releasePointerCapture'] ??= () => {}
  proto['scrollIntoView'] ??= () => {}
})

afterEach(() => {
  vi.restoreAllMocks()
})

const PLAN: Plan = {
  id: 'plan-live',
  name: 'Premium Live',
  description: null,
  tag: null,
  icon: null,
  type: 'TRAFFIC',
  availability: 'ALL',
  trafficLimit: 50,
  deviceLimit: 1,
  trafficLimitStrategy: 'MONTH',
  isActive: true,
  isArchived: false,
  orderIndex: 0,
  internalSquads: [],
  externalSquad: null,
  durations: [],
  replacementPlanIds: [],
  upgradeToPlanIds: [],
}

type StyleMap = Record<string, PlanCardStyleDraft>

/**
 * The section is controlled, and these cases drive sequences of edits, so the
 * harness holds the map exactly as the branding form does. `latest` is what the
 * form would have submitted at that point.
 */
function renderSection(input: {
  readonly initial?: StyleMap
  readonly subscriptionCardText?: BrandingSubscriptionCardTextDraft
}) {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) =>
    path === '/admin/plans' ? { data: [PLAN] } : { data: [] },
  )
  const seen: StyleMap[] = []

  function Harness() {
    const [value, setValue] = useState<StyleMap>(input.initial ?? {})
    return (
      <PlanCardStylesSection
        value={value}
        onChange={(next) => {
          seen.push(next)
          setValue(next)
        }}
        primary="#7c3aed"
        subscriptionCardText={input.subscriptionCardText ?? { mode: 'auto', color: null }}
      />
    )
  }

  renderWithProviders(<Harness />)
  return {
    user: userEvent.setup(),
    latest: (): StyleMap | undefined => seen[seen.length - 1],
    seen,
  }
}

/**
 * jsdom reports an inline colour as `rgb(r, g, b)`, so compare against that
 * rather than the hex the component was given — otherwise a passing assertion
 * would only prove the string was copied somewhere, not that it was applied.
 */
function rgb(hex: string): string {
  const value = hex.replace('#', '')
  const channels =
    value.length === 3 ? [...value].map((c) => `${c}${c}`) : value.match(/.{2}/g)!
  return `rgb(${channels.map((c) => parseInt(c, 16)).join(', ')})`
}

function renderedColour(node: HTMLElement | null): string | null {
  return node?.style.color ?? null
}

/** Opens the row's editor; the controls are collapsed until the row is clicked. */
async function openRow(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const [label] = await screen.findAllByText('Premium Live')
  await user.click(label)
}

async function chooseMode(
  user: ReturnType<typeof userEvent.setup>,
  option: string,
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: 'Card text' }))
  await user.click(screen.getByRole('option', { name: option }))
}

describe('per-plan card text control', () => {
  it('reads inherit from an entry that has no text at all', async () => {
    const { user } = renderSection({ initial: { 'plan-live': { accent: '#22c55e' } } })
    await openRow(user)

    // Absence is the inherit state; if the control defaulted to `auto` instead,
    // every already-configured plan would silently detach from the global
    // policy the first time an operator opened this row.
    expect(screen.getByRole('combobox', { name: 'Card text' })).toHaveTextContent(
      'Same as the subscription card',
    )
  })

  it('offers the same four policies as the subscription card, plus inherit', async () => {
    const { user } = renderSection({})
    await openRow(user)
    await user.click(screen.getByRole('combobox', { name: 'Card text' }))

    for (const option of [
      'Same as the subscription card',
      'Automatic contrast',
      'Light text',
      'Dark text',
      'Custom colour',
    ]) {
      expect(screen.getByRole('option', { name: option })).toBeInTheDocument()
    }
  })

  it('stores a text-only entry for a plan with no other styling', async () => {
    const { user, latest } = renderSection({})
    await openRow(user)
    await chooseMode(user, 'Light text')

    expect(latest()).toEqual({ 'plan-live': { text: { mode: 'light', color: null } } })
  })

  it('removes the entry entirely when the plan goes back to inherit', async () => {
    const { user, latest } = renderSection({
      initial: { 'plan-live': { text: { mode: 'dark', color: null } } },
    })
    await openRow(user)
    await chooseMode(user, 'Same as the subscription card')

    // Not `{ 'plan-live': { text: { mode: 'inherit' } } }` — see the file note.
    expect(latest()).toEqual({})
  })

  it('keeps the rest of the styling when only the text goes back to inherit', async () => {
    const { user, latest } = renderSection({
      initial: {
        'plan-live': { gradient: 'linear-gradient(90deg,#111,#222)', text: { mode: 'light', color: null } },
      },
    })
    await openRow(user)
    await chooseMode(user, 'Same as the subscription card')

    expect(latest()).toEqual({
      'plan-live': {
        gradient: 'linear-gradient(90deg,#111,#222)',
        text: { mode: 'inherit', color: null },
      },
    })
  })

  it('drops the colour when leaving custom, and seeds one when entering it', async () => {
    const { user, latest } = renderSection({})
    await openRow(user)

    await chooseMode(user, 'Custom colour')
    // Seeded from the brand primary so the swatch and the card show something
    // deliberate immediately; a `custom` with no colour is refused by the
    // schema and would fail the whole branding save at a path no input owns.
    expect(latest()).toEqual({ 'plan-live': { text: { mode: 'custom', color: '#7c3aed' } } })

    await chooseMode(user, 'Dark text')
    expect(latest()).toEqual({ 'plan-live': { text: { mode: 'dark', color: null } } })
  })

  it('shows the colour inputs only for custom', async () => {
    const { user } = renderSection({})
    await openRow(user)
    expect(screen.queryByLabelText('Custom text colour')).not.toBeInTheDocument()

    await chooseMode(user, 'Custom colour')
    expect(screen.getByLabelText('Custom text colour')).toBeInTheDocument()
  })

  describe('the row preview', () => {
    // The COLOUR the copy is actually painted with, not the debug attribute
    // beside it. Asserting the attribute alone would pass a card that reports
    // the right decision and then draws white anyway.
    const thumbForeground = (): (string | null)[] =>
      [...document.querySelectorAll('[data-plan-card-thumb-foreground]')].map((node) =>
        renderedColour(node.querySelector<HTMLElement>('[style*="color"]')),
      )

    it('inherits the global policy for a plan with no text of its own', async () => {
      renderSection({ subscriptionCardText: { mode: 'dark', color: null } })
      await screen.findAllByText('Premium Live')

      // The inheritance has to be visible without opening anything, or the
      // operator cannot tell which cards the global decision reached.
      expect(thumbForeground()).toContain(rgb('#0a0a0a'))
    })

    it('shows the per-plan override instead of the global policy', async () => {
      renderSection({
        initial: { 'plan-live': { text: { mode: 'custom', color: '#22c55e' } } },
        subscriptionCardText: { mode: 'dark', color: null },
      })
      await screen.findAllByText('Premium Live')

      expect(thumbForeground()).toContain(rgb('#22c55e'))
    })

    it('reports automatic contrast as auto rather than inventing a colour', async () => {
      // `auto` is the shipping default and the thumb has no contrast engine —
      // it keeps drawing white, which is what it has always done. What it must
      // not do is claim a forced colour it was never given.
      renderSection({})
      await screen.findAllByText('Premium Live')

      // No forced colour, so the thumb falls back to the white it has always
      // drawn — not to a colour it invented from a policy it was never given.
      expect(thumbForeground().every((value) => value === rgb('#ffffff'))).toBe(true)
    })
  })
})

/**
 * The phone-frame preview beside the section, which is the only surface that
 * runs the real contrast computation — so it is the one that has to be right
 * about `auto`, where the thumb settles for white.
 */
describe('the tariff cards in the live preview', () => {
  const previewForeground = (): (string | null)[] =>
    [...document.querySelectorAll<HTMLElement>('[data-preview-tariff-card]')].map((node) =>
      renderedColour(node),
    )

  function renderPreview(values: Record<string, unknown>) {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) =>
      path === '/admin/plans' ? { data: [PLAN] } : { data: [] },
    )
    renderWithProviders(<BrandingPreview values={values as never} focus="planCards" />)
  }

  it('computes automatic contrast from the card artwork', async () => {
    // Light artwork with the shipping defaults: the cabinet would draw dark
    // copy here, and a preview hard-coded to white would be lying about it.
    renderPreview({
      planCardStyles: { 'plan-live': { gradient: 'linear-gradient(90deg,#f8fafc,#e2e8f0)' } },
    })
    await screen.findAllByText('Premium Live')

    expect(previewForeground()).toContain(rgb('#0a0a0a'))
  })

  it('inherits the global card-text policy', async () => {
    renderPreview({
      subscriptionCardText: { mode: 'dark', color: null },
      planCardStyles: { 'plan-live': { gradient: 'linear-gradient(90deg,#111,#222)' } },
    })
    await screen.findAllByText('Premium Live')

    // Dark artwork, so automatic contrast would say white; the global policy
    // says dark, and an inheriting card follows it.
    expect(previewForeground()).toContain(rgb('#0a0a0a'))
  })

  it('shows the per-plan override ahead of the global policy', async () => {
    renderPreview({
      subscriptionCardText: { mode: 'dark', color: null },
      planCardStyles: {
        'plan-live': {
          gradient: 'linear-gradient(90deg,#111,#222)',
          text: { mode: 'custom', color: '#22c55e' },
        },
      },
    })
    await screen.findAllByText('Premium Live')

    expect(previewForeground()).toContain(rgb('#22c55e'))
  })
})
