/**
 * DELETING A PLAN FROM THE PLANS PAGE (plan-deletion contract v2, 13.09.2026).
 *
 * The owner's rule: an explicit button that deletes the plan in any case. The
 * server never refuses — it removes an unused plan for good and hides a plan
 * that something still uses — so the dialog's job is to say which of the two is
 * about to happen, and nothing on the page may stand between a confirmed click
 * and the DELETE.
 *
 * WHAT THESE SPECS PIN, each a separate way for the feature to rot:
 *
 *   1. PERMISSION. The control exists only for `plans:delete`, on every card,
 *      whatever state the plan is in.
 *   2. CONFIRMATION. Opening the dialog sends no DELETE, Cancel sends none, and
 *      a confirmed click sends exactly one.
 *   3. THE REFERENCES ARE SHOWN, NEVER DROPPED — a kind this build has no words
 *      for included — together with the consequences that follow from them.
 *   4. THE REFERENCES INFORM, THEY DO NOT GATE. When they cannot be fetched the
 *      dialog says so and Delete still works.
 *   5. SUCCESS AND 404 BOTH REFRESH THE LIST; any other failure is reported
 *      through the page's refusal copy and leaves the dialog open.
 *   6. EVERY WORD COMES FROM THE DICTIONARIES, asserted by driving the dialog in
 *      Russian, plural forms included.
 *
 * THE WIRE IS STUBBED AT THE AXIOS ADAPTER, not at `api.get` / `api.delete`:
 * the page's real fetchers, the real response validation and the real axios
 * error shapes all run. The stub also behaves like the server — a successful
 * DELETE removes the plan from the catalogue it serves — so "the list was
 * refetched" is observable as a card disappearing, not merely as a call count.
 *
 * ANTI-VACUITY. Expected text is read from the ACTIVE bundle with `i18n.t` and
 * each key is first proven to resolve to prose rather than to its own path; no
 * spec waits for the text it is about to assert; and the DELETE count is
 * asserted the instant the trigger is released, so a bypassed confirmation
 * fails in milliseconds instead of expiring a timeout.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { toast } from 'sonner'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePermissionStore } from '@/features/rbac'
import { i18n, i18nReady } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import PlansPage from './plans-page'
import type { Plan } from './plans-api'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

// ── The wire ────────────────────────────────────────────────────────────────

type Reply =
  | { readonly status: number; readonly data: unknown }
  | { readonly networkError: true }

interface Exchange {
  readonly method: string
  readonly url: string
}

interface Wire {
  /** What `GET /admin/plans` serves. A successful DELETE removes from it. */
  catalogue: Plan[]
  /** Per plan id; absent → `{ references: [] }`. A promise holds the answer back. */
  readonly references: Map<string, Reply | Promise<Reply>>
  /** Per plan id; absent → `{ deleted: true, removed: true }`. A promise holds the answer back. */
  readonly deletes: Map<string, Reply | Promise<Reply>>
  /** Every request the page made, in order. */
  readonly log: Exchange[]
}

let wire: Wire

const REFERENCES_PATH = /^\/admin\/plans\/([^/]+)\/references$/
const PLAN_PATH = /^\/admin\/plans\/([^/]+)$/

async function answer(method: string, url: string): Promise<Reply> {
  if (method === 'GET' && url === '/admin/plans') return { status: 200, data: wire.catalogue }

  const references = REFERENCES_PATH.exec(url)
  if (method === 'GET' && references !== null) {
    const id = decodeURIComponent(references[1])
    return (await wire.references.get(id)) ?? { status: 200, data: { planId: id, references: [] } }
  }

  const planPath = PLAN_PATH.exec(url)
  if (method === 'DELETE' && planPath !== null) {
    const id = decodeURIComponent(planPath[1])
    const reply = (await wire.deletes.get(id)) ?? { status: 200, data: { deleted: true, removed: true } }
    if ('status' in reply && reply.status === 200) {
      wire.catalogue = wire.catalogue.filter((listed) => listed.id !== id)
    }
    return reply
  }

  return { status: 404, data: { statusCode: 404, message: `Cannot ${method} ${url}`, errorCode: 'NOT_FOUND' } }
}

