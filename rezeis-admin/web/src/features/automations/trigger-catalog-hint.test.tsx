import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, screen } from '@testing-library/react'

import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { TriggerCatalogHint } from './trigger-catalog-hint'
import type { CatalogEvent } from './event-catalog-api'

/**
 * WHAT THE TRIGGER FIELD SAYS BEFORE A RULE IS SAVED.
 *
 * A rule bound to an event nothing emits is the quietest failure in this
 * subsystem: the pattern filter never selects it, so there is no execution row,
 * no error and no log line, and it reads "enabled" in the list for ever. The
 * only way an operator found out was that the thing they wrote it for never
 * happened.
 *
 * The hint under the field is the one place that can say so BEFORE the rule is
 * saved rather than months after — and it has to say it as a count from the
 * operator's own history, because "this event is never emitted" is a claim the
 * panel cannot honestly make about its own source.
 */

const event = (over: Partial<CatalogEvent> = {}): CatalogEvent => ({
  type: 'payment.failed',
  namespace: 'payment',
  popupCapable: true,
  seen: 12,
  lastSeenAt: '2026-09-08T10:00:00.000Z',
  ...over,
})

function draw(spec: string, events: CatalogEvent[]) {
  return renderWithProviders(
    <TriggerCatalogHint spec={spec} events={events} windowDays={90} />,
  )
}

/**
 * The sentence a key renders right now, as a substring matcher.
 *
 * Read out of the live bundle instead of pinned here, because these cases are
 * about WHICH branch of the hint drew — which of four paragraphs, and whether a
 * suffix is appended to one of them — and not about the wording. The wording
 * moved once already: it called every template a pop-up while nine of the
 * twenty-one render as a line that does not take the screen. A pinned literal
 * turned that correction into a red test on the positive case and, worse, into
 * a silently vacuous one on the negative: `queryByText(/can carry a pop-up/)`
 * finds nothing whether the suffix is suppressed correctly or the copy simply
 * no longer says that.
 *
 * Asserting the key RESOLVES is the other half — an unresolved key comes back
 * from i18next as its own path, and a matcher built from that would match
 * nothing and pass just as quietly.
 */
function says(key: string, values?: Record<string, unknown>): RegExp {
  const sentence = String(i18n.t(key, values ?? {}))
  expect(sentence, `${key} is missing from the automations bundle`).not.toBe(key)
  return new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

describe('the trigger hint', () => {
  beforeEach(async () => {
    await loadFeatureBundle('automations')
  })

  afterEach(() => {
    cleanup()
  })

  it('says nothing at all for an empty field', () => {
    // A warning on a field somebody has not filled in yet is noise, and noise
    // is how the warning that matters stops being read.
    //
    // "Nothing" is asserted as an empty container rather than as three
    // sentences that are absent. The component has four branches and the
    // absent-sentence form only ever named three of them, so a regression into
    // the fourth read as a pass — and every one of those names was a copy
    // literal, which is a second way for the same case to stop meaning
    // anything.
    expect(draw('   ', [event()]).container).toBeEmptyDOMElement()
  })

  it('reports how often a live event has fired here', () => {
    draw('payment.failed', [event({ seen: 12 })])

    expect(screen.getByText(/Happened 12 times in 90 days/)).toBeInTheDocument()
  })

  it('warns when the event exists and has never happened here', () => {
    // THE ROW THAT MATTERS. Everything matches, nothing has fired: that is what
    // a rule that will never fire looks like from the outside.
    draw('subscription.renewed', [
      event({ type: 'subscription.renewed', seen: 0, lastSeenAt: null, popupCapable: false }),
    ])

    // The whole sentence at count 90, not a fragment of it: this is the one
    // string in the component that pluralises on the window itself, so matching
    // the finished text proves the window reached the key as a COUNT rather
    // than as pre-rendered words.
    expect(
      screen.getByText(says('automationsPage.config.triggerNeverFired', { count: 90 })),
    ).toBeInTheDocument()
  })

  it('warns when nothing in the catalogue answers to it at all', () => {
    // Not a refusal: a custom type posted to the internal events endpoint is
    // legitimate. It says what it knows, which is that it knows nothing.
    draw('paymnet.failed', [event()])

    expect(screen.getByText(says('automationsPage.config.triggerUnknown'))).toBeInTheDocument()
  })

  it('adds up a wildcard across every event it selects', () => {
    // `payment.*` fires on all of them, so one count for the pattern is the
    // number an operator is actually asking for.
    draw('payment.*', [
      event({ type: 'payment.failed', seen: 12 }),
      event({ type: 'payment.completed', seen: 30 }),
      event({ type: 'user.registered', seen: 99, namespace: 'user' }),
    ])

    expect(screen.getByText(/Happened 42 times/)).toBeInTheDocument()
    expect(screen.getByText(/2 event types matched/)).toBeInTheDocument()
  })

  it('says when the trigger can carry a hint', () => {
    draw('payment.failed', [event({ popupCapable: true })])

    expect(screen.getByText(says('automationsPage.config.triggerPopupCapable'))).toBeInTheDocument()
  })

  it('does not say so when it cannot', () => {
    // Saying it wrongly would send an operator to build a hint the save-time
    // check then refuses.
    draw('node.connection_lost', [
      event({ type: 'node.connection_lost', namespace: 'node', popupCapable: false, seen: 4 }),
    ])

    expect(
      screen.queryByText(says('automationsPage.config.triggerPopupCapable')),
    ).not.toBeInTheDocument()
  })

  it('stays quiet until the catalogue has loaded', () => {
    // An empty list is "we have not asked yet", not "this event is unknown" —
    // and warning on the first render of every editor would train the operator
    // to ignore the warning.
    expect(draw('payment.failed', []).container).toBeEmptyDOMElement()
  })
})
