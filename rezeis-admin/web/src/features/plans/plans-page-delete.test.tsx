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
 * AND, SINCE THE MIGRATION STEPS (owner decisions of 15.09.2026, spec §7):
 *
 *   7. NO SUBSCRIPTIONS → TODAY'S DIALOG. The first page of subscriptions is
 *      asked beside the references, and an empty plan deletes exactly as before.
 *   8. THE REQUEST IS WHAT WAS ASSIGNED: per-selection groups, "all N" as the
 *      rest target, exceptions after it, only non-trial targets offered.
 *   9. THE PREVIEW SHOWS WHAT THE SERVER COMPUTED, both unlimited encodings and
 *      codes this build cannot name included.
 *  10. THE DELETE COMES LAST: after the success state, after the plan was read
 *      again, once — and not at all when subscriptions landed meanwhile.
 *  11. PROBLEMS ARE THE OPERATOR'S: polling stops, and each of «Повторить для
 *      неудавшихся», «Повторить синхронизацию» and «Удалить всё равно» does what
 *      it says; Escape cannot close a running move.
 *  12. PERMISSIONS, MALFORMED BODIES AND REDUCED MOTION each change the dialog
 *      in their own way, pinned one by one.
 *
 * The migration clocks are shortened through `vi.mock` — polling every 25 ms
 * instead of 2.5 s — while `plan-migration.test.ts` pins the real values.
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
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
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
import {
  wireLimitValues,
  wirePreview,
  wirePreviewRow,
  wireProblem,
  wireRunView,
  wireSubscriptionItem,
  wireTwinBlockedDetail,
  wireUser,
  wireWarningCounts,
  type WirePreviewRow,
  type WirePreviewSummary,
  type WireProblem,
  type WireSubscriptionItem,
} from './plan-migration-wire.fixtures'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock('./plan-migration-timing', () => ({
  PLAN_MIGRATION_POLL_MS: 25,
  PLAN_MIGRATION_SEARCH_DEBOUNCE_MS: 5,
  PLAN_MIGRATION_SUCCESS_HOLD_MS: 120,
  PLAN_MIGRATION_RETRY_ECHO_MS: 150,
}))

// ── The wire ────────────────────────────────────────────────────────────────

type Reply =
  | { readonly status: number; readonly data: unknown }
  | { readonly networkError: true }
  /** No answer within the request's own timeout — what axios rejects with `ECONNABORTED`. */
  | { readonly timeout: true }

interface Exchange {
  readonly method: string
  readonly url: string
}

/** A request with its query, body and timeout. Kept apart from `log`, which specs compare as `{ method, url }`. */
interface Sent extends Exchange {
  readonly params: Readonly<Record<string, unknown>>
  readonly body: unknown
  readonly timeout: number | undefined
}

/** `call` counts the earlier requests to the same method and path, from 0. */
type Handler = (request: { readonly params: Readonly<Record<string, unknown>>; readonly body: unknown; readonly call: number }) =>
  | Reply
  | Promise<Reply>

interface Wire {
  /** What `GET /admin/plans` serves. A successful DELETE removes from it. */
  catalogue: Plan[]
  /** Per plan id; absent → `{ references: [] }`. A promise holds the answer back. */
  readonly references: Map<string, Reply | Promise<Reply>>
  /** Per plan id; absent → `{ deleted: true, removed: true }`. A promise holds the answer back. */
  readonly deletes: Map<string, Reply | Promise<Reply>>
  /** Every request the page made, in order. */
  readonly log: Exchange[]
  readonly sent: Sent[]
  /** `GET …/subscriptions` per plan id. Absent → 404, as a server without the route answers. */
  readonly subscriptions: Map<string, Handler>
  /** `POST …/migrations/preview` per plan id. */
  readonly previews: Map<string, Handler>
  /** `POST …/migrations` per plan id. */
  readonly starts: Map<string, Handler>
  /** `GET …/migrations/current` per plan id; absent → `{ runId: null }`. */
  readonly current: Map<string, Handler>
  /** `GET …/migrations/:runId` per run id. */
  readonly runs: Map<string, Handler>
  /** `POST …/migrations/:runId/retry` per run id; absent → 202. */
  readonly retries: Map<string, Handler>
  squads: { internal: Reply; external: Reply }
  /** Runs the moment a DELETE arrives, before it is answered. */
  onDelete: (() => void) | null
}

let wire: Wire

const REFERENCES_PATH = /^\/admin\/plans\/([^/]+)\/references$/
const PLAN_PATH = /^\/admin\/plans\/([^/]+)$/
const SUBSCRIPTIONS_PATH = /^\/admin\/plans\/([^/]+)\/subscriptions$/
const PREVIEW_PATH = /^\/admin\/plans\/([^/]+)\/migrations\/preview$/
const START_PATH = /^\/admin\/plans\/([^/]+)\/migrations$/
const CURRENT_PATH = /^\/admin\/plans\/([^/]+)\/migrations\/current$/
const RUN_PATH = /^\/admin\/plans\/([^/]+)\/migrations\/([^/]+)$/
const RETRY_PATH = /^\/admin\/plans\/([^/]+)\/migrations\/([^/]+)\/retry$/

async function answer(method: string, url: string, params: Readonly<Record<string, unknown>>, body: unknown): Promise<Reply> {
  if (method === 'GET' && url === '/admin/plans') return { status: 200, data: wire.catalogue }
  if (method === 'GET' && url === '/admin/plans/options/internal-squads') return wire.squads.internal
  if (method === 'GET' && url === '/admin/plans/options/external-squads') return wire.squads.external

  const references = REFERENCES_PATH.exec(url)
  if (method === 'GET' && references !== null) {
    const id = decodeURIComponent(references[1])
    return (await wire.references.get(id)) ?? { status: 200, data: { planId: id, references: [] } }
  }

  const planPath = PLAN_PATH.exec(url)
  if (method === 'DELETE' && planPath !== null) {
    const id = decodeURIComponent(planPath[1])
    wire.onDelete?.()
    const reply = (await wire.deletes.get(id)) ?? { status: 200, data: { deleted: true, removed: true } }
    if ('status' in reply && reply.status === 200) {
      wire.catalogue = wire.catalogue.filter((listed) => listed.id !== id)
    }
    return reply
  }

  const call = wire.sent.filter((earlier) => earlier.method === method && earlier.url === url).length - 1
  const routes: ReadonlyArray<readonly [string, RegExp, (match: RegExpExecArray) => Handler | undefined]> = [
    ['GET', SUBSCRIPTIONS_PATH, (match) => wire.subscriptions.get(decodeURIComponent(match[1]))],
    ['POST', PREVIEW_PATH, (match) => wire.previews.get(decodeURIComponent(match[1]))],
    ['POST', START_PATH, (match) => wire.starts.get(decodeURIComponent(match[1]))],
    // Before `:runId`, as the server must mount it: `current` is not a run id.
    [
      'GET',
      CURRENT_PATH,
      (match) => wire.current.get(decodeURIComponent(match[1])) ?? (() => ({ status: 200, data: { runId: null } })),
    ],
    ['GET', RUN_PATH, (match) => wire.runs.get(decodeURIComponent(match[2]))],
    [
      'POST',
      RETRY_PATH,
      (match) =>
        wire.retries.get(decodeURIComponent(match[2])) ??
        (() => ({ status: 202, data: { runId: decodeURIComponent(match[2]) } })),
    ],
  ]
  for (const [routeMethod, path, handlerOf] of routes) {
    const match = path.exec(url)
    if (method !== routeMethod || match === null) continue
    const handler = handlerOf(match)
    if (handler !== undefined) return handler({ params, body, call })
    // Matched but not served: a later, looser pattern must not claim it.
    break
  }

  return { status: 404, data: { statusCode: 404, message: `Cannot ${method} ${url}`, errorCode: 'NOT_FOUND' } }
}

/** What a real adapter does with a reply: resolve 2xx, reject everything else as axios would. */
function settle(config: InternalAxiosRequestConfig, reply: Reply): AxiosResponse {
  if ('networkError' in reply) {
    throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config)
  }
  if ('timeout' in reply) {
    throw new AxiosError(`timeout of ${config.timeout ?? 0}ms exceeded`, AxiosError.ECONNABORTED, config)
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
  const params = { ...((config.params ?? {}) as Record<string, unknown>) }
  // By the time the adapter runs, axios has serialised a JSON body to a string.
  const body = typeof config.data === 'string' ? (JSON.parse(config.data) as unknown) : config.data
  wire.sent.push({ method, url, params, body, timeout: config.timeout })
  return settle(config, await answer(method, url, params, body))
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
  wire = {
    catalogue: [],
    references: new Map(),
    deletes: new Map(),
    log: [],
    sent: [],
    subscriptions: new Map(),
    previews: new Map(),
    starts: new Map(),
    current: new Map(),
    runs: new Map(),
    retries: new Map(),
    squads: { internal: { status: 200, data: [] }, external: { status: 200, data: [] } },
    onDelete: null,
  }
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

// ── Moving the subscriptions before the delete ─────────────────────────────

const m = (key: string, options?: Record<string, unknown>): string =>
  i18n.t(`plansPage.deleteDialog.migrate.${key}`, options)

/** A migrate sentence, proven to be prose rather than its own key path before a spec relies on it. */
function says(key: string, options?: Record<string, unknown>): string {
  const sentence = m(key, options)
  expect(sentence).not.toMatch(/plansPage\./)
  return sentence
}

const GOLD = plan({ id: 'plan-gold', name: 'Gold', isActive: true, isArchived: false, orderIndex: 10 })
const STANDARD = plan({ id: 'plan-standard', name: 'Standard', orderIndex: 11 })
const VINTAGE = plan({ id: 'plan-vintage', name: 'Vintage', isActive: false, isArchived: true, orderIndex: 12 })
const DORMANT = plan({ id: 'plan-dormant', name: 'Dormant', isActive: false, isArchived: false, orderIndex: 13 })
const FREE_TRIAL = plan({ id: 'plan-free-trial', name: 'Free trial', availability: 'TRIAL', orderIndex: 14 })
const MIGRATION_CATALOGUE: readonly Plan[] = [GOLD, STANDARD, VINTAGE, DORMANT, FREE_TRIAL]

const SUBSCRIPTIONS_URL = `/admin/plans/${GOLD.id}/subscriptions`
const PREVIEW_URL = `/admin/plans/${GOLD.id}/migrations/preview`
const START_URL = `/admin/plans/${GOLD.id}/migrations`
const RUN_ID = 'run-1'
const RUN_URL = `/admin/plans/${GOLD.id}/migrations/${RUN_ID}`
const RETRY_URL = `${RUN_URL}/retry`

/** A live term, anchored to now so the fixture cannot drift into the past. */
const LIVE_EXPIRY = new Date(Date.now() + 40 * 86_400_000).toISOString()

/**
 * Every body below is built by `plan-migration-wire.fixtures.ts`, which
 * `plan-migration-wire-contract.test.ts` holds to the backend's own
 * declarations — so what these specs answer the dialog with is what the server
 * sends, not what the spec once said it would.
 */
type WireSubscription = WireSubscriptionItem

function onPlan(name: string, overrides: Partial<WireSubscriptionItem> = {}): WireSubscription {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return {
    ...wireSubscriptionItem(`sub-${slug}`, { user: wireUser(`user-${slug}`, { name }), expiresAt: LIVE_EXPIRY }),
    ...overrides,
  }
}

/**
 * Answers like the server (BE-MOVE): case-insensitive search over name, email
 * and the subscription id, the username without a leading `@`, the Telegram id
 * matched exactly; cursor paging; `total` ignoring the search.
 */
function page(all: readonly WireSubscription[], params: Readonly<Record<string, unknown>>): Reply {
  const search = typeof params.search === 'string' ? params.search.toLowerCase() : ''
  const handle = search.replace(/^@/, '')
  const matched =
    search.length === 0
      ? all
      : all.filter(
          (subscription) =>
            subscription.user?.telegramId === search ||
            (subscription.user?.username?.toLowerCase().includes(handle) ?? false) ||
            [subscription.subscriptionId, subscription.user?.name, subscription.user?.email].some(
              (value) => typeof value === 'string' && value.toLowerCase().includes(search),
            ),
        )
  const limit = Number(params.limit ?? 50)
  const offset = typeof params.cursor === 'string' ? Number(params.cursor.slice('after-'.length)) : 0
  return {
    status: 200,
    data: {
      total: all.length,
      matched: matched.length,
      items: matched.slice(offset, offset + limit),
      nextCursor: offset + limit < matched.length ? `after-${offset + limit}` : null,
    },
  }
}

const snapshot = wireLimitValues

function previewRow(
  subscription: WireSubscription,
  targetPlanId: string,
  overrides: Partial<Omit<WirePreviewRow, 'subscriptionId' | 'targetPlanId'>> = {},
): WirePreviewRow {
  return wirePreviewRow(subscription.subscriptionId, targetPlanId, { user: subscription.user, ...overrides })
}

/**
 * A first preview page. Its summary is the server's count over `rows` unless
 * one is given; a given one lists the warnings that matter to the spec, and the
 * rest of the codes are sent as zero, as the server sends them.
 */
function previewOf(rows: readonly WirePreviewRow[], summary?: readonly WirePreviewSummary[]): Reply {
  return {
    status: 200,
    data: wirePreview(rows, {
      summary: summary?.map((entry) => ({ ...entry, warnings: wireWarningCounts(entry.warnings) })),
    }),
  }
}

/** A run as the server reports it; its counts must add up (`wireRunView` refuses otherwise). */
function runReply(shape: {
  readonly status?: string
  readonly finished?: boolean
  readonly totals?: Partial<Record<'total' | 'pending' | 'moved' | 'skipped' | 'failed', number>>
  readonly skippedByReason?: Readonly<Record<string, number>>
  readonly sync?: Partial<Record<'total' | 'pending' | 'completed' | 'failed', number>>
  readonly problems?: readonly WireProblem[]
  readonly problemsCursor?: string | null
} = {}): Reply {
  return {
    status: 200,
    data: wireRunView({
      runId: RUN_ID,
      status: shape.status,
      totals: { total: 2, pending: 0, moved: 2, skipped: 0, failed: 0, ...shape.totals },
      skippedByReason: shape.skippedByReason,
      sync: shape.sync,
      problems: shape.problems,
      problemsCursor: shape.problemsCursor,
      finished: shape.finished,
    }),
  }
}

/** The step's visible status line — not a live region, so read by its marker. */
const headline = (dialog: HTMLElement): string | null =>
  dialog.querySelector('[data-headline]')?.textContent ?? null

/** What the dialog's one live region says right now: a milestone, or nothing. */
const announced = (dialog: HTMLElement): string | null => within(dialog).getByRole('status').textContent

const movingReply = (moved: number, total: number): Reply =>
  runReply({ status: 'RUNNING', finished: false, totals: { total, pending: total - moved, moved } })

function problem(
  subscription: WireSubscription,
  kind: string,
  reason: string,
  detail: string | null = null,
): WireProblem {
  return wireProblem(subscription.subscriptionId, {
    kind,
    reason,
    detail,
    user: subscription.user,
    targetPlanId: STANDARD.id,
  })
}

const started = (): Reply => ({ status: 202, data: { runId: RUN_ID, totalItems: 2 } })

const sentTo = (method: string, url: string): Sent[] =>
  wire.sent.filter((request) => request.method === method && request.url === url)

function held(): { readonly reply: Promise<Reply>; readonly release: (reply: Reply) => void } {
  let release: (reply: Reply) => void = () => undefined
  const reply = new Promise<Reply>((resolve) => (release = resolve))
  return { reply, release }
}

/** What moving needs: the plans, the delete, and subscriptions to view — and to edit, unless told otherwise. */
function grantMove(options: { readonly withoutEdit?: boolean } = {}): void {
  const permissions = ['plans:view', 'plans:delete', 'subscriptions:view']
  if (options.withoutEdit !== true) permissions.push('subscriptions:edit')
  grant(...permissions)
}

async function openMoveDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const dialog = await openDeleteDialog(user, GOLD.name)
  await referencesSettled(dialog)
  return dialog
}

