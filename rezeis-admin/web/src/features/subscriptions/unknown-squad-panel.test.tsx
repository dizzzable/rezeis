import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { UnknownSquadPanel } from './unknown-squad-panel'

/**
 * The screen that answers "which subscriptions will fail their next renewal".
 *
 * The assertion that matters most is the LAST one: an unreachable panel must
 * read as a refusal, never as an all-clear. Everywhere else in this codebase a
 * failed panel read degrades to "we could not tell"; a surface whose whole job
 * is to say "these are broken" cannot degrade that way, because an empty list
 * here is indistinguishable from good news.
 */

function grant(permissions: ReadonlyArray<{ resource: string; action: RbacAction }>) {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(permissions.map((p) => `${p.resource}:${p.action}`)),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

const REPORT = {
  scanned: 120,
  affected: 1,
  truncated: false,
  rows: [
    {
      subscriptionId: 'sub-1',
      userId: 'u-1',
      status: 'ACTIVE',
      planName: 'MiniFamily',
      unknownSquads: ['deadbeef-0000-4000-8000-000000000001'],
      externalSquadMissing: false,
    },
  ],
  affectedPlans: [{ id: 'p-1', name: 'MiniFamily' }],
}

beforeEach(() => {
  vi.restoreAllMocks()
  grant([{ resource: 'plans', action: 'view' }])
})

describe('the unknown-squad panel', () => {
  it('renders nothing without plans:view', () => {
    grant([])
    const { container } = renderWithProviders(<UnknownSquadPanel />)
    expect(container.textContent).toBe('')
  })

  it('does not call the endpoint until asked', () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: REPORT } as never)
    renderWithProviders(<UnknownSquadPanel />)
    // It walks the subscription table and asks the panel for its squads; that
    // is not something to do on every page load.
    expect(get).not.toHaveBeenCalled()
  })

  it('names the affected plan and the dead squad', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: REPORT } as never)
    const user = userEvent.setup()

    renderWithProviders(<UnknownSquadPanel />)
    await user.click(screen.getByRole('button'))

    // The plan first: repairing subscriptions while the plan still holds the
    // dead uuid means the next purchase recreates the problem.
    expect(await screen.findAllByText('MiniFamily')).not.toHaveLength(0)
    expect(screen.getByText('sub-1')).toBeInTheDocument()
    expect(screen.getByText('deadbeef')).toBeInTheDocument()
  })

  it('says so plainly when nothing is broken', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { scanned: 10, affected: 0, truncated: false, rows: [], affectedPlans: [] },
    } as never)
    const user = userEvent.setup()

    renderWithProviders(<UnknownSquadPanel />)
    await user.click(screen.getByRole('button'))

    expect(await screen.findByText(/every squad is accounted for/i)).toBeInTheDocument()
  })

  it('shows an unreachable panel as a REFUSAL, not as an all-clear', async () => {
    // The distinction the whole surface rests on. An empty list on a failed
    // read would tell the operator their install is healthy.
    vi.spyOn(api, 'get').mockRejectedValue(new Error('503'))
    const user = userEvent.setup()

    renderWithProviders(<UnknownSquadPanel />)
    await user.click(screen.getByRole('button'))

    await waitFor(() => {
      expect(screen.getByText(/did not answer/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/every squad is accounted for/i)).toBeNull()
  })
})