/** What a real adapter does with a reply: resolve 2xx, reject everything else as axios would. */
function settle(config: InternalAxiosRequestConfig, reply: Reply): AxiosResponse {
  if ('networkError' in reply) {
    throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config)
  }
  const response = {
    data: reply.data,
    status: reply.status,
    statusText: String(reply.status),
    headers: {},
    config,
  } as AxiosResponse
  if (reply.status >= 200 && reply.status < 300) return response
  throw new AxiosError(
    `Request failed with status code ${reply.status}`,
    reply.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
    config,
    undefined,
    response,
  )
}

const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const method = (config.method ?? 'get').toUpperCase()
  const url = config.url ?? ''
  wire.log.push({ method, url })
  return settle(config, await answer(method, url))
}

let originalAdapter: AxiosAdapter | undefined

const deletesSent = (): Exchange[] => wire.log.filter((exchange) => exchange.method === 'DELETE')
const catalogueReads = (): number =>
  wire.log.filter((exchange) => exchange.method === 'GET' && exchange.url === '/admin/plans').length

// ── The page ────────────────────────────────────────────────────────────────

/** Read from the ACTIVE bundle, so the Russian spec drives the same helpers. */
const deleteLabel = (): string => i18n.t('plansPage.aria.delete')
const confirmLabel = (): string => i18n.t('plansPage.deleteDialog.confirm')
const cancelLabel = (): string => i18n.t('common.cancel')

function plan(overrides: Partial<Plan> & { readonly id: string; readonly name: string }): Plan {
  return {
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
    orderIndex: 1,
    internalSquads: [],
    externalSquad: null,
    durations: [],
    replacementPlanIds: [],
    upgradeToPlanIds: [],
    cashbackMode: 'INHERIT',
    cashbackPercent: null,
    ...overrides,
  }
}

/** The three states a plan can be in; the control must not care which. */
const ON_SALE = plan({ id: 'plan-on-sale', name: 'Premium', isActive: true, isArchived: false })
const INACTIVE = plan({ id: 'plan-inactive', name: 'Paused', isActive: false, isArchived: false, orderIndex: 2 })
const ARCHIVED = plan({ id: 'plan-archived', name: 'Legacy', isActive: false, isArchived: true, orderIndex: 3 })

function grant(...permissions: string[]): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(permissions),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

async function renderPage(plans: readonly Plan[]): Promise<ReturnType<typeof userEvent.setup>> {
  wire.catalogue = [...plans]
  const user = userEvent.setup()
  renderWithProviders(<PlansPage />)
  // Every card is on screen before any spec reads one, so "no delete control"
  // cannot pass on a page that rendered nothing.
  for (const listed of plans) {
    expect(await screen.findByTitle(listed.name)).toBeInTheDocument()
  }
  return user
}

/**
 * The controls of the card titled `name`: the nearest ancestor of its title
 * that holds a switch. Walked up from the title, so the controls returned can
 * only be that plan's; never matched on a CSS class.
 */
function controlsOf(name: string): HTMLElement {
  for (let node: HTMLElement | null = screen.getByTitle(name); node !== null; node = node.parentElement) {
    if (within(node).queryAllByRole('switch').length > 0) return node
  }
  throw new Error(`no card titled ${name}`)
}

async function openDeleteDialog(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
): Promise<HTMLElement> {
  await user.click(within(controlsOf(name)).getByRole('button', { name: deleteLabel() }))
  return screen.findByRole('alertdialog')
}

/** Waits until the dialog is no longer checking — never for the text a spec then asserts. */
async function referencesSettled(dialog: HTMLElement): Promise<void> {
  const checking = i18n.t('plansPage.deleteDialog.checking')
  await waitFor(() => expect(within(dialog).queryByText(checking)).toBeNull())
}

function referencesReply(planId: string, references: ReadonlyArray<{ kind: string; count: number }>): Reply {
  return { status: 200, data: { planId, references } }
}

// ── Specs ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await i18nReady
  // Anti-vacuity: with no bundle every `i18n.t` below returns its key path, and
  // a spec looking up a button or a sentence by a key path finds nothing real.
  for (const key of [
    'plansPage.aria.delete',
    'plansPage.deleteDialog.title',
    'plansPage.deleteDialog.confirm',
    'plansPage.deleteDialog.checking',
    'plansPage.deleteDialog.unused',
    'plansPage.deleteDialog.used',
    'plansPage.deleteDialog.usedBy',
    'plansPage.deleteDialog.checkFailed',
    'plansPage.deleted',
    'plansPage.deleteFailed',
    'plansPage.alreadyDeleted',
    'planWriteRefusal.deleteReferenced',
    'common.cancel',
  ]) {
    expect(i18n.t(key)).not.toBe(key)
  }
})

