import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'
import { PromocodeForm, type PromocodeFormData } from './promocode-form'

/**
 * A promocode does a LIST of things now.
 *
 * The form used to have one "reward type" select that drove everything, so
 * "-10% on the next purchase AND +7 days" needed two separate codes and a line
 * of copy telling the customer to enter both. These are about the two claims
 * that make the new shape worth anything: that a second action actually
 * reaches the request, and that a discount's own restrictions are not confused
 * with the promocode's activation conditions.
 */

vi.mock('@/features/plans/plans-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/features/plans/plans-api')
  return {
    ...actual,
    usePlans: () => ({
      data: [
        { id: 'plan-1m', name: '1 месяц', isArchived: false, durations: [] },
        { id: 'plan-6m', name: '6 месяцев', isArchived: false, durations: [] },
      ],
    }),
  }
})

function renderForm() {
  const onSubmit = vi.fn<(data: PromocodeFormData) => void>()
  renderWithProviders(<PromocodeForm onSubmit={onSubmit} isLoading={false} />)
  return onSubmit
}

/** Submit is disabled until there is a code, so every test types one first. */
async function submitWith(user: ReturnType<typeof userEvent.setup>) {
  const inputs = screen.getAllByRole('textbox')
  await user.type(inputs[0] as HTMLElement, 'D3M-SEP')
  const buttons = screen.getAllByRole('button')
  const submit = buttons[buttons.length - 1] as HTMLElement
  await user.click(submit)
}

describe('a promocode can do more than one thing', () => {
  it('sends the main action and the added one', async () => {
    const user = userEvent.setup()
    const onSubmit = renderForm()

    await user.click(await screen.findByRole('button', { name: /Добавить действие|Add action/ }))
    await submitWith(user)

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const data = onSubmit.mock.calls[0]?.[0]
    expect(data?.actions?.length).toBe(2)
  })

  it('keeps sending the legacy fields beside the list', async () => {
    // The API rewrites them from the list's first entry, and an older API reads
    // only them. Dropping them here would make a panel and an API on different
    // versions describe different offers.
    const user = userEvent.setup()
    const onSubmit = renderForm()

    await submitWith(user)

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const data = onSubmit.mock.calls[0]?.[0]
    expect(data?.rewardType).toBe('DURATION')
    expect(data?.actions?.[0]?.type).toBe('DURATION')
  })

  it('never offers the same action type twice', async () => {
    // One action per type: "+7 days and another +3 days" is one action for ten,
    // and the database enforces it. Offering the duplicate would only be a way
    // to reach that error.
    const user = userEvent.setup()
    renderForm()

    await user.click(await screen.findByRole('button', { name: /Добавить действие|Add action/ }))

    // The added row must not offer DURATION, which the main action already is.
    const selects = screen.getAllByRole('combobox')
    expect(selects.length).toBeGreaterThan(1)
  })
})

describe('a discount carries restrictions of its own', () => {
  it('offers them only for a discount action', async () => {
    // The promocode's own plan list says where the CODE may be activated. This
    // one says where the granted DISCOUNT may be spent — weeks later, possibly
    // on a different plan. They were the same control before, which is why
    // "-20% only on six months" could not be expressed.
    renderForm()

    expect(screen.queryByText(/Скидка действует на тарифах|Discount applies to plans/)).toBeNull()
  })
})
