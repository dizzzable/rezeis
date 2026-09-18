/**
 * The tooltip that says what a button does — and why it cannot be pressed.
 *
 * It was two trees: the bare button while enabled, a focusable span around it
 * while disabled. A button that turned disabled under the keyboard — «Сохранить»
 * pressed with Enter — was unmounted and mounted again, so focus fell to the
 * page, and the tooltip switched between uncontrolled and controlled on every
 * flip, which Radix warns about. These cases hold it to one tree.
 */
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Button } from '@/components/ui/button'

import { ButtonTip } from './rule-button-tip'

afterEach(() => {
  vi.restoreAllMocks()
})

/** A save button that is disabled while it saves, as the editor's is. */
function Saving({ onPress }: { readonly onPress?: () => void }) {
  const [saving, setSaving] = useState(false)
  return (
    <div>
      <ButtonTip tip="Записывает изменения." disabled={saving}>
        <Button
          onClick={() => {
            onPress?.()
            setSaving(true)
          }}
          disabled={saving}
        >
          Сохранить
        </Button>
      </ButtonTip>
      <button type="button" onClick={() => setSaving(false)}>
        answer
      </button>
    </div>
  )
}

/**
 * A browser that blurs a control the moment it stops being focusable — the
 * HTML focus fixup rule — run SYNCHRONOUSLY, inside the same mutation that
 * disables the button, which is the worst case for anything that asks "is
 * focus still inside?" afterwards. jsdom does none of this, and an emulation
 * built on a MutationObserver cannot reproduce it: its callback is a microtask
 * and always runs after the layout effect.
 *
 * Both ways React can disable a control are covered, and the count says which
 * one fired, so a React that stops using either does not leave this vacuous.
 */
function emulateSynchronousFocusFixup(): { stop: () => void; fired: () => number } {
  const elsewhere = document.createElement('div')
  elsewhere.tabIndex = -1
  elsewhere.setAttribute('data-focus-fixup', '')
  document.body.appendChild(elsewhere)
  let fired = 0
  const fixup = (element: Element): void => {
    if (element !== document.activeElement) return
    fired += 1
    elsewhere.focus()
  }
  const setAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function patched(name: string, value: string) {
    setAttribute.call(this, name, value)
    if (name === 'disabled') fixup(this)
  }
  const property = Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'disabled')
  if (property?.set !== undefined) {
    Object.defineProperty(HTMLButtonElement.prototype, 'disabled', {
      ...property,
      set(this: HTMLButtonElement, value: boolean) {
        property.set!.call(this, value)
        if (value) fixup(this)
      },
    })
  }
  return {
    fired: () => fired,
    stop() {
      Element.prototype.setAttribute = setAttribute
      if (property !== undefined) Object.defineProperty(HTMLButtonElement.prototype, 'disabled', property)
      elsewhere.remove()
    },
  }
}

describe('ButtonTip', () => {
  it('keeps keyboard focus in place when the button it explains becomes disabled, and hands it back after', async () => {
    const fixup = emulateSynchronousFocusFixup()
    try {
      const user = userEvent.setup()
      render(<Saving />)

      await user.tab()
      const save = screen.getByRole('button', { name: 'Сохранить' })
      expect(save).toHaveFocus()
      await user.keyboard('{Enter}')

      expect(save).toBeDisabled()
      // Anti-vacuity: the browser really did take focus away mid-mutation.
      expect(fixup.fired()).toBeGreaterThan(0)
      // And it came back to the button's own place, not the page.
      expect(document.activeElement).not.toBe(document.body)
      expect(save.parentElement!.contains(document.activeElement)).toBe(true)
      // The button is the same element it was — it was never mounted again.
      expect(screen.getByRole('button', { name: 'Сохранить' })).toBe(save)

      // Once it can be pressed again, the button takes focus back off the
      // wrapper — which is not focusable any more. fireEvent, not a click:
      // clicking would move focus itself and prove nothing.
      fireEvent.click(screen.getByRole('button', { name: 'answer' }))
      expect(save).toBeEnabled()
      expect(save).toHaveFocus()
    } finally {
      fixup.stop()
    }
  })

  it('gives the wrapper a role and the button’s own name, so it is not a nameless stop', async () => {
    const user = userEvent.setup()
    render(<Saving />)

    // Enabled: the button is the only tree, nothing extra to tab through.
    expect(screen.queryByRole('group')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    // Disabled: the wrapper holds the tooltip and the keyboard stop, and a
    // screen reader hears which button it is about.
    const wrapper = screen.getByRole('group', { name: 'Сохранить' })
    expect(wrapper.tagName).toBe('SPAN')
    expect(wrapper).toContainElement(screen.getByRole('button', { name: 'Сохранить' }))
  })

  it('never switches its tooltip between controlled and uncontrolled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<Saving />)

    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await user.click(screen.getByRole('button', { name: 'answer' }))
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    const switches = warn.mock.calls.map((call) => String(call[0])).filter((line) => /controlled/.test(line))
    expect(switches).toEqual([])
    // Anti-vacuity: the button really flipped both ways.
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  })

  it('explains an enabled button on hover, and lets its press through', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    render(<Saving onPress={onPress} />)
    const save = screen.getByRole('button', { name: 'Сохранить' })

    await user.hover(save)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Записывает изменения.')
    await user.click(save)

    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('explains a disabled button on hover and on a tap, and a tap presses nothing around it', async () => {
    const onRow = vi.fn()
    const user = userEvent.setup()
    render(
      <div onClick={onRow}>
        <ButtonTip tip="Вашей роли не выдано право." disabled>
          <Button disabled>Запустить сейчас</Button>
        </ButtonTip>
      </div>,
    )
    const wrapper = screen.getByRole('button', { name: 'Запустить сейчас' }).parentElement!

    await user.hover(wrapper)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Вашей роли не выдано право.')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    await user.unhover(wrapper)

    await user.pointer({ keys: '[TouchA]', target: wrapper })
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Вашей роли не выдано право.')
    await user.pointer({ keys: '[TouchA]', target: wrapper })
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    expect(onRow).not.toHaveBeenCalled()
  })
})
