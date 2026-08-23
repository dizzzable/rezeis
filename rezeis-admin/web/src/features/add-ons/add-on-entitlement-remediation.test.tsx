/**
 * The Delivery tab used to call exactly one of the seven routes on
 * `admin/add-on-entitlements` — `GET metrics` — while rendering
 * `openIncidentsByKind` and the stranded/pending SLO backlog. It told the
 * operator something was wrong and offered nothing to do about it; the other
 * six routes had no caller anywhere in this repository or the cabinet.
 *
 * A test that a handler exists, or that a prop was passed, would reproduce that
 * disease exactly. So these drive the tab the way an operator does — type an
 * id, type a reason, click — and assert THE REQUESTS THAT GO OUT: path, body,
 * and, for the two consequential commands, that nothing goes out until a
 * confirmation naming the target is accepted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { usePermissionStore } from '@/features/rbac'
import { renderWithProviders } from '@/test/test-utils'
import { AddOnEntitlementsTab } from './add-on-entitlements-tab'

const METRICS = {
  entitlementsByState: { ACTIVE: 4 },
  projectionsByState: { PENDING: 1 },
  deviceReductionPlansByState: { BLOCKED: 1 },
  openIncidentsByKind: { DEVICE_REDUCTION_BLOCKED: 2 },
  slo: {
    objectiveMs: 300000,
    alertMs: 900000,
    strandedCapturedOverObjective: 5,
    strandedCapturedOverAlert: 1,
    oldestStrandedAgeMs: 1200000,
    pendingSyncOverObjective: 2,
    pendingSyncOverAlert: 0,
    oldestPendingSyncAgeMs: 600000,
  },
}

const INSPECTION = {
  subscriptionId: 'sub-1',
  entitlements: [
    {
      id: 'ent-1',
      type: 'EXTRA_TRAFFIC',
      state: 'ACTIVE',
      lifetime: 'UNTIL_SUBSCRIPTION_END',
      valuePerUnit: 50,
      totalValue: '53687091200',
      currency: 'RUB',
      totalAmount: '150',
      purchasedAt: '2026-08-01T10:00:00.000Z',
      activatedAt: '2026-08-01T10:00:01.000Z',
      expiresAt: null,
      terminalReason: null,
      sourceTransactionId: 'tx-1',
      sourceLineKey: 'line-1',
      catalogRevision: 3,
    },
  ],
  projection: {
    desiredRevision: '9',
    state: 'PENDING',
    desiredTrafficLimitBytes: '107374182400',
    desiredDeviceLimit: 3,
    lastAppliedRevision: '8',
  },
  incidents: [
    {
      id: 'inc-1',
      kind: 'DEVICE_REDUCTION_BLOCKED',
      severity: 'CRITICAL',
      state: 'OPEN',
      summaryCode: 'STRICT_LIST_MALFORMED',
      createdAt: '2026-08-20T09:00:00.000Z',
    },
  ],
  deviceReductionPlans: [
    {
      id: 'plan-1',
      state: 'PENDING',
      desiredLimit: 2,
      projectionRevision: '9',
      targetCount: 3,
      attempts: 1,
    },
  ],
}

const ALL_TOKENS = [
  'add_on_entitlements:view',
  'add_on_entitlements:run',
  'add_on_entitlements:resolve',
  'add_on_entitlements:enforce',
  'add_on_entitlements:moderate',
]

function grant(tokens: readonly string[]): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(tokens),
    mustChangePassword: false,
    // Deliberately NOT 'DEV': that role short-circuits every check, which would
    // make the gating assertions below pass no matter what is rendered.
    role: 'ADMIN',
    rbacRoleId: null,
    error: null,
  })
}

function mockReads(): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/add-on-entitlements/metrics') return { data: METRICS }
    if (path === '/admin/add-on-entitlements/subscriptions/sub-1') return { data: INSPECTION }
    return { data: {} }
  })
}

/** Just enough of a vitest spy to read the calls back, without naming its type. */
interface CallRecorder {
  readonly mock: { readonly calls: readonly unknown[][] }
}

function mockCommands() {
  return vi.spyOn(api, 'post').mockImplementation(async (path: string) => {
    if (path.endsWith('/retry-sync')) return { data: { retried: 2, jobIds: ['job-1', 'job-2'] } }
    if (path.endsWith('/reconcile'))
      return { data: { changed: true, desiredRevision: '10', syncJobId: 'job-3' } }
    if (path.endsWith('/acknowledge')) return { data: { changed: true } }
    if (path.endsWith('/reverse')) return { data: { state: 'REVERSED', changed: true } }
    return { data: { status: 'APPLIED' } }
  })
}