const rowCheckbox = (dialog: HTMLElement, name: string): HTMLElement =>
  within(dialog).getByRole('checkbox', { name: m('choose.selectRow', { name }) })

function rowOf(dialog: HTMLElement, name: string): HTMLElement {
  const row = rowCheckbox(dialog, name).closest('li')
  if (row === null) throw new Error(`no row for ${name}`)
  return row
}

async function pickTarget(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  option: string,
): Promise<void> {
  await user.click(within(dialog).getByRole('combobox', { name: m('choose.targetLabel') }))
  await user.click(await screen.findByRole('option', { name: option }))
}

async function assignTo(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  rows: readonly string[] | 'shown',
  option: string,
): Promise<void> {
  if (rows === 'shown') await user.click(within(dialog).getByRole('checkbox', { name: m('choose.selectShown') }))
  else for (const name of rows) await user.click(rowCheckbox(dialog, name))
  await pickTarget(user, dialog, option)
  await user.click(within(dialog).getByRole('button', { name: m('choose.assign') }))
}

const confirmMove = (dialog: HTMLElement): HTMLElement =>
  within(dialog).getByRole('button', { name: m('preview.confirm') })

/** From an open choose step to a settled preview of "every shown row → Standard". */
async function previewEveryoneOnStandard(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement): Promise<void> {
  await assignTo(user, dialog, 'shown', STANDARD.name)
  await user.click(within(dialog).getByRole('button', { name: m('choose.next') }))
  await within(dialog).findByRole('button', { name: m('preview.back') })
  await waitFor(() => expect(within(dialog).queryByText(m('preview.loading'))).toBeNull())
}

async function startMove(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement): Promise<void> {
  await previewEveryoneOnStandard(user, dialog)
  await user.click(confirmMove(dialog))
  await waitFor(() => expect(sentTo('POST', START_URL)).toHaveLength(1))
}

