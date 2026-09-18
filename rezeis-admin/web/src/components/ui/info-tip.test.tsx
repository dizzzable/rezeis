import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { InfoTip, LabelWithInfo } from './info-tip'

/**
 * The (i) has to be reachable three ways, and Radix gives two of them.
 *
 * A plain Radix tooltip opens on a hover and on focus and never on a touch —
 * its trigger closes on the click a tap produces. Every case below that says
 * "tap" is a case that was unreachable on a phone before this component.
 */

function renderTip() {
  const user = userEvent.setup()
  render(
    <div>
      <InfoTip label="Подробнее: Ключ">Ключ — это привязка.</InfoTip>
      <button type="button">elsewhere</button>
    </div>,
  )
  return { user, icon: screen.getByRole('button', { name: 'Подробнее: Ключ' }) }
}

describe('InfoTip', () => {
  it('opens on a mouse hover', async () => {
    const { user, icon } = renderTip()

    await user.hover(icon)

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Ключ — это привязка.')
  })

  it('keeps the tip open when the hovered icon is clicked', async () => {
    const { user, icon } = renderTip()

    await user.hover(icon)
    await screen.findByRole('tooltip')
    await user.click(icon)

    expect(screen.getByRole('tooltip')).toHaveTextContent('Ключ — это привязка.')
  })

  it('opens on keyboard focus, and a key press on the icon toggles it', async () => {
    const { user } = renderTip()

    await user.tab()
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()

    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())

    await user.keyboard('{Enter}')
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()
  })

  it('opens on a tap, and a second tap on the icon closes it', async () => {
    const { user, icon } = renderTip()

    await user.pointer({ keys: '[TouchA]', target: icon })
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Ключ — это привязка.')

    await user.pointer({ keys: '[TouchA]', target: icon })
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  it('closes on a tap somewhere else', async () => {
    const { user, icon } = renderTip()

    await user.pointer({ keys: '[TouchA]', target: icon })
    await screen.findByRole('tooltip')
    await user.pointer({ keys: '[TouchA]', target: screen.getByRole('button', { name: 'elsewhere' }) })

    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  it('closes on Escape', async () => {
    const { user, icon } = renderTip()

    await user.hover(icon)
    await screen.findByRole('tooltip')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  it('draws the icon it is given in place of the (i), and still opens on a tap', async () => {
    // A marker that explains a STATE rather than a setting — the map's amber
    // "may never be shown" — needs its own icon and the same three ways in.
    const user = userEvent.setup()
    render(
      <InfoTip label="Скорее всего, не покажется" icon={<svg data-testid="marker" aria-hidden="true" />}>
        Такие клиенты открывают кабинет там, где подсказка не разрешена.
      </InfoTip>,
    )
    const button = screen.getByRole('button', { name: 'Скорее всего, не покажется' })

    expect(button.querySelector('[data-testid="marker"]')).not.toBeNull()
    expect(button.querySelector('.lucide-info')).toBeNull()

    await user.pointer({ keys: '[TouchA]', target: button })
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Такие клиенты открывают кабинет')
  })

  it('draws the (i) when no icon is given', () => {
    render(<InfoTip label="Подробнее: Ключ">Ключ — это привязка.</InfoTip>)

    expect(screen.getByRole('button', { name: 'Подробнее: Ключ' }).querySelector('.lucide-info')).not.toBeNull()
  })

  it('does not submit the form it sits in, nor press the row around it', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault())
    const onRowClick = vi.fn()
    render(
      <form onSubmit={onSubmit}>
        <div onClick={onRowClick}>
          <InfoTip label="Подробнее">текст</InfoTip>
        </div>
      </form>,
    )

    await user.click(screen.getByRole('button', { name: 'Подробнее' }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onRowClick).not.toHaveBeenCalled()
  })
})

describe('LabelWithInfo', () => {
  it('labels the field, and the icon is a separate thing with a name of its own', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <LabelWithInfo
          htmlFor="ttl"
          info="Сколько подсказка ждёт человека."
          infoLabel="Подробнее: Срок годности"
        >
          Срок годности
        </LabelWithInfo>
        <input id="ttl" />
      </div>,
    )

    expect(screen.getByLabelText('Срок годности')).toBe(document.getElementById('ttl'))
    await user.hover(screen.getByRole('button', { name: 'Подробнее: Срок годности' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Сколько подсказка ждёт человека.')
  })

  it('draws no icon when there is nothing to explain', () => {
    render(<LabelWithInfo htmlFor="x">Название</LabelWithInfo>)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