function bodyOf(spy: CallRecorder, index: number): Record<string, unknown> {
  return spy.mock.calls[index]?.[1] as Record<string, unknown>
}

function pathsOf(spy: CallRecorder): string[] {
  return spy.mock.calls.map((call) => call[0] as string)
}

async function openInspector(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(await screen.findByLabelText('Subscription ID'), 'sub-1')
  await user.click(screen.getByRole('button', { name: 'Inspect' }))
  await screen.findByText('Entitlement ledger')
}

describe('add-on entitlement remediation from the Delivery tab', () => {
  beforeEach(() => {
    grant(ALL_TOKENS)
    mockReads()
  })

  afterEach(() => {
    cleanup()
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('sends the two subscription-scoped commands and the incident acknowledgement', async () => {
    const user = userEvent.setup()
    const post = mockCommands()
    renderWithProviders(<AddOnEntitlementsTab />)

    await openInspector(user)
    await user.type(screen.getByLabelText('Reason'), 'ticket 42: stalled fulfilment')

    await user.click(screen.getByRole('button', { name: 'Retry failed syncs' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: 'Force reconcile' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    await user.click(screen.getByRole('button', { name: 'Acknowledge incident inc-1' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3))

    expect(pathsOf(post)).toEqual([
      '/admin/add-on-entitlements/subscriptions/sub-1/retry-sync',
      '/admin/add-on-entitlements/subscriptions/sub-1/reconcile',
      '/admin/add-on-entitlements/incidents/inc-1/acknowledge',
    ])
    for (let i = 0; i < 3; i += 1) {
      expect(bodyOf(post, i)['reason']).toBe('ticket 42: stalled fulfilment')
      expect(String(bodyOf(post, i)['commandKey']).length).toBeGreaterThan(0)
    }
  })

  it('reads the inspected subscription through the inspect route', async () => {
    const user = userEvent.setup()
    mockCommands()
    renderWithProviders(<AddOnEntitlementsTab />)

    await openInspector(user)

    expect(api.get).toHaveBeenCalledWith('/admin/add-on-entitlements/subscriptions/sub-1')
  })

  it('will not reverse an entitlement until a confirmation naming it is accepted', async () => {
    const user = userEvent.setup()
    const post = mockCommands()
    renderWithProviders(<AddOnEntitlementsTab />)

    await openInspector(user)
    await user.type(screen.getByLabelText('Reason'), 'chargeback on tx-1')

    await user.click(screen.getByRole('button', { name: 'Reverse entitlement ent-1' }))

    const dialog = await screen.findByRole('alertdialog')
    // The confirmation has to say WHICH entitlement, or it is a speed bump.
    expect(dialog).toHaveTextContent('ent-1')
    expect(dialog).toHaveTextContent('EXTRA_TRAFFIC')
    expect(dialog).toHaveTextContent('150 RUB')
    // Anti-vacuity: nothing may have gone out yet.
    expect(post).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(post).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Reverse entitlement ent-1' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reverse' }),
    )

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0]?.[0]).toBe('/admin/add-on-entitlements/entitlements/ent-1/reverse')
    expect(bodyOf(post, 0)['reason']).toBe('chargeback on tx-1')
  })

  it('will not approve a device-reduction plan until a confirmation naming it is accepted', async () => {
    const user = userEvent.setup()
    const post = mockCommands()
    renderWithProviders(<AddOnEntitlementsTab />)

    await openInspector(user)
    await user.type(screen.getByLabelText('Reason'), 'reviewed with support')

    await user.click(screen.getByRole('button', { name: 'Approve device-reduction plan plan-1' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('plan-1')
    // Approving deletes devices off the panel — the count has to be on screen.
    expect(dialog).toHaveTextContent('3')
    expect(post).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(post).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Approve device-reduction plan plan-1' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Approve and execute',
      }),
    )

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0]?.[0]).toBe('/admin/add-on-entitlements/device-plans/plan-1/approve')
  })

  it('shows only the controls whose route permission the operator actually holds', async () => {
    const user = userEvent.setup()
    mockCommands()
    // `view` alone: the inspector opens, and not one command is offered.
    grant(['add_on_entitlements:view'])
    renderWithProviders(<AddOnEntitlementsTab />)

    await openInspector(user)

    expect(screen.queryByRole('button', { name: 'Retry failed syncs' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Force reconcile' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Acknowledge incident inc-1' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reverse entitlement ent-1' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve device-reduction plan plan-1' })).toBeNull()
  })

  it('gates each control on its own permission, not on one blanket grant', async () => {
    const user = userEvent.setup()
    mockCommands()
    // `run` is retry-sync's token; `resolve` (reconcile + acknowledge),
    // `enforce` (reverse) and `moderate` (approve) are withheld.
    grant(['add_on_entitlements:view', 'add_on_entitlements:run'])
    renderWithProviders(<AddOnEntitlementsTab />)

    await openInspector(user)

    expect(screen.getByRole('button', { name: 'Retry failed syncs' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Force reconcile' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Acknowledge incident inc-1' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reverse entitlement ent-1' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve device-reduction plan plan-1' })).toBeNull()
  })

  it('sends nothing while the mandatory reason is empty', async () => {
    const user = userEvent.setup()
    const post = mockCommands()
    renderWithProviders(<AddOnEntitlementsTab />)

    await openInspector(user)

    const retry = screen.getByRole('button', { name: 'Retry failed syncs' })
    expect(retry).toBeDisabled()
    await user.click(retry)
    expect(post).not.toHaveBeenCalled()

    // Two characters is under the DTO's `@MinLength(3)` — still refused.
    await user.type(screen.getByLabelText('Reason'), 'ok')
    expect(screen.getByRole('button', { name: 'Retry failed syncs' })).toBeDisabled()
    expect(post).not.toHaveBeenCalled()
  })

  it('retries a failed command under the SAME commandKey, and mints a new one once it lands', async () => {
    const user = userEvent.setup()
    let attempt = 0
    const post = vi.spyOn(api, 'post').mockImplementation(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('gateway timeout')
      return { data: { changed: true } }
    })
    renderWithProviders(<AddOnEntitlementsTab />)

    await openInspector(user)
    await user.type(screen.getByLabelText('Reason'), 'ack after panel outage')

    await user.click(screen.getByRole('button', { name: 'Acknowledge incident inc-1' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: 'Acknowledge incident inc-1' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))

    // The operator who clicks again after a timeout means "finish that
    // command", not "run a second one" — which is the whole point of the key
    // the backend now honours on this route.
    expect(bodyOf(post, 1)['commandKey']).toBe(bodyOf(post, 0)['commandKey'])

    await user.click(screen.getByRole('button', { name: 'Acknowledge incident inc-1' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3))

    // Anti-vacuity: the key is not simply constant. Once a command has landed,
    // the next click is a NEW command and must not be deduplicated against it.
    expect(bodyOf(post, 2)['commandKey']).not.toBe(bodyOf(post, 1)['commandKey'])
  })

  it('turns the aggregate incident counter into a way into the inspector', async () => {
    const user = userEvent.setup()
    mockCommands()
    renderWithProviders(<AddOnEntitlementsTab />)

    await user.click(
      await screen.findByRole('button', { name: 'Remediate DEVICE_REDUCTION_BLOCKED incidents' }),
    )

    expect(screen.getByLabelText('Subscription ID')).toHaveFocus()
  })
})