beforeEach(() => {
  wire = { catalogue: [], references: new Map(), deletes: new Map(), log: [] }
  originalAdapter = api.defaults.adapter as AxiosAdapter | undefined
  api.defaults.adapter = adapter
})

afterEach(() => {
  cleanup()
  api.defaults.adapter = originalAdapter
  usePermissionStore.getState().reset()
  vi.clearAllMocks()
})

describe('who sees the delete control', () => {
  it('offers no delete control to an operator without plans:delete', async () => {
    grant('plans:view', 'plans:create', 'plans:edit')
    await renderPage([ON_SALE, ARCHIVED])

    // Anti-vacuity: the cards and their other controls are there.
    expect(
      within(controlsOf(ON_SALE.name)).getByRole('button', { name: i18n.t('plansPage.aria.archive') }),
    ).toBeInTheDocument()
    expect(
      within(controlsOf(ARCHIVED.name)).getByRole('button', { name: i18n.t('plansPage.aria.unarchive') }),
    ).toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: deleteLabel() })).toEqual([])
  })

  it('puts exactly one delete control on every card, on sale, inactive or archived', async () => {
    grant('plans:view', 'plans:delete')
    const plans = [ON_SALE, INACTIVE, ARCHIVED]
    await renderPage(plans)

    for (const listed of plans) {
      expect(within(controlsOf(listed.name)).getAllByRole('button', { name: deleteLabel() })).toHaveLength(1)
    }
    expect(screen.getAllByRole('button', { name: deleteLabel() })).toHaveLength(plans.length)
  })
})

