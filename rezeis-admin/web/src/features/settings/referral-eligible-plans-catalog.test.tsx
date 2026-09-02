/**
 * The two plan pickers on the referral settings page, and the catalog behind
 * them.
 *
 * Reported from a live deployment with six plans: the "plans that qualify a
 * referral" picker showed only two. Two filters stacked to produce that —
 * `usePlans({ active: true })` on the shared query dropped the deactivated
 * plan, and the picker's own `.filter((p) => !p.isArchived)` dropped the three
 * archived ones. One query was answering two different questions with one
 * policy, and the policy was wrong for both.
 *
 * The consequence that mattered was not the missing options. It was that a
 * plan already IN the saved configuration lost its chip when it was archived:
 * the id kept being submitted by every save, the hint kept counting it, and
 * the operator had no way to see or remove it.
 *
 * These tests assert what the SAVE REQUEST CARRIES, because that is where a
 * configuration is either kept or lost. Rendering assertions are here only to
 * pin what the operator can see and act on.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18nReady } from '@/i18n/i18n'
import { api } from '@/lib/api'
import type { Plan } from '@/features/plans/plans-api'
import { renderWithProviders } from '@/test/test-utils'
import ReferralSettingsPage from './referral-settings-page'

const BASE: Plan = {
  id: 'plan-base',
  name: 'Base',
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

/** The reported deployment, plan for plan. */
const CATALOG: readonly Plan[] = [
  { ...BASE, id: 'plan-trial', name: 'Probniy', availability: 'TRIAL' },
  { ...BASE, id: 'plan-standard', name: 'Standard', isActive: false },
  { ...BASE, id: 'plan-mini', name: 'MiniFamily' },
  { ...BASE, id: 'plan-oldmoney', name: 'OldMoney', isArchived: true },
  { ...BASE, id: 'plan-starter', name: 'StarterPack', isArchived: true },
  { ...BASE, id: 'plan-unlimited', name: 'Unlimited', isArchived: true, type: 'UNLIMITED' },
]

const SELLABLE_NAMES = ['Probniy', 'MiniFamily']
/** An id no plan in `CATALOG` carries — a plan hard-deleted after being picked. */
const DELETED_PLAN_ID = 'plan-deleted-9f3a1c22'

function mountWith(options: {
  readonly eligiblePlanIds?: readonly string[]
  readonly giftPlanId?: string | null
  readonly catalog?: readonly Plan[]
}): ReturnType<typeof userEvent.setup> {
  const catalog = options.catalog ?? CATALOG
  vi.spyOn(api, 'get').mockImplementation((async (path: string) => {
    if (path === '/admin/plans') return { data: catalog }
    return {
      data: {
        referralSettings: {
          enabled: true,
          level1Reward: 5,
          eligiblePlanIds: options.eligiblePlanIds ?? [],
          pointsExchange: {
            exchangeEnabled: true,
            giftSubscription: {
              enabled: true,
              pointsCost: 30,
              giftDurationDays: 30,
              giftPlanId: options.giftPlanId ?? null,
            },
          },
        },
      },
    }
  }) as never)
  vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
  renderWithProviders(<ReferralSettingsPage />)
  return userEvent.setup()
}

function patchSpy(): ReturnType<typeof vi.fn> {
  return api.patch as unknown as ReturnType<typeof vi.fn>
}

/** The qualifying-plan chips. Nothing else on the page carries `aria-pressed`. */
function planChips(): HTMLElement[] {
  return Array.from(document.querySelectorAll('button[aria-pressed]'))
}

function chipLabels(): string[] {
  return planChips().map((chip) => (chip.textContent ?? '').trim())
}

async function saveAndReadBody(
  user: ReturnType<typeof userEvent.setup>,
): Promise<Record<string, unknown>> {
  await user.click(screen.getByRole('button', { name: /^Save$/ }))
  await vi.waitFor(() => expect(patchSpy()).toHaveBeenCalled())
  return patchSpy().mock.calls[0][1] as Record<string, unknown>
}

/**
 * Waits for the PLAN CATALOG to land, not merely for a chip to exist.
 *
 * The earlier version waited for any `aria-pressed` button, which a
 * selected-but-unknown id satisfies from local state before the catalog query
 * resolves — so assertions ran against a half-rendered picker and passed or
 * failed on timing. `Probniy` is sellable in every fixture, so its chip
 * appears only once the real list is in.
 */
async function chipsReady(): Promise<void> {
  await screen.findByRole('button', { name: /Probniy/ })
}

