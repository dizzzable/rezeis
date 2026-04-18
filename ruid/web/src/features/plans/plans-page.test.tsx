import { AxiosError } from 'axios'
import { describe, expect, it, vi } from 'vitest'
import { PlansPage } from '@/features/plans/plans-page'
import { usePlansQuery } from '@/features/plans/use-plans-query'
import { renderWithProviders } from '@/test/render-app'

vi.mock('@/features/plans/use-plans-query', () => ({
  usePlansQuery: vi.fn(),
}))

function createPlansQuery(overrides: Partial<ReturnType<typeof usePlansQuery>> = {}): ReturnType<typeof usePlansQuery> {
  return {
    data: [
      {
        id: 'plan-1',
        orderIndex: 1,
        name: 'Unlimited',
        description: null,
        tag: null,
        type: 'UNLIMITED',
        trafficLimit: null,
        deviceLimit: 5,
        durations: [
          {
            id: 'duration-1',
            days: 30,
            prices: [{ currency: 'USD', price: '19.99' }],
          },
        ],
      },
    ],
    error: null,
    isPending: false,
    ...overrides,
  } as ReturnType<typeof usePlansQuery>
}

function createPlansError(): AxiosError {
  const plansError = new AxiosError('Plans unavailable')
  Object.defineProperty(plansError, 'response', {
    value: {
      data: { detail: 'Plans unavailable' },
      status: 500,
      statusText: 'Server Error',
      headers: {},
      config: {},
    },
  })
  return plansError
}

describe('PlansPage', () => {
  it('renders the unlimited traffic copy for public plan cards', () => {
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery())

    const { getByText } = renderWithProviders(<PlansPage />)

    expect(getByText('UNLIMITED')).toBeInTheDocument()
    expect(getByText('No public description provided.')).toBeInTheDocument()
    expect(getByText('Traffic limit')).toBeInTheDocument()
    expect(getByText('Unlimited', { selector: 'dd' })).toBeInTheDocument()
    expect(getByText('USD 19.99')).toBeInTheDocument()
    expect(getByText("Available subscription plans loaded through the user API. This route remains a read-only plan catalog while rules acceptance stays the shell's only live write path.")).toBeInTheDocument()
  })

  it('renders the public loading state while the plan catalog is pending', () => {
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ data: undefined, isPending: true }))

    const { getByText } = renderWithProviders(<PlansPage />)

    expect(getByText('Loading plans...')).toBeInTheDocument()
  })

  it('renders a public API error without breaking existing plan rendering', () => {
    vi.mocked(usePlansQuery).mockReturnValue(createPlansQuery({ error: createPlansError() }))

    const { getByText } = renderWithProviders(<PlansPage />)

    expect(getByText('Plans unavailable')).toBeInTheDocument()
    expect(getByText('Unlimited', { selector: 'dd' })).toBeInTheDocument()
  })
})
