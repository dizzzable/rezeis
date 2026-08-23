/**
 * WHAT A REFUSED PLAN WRITE SAYS TO THE OPERATOR.
 *
 * Every mutation on this page used to report failures through
 * `getErrorMessage`, which prints the server's own sentence. For a plan write
 * that sentence is an English diagnostic naming a raw cuid — an operator
 * running the panel in Russian was shown, verbatim:
 *
 *     Replacement and upgrade plans must be active non-trial public plans:
 *     cmsxo98e8006r01jgn33gtpbe
 *
 * The backend now sends a stable `code` beside it. The rule these pin has
 * three outcomes and the middle one is the one a rewrite loses:
 *
 *   • a code this build knows       → the translated sentence;
 *   • a code this build does NOT    → the server's own `message`, in English;
 *   • neither (a dead host)         → the per-mutation fallback.
 *
 * The middle case is not a nicety. A rolling deploy WILL put a newer backend
 * behind this panel, and folding an unknown code into the generic fallback
 * throws away the only line that says which of seventeen refusals happened.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import PlansPage from './plans-page'
import type { Plan } from './plans-api'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}))

describe('PlansPage plan-write refusals', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockImplementation((async (path: string) => {
      if (path === '/admin/plans') return { data: [listedPlan()] }
      return { data: [] }
    }) as never)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders a recognised refusal in the operator language, not the server sentence', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValue({
      response: {
        data: {
          code: 'PLAN_NAME_TAKEN',
          message: 'Plan name already in use: cmsxo98e8006r01jgn33gtpbe',
        },
      },
    })

    renderWithProviders(<PlansPage />)

    await user.click(await screen.findByRole('button', { name: 'Create plan' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create plan' })
    await user.type(within(dialog).getByPlaceholderText('Premium 50GB'), 'Premium')
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'A plan with this name already exists. Give this one a different name and save again.',
      )
    })
    // The server's own English, carrying a cuid, is exactly what this replaces.
    expect(toast.error).not.toHaveBeenCalledWith(
      'Plan name already in use: cmsxo98e8006r01jgn33gtpbe',
    )
  })

  it('falls back to the server sentence for a code this build does not know', async () => {
    const user = userEvent.setup()
    // A refusal added to the backend after this panel was built — the rolling
    // deploy case. English prose the operator has to puzzle over still beats a
    // generic sentence that names nothing.
    vi.mocked(api.post).mockRejectedValue({
      response: {
        data: {
          code: 'PLAN_ARCHIVE_WINDOW_CLOSED',
          message: 'Plans cannot be archived during a billing run',
        },
      },
    })

    renderWithProviders(<PlansPage />)

    await user.click(await screen.findByRole('button', { name: 'Archive plan' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Plans cannot be archived during a billing run')
    })
    // Which mutation's `onError` this went through, stated rather than assumed.
    expect(api.post).toHaveBeenCalledWith('/admin/plans/plan-1/archive')
    expect(toast.error).not.toHaveBeenCalledWith('Failed to archive plan')
  })

  it('falls back to the per-mutation copy when there is no response at all', async () => {
    const user = userEvent.setup()
    // Axios shape for a refused connection: a `message`, no `response`. That
    // `message` is axios' own untranslated string, which is why it must not be
    // what reaches the operator.
    vi.mocked(api.post).mockRejectedValue(Object.assign(new Error('Network Error'), {}))

    renderWithProviders(<PlansPage />)

    await user.click(await screen.findByRole('button', { name: 'Archive plan' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to archive plan')
    })
    expect(api.post).toHaveBeenCalledWith('/admin/plans/plan-1/archive')
    expect(toast.error).not.toHaveBeenCalledWith('Network Error')
  })
})

function listedPlan(): Plan {
  return {
    id: 'plan-1',
    name: 'Premium',
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
  }
}