describe('moving the subscriptions before the delete', () => {
  it('asks for the first page of subscriptions and the running move beside the references, and deletes a plan with none exactly as before', async () => {
    grantMove()
    const references = held()
    wire.references.set(ARCHIVED.id, references.reply)
    wire.subscriptions.set(ARCHIVED.id, ({ params }) => page([], params))
    const user = await renderPage([ARCHIVED, ON_SALE])

    const dialog = await openDeleteDialog(user, ARCHIVED.name)
    // In parallel: the list and the current run are asked while the references are still held back.
    await waitFor(() => expect(sentTo('GET', `/admin/plans/${ARCHIVED.id}/subscriptions`)).toHaveLength(1))
    await waitFor(() => expect(sentTo('GET', `/admin/plans/${ARCHIVED.id}/migrations/current`)).toHaveLength(1))
    expect(sentTo('GET', `/admin/plans/${ARCHIVED.id}/subscriptions`)[0].params).toEqual({ limit: 50 })
    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.checking'))
    expect(within(dialog).getByRole('button', { name: confirmLabel() })).toBeDisabled()

    references.release(referencesReply(ARCHIVED.id, []))
    await referencesSettled(dialog)

    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.unused', { name: ARCHIVED.name }))
    expect(within(dialog).queryByRole('list')).toBeNull()
    expect(within(dialog).queryByRole('combobox')).toBeNull()
    expect(dialog).not.toHaveTextContent(says('subscriptionsUnavailable'))
    expect(dialog).not.toHaveTextContent(says('needsSubscriptionAccess'))

    const readsBefore = catalogueReads()
    await user.click(within(dialog).getByRole('button', { name: confirmLabel() }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(deletesSent()).toEqual([{ method: 'DELETE', url: '/admin/plans/plan-archived' }])
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.queryByTitle(ARCHIVED.name)).not.toBeInTheDocument())
    expect(catalogueReads()).toBe(readsBefore + 1)
    const afterDelete = wire.log.slice(wire.log.findIndex((exchange) => exchange.method === 'DELETE') + 1)
    expect(afterDelete).toEqual([{ method: 'GET', url: '/admin/plans' }])
  })

  it('offers every other plan except trials, tagged, assigns a plan per selection, and previews exactly those groups', async () => {
    grantMove()
    const alice = onPlan('Alice')
    const bob = onPlan('Bob')
    const carol = onPlan('Carol')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice, bob, carol], params))
    wire.previews.set(GOLD.id, () =>
      previewOf([previewRow(alice, STANDARD.id), previewRow(bob, VINTAGE.id), previewRow(carol, VINTAGE.id)]),
    )
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)

    expect(dialog).toHaveTextContent(says('choose.lead', { count: 3 }))
    const list = within(dialog).getByRole('list', { name: m('choose.listLabel') })
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(dialog).not.toHaveTextContent(says('choose.needsEditPermission'))

    await user.click(within(dialog).getByRole('combobox', { name: m('choose.targetLabel') }))
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Standard',
      `Vintage · ${says('choose.archivedTag')}`,
      `Dormant · ${says('choose.inactiveTag')}`,
    ])
    await user.click(screen.getByRole('option', { name: 'Standard' }))

    const next = within(dialog).getByRole('button', { name: m('choose.next') })
    expect(next).toBeDisabled()
    await user.click(rowCheckbox(dialog, 'Alice'))
    await user.click(within(dialog).getByRole('button', { name: m('choose.assign') }))

    expect(rowOf(dialog, 'Alice')).toHaveTextContent('Standard')
    expect(rowOf(dialog, 'Bob')).toHaveTextContent(says('choose.unassigned'))
    expect(dialog).toHaveTextContent(says('choose.unassignedHint', { count: 2 }))
    expect(next).toBeDisabled()

    await assignTo(user, dialog, ['Bob', 'Carol'], `Vintage · ${m('choose.archivedTag')}`)
    expect(rowOf(dialog, 'Carol')).toHaveTextContent('Vintage')
    expect(rowOf(dialog, 'Alice')).toHaveTextContent('Standard')
    expect(dialog).toHaveTextContent(says('choose.assignedSummary', { assigned: 3, total: 3 }))
    expect(next).toBeEnabled()
    expect(sentTo('POST', PREVIEW_URL)).toEqual([])

    await user.click(next)
    await waitFor(() => expect(sentTo('POST', PREVIEW_URL)).toHaveLength(1))
    expect(sentTo('POST', PREVIEW_URL)[0].body).toEqual({
      groups: [
        { targetPlanId: STANDARD.id, subscriptionIds: [alice.subscriptionId] },
        { targetPlanId: VINTAGE.id, subscriptionIds: [bob.subscriptionId, carol.subscriptionId] },
      ],
      limit: 50,
    })
    expect(sentTo('POST', START_URL)).toEqual([])
  })

  it('maps "select all N" to the rest target, keeps rows assigned after it as exceptions, and draws a partial selection as mixed', async () => {
    grantMove()
    const members = Array.from({ length: 60 }, (_, index) => onPlan(`Member ${String(index + 1).padStart(2, '0')}`))
    wire.subscriptions.set(GOLD.id, ({ params }) => page(members, params))
    wire.previews.set(GOLD.id, () => previewOf([]))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)

    const list = within(dialog).getByRole('list', { name: m('choose.listLabel') })
    expect(within(list).getAllByRole('listitem')).toHaveLength(50)
    const shown = within(dialog).getByRole('checkbox', { name: m('choose.selectShown') })

    await user.click(rowCheckbox(dialog, 'Member 03'))
    expect(shown).toHaveAttribute('aria-checked', 'mixed')
    // A minus — not the check mark the shared checkbox draws for every state.
    expect(shown.querySelector('[data-glyph="indeterminate"]')).not.toBeNull()
    expect(shown.querySelector('[data-glyph="checked"]')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: says('choose.selectAll', { count: 60 }) })).toBeNull()

    await user.click(shown)
    expect(shown).toHaveAttribute('aria-checked', 'true')
    expect(shown.querySelector('[data-glyph="checked"]')).not.toBeNull()
    await user.click(within(dialog).getByRole('button', { name: m('choose.selectAll', { count: 60 }) }))
    expect(dialog).toHaveTextContent(says('choose.allSelected', { count: 60 }))

    await pickTarget(user, dialog, 'Standard')
    await user.click(within(dialog).getByRole('button', { name: m('choose.assign') }))
    expect(dialog).toHaveTextContent(says('choose.restGroup', { plan: 'Standard' }))
    expect(dialog).toHaveTextContent(says('choose.assignedSummary', { assigned: 60, total: 60 }))
    const next = within(dialog).getByRole('button', { name: m('choose.next') })
    expect(next).toBeEnabled()

    await assignTo(user, dialog, ['Member 07'], `Dormant · ${m('choose.inactiveTag')}`)
    expect(rowOf(dialog, 'Member 07')).toHaveTextContent('Dormant')
    expect(rowOf(dialog, 'Member 08')).toHaveTextContent('Standard')

    await user.click(next)
    await waitFor(() => expect(sentTo('POST', PREVIEW_URL)).toHaveLength(1))
    expect(sentTo('POST', PREVIEW_URL)[0].body).toEqual({
      groups: [{ targetPlanId: DORMANT.id, subscriptionIds: ['sub-member-07'] }],
      restTargetPlanId: STANDARD.id,
      limit: 50,
    })
  })

  // A row's own choice outranks the rest target. Its plan deleted meanwhile, the
  // request cannot say "all but this one", so the rest would take it where nobody sent it.
  it('holds «Далее» for a row whose chosen plan was deleted meanwhile, instead of letting "all N" take it to the rest’s plan', async () => {
    grantMove()
    const members = Array.from({ length: 60 }, (_, index) => onPlan(`Member ${String(index + 1).padStart(2, '0')}`))
    wire.subscriptions.set(GOLD.id, ({ params }) => page(members, params))
    wire.previews.set(GOLD.id, ({ call }) => {
      if (call > 0) return previewOf([])
      // Dormant is deleted between the assignment and the preview.
      wire.catalogue = wire.catalogue.filter((listed) => listed.id !== DORMANT.id)
      return {
        status: 400,
        data: { statusCode: 400, code: 'TARGET_NOT_FOUND', errorCode: 'TARGET_NOT_FOUND', message: 'Target plan not found' },
      }
    })
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)

    await user.click(within(dialog).getByRole('checkbox', { name: m('choose.selectShown') }))
    await user.click(within(dialog).getByRole('button', { name: m('choose.selectAll', { count: 60 }) }))
    await pickTarget(user, dialog, 'Standard')
    await user.click(within(dialog).getByRole('button', { name: m('choose.assign') }))
    await assignTo(user, dialog, ['Member 07'], `Dormant · ${m('choose.inactiveTag')}`)
    await user.click(within(dialog).getByRole('button', { name: m('choose.next') }))
    expect(await within(dialog).findByText(says('refusals.targetNotFound'))).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: m('preview.back') }))
    // The refusal refreshed the plans, and Member 07's plan is not among them.
    await waitFor(() => expect(rowOf(dialog, 'Member 07')).toHaveTextContent(says('choose.targetUnavailable')))
    expect(rowOf(dialog, 'Member 08')).toHaveTextContent('Standard')
    expect(dialog).toHaveTextContent(says('choose.ineligibleHint'))
    expect(dialog).toHaveTextContent(says('choose.unassignedHint', { count: 1 }))
    expect(dialog).toHaveTextContent(says('choose.assignedSummary', { assigned: 59, total: 60 }))
    const next = within(dialog).getByRole('button', { name: m('choose.next') })
    expect(next).toBeDisabled()
    await user.click(next)
    expect(sentTo('POST', PREVIEW_URL)).toHaveLength(1)

    // Assigned again, it goes where the operator now says.
    await assignTo(user, dialog, ['Member 07'], `Vintage · ${m('choose.archivedTag')}`)
    expect(next).toBeEnabled()
    await user.click(next)
    await waitFor(() => expect(sentTo('POST', PREVIEW_URL)).toHaveLength(2))
    expect(sentTo('POST', PREVIEW_URL)[1].body).toEqual({
      groups: [{ targetPlanId: VINTAGE.id, subscriptionIds: ['sub-member-07'] }],
      restTargetPlanId: STANDARD.id,
      limit: 50,
    })
  })

  it('searches the plan’s subscriptions on the server and loads further pages with its cursor', async () => {
    grantMove()
    const members = Array.from({ length: 58 }, (_, index) => onPlan(`Member ${String(index + 1).padStart(2, '0')}`))
    const zed = onPlan('Zed Special', {
      user: { id: 'user-zed', name: 'Zed Special', username: 'zed', telegramId: '777001', email: 'zed@example.com' },
    })
    wire.subscriptions.set(GOLD.id, ({ params }) => page([...members, zed], params))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    const rows = () => within(within(dialog).getByRole('list', { name: m('choose.listLabel') })).getAllByRole('listitem')
    expect(rows()).toHaveLength(50)

    const search = within(dialog).getByRole('textbox', { name: m('choose.searchLabel') })
    await user.type(search, '777001')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]).toHaveTextContent('Zed Special')
    expect(rows()[0]).toHaveTextContent('@zed')
    expect(sentTo('GET', SUBSCRIPTIONS_URL).at(-1)?.params).toEqual({ limit: 50, search: '777001' })
    // Only the first page Delete waits for is cut to 10 seconds; a search waits as long as any read.
    expect(sentTo('GET', SUBSCRIPTIONS_URL)[0].timeout).toBe(10_000)
    expect(sentTo('GET', SUBSCRIPTIONS_URL).at(-1)?.timeout).toBe(30_000)
    // The lead counts the plan, not the search.
    expect(dialog).toHaveTextContent(m('choose.lead', { count: 59 }))

    await user.clear(search)
    await waitFor(() => expect(rows()).toHaveLength(50))
    await user.click(within(dialog).getByRole('button', { name: says('choose.loadMore') }))
    await waitFor(() => expect(rows()).toHaveLength(59))
    expect(sentTo('GET', SUBSCRIPTIONS_URL).at(-1)?.params).toEqual({ limit: 50, cursor: 'after-50' })
    expect(sentTo('GET', SUBSCRIPTIONS_URL).at(-1)?.timeout).toBe(30_000)
    expect(within(dialog).queryByRole('button', { name: m('choose.loadMore') })).toBeNull()
  })

  it('previews было → станет with the server’s warnings, the kept fields, squad names and both unlimited encodings', async () => {
    grantMove()
    const alice = onPlan('Alice', { isTrial: true })
    const bob = onPlan('Bob')
    const carol = onPlan('Carol')
    const dan = onPlan('Dan')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice, bob, carol, dan], params))
    wire.squads = {
      internal: { status: 200, data: [{ uuid: 'sq-eu', name: 'Europe' }, { uuid: 'sq-us', name: 'USA' }] },
      external: { status: 200, data: [{ uuid: 'sq-ext', name: 'Premium routing' }] },
    }
    wire.previews.set(GOLD.id, () =>
      previewOf(
        [
          previewRow(alice, STANDARD.id, {
            before: snapshot({ trafficLimit: 0, deviceLimit: 0, internalSquads: ['sq-eu', 'sq-us'], isTrial: true }),
            after: snapshot({ trafficLimit: null, deviceLimit: 2, internalSquads: ['sq-eu'], externalSquad: 'sq-ext' }),
            warnings: ['TRIAL_BECOMES_REGULAR', 'SQUADS_REMOVED', 'FEWER_DEVICES'],
          }),
          previewRow(bob, STANDARD.id, {
            before: snapshot({ trafficLimit: 100, deviceLimit: 5 }),
            after: snapshot({ trafficLimit: 100, deviceLimit: 5 }),
            kept: ['deviceLimit'],
            warnings: ['LOCAL_ONLY', 'LOYALTY_RESET'],
            pushesToRemnawave: false,
          }),
          // Skipped: `after` is `before`, so there is nothing to compare.
          previewRow(carol, STANDARD.id, { willSkip: 'SCHEDULED_TERM', pushesToRemnawave: false }),
          previewRow(dan, STANDARD.id, {
            before: snapshot({ trafficLimit: null, deviceLimit: 0 }),
            after: snapshot({ trafficLimit: null, deviceLimit: 0 }),
            willSkip: 'PANEL_WENT_AWAY',
            pushesToRemnawave: false,
          }),
        ],
        [
          {
            targetPlanId: STANDARD.id,
            count: 4,
            skipped: 2,
            warnings: { FEWER_DEVICES: 1, SQUADS_REMOVED: 0, LOCAL_ONLY: 1 },
          },
        ],
      ),
    )
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await previewEveryoneOnStandard(user, dialog)

    expect(dialog).toHaveTextContent(says('preview.lead'))
    const summary = within(dialog).getByRole('list', { name: m('preview.summaryLabel') })
    const targets = within(summary).getAllByRole('listitem')
    expect(targets).toHaveLength(1)
    expect(targets[0]).toHaveTextContent('Standard')
    expect(targets[0]).toHaveTextContent(says('preview.count', { count: 4 }))
    expect(targets[0]).toHaveTextContent(says('preview.skippedCount', { count: 2 }))
    expect(targets[0]).toHaveTextContent(m('warnings.count', { label: says('warnings.fewerDevices'), count: 1 }))
    expect(targets[0]).toHaveTextContent(m('warnings.count', { label: says('warnings.localOnly'), count: 1 }))
    expect(targets[0]).not.toHaveTextContent(says('warnings.squadsRemoved'))

    const rows = within(within(dialog).getByRole('list', { name: m('preview.rowsLabel') })).getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    const [aliceRow, bobRow, carolRow, danRow] = rows

    // A skipped row says why, and draws no было → станет.
    expect(within(carolRow).queryAllByRole('definition')).toEqual([])
    expect(carolRow).toHaveTextContent(says('preview.willSkip', { reason: says('reasons.scheduledTerm') }))
    expect(within(danRow).queryAllByRole('definition')).toEqual([])
    expect(danRow).toHaveTextContent(says('preview.willSkip', { reason: says('reasons.unknown') }))
    expect(within(danRow).getByText('PANEL_WENT_AWAY')).toBeInTheDocument()
    expect(danRow).not.toHaveTextContent(m('preview.unlimited'))
    expect(aliceRow).toHaveTextContent('Alice')
    const unlimited = says('preview.unlimited')
    // The arrow is hidden from screen readers; «было … станет …» is read instead.
    const was = says('preview.srBefore')
    const becomes = says('preview.srAfter')
    const aliceCells = within(aliceRow).getAllByRole('definition')
    expect(aliceCells).toHaveLength(5)
    // Traffic: zero is a cap of nothing and null is unlimited — two different values, and unlimited is more.
    expect(aliceCells[0].textContent).toBe(`${was} ${says('preview.gigabytes', { value: 0 })} → ${becomes} ${unlimited}`)
    expect(aliceCells[0]).toHaveAttribute('data-direction', 'more')
    // Devices: zero is unlimited, so two is fewer.
    expect(aliceCells[1].textContent).toBe(`${was} ${unlimited} → ${becomes} 2`)
    expect(aliceCells[1]).toHaveAttribute('data-direction', 'less')
    expect([...aliceCells[1].querySelectorAll('.sr-only')].map((label) => label.textContent?.trim())).toEqual([was, becomes])
    expect(aliceCells[1].querySelector('[aria-hidden="true"]')?.textContent).toBe('→')
    expect(within(aliceCells[2]).getByText('Europe').tagName).toBe('SPAN')
    expect(within(aliceCells[2]).getByText('USA').tagName).toBe('DEL')
    expect(aliceCells[3].textContent).toBe(`${was} ${says('preview.none')} → ${becomes} Premium routing`)
    expect(aliceCells[4].textContent).toBe(`${was} ${says('preview.trial')} → ${becomes} ${says('preview.regular')}`)
    const aliceText = aliceRow.textContent ?? ''
    const warningAt = [says('warnings.fewerDevices'), says('warnings.squadsRemoved'), says('warnings.trialBecomesRegular')].map(
      (label) => aliceText.indexOf(label),
    )
    expect(warningAt.every((at) => at >= 0)).toBe(true)
    expect([...warningAt].sort((a, b) => a - b)).toEqual(warningAt)

    const bobCells = within(bobRow).getAllByRole('definition')
    expect(bobCells).toHaveLength(4)
    expect(bobCells[0].textContent).toBe(m('preview.gigabytes', { value: 100 }))
    expect(bobCells[1].firstElementChild?.textContent).toBe('5')
    const kept = within(bobCells[1]).getByText(says('preview.kept'))
    expect(bobRow).not.toHaveTextContent(m('preview.willSkip', { reason: m('reasons.scheduledTerm') }))
    expect(bobRow).toHaveTextContent(says('warnings.localOnly'))
    expect(bobRow).toHaveTextContent(says('warnings.unknown', { code: 'LOYALTY_RESET' }))
    expect(bobRow).not.toHaveTextContent(m('warnings.fewerDevices'))

    // The kept marker explains itself on focus, not only on hover.
    const trigger = kept.closest('[tabindex="0"]')
    expect(trigger).not.toBeNull()
    act(() => (trigger as HTMLElement).focus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(says('preview.keptHint'))

    // Squad names come from the plans module's own option routes.
    expect(sentTo('GET', '/admin/plans/options/internal-squads')).toHaveLength(1)
    expect(sentTo('GET', '/admin/plans/options/external-squads')).toHaveLength(1)
    expect(wire.sent.filter((request) => request.url.startsWith('/admin/remnawave'))).toEqual([])
  })

  // `kept: 'squads'` names the internal squads and the external squad as one field.
  it('marks «вручную» on the squad field the move keeps, not on the one it changes, and says removed and added squads in words', async () => {
    grantMove()
    const alice = onPlan('Alice')
    const bob = onPlan('Bob')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice, bob], params))
    wire.squads = {
      internal: { status: 200, data: [{ uuid: 'sq-eu', name: 'Europe' }, { uuid: 'sq-us', name: 'USA' }] },
      external: {
        status: 200,
        data: [
          { uuid: 'sq-ext', name: 'Premium routing' },
          { uuid: 'sq-ext-2', name: 'Basic routing' },
        ],
      },
    }
    wire.previews.set(GOLD.id, () =>
      previewOf([
        // Internal squads set by hand and kept; the external squad comes from the new plan.
        previewRow(alice, STANDARD.id, {
          before: snapshot({ internalSquads: ['sq-eu'], externalSquad: 'sq-ext' }),
          after: snapshot({ internalSquads: ['sq-eu'], externalSquad: 'sq-ext-2' }),
          kept: ['squads'],
        }),
        // The external squad set by hand and kept; the internal squads come from the new plan.
        previewRow(bob, STANDARD.id, {
          before: snapshot({ internalSquads: ['sq-us'], externalSquad: 'sq-ext' }),
          after: snapshot({ internalSquads: ['sq-eu'], externalSquad: 'sq-ext' }),
          kept: ['squads'],
        }),
      ]),
    )
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await previewEveryoneOnStandard(user, dialog)
    await waitFor(() => expect(dialog).toHaveTextContent('Basic routing'))

    const kept = says('preview.kept')
    const [aliceRow, bobRow] = within(within(dialog).getByRole('list', { name: m('preview.rowsLabel') })).getAllByRole('listitem')
    const [, , aliceSquads, aliceExternal] = within(aliceRow).getAllByRole('definition')
    expect(within(aliceSquads).queryByText(kept)).not.toBeNull()
    expect(within(aliceExternal).queryByText(kept)).toBeNull()
    const [, , bobSquads, bobExternal] = within(bobRow).getAllByRole('definition')
    expect(within(bobSquads).queryByText(kept)).toBeNull()
    expect(within(bobExternal).queryByText(kept)).not.toBeNull()

    // Struck through and marked with a plus, and read as «убран» / «добавлен».
    expect(within(bobSquads).getByText('USA').tagName).toBe('DEL')
    expect(within(bobSquads).getByText('Europe').tagName).toBe('INS')
    expect([...bobSquads.querySelectorAll('.sr-only')].map((label) => label.textContent?.trim())).toEqual([
      says('preview.srRemoved'),
      says('preview.srAdded'),
    ])
    expect(bobSquads.querySelector('ins [aria-hidden="true"]')?.textContent).toBe('+')
  })

  it('says what else uses the plan before «Перенести и удалить», leaving out the subscriptions the move handles', async () => {
    grantMove()
    const alice = onPlan('Alice')
    wire.references.set(
      GOLD.id,
      referencesReply(GOLD.id, [
        { kind: 'subscriptions', count: 1 },
        { kind: 'promocodes', count: 2 },
      ]),
    )
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id)]))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await previewEveryoneOnStandard(user, dialog)

    const sentence = (key: string, options?: Record<string, unknown>): string => {
      const said = i18n.t(key, options)
      expect(said).not.toMatch(/plansPage\./)
      return said
    }
    const usedBy = within(dialog).getByRole('list', { name: sentence('plansPage.deleteDialog.usedBy') })
    // The promo codes, and not the one subscription the move handles.
    expect(within(usedBy).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      sentence('plansPage.deleteDialog.references.promocodes', { count: 2 }),
    ])
    expect(dialog).toHaveTextContent(sentence('plansPage.deleteDialog.consequences.grants'))
    expect(dialog).toHaveTextContent(sentence('plansPage.deleteDialog.consequences.cleanup'))
    // What subscribers are told about a deleted plan is not what happens to subscribers moved off it.
    expect(dialog).not.toHaveTextContent(sentence('plansPage.deleteDialog.consequences.subscribers'))
    // In the body that scrolls, above the move's own changes, with the button still below.
    expect(usedBy.closest('.overflow-y-auto')).not.toBeNull()
    const rows = within(dialog).getByRole('list', { name: m('preview.rowsLabel') })
    expect(usedBy.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(confirmMove(dialog)).toBeEnabled()
  })

  it('says on the preview, too, when what else uses the plan could not be checked', async () => {
    grantMove()
    const alice = onPlan('Alice')
    wire.references.set(GOLD.id, { status: 500, data: { statusCode: 500, message: 'Internal server error' } })
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id)]))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await previewEveryoneOnStandard(user, dialog)

    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.checkFailed'))
    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.checkFailedHint'))
    expect(within(dialog).queryByRole('list', { name: i18n.t('plansPage.deleteDialog.usedBy') })).toBeNull()
    expect(confirmMove(dialog)).toBeEnabled()
  })

  it('follows the move, holds the success state, reads the plan again and only then deletes it — once', async () => {
    grantMove()
    const alice = onPlan('Alice')
    const bob = onPlan('Bob')
    const recheck = held()
    wire.subscriptions.set(GOLD.id, ({ params, call }) => (call === 0 ? page([alice, bob], params) : recheck.reply))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id), previewRow(bob, STANDARD.id)]))
    wire.starts.set(GOLD.id, started)
    const finish = held()
    wire.runs.set(RUN_ID, ({ call }) => (call === 0 ? movingReply(1, 2) : call === 1 ? finish.reply : runReply()))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    let successShownAtDelete: boolean | null = null
    wire.onDelete = () => {
      successShownAtDelete = within(dialog).queryByText(m('success.title')) !== null
    }

    await startMove(user, dialog)
    expect(sentTo('POST', START_URL)[0].body).toEqual({
      groups: [{ targetPlanId: STANDARD.id, subscriptionIds: [alice.subscriptionId, bob.subscriptionId] }],
    })

    // Running. The second poll is held, so the first answer stays on screen.
    await waitFor(() => expect(sentTo('GET', RUN_URL)).toHaveLength(2))
    expect(headline(dialog)).toBe(says('running.moving', { done: 1, total: 2 }))
    // A screen reader hears the milestone, not the count that changes on every poll.
    expect(announced(dialog)).toBe(says('announce.started'))
    expect(within(dialog).getByRole('progressbar', { name: m('running.moveLabel') })).toHaveAttribute(
      'aria-valuenow',
      '50',
    )
    expect(dialog.querySelector('[data-motion]')?.getAttribute('data-motion')).toBe('animated')
    // Closing is the operator's explicit choice, beside the notice of what it means.
    expect(within(dialog).getByRole('button', { name: i18n.t('common.close') })).toBeEnabled()
    expect(dialog).toHaveTextContent(says('running.stayOpen'))
    expect(deletesSent()).toEqual([])

    finish.release(runReply())
    expect(await within(dialog).findByText(says('success.title'))).toBeInTheDocument()
    expect(announced(dialog)).toBe(says('announce.succeeded'))
    expect(deletesSent()).toEqual([])

    // The plan is read again before anything is deleted, and the DELETE waits for that answer.
    await waitFor(() => expect(sentTo('GET', SUBSCRIPTIONS_URL)).toHaveLength(2))
    expect(headline(dialog)).toBe(says('success.checking'))
    expect(deletesSent()).toEqual([])

    recheck.release(page([], { limit: 50 }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(deletesSent()).toEqual([{ method: 'DELETE', url: `/admin/plans/${GOLD.id}` }])
    expect(successShownAtDelete).toBe(true)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())

    const calls = wire.log.map((exchange) => `${exchange.method} ${exchange.url}`)
    const deleteAt = calls.indexOf(`DELETE /admin/plans/${GOLD.id}`)
    expect(calls.lastIndexOf(`GET ${RUN_URL}`)).toBeLessThan(calls.lastIndexOf(`GET ${SUBSCRIPTIONS_URL}`))
    expect(calls.lastIndexOf(`GET ${SUBSCRIPTIONS_URL}`)).toBeLessThan(deleteAt)
    // Nothing about the deleted plan is asked after its DELETE — only the catalogue.
    expect(wire.log.slice(deleteAt + 1)).toEqual([{ method: 'GET', url: '/admin/plans' }])
    expect(deletesSent()).toHaveLength(1)
  })

  it('goes back to choosing, with a notice, when subscriptions landed on the plan during the move — and deletes nothing', async () => {
    grantMove()
    const alice = onPlan('Alice')
    const dave = onPlan('Dave')
    wire.references.set(GOLD.id, referencesReply(GOLD.id, [{ kind: 'subscriptions', count: 1 }]))
    wire.subscriptions.set(GOLD.id, ({ params, call }) => page(call === 0 ? [alice] : [dave], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id)]))
    wire.starts.set(GOLD.id, started)
    wire.runs.set(RUN_ID, () => runReply({ totals: { total: 1, moved: 1 } }))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    await within(dialog).findByText(says('success.title'))
    await waitFor(() => expect(within(dialog).queryByText(m('success.title'))).toBeNull())

    // Seen in the notice, heard through the region that was mounted before it.
    expect(dialog.querySelector('[data-notice]')?.textContent).toBe(says('choose.newSubscriptions', { count: 1 }))
    expect(announced(dialog)).toBe(says('announce.newSubscriptions', { count: 1 }))
    expect(dialog).toHaveTextContent(m('choose.lead', { count: 1 }))
    expect(rowOf(dialog, 'Dave')).toHaveTextContent(says('choose.unassigned'))
    expect(within(dialog).queryByRole('checkbox', { name: m('choose.selectRow', { name: 'Alice' }) })).toBeNull()
    expect(within(dialog).getByRole('button', { name: m('choose.next') })).toBeDisabled()
    expect(deletesSent()).toEqual([])
    expect(toast.success).not.toHaveBeenCalled()
    // The references were read again: every count they held before the move is stale.
    expect(sentTo('GET', `/admin/plans/${GOLD.id}/references`)).toHaveLength(2)
  })

  it('ignores Escape while the move runs, closes only through «Закрыть», and follows the run again when reopened', async () => {
    grantMove()
    const alice = onPlan('Alice')
    const bob = onPlan('Bob')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice, bob], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id), previewRow(bob, STANDARD.id)]))
    wire.starts.set(GOLD.id, started)
    // Nothing runs when the dialog first opens; once started, the server reports the run.
    wire.current.set(GOLD.id, () => ({
      status: 200,
      data: { runId: sentTo('POST', START_URL).length > 0 ? RUN_ID : null },
    }))
    // A move that never advances — a worker down — while every poll answers.
    wire.runs.set(RUN_ID, () => movingReply(0, 2))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)
    await waitFor(() => expect(sentTo('GET', RUN_URL).length).toBeGreaterThanOrEqual(2))
    expect(headline(dialog)).toBe(says('running.moving', { done: 0, total: 2 }))

    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBe(dialog)
    // Polls keep coming, and a stray Escape still does not close it.
    const polls = sentTo('GET', RUN_URL).length
    await waitFor(() => expect(sentTo('GET', RUN_URL).length).toBeGreaterThan(polls + 1))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBe(dialog)

    // The explicit button, next to the notice that the move goes on and the plan stays.
    expect(dialog).toHaveTextContent(says('running.stayOpen'))
    await user.click(within(dialog).getByRole('button', { name: i18n.t('common.close') }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(deletesSent()).toEqual([])

    // Reopened: the running move is followed at once, not a list of subscriptions already moving.
    const reopened = await openDeleteDialog(user, GOLD.name)
    await waitFor(() => expect(headline(reopened)).toBe(says('running.moving', { done: 0, total: 2 })))
    expect(within(reopened).queryByRole('list', { name: m('choose.listLabel') })).toBeNull()
    expect(sentTo('POST', START_URL)).toHaveLength(1)
    expect(deletesSent()).toEqual([])
  })

  it('lists what failed and why, stops polling, and retries the failed subscriptions', async () => {
    grantMove()
    const alice = onPlan('Alice')
    const bob = onPlan('Bob')
    const erin = onPlan('Erin')
    wire.subscriptions.set(GOLD.id, ({ params, call }) => page(call === 0 ? [alice, bob, erin] : [], params))
    wire.previews.set(GOLD.id, () =>
      previewOf([previewRow(alice, STANDARD.id), previewRow(bob, STANDARD.id), previewRow(erin, STANDARD.id)]),
    )
    wire.starts.set(GOLD.id, started)
    let retriedAtPoll: number | null = null
    wire.retries.set(RUN_ID, () => {
      retriedAtPoll = sentTo('GET', RUN_URL).length
      return { status: 202, data: { runId: RUN_ID } }
    })
    wire.runs.set(RUN_ID, ({ call }) => {
      if (retriedAtPoll === null) {
        return runReply({
          totals: { total: 3, moved: 1, failed: 2 },
          problems: [
            problem(bob, 'MOVE_FAILED', 'INTERNAL_ERROR', 'Row lock timeout'),
            problem(erin, 'MOVE_FAILED', 'PANEL_WENT_AWAY'),
          ],
        })
      }
      return call === retriedAtPoll ? movingReply(1, 3) : runReply({ totals: { total: 3, moved: 3 } })
    })
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    const problems = await within(dialog).findByRole('list', { name: says('problems.listLabel') })
    const items = within(problems).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Bob')
    expect(items[0]).toHaveTextContent(says('problems.kinds.moveFailed'))
    expect(items[0]).toHaveTextContent(says('reasons.internalError'))
    expect(items[0]).toHaveTextContent('Row lock timeout')
    expect(items[0]).toHaveTextContent('Standard')
    // A reason this build has no words for: the generic sentence, with the raw code beside it.
    expect(items[1]).toHaveTextContent('Erin')
    expect(items[1]).toHaveTextContent(says('reasons.unknown'))
    expect(within(items[1]).getByText('PANEL_WENT_AWAY')).toBeInTheDocument()
    expect(dialog).toHaveTextContent(says('problems.title'))
    expect(announced(dialog)).toBe(says('announce.problems'))
    expect(dialog).toHaveTextContent(says('problems.deleteAnywayConsequence'))
    expect(dialog).not.toHaveTextContent(says('problems.syncConsequence'))
    expect(within(dialog).queryByRole('button', { name: says('problems.retrySync') })).toBeNull()
    expect(within(dialog).getByRole('button', { name: says('problems.chooseAnotherTarget') })).toBeEnabled()
    expect(within(dialog).getByRole('button', { name: says('problems.deleteAnyway') })).toBeEnabled()
    expect(within(dialog).getByRole('button', { name: i18n.t('common.close') })).toBeEnabled()
    expect(within(dialog).queryByText(m('success.title'))).toBeNull()

    // A settled run makes no more requests while its result is on screen.
    const polls = sentTo('GET', RUN_URL).length
    await new Promise((resolve) => setTimeout(resolve, 25 * 8))
    expect(sentTo('GET', RUN_URL)).toHaveLength(polls)
    expect(deletesSent()).toEqual([])

    await user.click(within(dialog).getByRole('button', { name: says('problems.retryFailed') }))
    await waitFor(() => expect(sentTo('POST', RETRY_URL)).toHaveLength(1))
    expect(sentTo('POST', RETRY_URL)[0].body).toEqual({ scope: 'failed' })

    // Polling resumes, the move plays out, and the plan is deleted after all.
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(sentTo('GET', RUN_URL).length).toBeGreaterThan(polls + 1)
    expect(deletesSent()).toHaveLength(1)
  })

  it('retries the synchronisation of the profiles that failed, following the run again before showing its result', async () => {
    grantMove()
    const alice = onPlan('Alice')
    const bob = onPlan('Bob')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice, bob], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id), previewRow(bob, STANDARD.id)]))
    wire.starts.set(GOLD.id, started)
    wire.runs.set(RUN_ID, () =>
      runReply({
        sync: { total: 2, completed: 1, failed: 1 },
        problems: [problem(alice, 'SYNC_FAILED', 'SYNC_FAILED', 'Remnawave answered 502')],
      }),
    )
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    const problems = await within(dialog).findByRole('list', { name: m('problems.listLabel') })
    const [item] = within(problems).getAllByRole('listitem')
    expect(item).toHaveTextContent(says('problems.kinds.syncFailed'))
    expect(item).toHaveTextContent(says('reasons.syncFailed'))
    expect(item).toHaveTextContent('Remnawave answered 502')
    expect(dialog).toHaveTextContent(says('problems.syncConsequence'))
    expect(dialog).not.toHaveTextContent(says('problems.deleteAnywayConsequence'))
    expect(within(dialog).queryByRole('button', { name: says('problems.retryFailed') })).toBeNull()
    // A failed sync has already moved its subscription: there is nothing to choose another plan for.
    expect(within(dialog).queryByRole('button', { name: says('problems.chooseAnotherTarget') })).toBeNull()
    expect(headline(dialog)).toBeNull()

    const polls = sentTo('GET', RUN_URL).length
    await user.click(within(dialog).getByRole('button', { name: says('problems.retrySync') }))
    await waitFor(() => expect(sentTo('POST', RETRY_URL)).toHaveLength(1))
    expect(sentTo('POST', RETRY_URL)[0].body).toEqual({ scope: 'sync' })

    // The first answers after an accepted retry may predate it: the run is followed again…
    await waitFor(() => expect(headline(dialog)).toBe(m('running.queued')))
    // …and once they cannot, the result is back — the same failure, since this server still reports it.
    expect(await within(dialog).findByRole('list', { name: m('problems.listLabel') })).toBeInTheDocument()
    expect(sentTo('GET', RUN_URL).length).toBeGreaterThan(polls + 1)
    expect(deletesSent()).toEqual([])
  })

  it('deletes anyway after a skip, saying the skipped subscriptions stay on the deleted plan', async () => {
    grantMove()
    const alice = onPlan('Alice')
    const carol = onPlan('Carol', {
      flags: { pendingRenewalForPlan: false, scheduledTermOnPlan: true, sharedPanelProfile: false },
    })
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice, carol], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id), previewRow(carol, STANDARD.id)]))
    wire.starts.set(GOLD.id, started)
    wire.runs.set(RUN_ID, () =>
      runReply({
        totals: { moved: 1, skipped: 1 },
        skippedByReason: { SCHEDULED_TERM: 1 },
        problems: [problem(carol, 'MOVE_SKIPPED', 'SCHEDULED_TERM')],
      }),
    )
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    expect(rowOf(dialog, 'Carol')).toHaveTextContent(says('flags.scheduledTerm'))
    expect(rowOf(dialog, 'Alice')).not.toHaveTextContent(m('flags.scheduledTerm'))
    await startMove(user, dialog)

    const problems = await within(dialog).findByRole('list', { name: m('problems.listLabel') })
    const [item] = within(problems).getAllByRole('listitem')
    expect(item).toHaveTextContent('Carol')
    expect(item).toHaveTextContent(says('problems.kinds.moveSkipped'))
    expect(item).toHaveTextContent(says('reasons.scheduledTerm'))
    // A skip other than "already off the plan" is not a success.
    expect(within(dialog).queryByText(m('success.title'))).toBeNull()
    expect(within(dialog).queryByRole('button', { name: m('problems.retryFailed') })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: m('problems.retrySync') })).toBeNull()
    // A subscription renewed in advance would be skipped again on any plan.
    expect(within(dialog).queryByRole('button', { name: says('problems.chooseAnotherTarget') })).toBeNull()
    expect(dialog).toHaveTextContent(says('problems.deleteAnywayConsequence'))
    expect(deletesSent()).toEqual([])

    await user.click(within(dialog).getByRole('button', { name: says('problems.deleteAnyway') }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(deletesSent()).toEqual([{ method: 'DELETE', url: `/admin/plans/${GOLD.id}` }])
    // «Удалить всё равно» deletes as things stand: no second read of the plan.
    expect(sentTo('GET', SUBSCRIPTIONS_URL)).toHaveLength(1)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  const ALREADY_RUNNING: Reply = {
    status: 409,
    data: {
      statusCode: 409,
      code: 'MIGRATION_ALREADY_RUNNING',
      errorCode: 'MIGRATION_ALREADY_RUNNING',
      message: 'A migration is already running for this plan',
    },
  }
  const CURRENT_URL = `/admin/plans/${GOLD.id}/migrations/current`

  it('follows the move already running when a start is refused for it, asking the server which run that is', async () => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id)]))
    wire.starts.set(GOLD.id, () => ALREADY_RUNNING)
    // Nothing was running when the dialog opened; by the start, another operator's move was.
    wire.current.set(GOLD.id, ({ call }) => ({ status: 200, data: { runId: call === 0 ? null : 'run-9' } }))
    wire.runs.set('run-9', () => movingReply(0, 1))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    await waitFor(() => expect(sentTo('GET', CURRENT_URL)).toHaveLength(2))
    await waitFor(() => expect(sentTo('GET', `/admin/plans/${GOLD.id}/migrations/run-9`).length).toBeGreaterThan(0))
    await waitFor(() => expect(headline(dialog)).not.toBe(m('running.starting')))
    expect(headline(dialog)).toBe(says('running.moving', { done: 0, total: 1 }))
    expect(dialog).not.toHaveTextContent(says('refusals.alreadyRunning'))
  })

  it('says a move is already running, and stays on the preview, when the server then reports no run to follow', async () => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id)]))
    wire.starts.set(GOLD.id, () => ALREADY_RUNNING)
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    await waitFor(() => expect(sentTo('GET', CURRENT_URL)).toHaveLength(2))
    await waitFor(() => expect(confirmMove(dialog)).toBeEnabled())
    expect(dialog).toHaveTextContent(says('refusals.alreadyRunning'))
    expect(dialog).not.toHaveTextContent('A migration is already running for this plan')
    expect(wire.sent.filter((request) => request.method === 'GET' && request.url.startsWith(`${START_URL}/run`))).toEqual([])
  })

  it('opens straight onto the move already running for the plan — a reload, or another operator — instead of the list', async () => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.current.set(GOLD.id, () => ({ status: 200, data: { runId: RUN_ID } }))
    wire.runs.set(RUN_ID, () => movingReply(1, 4))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openDeleteDialog(user, GOLD.name)

    await waitFor(() => expect(headline(dialog)).toBe(says('running.moving', { done: 1, total: 4 })))
    expect(announced(dialog)).toBe(says('announce.started'))
    expect(within(dialog).queryByRole('list', { name: m('choose.listLabel') })).toBeNull()
    // Escape does not close it; the explicit «Закрыть» still may.
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBe(dialog)
    expect(within(dialog).getByRole('button', { name: i18n.t('common.close') })).toBeEnabled()
    expect(sentTo('POST', START_URL)).toEqual([])
  })

  it.each<[string, Reply]>([
    ['a 404', { status: 404, data: { statusCode: 404, message: 'Cannot GET', errorCode: 'NOT_FOUND' } }],
    ['no answer within 10 seconds', { timeout: true }],
  ])('lists the subscriptions as usual when asking for the running move gets %s', async (_label, unanswered) => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.current.set(GOLD.id, () => unanswered)
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)

    expect(within(dialog).getByRole('list', { name: m('choose.listLabel') })).toBeInTheDocument()
    expect(rowOf(dialog, 'Alice')).toHaveTextContent(says('choose.unassigned'))
    expect(sentTo('GET', CURRENT_URL)).toHaveLength(1)
    expect(sentTo('GET', CURRENT_URL)[0].timeout).toBe(10_000)
  })

  // §9 A1: a profile sync that failed but will be retried counts as pending, and
  // the run is not finished. Reading "COMPLETED" as the end would show its
  // transient failure as final — or delete while Remnawave is still catching up.
  it('keeps following a move whose Remnawave update failed once and is being retried, and deletes only once it is done', async () => {
    grantMove()
    const alice = onPlan('Alice')
    const bob = onPlan('Bob')
    wire.subscriptions.set(GOLD.id, ({ params, call }) => page(call === 0 ? [alice, bob] : [], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id), previewRow(bob, STANDARD.id)]))
    wire.starts.set(GOLD.id, started)
    const synced = held()
    wire.runs.set(RUN_ID, ({ call }) =>
      call === 0
        ? runReply({ status: 'COMPLETED', finished: false, sync: { total: 2, pending: 1, completed: 1, failed: 0 } })
        : call === 1
          ? synced.reply
          : runReply({ sync: { total: 2, completed: 2 } }),
    )
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    // Still followed: the next poll went out (and is held).
    await waitFor(() => expect(sentTo('GET', RUN_URL)).toHaveLength(2))
    expect(headline(dialog)).toBe(says('running.syncing', { done: 1, total: 2 }))
    expect(within(dialog).queryByText(m('success.title'))).toBeNull()
    expect(within(dialog).queryByRole('list', { name: m('problems.listLabel') })).toBeNull()
    expect(sentTo('GET', SUBSCRIPTIONS_URL)).toHaveLength(1)
    expect(deletesSent()).toEqual([])

    synced.release(runReply({ sync: { total: 2, completed: 2 } }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(deletesSent()).toHaveLength(1)
  })

  // §9 A6.2: a start slower than the client's patience can still commit.
  it('asks for the running move when the start gets no answer in time, and follows the run it started all the same', async () => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id)]))
    wire.starts.set(GOLD.id, () => ({ timeout: true }))
    // Nothing ran when the dialog opened; the timed-out start did commit.
    wire.current.set(GOLD.id, ({ call }) => ({ status: 200, data: { runId: call === 0 ? null : RUN_ID } }))
    wire.runs.set(RUN_ID, () => movingReply(0, 1))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    // 120 seconds for both, not the client-wide 30.
    expect(sentTo('POST', PREVIEW_URL)[0].timeout).toBe(120_000)
    expect(sentTo('POST', START_URL)[0].timeout).toBe(120_000)
    await waitFor(() => expect(sentTo('GET', CURRENT_URL)).toHaveLength(2))
    await waitFor(() => expect(headline(dialog)).toBe(says('running.moving', { done: 0, total: 1 })))
    expect(announced(dialog)).toBe(says('announce.started'))
    expect(dialog).not.toHaveTextContent(says('refusals.startFailed'))
    expect(sentTo('POST', START_URL)).toHaveLength(1)
  })

  it('says the move could not be started when the start gets no answer and no run turns up', async () => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id)]))
    wire.starts.set(GOLD.id, () => ({ networkError: true }))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    await waitFor(() => expect(sentTo('GET', CURRENT_URL)).toHaveLength(2))
    await waitFor(() => expect(confirmMove(dialog)).toBeEnabled())
    expect(dialog).toHaveTextContent(says('refusals.startFailed'))
    expect(headline(dialog)).toBeNull()
  })

  // The app's request-timeout middleware answers 408 while the handler goes on and
  // commits; a proxy in front of it answers 504 the same way.
  it.each<[string, Reply]>([
    ['the app’s 408', { status: 408, data: { statusCode: 408, message: 'Request timed out after 120000ms', error: 'Request Timeout' } }],
    ['a proxy’s 504', { status: 504, data: '<html><body><h1>504 Gateway Time-out</h1></body></html>' }],
  ])('follows the run a start answered with %s committed all the same, instead of staying on the preview', async (_label, timedOut) => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id)]))
    wire.starts.set(GOLD.id, () => timedOut)
    // Nothing ran when the dialog opened; the start that timed out did commit.
    wire.current.set(GOLD.id, ({ call }) => ({ status: 200, data: { runId: call === 0 ? null : RUN_ID } }))
    wire.runs.set(RUN_ID, () => movingReply(0, 1))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    await waitFor(() => expect(sentTo('GET', CURRENT_URL)).toHaveLength(2))
    await waitFor(() => expect(headline(dialog)).toBe(says('running.moving', { done: 0, total: 1 })))
    expect(dialog).not.toHaveTextContent(says('refusals.startFailed'))
    // Off the preview: «Назад» → «Удалить без переноса» is not there to press while the move runs.
    expect(within(dialog).queryByRole('button', { name: m('preview.back') })).toBeNull()
    expect(sentTo('POST', START_URL)).toHaveLength(1)
  })

  it('says the move could not be started when the start timed out on the server and no run turns up', async () => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id)]))
    wire.starts.set(GOLD.id, () => ({ status: 408, data: { statusCode: 408, message: 'Request timed out after 120000ms', error: 'Request Timeout' } }))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    await waitFor(() => expect(sentTo('GET', CURRENT_URL)).toHaveLength(2))
    await waitFor(() => expect(confirmMove(dialog)).toBeEnabled())
    expect(dialog).toHaveTextContent(says('refusals.startFailed'))
    expect(headline(dialog)).toBeNull()
  })

  // A preview writes nothing: its timeout is a preview that failed, not a move to look for.
  it.each<[string, Reply]>([
    ['the app’s 408', { status: 408, data: { statusCode: 408, message: 'Request timed out after 120000ms', error: 'Request Timeout' } }],
    ['a proxy’s 504', { status: 504, data: '<html><body><h1>504 Gateway Time-out</h1></body></html>' }],
  ])('keeps Retry, and looks for no running move, when the preview is answered with %s', async (_label, timedOut) => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.previews.set(GOLD.id, ({ call }) => (call === 0 ? timedOut : previewOf([previewRow(alice, STANDARD.id)])))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await previewEveryoneOnStandard(user, dialog)

    expect(dialog).toHaveTextContent(says('refusals.previewFailed'))
    expect(confirmMove(dialog)).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: i18n.t('common.retry') }))
    await waitFor(() => expect(confirmMove(dialog)).toBeEnabled())
    expect(sentTo('GET', CURRENT_URL)).toHaveLength(1)
    expect(sentTo('POST', START_URL)).toEqual([])
  })

  // A retry that failed may have reopened the run all the same (§ wave 4): the
  // settled result on screen proves nothing, and «Удалить всё равно» on it would
  // delete the plan under a move with pending items.
  it('reads the run again when a retry gets no answer, and shows the reopened run running, not the old result', async () => {
    grantMove()
    const alice = onPlan('Alice')
    const bob = onPlan('Bob')
    wire.subscriptions.set(GOLD.id, ({ params, call }) => page(call === 0 ? [alice, bob] : [], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id), previewRow(bob, STANDARD.id)]))
    wire.starts.set(GOLD.id, started)
    let reopenedAtPoll: number | null = null
    // The server reopened the run; its answer was lost on the way back.
    wire.retries.set(RUN_ID, () => {
      reopenedAtPoll = sentTo('GET', RUN_URL).length
      return { networkError: true }
    })
    const reopened = held()
    wire.runs.set(RUN_ID, ({ call }) => {
      if (reopenedAtPoll === null) {
        return runReply({
          totals: { total: 2, moved: 1, failed: 1 },
          problems: [problem(bob, 'MOVE_FAILED', 'INTERNAL_ERROR', 'Row lock timeout')],
        })
      }
      return call === reopenedAtPoll ? reopened.reply : runReply({ totals: { total: 2, moved: 2 } })
    })
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    await within(dialog).findByRole('list', { name: m('problems.listLabel') })
    await user.click(within(dialog).getByRole('button', { name: says('problems.retryFailed') }))
    await waitFor(() => expect(sentTo('POST', RETRY_URL)).toHaveLength(1))

    // Read again at once, and the old result is not shown while that read is out.
    await waitFor(() => expect(sentTo('GET', RUN_URL).length).toBeGreaterThan(reopenedAtPoll ?? Number.POSITIVE_INFINITY))
    await waitFor(() => expect(within(dialog).queryByRole('list', { name: m('problems.listLabel') })).toBeNull())
    expect(within(dialog).queryByRole('button', { name: m('problems.deleteAnyway') })).toBeNull()
    expect(dialog).not.toHaveTextContent(says('problems.retryRefused'))
    expect(deletesSent()).toEqual([])

    reopened.release(runReply({ status: 'RUNNING', finished: false, totals: { total: 2, moved: 1, pending: 1 } }))
    await waitFor(() => expect(headline(dialog)).toBe(says('running.moving', { done: 1, total: 2 })))
    expect(dialog).not.toHaveTextContent(says('problems.retryRefused'))
    // …and it plays out: everything moved, and the plan is deleted after all.
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(deletesSent()).toHaveLength(1)
  })

  it('says the retry could not be started only once the run, read again, is still the result it was asked from', async () => {
    grantMove()
    const alice = onPlan('Alice')
    const bob = onPlan('Bob')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice, bob], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id), previewRow(bob, STANDARD.id)]))
    wire.starts.set(GOLD.id, started)
    wire.retries.set(RUN_ID, () => ({ status: 408, data: { statusCode: 408, message: 'Request timed out after 120000ms', error: 'Request Timeout' } }))
    wire.runs.set(RUN_ID, () =>
      runReply({
        totals: { total: 2, moved: 1, failed: 1 },
        problems: [problem(bob, 'MOVE_FAILED', 'INTERNAL_ERROR', 'Row lock timeout')],
      }),
    )
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    await within(dialog).findByRole('list', { name: m('problems.listLabel') })
    const polls = sentTo('GET', RUN_URL).length
    await user.click(within(dialog).getByRole('button', { name: says('problems.retryFailed') }))

    expect(await within(dialog).findByText(says('problems.retryRefused'))).toBeInTheDocument()
    // Said on the run as read AFTER the retry failed, through the whole echo window.
    expect(sentTo('GET', RUN_URL).length).toBeGreaterThan(polls + 1)
    expect(within(dialog).getByRole('list', { name: m('problems.listLabel') })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: says('problems.deleteAnyway') })).toBeEnabled()
    expect(deletesSent()).toEqual([])
  })

  it('follows the other move when a retry is refused because one is already running for the plan', async () => {
    grantMove()
    const alice = onPlan('Alice')
    const bob = onPlan('Bob')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice, bob], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id), previewRow(bob, STANDARD.id)]))
    wire.starts.set(GOLD.id, started)
    wire.retries.set(RUN_ID, () => ALREADY_RUNNING)
    // Another operator's move of the plan started after this one finished.
    wire.current.set(GOLD.id, ({ call }) => ({ status: 200, data: { runId: call === 0 ? null : 'run-9' } }))
    wire.runs.set(RUN_ID, () =>
      runReply({ totals: { total: 2, moved: 1, failed: 1 }, problems: [problem(bob, 'MOVE_FAILED', 'INTERNAL_ERROR')] }),
    )
    wire.runs.set('run-9', () => movingReply(0, 1))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    await within(dialog).findByRole('list', { name: m('problems.listLabel') })
    await user.click(within(dialog).getByRole('button', { name: says('problems.retryFailed') }))

    await waitFor(() => expect(sentTo('GET', CURRENT_URL)).toHaveLength(2))
    await waitFor(() => expect(headline(dialog)).toBe(says('running.moving', { done: 0, total: 1 })))
    expect(sentTo('GET', `/admin/plans/${GOLD.id}/migrations/run-9`).length).toBeGreaterThan(0)
    expect(dialog).not.toHaveTextContent(says('problems.retryRefused'))
    expect(deletesSent()).toEqual([])
  })

  // §9 A2: the problems list pages at 100; the per-reason counts cover every item.
  it('deletes after a move whose only skips are benign — more of them than the first problems page lists', async () => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params, call }) => page(call === 0 ? [alice] : [], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id)]))
    wire.starts.set(GOLD.id, started)
    const gone = Array.from({ length: 100 }, (_, index) => onPlan(`Gone ${index + 1}`))
    wire.runs.set(RUN_ID, () =>
      runReply({
        totals: { total: 121, moved: 1, skipped: 120 },
        skippedByReason: { NOT_ON_SOURCE_PLAN: 100, SUBSCRIPTION_DELETED: 20 },
        problems: gone.map((subscription) => problem(subscription, 'MOVE_SKIPPED', 'NOT_ON_SOURCE_PLAN')),
        problemsCursor: 'problems-2',
      }),
    )
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    expect(await within(dialog).findByText(says('success.title'))).toBeInTheDocument()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(deletesSent()).toHaveLength(1)
    // Decided without reading a single further problems page.
    expect(wire.sent.filter((request) => request.params.problemsCursor !== undefined)).toEqual([])
  })

  // The safe error filter writes a generic `errorCode` on EVERY error.
  it('keeps Retry for a preview that failed with a server error, whose only code is the generic one', async () => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.previews.set(GOLD.id, ({ call }) =>
      call === 0
        ? { status: 500, data: { statusCode: 500, message: 'Internal server error', errorCode: 'INTERNAL_SERVER_ERROR' } }
        : previewOf([previewRow(alice, STANDARD.id)]),
    )
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await previewEveryoneOnStandard(user, dialog)

    expect(dialog).toHaveTextContent(says('refusals.previewFailed'))
    expect(confirmMove(dialog)).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: i18n.t('common.retry') }))
    await waitFor(() => expect(confirmMove(dialog)).toBeEnabled())
    expect(sentTo('POST', PREVIEW_URL)).toHaveLength(2)
    expect(within(dialog).getByRole('list', { name: m('preview.rowsLabel') })).toBeInTheDocument()
    // A server error is not a missing answer: nobody asked for a running move.
    expect(sentTo('GET', CURRENT_URL)).toHaveLength(1)
  })

  it('offers another plan for what is left when the target is gone — a profile twin held back by it included — instead of a retry that would fail again', async () => {
    grantMove()
    const shared = { pendingRenewalForPlan: false, scheduledTermOnPlan: false, sharedPanelProfile: true }
    const alice = onPlan('Alice')
    const bob = onPlan('Bob', { flags: shared })
    const carol = onPlan('Carol', { flags: shared })
    // After the move only Bob and Carol are still on the plan.
    wire.subscriptions.set(GOLD.id, ({ params, call }) => page(call === 0 ? [alice, bob, carol] : [bob, carol], params))
    wire.previews.set(GOLD.id, () =>
      previewOf([previewRow(alice, STANDARD.id), previewRow(bob, STANDARD.id), previewRow(carol, STANDARD.id)]),
    )
    wire.starts.set(GOLD.id, started)
    // Carol shares Bob's Remnawave profile, and Bob's target is gone: she fails with him.
    const heldBack = wireTwinBlockedDetail([{ subscriptionId: bob.subscriptionId, reason: 'TARGET_DELETED' }])
    wire.runs.set(RUN_ID, () =>
      runReply({
        totals: { total: 3, moved: 1, failed: 2 },
        problems: [
          problem(bob, 'MOVE_FAILED', 'TARGET_DELETED'),
          problem(carol, 'MOVE_FAILED', 'SHARED_PROFILE_TWIN_BLOCKED', heldBack),
        ],
      }),
    )
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    const problems = await within(dialog).findByRole('list', { name: m('problems.listLabel') })
    const items = within(problems).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent(says('reasons.targetDeleted'))
    expect(items[1]).toHaveTextContent(says('reasons.sharedProfileTwinBlocked'))
    // Why the twin cannot move, in words — not the server's sentence.
    expect(items[1]).toHaveTextContent(says('problems.twinReason', { reason: says('reasons.targetDeleted') }))
    expect(items[1]).not.toHaveTextContent(heldBack)
    // A retry retries both twins — onto the same deleted plan.
    expect(within(dialog).queryByRole('button', { name: says('problems.retryFailed') })).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: says('problems.chooseAnotherTarget') }))
    // Back to choosing, with what is still on the plan, read afresh and assigned to nothing.
    await waitFor(() => expect(sentTo('GET', SUBSCRIPTIONS_URL)).toHaveLength(2))
    const list = await within(dialog).findByRole('list', { name: m('choose.listLabel') })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(rowOf(dialog, 'Bob')).toHaveTextContent(says('choose.unassigned'))
    expect(rowOf(dialog, 'Carol')).toHaveTextContent(says('flags.sharedProfile'))
    expect(within(dialog).queryByRole('checkbox', { name: m('choose.selectRow', { name: 'Alice' }) })).toBeNull()
    expect(within(dialog).getByRole('button', { name: m('choose.next') })).toBeDisabled()
    expect(sentTo('POST', RETRY_URL)).toEqual([])
    expect(deletesSent()).toEqual([])
  })

  it('retries a subscription held back by its profile twin’s failure together with that twin, and names the twin’s reason', async () => {
    grantMove()
    const shared = { pendingRenewalForPlan: false, scheduledTermOnPlan: false, sharedPanelProfile: true }
    const alice = onPlan('Alice', { flags: shared })
    const bob = onPlan('Bob', { flags: shared })
    wire.subscriptions.set(GOLD.id, ({ params, call }) => page(call === 0 ? [alice, bob] : [], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id), previewRow(bob, STANDARD.id)]))
    wire.starts.set(GOLD.id, started)
    let retriedAtPoll: number | null = null
    wire.retries.set(RUN_ID, () => {
      retriedAtPoll = sentTo('GET', RUN_URL).length
      return { status: 202, data: { runId: RUN_ID } }
    })
    // Bob's move hit a transient error; Alice, on his profile, took his status: FAILED.
    wire.runs.set(RUN_ID, ({ call }) => {
      if (retriedAtPoll === null) {
        return runReply({
          totals: { total: 2, moved: 0, failed: 2 },
          problems: [
            problem(
              alice,
              'MOVE_FAILED',
              'SHARED_PROFILE_TWIN_BLOCKED',
              wireTwinBlockedDetail([{ subscriptionId: bob.subscriptionId, reason: 'INTERNAL_ERROR' }]),
            ),
            problem(bob, 'MOVE_FAILED', 'INTERNAL_ERROR', 'The subscription was being changed by another operation at the same time. Retry.'),
          ],
        })
      }
      return call === retriedAtPoll ? movingReply(0, 2) : runReply({ totals: { total: 2, moved: 2 } })
    })
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    const problems = await within(dialog).findByRole('list', { name: m('problems.listLabel') })
    const [held] = within(problems).getAllByRole('listitem')
    expect(held).toHaveTextContent('Alice')
    expect(held).toHaveTextContent(says('problems.kinds.moveFailed'))
    expect(held).toHaveTextContent(says('reasons.sharedProfileTwinBlocked'))
    expect(held).toHaveTextContent(says('problems.twinReason', { reason: says('reasons.internalError') }))
    // Not a harmless skip: both stay on the plan if it is deleted now.
    expect(dialog).toHaveTextContent(says('problems.deleteAnywayConsequence'))
    expect(deletesSent()).toEqual([])

    await user.click(within(dialog).getByRole('button', { name: says('problems.retryFailed') }))
    await waitFor(() => expect(sentTo('POST', RETRY_URL)).toHaveLength(1))
    expect(sentTo('POST', RETRY_URL)[0].body).toEqual({ scope: 'failed' })
    // Both move on the retry, and the plan is deleted after all.
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(deletesSent()).toHaveLength(1)
  })

  it('does not take a subscription skipped behind its profile twin as harmless: it names the twin’s reason, offers another plan, and no retry', async () => {
    grantMove()
    const shared = { pendingRenewalForPlan: false, scheduledTermOnPlan: false, sharedPanelProfile: true }
    const alice = onPlan('Alice')
    const bob = onPlan('Bob', { flags: { ...shared, scheduledTermOnPlan: true } })
    const carol = onPlan('Carol', { flags: shared })
    const dave = onPlan('Dave', { flags: shared })
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice, bob, carol, dave], params))
    wire.previews.set(GOLD.id, () =>
      previewOf([
        previewRow(alice, STANDARD.id),
        previewRow(bob, STANDARD.id, { willSkip: 'SCHEDULED_TERM', pushesToRemnawave: false }),
        previewRow(carol, STANDARD.id, { willSkip: 'SHARED_PROFILE_TWIN_BLOCKED', pushesToRemnawave: false }),
        previewRow(dave, STANDARD.id),
      ]),
    )
    wire.starts.set(GOLD.id, started)
    const unreadable = wireTwinBlockedDetail([{ subscriptionId: 'sub-elsewhere', reason: 'PANEL_WENT_AWAY' }])
    wire.runs.set(RUN_ID, () =>
      runReply({
        totals: { total: 4, moved: 1, skipped: 3 },
        skippedByReason: { SCHEDULED_TERM: 1, SHARED_PROFILE_TWIN_BLOCKED: 2 },
        problems: [
          problem(bob, 'MOVE_SKIPPED', 'SCHEDULED_TERM'),
          problem(
            carol,
            'MOVE_SKIPPED',
            'SHARED_PROFILE_TWIN_BLOCKED',
            wireTwinBlockedDetail([{ subscriptionId: bob.subscriptionId, reason: 'SCHEDULED_TERM' }]),
          ),
          // A blocker's reason this build has no words for: the server's sentence, as it came.
          problem(dave, 'MOVE_SKIPPED', 'SHARED_PROFILE_TWIN_BLOCKED', unreadable),
        ],
      }),
    )
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await previewEveryoneOnStandard(user, dialog)

    // The preview already says so, in words.
    const previewRows = within(within(dialog).getByRole('list', { name: m('preview.rowsLabel') })).getAllByRole('listitem')
    expect(previewRows[2]).toHaveTextContent('Carol')
    expect(previewRows[2]).toHaveTextContent(says('preview.willSkip', { reason: says('reasons.sharedProfileTwinBlocked') }))
    expect(within(dialog).getByRole('list', { name: m('preview.summaryLabel') })).toHaveTextContent(
      says('preview.skippedCount', { count: 2 }),
    )
    await user.click(confirmMove(dialog))
    await waitFor(() => expect(sentTo('POST', START_URL)).toHaveLength(1))

    const problems = await within(dialog).findByRole('list', { name: m('problems.listLabel') })
    const items = within(problems).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    // Not a success: all three would stay on the deleted plan.
    expect(within(dialog).queryByText(m('success.title'))).toBeNull()
    expect(dialog).toHaveTextContent(says('problems.deleteAnywayConsequence'))
    const why = says('problems.twinReason', { reason: says('reasons.scheduledTerm') })
    expect(items[1]).toHaveTextContent('Carol')
    expect(items[1]).toHaveTextContent(says('problems.kinds.moveSkipped'))
    expect(items[1]).toHaveTextContent(says('reasons.sharedProfileTwinBlocked'))
    expect(items[1]).toHaveTextContent(why)
    expect(items[2]).toHaveTextContent(unreadable)
    expect(items[2]).not.toHaveTextContent(m('problems.twinReason', { reason: '' }).trim())
    // Nothing failed, so nothing to retry; another plan is the way on.
    expect(within(dialog).queryByRole('button', { name: says('problems.retryFailed') })).toBeNull()
    expect(within(dialog).getByRole('button', { name: says('problems.chooseAnotherTarget') })).toBeEnabled()
    expect(deletesSent()).toEqual([])
  })

  // §9 A3: `summary` comes on the first page only; rows carry their `user`.
  it('keeps the first page’s summary when later preview pages carry none, and names a row by the user it carries', async () => {
    grantMove()
    const members = [onPlan('Member 1'), onPlan('Member 2')]
    wire.subscriptions.set(GOLD.id, ({ params }) => page(members, params))
    const remote = { id: 'user-zoe', name: 'Zoe Remote', username: 'zoe', telegramId: null, email: null }
    wire.previews.set(GOLD.id, ({ body }) => ({
      status: 200,
      data:
        (body as { cursor?: string }).cursor === undefined
          ? wirePreview([previewRow(members[0], STANDARD.id)], {
              summary: [
                { targetPlanId: STANDARD.id, count: 3, skipped: 0, warnings: wireWarningCounts({ FEWER_DEVICES: 2 }) },
              ],
              nextCursor: 'rows-2',
            })
          : // Swept in by the rest group, never loaded in the list: only its `user` names it.
            wirePreview([previewRow(onPlan('Remote Row'), STANDARD.id, { user: remote })], { firstPage: false }),
    }))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await previewEveryoneOnStandard(user, dialog)
    const summaryText = () => within(dialog).getByRole('list', { name: m('preview.summaryLabel') }).textContent

    const firstSummary = summaryText()
    expect(firstSummary).toContain(says('preview.count', { count: 3 }))
    await user.click(within(dialog).getByRole('button', { name: says('preview.loadMore') }))
    const rowsList = () => within(within(dialog).getByRole('list', { name: m('preview.rowsLabel') })).getAllByRole('listitem')
    await waitFor(() => expect(rowsList()).toHaveLength(2))

    expect(sentTo('POST', PREVIEW_URL).at(-1)?.body).toMatchObject({ cursor: 'rows-2', limit: 50 })
    expect(summaryText()).toBe(firstSummary)
    expect(summaryText()).toContain(m('warnings.count', { label: says('warnings.fewerDevices'), count: 2 }))
    expect(rowsList()[1]).toHaveTextContent('Zoe Remote')
    expect(rowsList()[1]).toHaveTextContent('@zoe')
  })
})

