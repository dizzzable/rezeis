/**
 * The reason a device-reduction plan stopped, on the operator's screen.
 *
 * `BLOCKED` is a state the operator is expected to RE-DRIVE: fix the cause,
 * then approve again. The panel offered the approve button and never said what
 * blocked the plan, so the one move on offer was also the move that repeats the
 * failure while the cause is still live. `lastErrorCode` now reaches the
 * inspection contract (`AddOnEntitlementInspectionService.inspectSubscription`
 * selects it and maps it through); these tests are about it reaching the eye.
 *
 * Two things they deliberately pin, because both are decisions and not details:
 *
 *   • the CODE is rendered verbatim and is never looked up in the bundle. The
 *     executor composes codes at runtime — `STRICT_LIST_${kind.toUpperCase()}`
 *     and `STRICT_DELETE_${kind.toUpperCase()}` — so the set is open and no
 *     dictionary can be complete. A per-code translation map would be wrong on
 *     the day it landed, which is `referrals-icons.ts` mapping an enum that did
 *     not exist, again. Only the LABEL around the code is translated.
 *
 *   • the incident list's order is the SERVER's order. The backend answers
 *     `createdAt desc`, so the newest cause is on top — but only for as long as
 *     nothing here re-sorts or reverses it, which is what the assertion below
 *     actually holds. A plan blocked first for one reason and later for another
 *     used to keep showing the first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'

import { api } from '@/lib/api'
import { i18n } from '@/i18n/i18n'
import { usePermissionStore } from '@/features/rbac'
import { renderWithProviders } from '@/test/test-utils'
import { AddOnEntitlementInspector } from './add-on-entitlement-inspector'

const SUBSCRIPTION = 'sub-blocked-1'

/**
 * Relative, never a literal date. A fixture pinned to a wall-clock string is a
 * clock the suite cannot advance and a comparison that means something
 * different next year; here the ordering claim IS the assertion, so the
 * timestamps have to be facts the test states rather than constants it hopes
 * about.
 */
const NOW = Date.now()
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()

interface PlanFixture {
  readonly id: string
  readonly state: string
  readonly desiredLimit: number
  readonly projectionRevision: string
  readonly targetCount: number
  readonly attempts: number
  readonly lastErrorCode?: string | null
}

/** `absent` models an API older than the field — the key is not sent at all. */
function planFixture(
  id: string,
  state: string,
  lastErrorCode: string | null | 'absent',
): PlanFixture {
  const base = {
    id,
    state,
    desiredLimit: 2,
    projectionRevision: '9',
    targetCount: 3,
    attempts: 1,
  }
  return lastErrorCode === 'absent' ? base : { ...base, lastErrorCode }
}

const INCIDENTS = [
  {
    id: 'inc-latest',
    kind: 'DEVICE_REDUCTION_BLOCKED',
    severity: 'CRITICAL',
    state: 'OPEN',
    summaryCode: 'DORMANT_RETENTION_CONFLICT',
    createdAt: minutesAgo(3),
  },
  {
    id: 'inc-middle',
    kind: 'DEVICE_REDUCTION_BLOCKED',
    severity: 'CRITICAL',
    state: 'ACKNOWLEDGED',
    summaryCode: 'STRICT_LIST_MALFORMED',
    createdAt: minutesAgo(240),
  },
  {
    id: 'inc-oldest',
    kind: 'DEVICE_REDUCTION_BLOCKED',
    severity: 'CRITICAL',
    state: 'RESOLVED',
    summaryCode: 'STALE_PANEL_LINK',
    createdAt: minutesAgo(6000),
  },
]

function inspection(plans: readonly PlanFixture[]) {
  return {
    subscriptionId: SUBSCRIPTION,
    entitlements: [],
    projection: {
      desiredRevision: '9',
      state: 'PENDING',
      desiredTrafficLimitBytes: null,
      desiredDeviceLimit: 2,
      lastAppliedRevision: '8',
    },
    incidents: INCIDENTS,
    deviceReductionPlans: plans,
  }
}

function mockInspect(plans: readonly PlanFixture[]) {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === `/admin/add-on-entitlements/subscriptions/${SUBSCRIPTION}`) {
      return { data: inspection(plans) }
    }
    return { data: {} }
  })
}

function grantView(): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(['add_on_entitlements:view', 'add_on_entitlements:moderate']),
    mustChangePassword: false,
    // Not 'DEV': that role short-circuits every permission check.
    role: 'ADMIN',
    rbacRoleId: null,
    error: null,
  })
}

/** The `<section>` a titled block lives in, so assertions cannot drift across blocks. */
function sectionFor(title: string): HTMLElement {
  const heading = screen.getByText(title)
  const section = heading.closest('section')
  if (section === null) throw new Error(`"${title}" is not inside a <section>`)
  return section
}

function rowsOf(title: string): HTMLElement[] {
  return within(sectionFor(title)).getAllByRole('listitem')
}

async function openInspector(plansTitle = 'Device-reduction plans'): Promise<void> {
  renderWithProviders(<AddOnEntitlementInspector />, {
    route: `/?subscription=${SUBSCRIPTION}`,
  })
  await screen.findByText(plansTitle)
}