describe('Referral qualifying-plan picker', () => {
  beforeAll(async () => {
    await i18nReady
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ── What is offered ───────────────────────────────────────────────────────

  it('offers every plan the platform can actually sell', async () => {
    mountWith({})
    await chipsReady()

    expect(chipLabels()).toEqual(SELLABLE_NAMES)
  })

  /**
   * Deliberate: a NEW qualification on a plan nobody can buy is an outage in
   * disguise. An empty selection means "every plan qualifies", so a selection
   * of only retired plans means no purchase qualifies at all, silently.
   */
  it('does not offer a retired plan that is not already selected', async () => {
    mountWith({})
    await chipsReady()

    expect(chipLabels().join(' ')).not.toMatch(/OldMoney|Standard/)
  })

  // ── What is already configured stays visible ──────────────────────────────

  it('shows an archived plan that is already selected, marked archived', async () => {
    mountWith({ eligiblePlanIds: ['plan-oldmoney'] })
    await chipsReady()

    const chip = screen.getByRole('button', { name: /OldMoney/ })
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(within(chip).getByText('archived')).toBeInTheDocument()
  })

  it('shows a deactivated plan that is already selected, marked inactive', async () => {
    mountWith({ eligiblePlanIds: ['plan-standard'] })
    await chipsReady()

    const chip = screen.getByRole('button', { name: /Standard/ })
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(within(chip).getByText('inactive')).toBeInTheDocument()
  })

  /**
   * Plans can be hard-deleted (`DELETE /admin/plans/:planId`). The id stays in
   * `referralSettings.eligiblePlanIds` and is resubmitted by every save, so
   * without a chip of its own it is configuration nobody can ever see or drop.
   */
  /**
   * The loading window. `plans` is `undefined` until the catalog query lands,
   * and an id is only "deleted" relative to a catalog that has actually
   * arrived — computing it against an empty list made EVERY selected plan
   * flash up as deleted on a slow connection, which is a worse lie than the
   * missing chip it replaced.
   */
  it('does not call a plan deleted while the catalog is still loading', async () => {
    let releaseCatalog: (() => void) | undefined
    const catalogArrived = new Promise<void>((resolve) => {
      releaseCatalog = resolve
    })
    vi.spyOn(api, 'get').mockImplementation((async (path: string) => {
      if (path === '/admin/plans') {
        await catalogArrived
        return { data: CATALOG }
      }
      return {
        data: { referralSettings: { enabled: true, eligiblePlanIds: ['plan-mini'] } },
      }
    }) as never)
    vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    renderWithProviders(<ReferralSettingsPage />)

    // The rest of the form is up; only the catalog is outstanding.
    await screen.findByText('Invite Link Limits')
    expect(screen.queryByRole('button', { name: /Deleted plan/ })).toBeNull()

    releaseCatalog?.()
    await chipsReady()
    expect(screen.getByRole('button', { name: /MiniFamily/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.queryByRole('button', { name: /Deleted plan/ })).toBeNull()
  })

  it('shows a selected id whose plan no longer exists', async () => {
    mountWith({ eligiblePlanIds: [DELETED_PLAN_ID] })
    await chipsReady()

    expect(screen.getByRole('button', { name: /Deleted plan plan-del/ })).toBeInTheDocument()
  })

  it('counts every selected id, including the ones that are not sellable', async () => {
    mountWith({ eligiblePlanIds: ['plan-mini', 'plan-oldmoney', DELETED_PLAN_ID] })
    await chipsReady()

    expect(screen.getByText(/3 plan\(s\) selected/)).toBeInTheDocument()
    expect(planChips().filter((c) => c.getAttribute('aria-pressed') === 'true')).toHaveLength(3)
  })

  // ── What the save carries ─────────────────────────────────────────────────

  /**
   * THE DATA QUESTION. `eligiblePlanIds` is component state seeded from the
   * stored value and submitted verbatim — it is never re-derived from the
   * rendered options — so an unrenderable id was NOT dropped by an unrelated
   * save. Measured, not assumed: this passed before the picker was changed
   * too. Pinned because re-deriving the submitted list from the visible chips
   * is the obvious "tidy-up" that would turn archiving a plan into silent
   * data loss.
   */
  it('keeps a selection the picker could not render through an unrelated save', async () => {
    const user = mountWith({ eligiblePlanIds: ['plan-oldmoney', DELETED_PLAN_ID] })
    await chipsReady()

    // Edit something else entirely, the way the reported flow would.
    const reward = screen.getByLabelText('Level 1 reward')
    await user.clear(reward)
    await user.type(reward, '9')

    const body = await saveAndReadBody(user)
    expect(body.eligiblePlanIds).toEqual(['plan-oldmoney', DELETED_PLAN_ID])
    expect(body.level1Reward).toBe(9)
  })

  it('lets a retired plan be deselected, and drops it from the request', async () => {
    const user = mountWith({ eligiblePlanIds: ['plan-oldmoney', 'plan-mini'] })
    await chipsReady()

    await user.click(screen.getByRole('button', { name: /OldMoney/ }))

    const body = await saveAndReadBody(user)
    expect(body.eligiblePlanIds).toEqual(['plan-mini'])
  })

  it('lets a deleted plan id be removed once it is visible', async () => {
    const user = mountWith({ eligiblePlanIds: [DELETED_PLAN_ID, 'plan-mini'] })
    await chipsReady()

    await user.click(screen.getByRole('button', { name: /Deleted plan/ }))

    const body = await saveAndReadBody(user)
    expect(body.eligiblePlanIds).toEqual(['plan-mini'])
  })

  /**
   * ANTI-VACUITY. A picker that submitted nothing, or submitted everything,
   * would pass several of the assertions above. An ordinary selection made by
   * an ordinary click has to round-trip exactly.
   */
  it('ANTI-VACUITY: an ordinary selection round-trips unchanged', async () => {
    const user = mountWith({})
    await chipsReady()

    await user.click(screen.getByRole('button', { name: /MiniFamily/ }))

    const body = await saveAndReadBody(user)
    expect(body.eligiblePlanIds).toEqual(['plan-mini'])
  })

  it('ANTI-VACUITY: an empty selection stays empty, meaning every plan qualifies', async () => {
    const user = mountWith({})
    await chipsReady()

    expect(screen.getByText(/Nothing selected/)).toBeInTheDocument()

    const body = await saveAndReadBody(user)
    expect(body.eligiblePlanIds).toEqual([])
  })
})