describe('moving the subscriptions: who may, and what cannot be read', () => {
  it.each<[string, ReadonlyArray<{ kind: string; count: number }>, boolean]>([
    ['with subscriptions on it', [{ kind: 'subscriptions', count: 3 }], true],
    ['with nothing but a quest on it', [{ kind: 'quests', count: 1 }], false],
  ])(
    'without subscriptions:view keeps today’s dialog for a plan %s, never asks for the list, and names the missing access only when it matters',
    async (_label, references, saysAccess) => {
      grant('plans:view', 'plans:delete')
      wire.references.set(GOLD.id, referencesReply(GOLD.id, references))
      const user = await renderPage(MIGRATION_CATALOGUE)
      const dialog = await openMoveDialog(user)

      const access = says('needsSubscriptionAccess')
      if (saysAccess) expect(dialog).toHaveTextContent(access)
      else expect(dialog).not.toHaveTextContent(access)
      expect(within(dialog).queryByRole('combobox')).toBeNull()
      expect(
        wire.sent.filter((request) => request.url.includes('/subscriptions') || request.url.includes('/migrations')),
      ).toEqual([])

      await user.click(within(dialog).getByRole('button', { name: confirmLabel() }))
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
      expect(deletesSent()).toEqual([{ method: 'DELETE', url: `/admin/plans/${GOLD.id}` }])
    },
  )

  it('with subscriptions:view but not :edit shows the list and the preview, and holds «Перенести и удалить» with the reason', async () => {
    grantMove({ withoutEdit: true })
    const alice = onPlan('Alice')
    const bob = onPlan('Bob')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice, bob], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id), previewRow(bob, STANDARD.id)]))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)

    expect(within(dialog).getByRole('list', { name: m('choose.listLabel') })).toBeInTheDocument()
    expect(dialog).toHaveTextContent(says('choose.needsEditPermission'))
    await previewEveryoneOnStandard(user, dialog)

    expect(within(within(dialog).getByRole('list', { name: m('preview.rowsLabel') })).getAllByRole('listitem')).toHaveLength(2)
    expect(confirmMove(dialog)).toBeDisabled()
    expect(dialog).toHaveTextContent(says('preview.needsEditPermission'))
    await user.click(confirmMove(dialog))
    expect(sentTo('POST', START_URL)).toEqual([])
  })

  it('keeps today’s dialog, and still deletes, when the subscriptions come back in a shape this build cannot read', async () => {
    grantMove()
    wire.references.set(GOLD.id, referencesReply(GOLD.id, [{ kind: 'subscriptions', count: 2 }]))
    wire.subscriptions.set(GOLD.id, () => ({
      status: 200,
      data: { total: 'two', matched: 0, items: [], nextCursor: null },
    }))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)

    expect(dialog).toHaveTextContent(i18n.t('plansPage.deleteDialog.used'))
    expect(dialog).toHaveTextContent(says('subscriptionsUnavailable'))
    expect(within(dialog).queryByRole('combobox')).toBeNull()
    const confirm = within(dialog).getByRole('button', { name: confirmLabel() })
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(deletesSent()).toEqual([{ method: 'DELETE', url: `/admin/plans/${GOLD.id}` }])
  })

  // Delete waits for the first page as the dialog opens, like the references it
  // waits for 10 seconds at most — never the client-wide thirty.
  it('waits 10 seconds for the first page of subscriptions, then keeps today’s dialog and still deletes', async () => {
    grantMove()
    wire.references.set(GOLD.id, referencesReply(GOLD.id, [{ kind: 'subscriptions', count: 3 }]))
    wire.subscriptions.set(GOLD.id, () => ({ timeout: true }))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)

    expect(sentTo('GET', SUBSCRIPTIONS_URL).map((request) => request.timeout)).toEqual([10_000])
    expect(dialog).toHaveTextContent(says('subscriptionsUnavailable'))
    expect(within(dialog).queryByRole('combobox')).toBeNull()
    const confirm = within(dialog).getByRole('button', { name: confirmLabel() })
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    expect(deletesSent()).toEqual([{ method: 'DELETE', url: `/admin/plans/${GOLD.id}` }])
  })

  it('says the changes could not be calculated, and holds the move, when the preview cannot be read', async () => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.previews.set(GOLD.id, () => ({ status: 200, data: { summary: [], rows: 'soon', nextCursor: null } }))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await previewEveryoneOnStandard(user, dialog)

    expect(dialog).toHaveTextContent(says('refusals.previewFailed'))
    expect(confirmMove(dialog)).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: i18n.t('common.retry') })).toBeEnabled()
    expect(within(dialog).queryByRole('list', { name: m('preview.rowsLabel') })).toBeNull()
    expect(sentTo('POST', START_URL)).toEqual([])
  })

  it('names a refused target in the operator’s words, offers no pointless retry, and refreshes the plans', async () => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.previews.set(GOLD.id, () => ({
      status: 400,
      data: { statusCode: 400, code: 'TARGET_NOT_FOUND', errorCode: 'TARGET_NOT_FOUND', message: 'Target plan not found' },
    }))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    // The choose step reads the catalogue afresh once; count from after that read.
    await waitFor(() => expect(catalogueReads()).toBeGreaterThanOrEqual(2))
    const readsBefore = catalogueReads()
    await previewEveryoneOnStandard(user, dialog)

    expect(dialog).toHaveTextContent(says('refusals.targetNotFound'))
    expect(dialog).not.toHaveTextContent('Target plan not found')
    expect(within(dialog).queryByRole('button', { name: i18n.t('common.retry') })).toBeNull()
    await waitFor(() => expect(catalogueReads()).toBeGreaterThan(readsBefore))
  })

  it('lets the dialog be closed, deleting nothing, when the state of the move cannot be read', async () => {
    grantMove()
    const alice = onPlan('Alice')
    wire.subscriptions.set(GOLD.id, ({ params }) => page([alice], params))
    wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id)]))
    wire.starts.set(GOLD.id, started)
    wire.runs.set(RUN_ID, () => ({
      status: 200,
      data: { runId: RUN_ID, status: 'RUNNING', totals: {}, sync: {}, problems: [], problemsCursor: null, finished: false },
    }))
    const user = await renderPage(MIGRATION_CATALOGUE)
    const dialog = await openMoveDialog(user)
    await startMove(user, dialog)

    await waitFor(() => expect(headline(dialog)).not.toBe(m('running.starting')))
    expect(headline(dialog)).toBe(says('running.statusUnavailable'))
    expect(within(dialog).getByRole('button', { name: i18n.t('common.close') })).toBeEnabled()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(deletesSent()).toEqual([])
  })

  it('shows still icons, and says in words what is happening, when the operator asks for reduced motion', async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
    try {
      grantMove()
      const alice = onPlan('Alice')
      const bob = onPlan('Bob')
      wire.subscriptions.set(GOLD.id, ({ params, call }) => page(call === 0 ? [alice, bob] : [], params))
      wire.previews.set(GOLD.id, () => previewOf([previewRow(alice, STANDARD.id), previewRow(bob, STANDARD.id)]))
      wire.starts.set(GOLD.id, started)
      const finish = held()
      wire.runs.set(RUN_ID, ({ call }) => (call === 0 ? movingReply(1, 2) : call === 1 ? finish.reply : runReply()))
      const user = await renderPage(MIGRATION_CATALOGUE)
      const dialog = await openMoveDialog(user)
      await startMove(user, dialog)

      await waitFor(() => expect(sentTo('GET', RUN_URL)).toHaveLength(2))
      expect(dialog.querySelector('[data-motion]')?.getAttribute('data-motion')).toBe('static')
      expect(dialog.querySelector('[class*="plan-migration-"]')).toBeNull()
      // The still icon comes with the words: the status line says what is happening.
      expect(headline(dialog)).toBe(says('running.moving', { done: 1, total: 2 }))

      finish.release(runReply())
      expect(await within(dialog).findByText(says('success.title'))).toBeInTheDocument()
      expect(dialog.querySelector('[data-motion]')?.getAttribute('data-motion')).toBe('static')
      expect(dialog.querySelector('[class*="plan-migration-"]')).toBeNull()
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith(i18n.t('plansPage.deleted')))
    } finally {
      window.matchMedia = original
    }
  })
})