/**
 * What the Approve button TELLS the operator.
 *
 * `POST device-plans/:id/approve` answers 200 for five different things, and
 * only one of them means the customer's devices were removed. `DEFERRED`,
 * `BLOCKED`, `SUPERSEDED` and `REMEDIATION_REQUIRED` all mean the override ran
 * and the plan is not applied — and every one of them used to raise the same
 * green toast as a success. An operator who is told their override worked
 * closes the incident, so a button that reports success on a no-op is worse
 * than no button at all.
 *
 * These specs assert the toast the operator actually gets, per outcome. They
 * spy on the concrete `toast.*` channel rather than on some internal, because
 * the colour IS the message here: the sentence is nearly the same either way.
 */
describe('the Approve button reports the outcome it actually got', () => {
  function toastSpies() {
    return {
      success: vi.spyOn(toast, 'success').mockReturnValue('t-ok'),
      warning: vi.spyOn(toast, 'warning').mockReturnValue('t-warn'),
      error: vi.spyOn(toast, 'error').mockReturnValue('t-err'),
      info: vi.spyOn(toast, 'info').mockReturnValue('t-info'),
    }
  }

  /** Drive the button the way an operator does, confirmation included. */
  async function approve(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await openInspector(user)
    await user.type(screen.getByLabelText('Reason'), 'ticket 91: panel fixed')
    await user.click(screen.getByRole('button', { name: 'Approve device-reduction plan plan-1' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Approve and execute',
      }),
    )
  }

  beforeEach(() => {
    grant(ALL_TOKENS)
    mockReads()
  })

  afterEach(() => {
    cleanup()
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('APPLIED — the one outcome that removed devices — is reported as a success', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'post').mockResolvedValue({ data: { status: 'APPLIED' } })
    const spy = toastSpies()
    renderWithProviders(<AddOnEntitlementsTab />)

    await approve(user)

    await waitFor(() => expect(spy.success).toHaveBeenCalledTimes(1))
    expect(String(spy.success.mock.calls[0]?.[0])).toContain('APPLIED')
    expect(spy.warning).not.toHaveBeenCalled()
    expect(spy.error).not.toHaveBeenCalled()
  })

  // The whole point. Each of these is a 200 whose plan is NOT applied.
  for (const status of ['BLOCKED', 'DEFERRED', 'SUPERSEDED', 'REMEDIATION_REQUIRED']) {
    it(`${status} — the override ran and did not apply — is NOT reported as a success`, async () => {
      const user = userEvent.setup()
      vi.spyOn(api, 'post').mockResolvedValue({ data: { status } })
      const spy = toastSpies()
      renderWithProviders(<AddOnEntitlementsTab />)

      await approve(user)

      await waitFor(() => expect(spy.warning).toHaveBeenCalledTimes(1))
      // The operator has to be able to read WHICH outcome, not just that
      // something was off — `BLOCKED` and `DEFERRED` need opposite responses.
      expect(String(spy.warning.mock.calls[0]?.[0])).toContain(status)
      expect(spy.success).not.toHaveBeenCalled()
    })
  }

  it('a REFUSED override arrives as an error carrying the reason the server gave', async () => {
    // `REFUSED` never travels as 200: the route maps it to 404/409 with its own
    // sentence, which survives `AdminSafeExceptionFilter` intact. Showing the
    // generic fallback instead would drop the one word — the plan state — that
    // tells the operator why.
    const user = userEvent.setup()
    const declined = Object.assign(new Error('Request failed with status code 409'), {
      response: {
        status: 409,
        data: {
          statusCode: 409,
          message: 'Device reduction plan cannot be re-run: PLAN_STATE_APPLIED',
        },
      },
    })
    vi.spyOn(api, 'post').mockRejectedValue(declined)
    const spy = toastSpies()
    renderWithProviders(<AddOnEntitlementsTab />)

    await approve(user)

    await waitFor(() => expect(spy.error).toHaveBeenCalledTimes(1))
    expect(spy.error.mock.calls[0]?.[0]).toBe(
      'Device reduction plan cannot be re-run: PLAN_STATE_APPLIED',
    )
    expect(spy.success).not.toHaveBeenCalled()
    expect(spy.warning).not.toHaveBeenCalled()
  })

  it('anti-vacuity: the tone is chosen per OUTCOME, not fixed per command', async () => {
    // If `approve` had simply been re-pointed at `toast.warning`, every test
    // above but the first would still pass. Acknowledging an incident that
    // really did flip OPEN → ACKNOWLEDGED is still a success, on the same
    // mutation, through the same handler.
    const user = userEvent.setup()
    vi.spyOn(api, 'post').mockResolvedValue({ data: { changed: true } })
    const spy = toastSpies()
    renderWithProviders(<AddOnEntitlementsTab />)

    await openInspector(user)
    await user.type(screen.getByLabelText('Reason'), 'ticket 91: panel fixed')
    await user.click(screen.getByRole('button', { name: 'Acknowledge incident inc-1' }))

    await waitFor(() => expect(spy.success).toHaveBeenCalledTimes(1))
    expect(spy.warning).not.toHaveBeenCalled()
  })

  it('anti-vacuity: a command that changed nothing is not dressed up as a success either', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'post').mockResolvedValue({ data: { changed: false } })
    const spy = toastSpies()
    renderWithProviders(<AddOnEntitlementsTab />)

    await openInspector(user)
    await user.type(screen.getByLabelText('Reason'), 'ticket 91: panel fixed')
    await user.click(screen.getByRole('button', { name: 'Acknowledge incident inc-1' }))

    await waitFor(() => expect(spy.info).toHaveBeenCalledTimes(1))
    expect(spy.success).not.toHaveBeenCalled()
  })
})