describe('the confirmation', () => {
  it('sends no DELETE when the dialog opens, and none when it is cancelled', async () => {
    grant('plans:delete')
    const user = await renderPage([ON_SALE])

    await user.click(within(controlsOf(ON_SALE.name)).getByRole('button', { name: deleteLabel() }))
    // Before any wait: a bypassed confirmation has sent it by now.
    expect(deletesSent()).toEqual([])

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.title', { name: ON_SALE.name }))
    await referencesSettled(dialog)
    expect(wire.log).toContainEqual({ method: 'GET', url: '/admin/plans/plan-on-sale/references' })
    expect(deletesSent()).toEqual([])

    await user.click(within(dialog).getByRole('button', { name: cancelLabel() }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(deletesSent()).toEqual([])
    expect(screen.getByTitle(ON_SALE.name)).toBeInTheDocument()
  })

  it('holds Delete while the references load, and releases it once they arrive', async () => {
    grant('plans:delete')
    let release: (reply: Reply) => void = () => undefined
    wire.references.set(ARCHIVED.id, new Promise<Reply>((resolve) => (release = resolve)))
    const user = await renderPage([ARCHIVED])

    const dialog = await openDeleteDialog(user, ARCHIVED.name)
    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.checking'))
    expect(within(dialog).getByRole('button', { name: confirmLabel() })).toBeDisabled()

    release(referencesReply(ARCHIVED.id, []))
    await referencesSettled(dialog)
    expect(within(dialog).getByRole('button', { name: confirmLabel() })).toBeEnabled()
    expect(deletesSent()).toEqual([])
  })

  it('says an unused plan goes for good, sends exactly one DELETE and refetches the list', async () => {
    grant('plans:delete')
    const user = await renderPage([ARCHIVED, ON_SALE])

    const dialog = await openDeleteDialog(user, ARCHIVED.name)
    await referencesSettled(dialog)

    const unused = i18n.t('plansPage.deleteDialog.unused', { name: ARCHIVED.name })
    expect(unused).toContain(ARCHIVED.name)
    expect(dialog).toHaveTextContent(unused)
    expect(dialog).not.toHaveTextContent(i18n.t('plansPage.deleteDialog.used'))
    expect(within(dialog).queryByRole('list')).toBeNull()

    const readsBefore = catalogueReads()
    await user.click(within(dialog).getByRole('button', { name: confirmLabel() }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(deletesSent()).toEqual([{ method: 'DELETE', url: '/admin/plans/plan-archived' }])
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())

    // THE INVALIDATION, observed: the catalogue is read again and the card of
    // the deleted plan is gone, while the other one stays.
    await waitFor(() => expect(screen.queryByTitle(ARCHIVED.name)).not.toBeInTheDocument())
    expect(catalogueReads()).toBe(readsBefore + 1)
    expect(screen.getByTitle(ON_SALE.name)).toBeInTheDocument()
    expect(deletesSent()).toHaveLength(1)

    // …and it does not drag the deleted plan's references along with it: the
    // only thing asked for after the DELETE is the catalogue.
    const afterDelete = wire.log.slice(wire.log.findIndex((exchange) => exchange.method === 'DELETE') + 1)
    expect(afterDelete).toEqual([{ method: 'GET', url: '/admin/plans' }])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('sends exactly one DELETE when Delete is clicked again while the first is still pending', async () => {
    grant('plans:delete')
    let release: (reply: Reply) => void = () => undefined
    wire.deletes.set(ARCHIVED.id, new Promise<Reply>((resolve) => (release = resolve)))
    const user = await renderPage([ARCHIVED])

    const dialog = await openDeleteDialog(user, ARCHIVED.name)
    await referencesSettled(dialog)
    const confirm = within(dialog).getByRole('button', { name: confirmLabel() })
    await user.click(confirm)
    await waitFor(() => expect(deletesSent()).toHaveLength(1))

    expect(confirm).toBeDisabled()
    await user.click(confirm)
    await user.dblClick(confirm)
    expect(deletesSent()).toHaveLength(1)

    release({ status: 200, data: { deleted: true, removed: true } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(deletesSent()).toHaveLength(1)
    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it('cannot be dismissed with Escape while its DELETE is pending, and closes once it is answered', async () => {
    grant('plans:delete')
    let release: (reply: Reply) => void = () => undefined
    wire.deletes.set(ARCHIVED.id, new Promise<Reply>((resolve) => (release = resolve)))
    const user = await renderPage([ARCHIVED])

    const dialog = await openDeleteDialog(user, ARCHIVED.name)
    await referencesSettled(dialog)
    await user.click(within(dialog).getByRole('button', { name: confirmLabel() }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: confirmLabel() })).toBeDisabled())

    await user.keyboard('{Escape}')

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(within(screen.getByRole('alertdialog')).getByRole('button', { name: cancelLabel() })).toBeDisabled()

    release({ status: 200, data: { deleted: true, removed: true } })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(deletesSent()).toHaveLength(1)
  })

  it('asks again when the dialog is reopened, and holds Delete until the new answer arrives', async () => {
    grant('plans:delete')
    wire.references.set(ARCHIVED.id, referencesReply(ARCHIVED.id, [{ kind: 'quests', count: 1 }]))
    const user = await renderPage([ARCHIVED])
    const oneQuest = i18n.t('plansPage.deleteDialog.references.quests', { count: 1 })
    const twoQuests = i18n.t('plansPage.deleteDialog.references.quests', { count: 2 })
    expect(oneQuest).not.toBe(twoQuests)

    const first = await openDeleteDialog(user, ARCHIVED.name)
    await referencesSettled(first)
    expect(first).toHaveTextContent(oneQuest)
    await user.click(within(first).getByRole('button', { name: cancelLabel() }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())

    // Another quest took the plan meanwhile, and this time the count is slow.
    let release: (reply: Reply) => void = () => undefined
    wire.references.set(ARCHIVED.id, new Promise<Reply>((resolve) => (release = resolve)))
    const second = await openDeleteDialog(user, ARCHIVED.name)

    // The previous opening's answer is not shown with Delete already live.
    expect(second).toHaveTextContent(i18n.t('plansPage.deleteDialog.checking'))
    expect(second).not.toHaveTextContent(oneQuest)
    expect(within(second).getByRole('button', { name: confirmLabel() })).toBeDisabled()

    release(referencesReply(ARCHIVED.id, [{ kind: 'quests', count: 2 }]))
    await referencesSettled(second)
    expect(second).toHaveTextContent(twoQuests)
    expect(within(second).getByRole('button', { name: confirmLabel() })).toBeEnabled()
    expect(
      wire.log.filter((exchange) => exchange.url === `/admin/plans/${ARCHIVED.id}/references`),
    ).toHaveLength(2)
    expect(deletesSent()).toEqual([])
  })
})

describe('what the dialog says about a plan in use', () => {
  it('lists every kind that still uses the plan — one this build cannot name included — and deletes anyway', async () => {
    grant('plans:delete')
    wire.references.set(
      ON_SALE.id,
      referencesReply(ON_SALE.id, [
        { kind: 'subscriptions', count: 3 },
        { kind: 'unsettledPayments', count: 1 },
        { kind: 'promocodes', count: 2 },
        { kind: 'referralEligibility', count: 1 },
        { kind: 'loyaltyTiers', count: 4 },
        { kind: 'transitions', count: 5 },
      ]),
    )
    const user = await renderPage([ON_SALE])

    const dialog = await openDeleteDialog(user, ON_SALE.name)
    await referencesSettled(dialog)

    const list = within(dialog).getByRole('list', { name: i18n.t('plansPage.deleteDialog.usedBy') })
    const rows = within(list)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '')
    expect(rows).toEqual([
      i18n.t('plansPage.deleteDialog.references.subscriptions', { count: 3 }),
      i18n.t('plansPage.deleteDialog.references.unsettledPayments', { count: 1 }),
      i18n.t('plansPage.deleteDialog.references.promocodes', { count: 2 }),
      i18n.t('plansPage.deleteDialog.references.referralEligibility'),
      i18n.t('plansPage.deleteDialog.references.unknown', { kind: 'loyaltyTiers', count: 4 }),
      i18n.t('plansPage.deleteDialog.references.transitions', { count: 5 }),
    ])
    // Anti-vacuity: real prose, six different sentences, each carrying its own
    // number — not six key paths, and not the generic label six times.
    for (const row of rows) expect(row).not.toMatch(/plansPage\./)
    expect(new Set(rows).size).toBe(rows.length)
    expect(rows[0]).toContain('3')
    expect(rows[2]).toContain('2')
    expect(rows[4]).toContain('loyaltyTiers')
    expect(rows[4]).toContain('4')
    expect(rows[5]).toContain('5')

    // The plan lingers hidden, so the dialog says so, and states what follows
    // from the kinds present.
    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.used'))
    expect(dialog).not.toHaveTextContent(i18n.t('plansPage.deleteDialog.unused', { name: ON_SALE.name }))
    for (const consequence of ['subscribers', 'invoices', 'grants', 'cleanup']) {
      const sentence = i18n.t(`plansPage.deleteDialog.consequences.${consequence}`)
      expect(sentence).not.toMatch(/^plansPage\./)
      expect(dialog).toHaveTextContent(sentence)
    }

    // Informational, not a gate.
    await user.click(within(dialog).getByRole('button', { name: confirmLabel() }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(deletesSent()).toEqual([{ method: 'DELETE', url: '/admin/plans/plan-on-sale' }])
  })

  it('states only the consequences that follow from what uses the plan', async () => {
    grant('plans:delete')
    wire.references.set(ARCHIVED.id, referencesReply(ARCHIVED.id, [{ kind: 'quests', count: 1 }]))
    const user = await renderPage([ARCHIVED])

    const dialog = await openDeleteDialog(user, ARCHIVED.name)
    await referencesSettled(dialog)

    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.references.quests', { count: 1 }))
    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.consequences.grants'))
    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.consequences.cleanup'))
    // Direction-complete: a quest says nothing about subscribers or invoices.
    expect(dialog).not.toHaveTextContent(i18n.t('plansPage.deleteDialog.consequences.subscribers'))
    expect(dialog).not.toHaveTextContent(i18n.t('plansPage.deleteDialog.consequences.invoices'))
  })

  // An ad placement's bonus, unlike every other grant, stops when the plan goes
  // off sale — and the server reports the placement only while its bonus still
  // grants the plan. So the promise that it keeps granting is a line of its own,
  // stated exactly when the placement is reported, and the shared grants line
  // never speaks for ad bonuses.
  it('says ad placements keep granting the plan only when the server reports them, in a line of their own', async () => {
    grant('plans:delete')
    wire.references.set(ON_SALE.id, referencesReply(ON_SALE.id, [{ kind: 'adPlacements', count: 1 }]))
    const user = await renderPage([ON_SALE])

    const dialog = await openDeleteDialog(user, ON_SALE.name)
    await referencesSettled(dialog)

    const adBonuses = i18n.t('plansPage.deleteDialog.consequences.adBonuses')
    expect(adBonuses).not.toMatch(/^plansPage\./)
    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.references.adPlacements', { count: 1 }))
    expect(dialog).toHaveTextContent(adBonuses)
    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.consequences.cleanup'))
    // Direction-complete: no promo code, quest or gift is listed, so the shared
    // grants line has nothing to say.
    expect(dialog).not.toHaveTextContent(i18n.t('plansPage.deleteDialog.consequences.grants'))
  })

  it('does not claim ad bonuses keep granting a plan that only other grants hold', async () => {
    grant('plans:delete')
    // What a server answers for an archived plan an active placement still
    // names: its bonus has stopped, so the placement is not reported at all.
    wire.references.set(ARCHIVED.id, referencesReply(ARCHIVED.id, [{ kind: 'promocodes', count: 1 }]))
    const user = await renderPage([ARCHIVED])

    const dialog = await openDeleteDialog(user, ARCHIVED.name)
    await referencesSettled(dialog)

    const grants = i18n.t('plansPage.deleteDialog.consequences.grants')
    const adBonuses = i18n.t('plansPage.deleteDialog.consequences.adBonuses')
    expect(adBonuses).not.toMatch(/^plansPage\./)
    expect(dialog).toHaveTextContent(grants)
    expect(dialog).not.toHaveTextContent(adBonuses)
    expect(grants).not.toMatch(/\bad (bonus|placement)/i)
  })

  it('does not claim an unused plan still on sale is deleted permanently: it is hidden now and cleaned up at night', async () => {
    grant('plans:delete')
    const user = await renderPage([ON_SALE])

    const dialog = await openDeleteDialog(user, ON_SALE.name)
    await referencesSettled(dialog)

    const onSaleLead = i18n.t('plansPage.deleteDialog.unusedOnSale', { name: ON_SALE.name })
    expect(onSaleLead).not.toMatch(/^plansPage\./)
    expect(onSaleLead).toContain(ON_SALE.name)
    expect(dialog).toHaveTextContent(onSaleLead)
    expect(dialog).not.toHaveTextContent(i18n.t('plansPage.deleteDialog.unused', { name: ON_SALE.name }))
    expect(dialog).not.toHaveTextContent(i18n.t('plansPage.deleteDialog.used'))
  })

  it('says subscribers of an archived plan left without a replacement must choose, without claiming the plan lingers', async () => {
    grant('plans:delete')
    wire.references.set(
      ON_SALE.id,
      referencesReply(ON_SALE.id, [
        { kind: 'transitions', count: 1 },
        { kind: 'replacementOrphans', count: 1 },
      ]),
    )
    const user = await renderPage([ON_SALE])

    const dialog = await openDeleteDialog(user, ON_SALE.name)
    await referencesSettled(dialog)

    const list = within(dialog).getByRole('list', { name: i18n.t('plansPage.deleteDialog.usedBy') })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      i18n.t('plansPage.deleteDialog.references.transitions', { count: 1 }),
      i18n.t('plansPage.deleteDialog.references.replacementOrphans', { count: 1 }),
    ])
    const renewalChoice = i18n.t('plansPage.deleteDialog.consequences.renewalChoice')
    expect(renewalChoice).not.toMatch(/^plansPage\./)
    expect(dialog).toHaveTextContent(renewalChoice)
    // Nothing holds the plan: no "removed once nothing uses it", no "used" lead.
    expect(dialog).not.toHaveTextContent(i18n.t('plansPage.deleteDialog.consequences.cleanup'))
    expect(dialog).not.toHaveTextContent(i18n.t('plansPage.deleteDialog.used'))
    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.unusedOnSale', { name: ON_SALE.name }))
  })

  it('does not claim a plan used only as an upgrade target lingers — the delete removes it for good', async () => {
    grant('plans:delete')
    wire.references.set(ARCHIVED.id, referencesReply(ARCHIVED.id, [{ kind: 'transitions', count: 2 }]))
    const user = await renderPage([ARCHIVED])

    const dialog = await openDeleteDialog(user, ARCHIVED.name)
    await referencesSettled(dialog)

    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.unused', { name: ARCHIVED.name }))
    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.references.transitions', { count: 2 }))
    expect(dialog).not.toHaveTextContent(i18n.t('plansPage.deleteDialog.used'))
    expect(dialog).not.toHaveTextContent(i18n.t('plansPage.deleteDialog.consequences.cleanup'))
  })

  it.each<[string, Reply]>([
    ['a server error', { status: 500, data: { statusCode: 500, message: 'Internal server error', errorCode: 'INTERNAL_SERVER_ERROR' } }],
    ['a refused connection', { networkError: true }],
    ['a body this build cannot read', { status: 200, data: { planId: 'plan-archived', references: 'soon' } }],
  ])('still lets the operator delete after %s on the references, and says it could not check', async (_label, reply) => {
    grant('plans:delete')
    wire.references.set(ARCHIVED.id, reply)
    const user = await renderPage([ARCHIVED])

    const dialog = await openDeleteDialog(user, ARCHIVED.name)
    await referencesSettled(dialog)

    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.checkFailed'))
    // Nothing claims to know an answer it did not get.
    expect(dialog).not.toHaveTextContent(i18n.t('plansPage.deleteDialog.unused', { name: ARCHIVED.name }))
    expect(dialog).not.toHaveTextContent(i18n.t('plansPage.deleteDialog.used'))
    expect(within(dialog).queryByRole('list')).toBeNull()

    const confirm = within(dialog).getByRole('button', { name: confirmLabel() })
    expect(confirm).toBeEnabled()
    await user.click(confirm)

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(deletesSent()).toEqual([{ method: 'DELETE', url: '/admin/plans/plan-archived' }])
  })
})

describe('what the answer to the DELETE does', () => {
  it('treats a 404 as the plan already being gone: says so, closes and refetches the list', async () => {
    grant('plans:delete')
    const user = await renderPage([ARCHIVED, ON_SALE])

    const dialog = await openDeleteDialog(user, ARCHIVED.name)
    await referencesSettled(dialog)

    // Deleted from another tab while this dialog was open.
    wire.catalogue = wire.catalogue.filter((listed) => listed.id !== ARCHIVED.id)
    wire.deletes.set(ARCHIVED.id, {
      status: 404,
      data: { statusCode: 404, message: 'Plan not found', errorCode: 'NOT_FOUND' },
    })
    const readsBefore = catalogueReads()

    await user.click(within(dialog).getByRole('button', { name: confirmLabel() }))

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(i18n.t('plansPage.alreadyDeleted')))
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.queryByTitle(ARCHIVED.name)).not.toBeInTheDocument())
    expect(catalogueReads()).toBe(readsBefore + 1)
    expect(deletesSent()).toHaveLength(1)
  })

  it.each<[string, Reply, () => string]>([
    ['a refused connection', { networkError: true }, () => i18n.t('plansPage.deleteFailed')],
    [
      'an older server refusing a plan that is still in use',
      {
        status: 400,
        data: {
          statusCode: 400,
          code: 'PLAN_DELETE_REFERENCED',
          errorCode: 'PLAN_DELETE_REFERENCED',
          message: 'Plan is referenced by subscriptions or transition rules. Archive it instead.',
        },
      },
      () => i18n.t('planWriteRefusal.deleteReferenced'),
    ],
  ])('reports %s through the page’s refusal copy and keeps the dialog open', async (_label, reply, expected) => {
    grant('plans:delete')
    wire.deletes.set(ARCHIVED.id, reply)
    const user = await renderPage([ARCHIVED])

    const dialog = await openDeleteDialog(user, ARCHIVED.name)
    await referencesSettled(dialog)
    const readsBefore = catalogueReads()

    await user.click(within(dialog).getByRole('button', { name: confirmLabel() }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expected()))
    expect(expected()).not.toMatch(/^(plansPage|planWriteRefusal)\./)
    // Never the server's English diagnostic.
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('Archive it instead'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()

    // Still open, usable again for a retry, and the list was left alone.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: confirmLabel() })).toBeEnabled(),
    )
    expect(catalogueReads()).toBe(readsBefore)
    expect(screen.getByTitle(ARCHIVED.name)).toBeInTheDocument()
    expect(deletesSent()).toHaveLength(1)
  })
})

describe('in Russian', () => {
  afterEach(async () => {
    // Unmount FIRST. This hook runs before the file-level one, and switching
    // the language back under a mounted page re-renders it outside `act`.
    cleanup()
    await i18n.changeLanguage('en')
  })

  it('asks in Russian, with the plural forms Russian needs', async () => {
    await i18n.changeLanguage('ru')
    // The core Russian bundle arrives through a dynamic import; until it has,
    // `t` falls back to English and every assertion below would be about that.
    await waitFor(() => expect(i18n.t('plansPage.deleteDialog.confirm')).toBe('Удалить'))

    grant('plans:delete')
    wire.references.set(
      ON_SALE.id,
      referencesReply(ON_SALE.id, [
        { kind: 'subscriptions', count: 1 },
        { kind: 'promocodes', count: 3 },
        { kind: 'quests', count: 5 },
        { kind: 'wheelSectors', count: 22 },
        { kind: 'loyaltyTiers', count: 4 },
      ]),
    )
    const user = await renderPage([ON_SALE])

    await user.click(within(controlsOf(ON_SALE.name)).getByRole('button', { name: 'Удалить тариф' }))
    expect(deletesSent()).toEqual([])
    const dialog = await screen.findByRole('alertdialog')
    await referencesSettled(dialog)

    expect(dialog).toHaveTextContent('Удалить тариф «Premium»?')
    expect(dialog).toHaveTextContent('Тариф исчезнет из панели и кабинета, купить его больше будет нельзя.')
    const list = within(dialog).getByRole('list', { name: 'Сейчас используется:' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '1 подписка',
      '3 промокода',
      '5 заданий',
      '22 сектора колеса фортуны',
      'Другое (loyaltyTiers): 4',
    ])
    expect(dialog).toHaveTextContent('Подписчики сохранят доступ до конца срока')
    expect(dialog).toHaveTextContent('продолжат выдавать этот тариф')
    // No placement was reported, so nothing may promise an ad bonus.
    expect(dialog).not.toHaveTextContent('рекламн')
    expect(dialog).toHaveTextContent('Данные тарифа удалятся полностью, когда он перестанет где-либо использоваться.')
    expect(within(dialog).getByRole('button', { name: 'Удалить' })).toBeEnabled()
    expect(within(dialog).getByRole('button', { name: 'Отмена' })).toBeEnabled()
    // Not one word of the English copy leaked through as a fallback.
    expect(dialog).not.toHaveTextContent('Currently used by')
    expect(dialog).not.toHaveTextContent('subscription')
  })

  it('says in Russian that ad placements keep granting a plan, in their own line', async () => {
    await i18n.changeLanguage('ru')
    await waitFor(() => expect(i18n.t('plansPage.deleteDialog.confirm')).toBe('Удалить'))

    grant('plans:delete')
    wire.references.set(ON_SALE.id, referencesReply(ON_SALE.id, [{ kind: 'adPlacements', count: 2 }]))
    const user = await renderPage([ON_SALE])

    await user.click(within(controlsOf(ON_SALE.name)).getByRole('button', { name: 'Удалить тариф' }))
    const dialog = await screen.findByRole('alertdialog')
    await referencesSettled(dialog)

    const list = within(dialog).getByRole('list', { name: 'Сейчас используется:' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['2 рекламных размещения с бонусом за регистрацию'])
    expect(dialog).toHaveTextContent('Рекламные размещения продолжат выдавать этот тариф как бонус за регистрацию.')
    // The shared grants line is not stated: nothing else grants the plan.
    expect(dialog).not.toHaveTextContent('Промокоды')
    expect(dialog).not.toHaveTextContent('placement')
  })

  it('names archived plans left without a replacement in Russian, and what happens to their subscribers', async () => {
    await i18n.changeLanguage('ru')
    await waitFor(() => expect(i18n.t('plansPage.deleteDialog.confirm')).toBe('Удалить'))

    grant('plans:delete')
    wire.references.set(
      ON_SALE.id,
      referencesReply(ON_SALE.id, [
        { kind: 'transitions', count: 3 },
        { kind: 'replacementOrphans', count: 3 },
      ]),
    )
    const user = await renderPage([ON_SALE])

    await user.click(within(controlsOf(ON_SALE.name)).getByRole('button', { name: 'Удалить тариф' }))
    const dialog = await screen.findByRole('alertdialog')
    await referencesSettled(dialog)

    expect(dialog).toHaveTextContent(
      'Тариф «Premium» будет удалён вместе с длительностями и ценами. Из панели и кабинета он исчезнет сразу, а его данные удалит ночная очистка.',
    )
    const list = within(dialog).getByRole('list', { name: 'Сейчас используется:' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '3 тарифа, где он указан как улучшение или замена (оттуда он будет убран)',
      '3 архивных тарифа, которые продлевают подписчиков на этот, и других замен в продаже у них нет',
    ])
    expect(dialog).toHaveTextContent('Подписчикам этих архивных тарифов при продлении придётся самим выбрать тариф')
    expect(dialog).not.toHaveTextContent('Данные тарифа удалятся полностью')
    expect(dialog).not.toHaveTextContent('archived')
  })
})