/**
 * Switched BEFORE the render, and only once the bundle is actually in the
 * store. `changeLanguage` resolves immediately here — no i18next backend is
 * configured — while the dictionary arrives later through a dynamic import, so
 * switching mid-test re-renders the tree from outside `act`.
 */
async function switchToRussian(): Promise<void> {
  await i18n.changeLanguage('ru')
  await waitFor(() => {
    expect(i18n.hasResourceBundle('ru', 'translation')).toBe(true)
  })
}

describe('a blocked device-reduction plan says what blocked it', () => {
  beforeEach(() => {
    grantView()
  })

  afterEach(async () => {
    cleanup()
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
    if (i18n.language !== 'en') await i18n.changeLanguage('en')
  })

  it('shows the recorded reason, and adds nothing to the plans that have none', async () => {
    mockInspect([
      planFixture('plan-blocked', 'BLOCKED', 'STALE_PANEL_LINK'),
      planFixture('plan-clean', 'PENDING', null),
      planFixture('plan-legacy', 'PENDING', 'absent'),
    ])

    await openInspector()
    const [blocked, clean, legacy] = rowsOf('Device-reduction plans')

    // The cause, on the row, next to the state that is useless without it.
    expect(blocked).toHaveTextContent('BLOCKED')
    expect(blocked).toHaveTextContent('last error STALE_PANEL_LINK')
    expect(blocked).toHaveTextContent('plan-blocked')

    // A plan that never failed reads exactly as it did before this landed: the
    // id, and no label standing over an empty value.
    for (const row of [clean, legacy]) {
      expect(row).toHaveTextContent('plan-')
      expect(row).not.toHaveTextContent('last error')
      expect(row?.textContent ?? '').not.toMatch(/\bnull\b|\bundefined\b/)
    }
  })

  it('prints the code verbatim, including codes the bundle cannot know', async () => {
    // Neither of these can be enumerated: the executor builds them from an
    // adapter's `kind` at the moment it gives up. Whatever is on the wire is
    // what the operator has to be able to grep for and quote in a ticket.
    mockInspect([
      planFixture('plan-list', 'BLOCKED', 'STRICT_LIST_MALFORMED'),
      planFixture('plan-delete', 'BLOCKED', 'STRICT_DELETE_INVALIDCONTRACT'),
      planFixture('plan-stuck', 'REMEDIATION_REQUIRED', 'STILL_OVER_LIMIT'),
    ])

    await openInspector()
    const rows = rowsOf('Device-reduction plans')

    expect(rows[0]).toHaveTextContent('last error STRICT_LIST_MALFORMED')
    expect(rows[1]).toHaveTextContent('last error STRICT_DELETE_INVALIDCONTRACT')
    // Not only BLOCKED: the executor stamps the code on every terminal stop.
    expect(rows[2]).toHaveTextContent('REMEDIATION_REQUIRED')
    expect(rows[2]).toHaveTextContent('last error STILL_OVER_LIMIT')

    // No lookup happened: a missing key renders its own path, a fallback
    // sentence renders prose. Neither may appear where the code belongs.
    const section = sectionFor('Device-reduction plans')
    expect(section.textContent ?? '').not.toContain('addOnsPage.')
  })

  it('translates the label around the code and leaves the code alone', async () => {
    mockInspect([planFixture('plan-blocked', 'BLOCKED', 'STALE_PANEL_LINK')])
    await switchToRussian()

    await openInspector('Планы сокращения устройств')

    // The operator reads Russian; the machine token stays the machine token.
    const row = await screen.findByText(/последняя ошибка STALE_PANEL_LINK/)
    expect(row).toBeInTheDocument()
    expect(screen.queryByText(/last error STALE_PANEL_LINK/)).toBeNull()
  })

  it('lists the incidents newest cause first', async () => {
    mockInspect([planFixture('plan-blocked', 'BLOCKED', 'STALE_PANEL_LINK')])

    await openInspector()
    const rows = rowsOf('Incidents')

    // Expected order is DERIVED from the timestamps, not read off the fixture
    // array: the claim is "newest on top", not "in the order I typed them".
    const newestFirst = [...INCIDENTS].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )
    expect(rows).toHaveLength(INCIDENTS.length)
    newestFirst.forEach((incident, index) => {
      expect(rows[index]).toHaveTextContent(`${incident.summaryCode} · ${incident.id}`)
    })

    const newest = INCIDENTS.reduce((a, b) =>
      Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a,
    )
    expect(rows[0]).toHaveTextContent(newest.summaryCode)
  })

  it('reports a failed inspection as a failure, never as a subscription with no plans', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('gateway timeout'))

    renderWithProviders(<AddOnEntitlementInspector />, {
      route: `/?subscription=${SUBSCRIPTION}`,
    })

    // "No device-reduction plans for this subscription." is a claim about the
    // operator's data. A read that never answered has made no such claim.
    await screen.findByText('Failed to load the subscription. Check the ID.')
    expect(screen.queryByText('No device-reduction plans for this subscription.')).toBeNull()
    expect(screen.queryByText('No incidents for this subscription.')).toBeNull()
  })
})