describe('moving the subscriptions, in Russian', () => {
  afterEach(async () => {
    // Unmount first, as the Russian block above does.
    cleanup()
    await i18n.changeLanguage('en')
  })

  it('chooses and previews in Russian, with the plural forms Russian needs', async () => {
    await i18n.changeLanguage('ru')
    await waitFor(() => expect(i18n.t('plansPage.deleteDialog.confirm')).toBe('Удалить'))

    grantMove()
    const members = Array.from({ length: 22 }, (_, index) =>
      onPlan(`Member ${String(index + 1).padStart(2, '0')}`, {
        flags: { pendingRenewalForPlan: false, scheduledTermOnPlan: index === 1, sharedPanelProfile: false },
      }),
    )
    wire.subscriptions.set(GOLD.id, ({ params }) => page(members, params))
    wire.previews.set(GOLD.id, () =>
      previewOf(
        [
          previewRow(members[0], STANDARD.id, {
            before: snapshot({ trafficLimit: null, deviceLimit: 4, isTrial: true }),
            after: snapshot({ trafficLimit: 30, deviceLimit: 4 }),
            kept: ['deviceLimit'],
            warnings: ['LESS_TRAFFIC', 'TRIAL_BECOMES_REGULAR', 'LOCAL_ONLY', 'TARGET_NOT_RENEWABLE'],
          }),
        ],
        [{ targetPlanId: STANDARD.id, count: 22, skipped: 1, warnings: { LESS_TRAFFIC: 5 } }],
      ),
    )
    const user = await renderPage(MIGRATION_CATALOGUE)
    await user.click(within(controlsOf(GOLD.name)).getByRole('button', { name: 'Удалить тариф' }))
    const dialog = await screen.findByRole('alertdialog')
    await referencesSettled(dialog)

    expect(dialog).toHaveTextContent('Удалить тариф «Gold»?')
    expect(dialog).toHaveTextContent(
      'На тарифе 22 подписки. Перед удалением перенесите подписки на другие тарифы — тариф удалится после переноса.',
    )
    const renewedEarly = within(dialog).getByRole('checkbox', { name: 'Выбрать: Member 02' }).closest('li')
    expect(renewedEarly).toHaveTextContent('Продлена заранее')
    await user.click(within(dialog).getByRole('checkbox', { name: 'Выбрать: Member 01' }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Тариф для переноса' }))
    await user.click(await screen.findByRole('option', { name: 'Vintage · архивный' }))
    await user.click(within(dialog).getByRole('button', { name: 'Назначить выбранным' }))
    expect(dialog).toHaveTextContent('Назначено 1 из 22')
    expect(dialog).toHaveTextContent('Для 21 подписки не выбран тариф. Назначьте его или удалите тариф без переноса.')
    expect(within(dialog).getByRole('button', { name: 'Удалить без переноса' })).toBeEnabled()
    expect(within(dialog).getByRole('button', { name: 'Далее' })).toBeDisabled()

    await user.click(within(dialog).getByRole('checkbox', { name: 'Выбрать все показанные' }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Тариф для переноса' }))
    await user.click(await screen.findByRole('option', { name: 'Standard' }))
    await user.click(within(dialog).getByRole('button', { name: 'Назначить выбранным' }))
    await user.click(within(dialog).getByRole('button', { name: 'Далее' }))
    await within(dialog).findByRole('button', { name: 'Назад' })
    await waitFor(() => expect(within(dialog).queryByText('Считаем изменения…')).toBeNull())

    expect(dialog).toHaveTextContent(
      'Так изменятся подписки после переноса. Срок действия и статус останутся прежними, деньги не спишутся, подписчики уведомлений не получат.',
    )
    const summary = within(dialog).getByRole('list', { name: 'По тарифам' })
    expect(summary).toHaveTextContent('22 подписки')
    expect(summary).toHaveTextContent('Будет пропущено: 1')
    expect(summary).toHaveTextContent('Меньше трафика: 5')
    const [row] = within(within(dialog).getByRole('list', { name: 'Изменения по подпискам' })).getAllByRole('listitem')
    const cells = within(row).getAllByRole('definition')
    // Read aloud as «было … станет …»; the arrow between them is decoration.
    expect(cells[0].textContent).toBe('было Без ограничений → станет 30 ГБ')
    expect(within(cells[1]).getByText('вручную')).toBeInTheDocument()
    expect(cells[4].textContent).toBe('было пробная → станет обычная')
    for (const label of ['Меньше трафика', 'Пробная станет обычной', 'Remnawave — позже', 'Нельзя продлить']) {
      expect(row).toHaveTextContent(label)
    }
    expect(within(dialog).getByRole('button', { name: 'Перенести и удалить' })).toBeEnabled()
    // Not one word of the English copy leaked through as a fallback.
    expect(dialog).not.toHaveTextContent('subscription')
    expect(dialog).not.toHaveTextContent('Unlimited')
  })
})
