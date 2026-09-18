import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { toast } from 'sonner'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { i18n, i18nReady } from '@/i18n/i18n'
import { CopyableId, copyTextToClipboard } from './copyable-id'

/**
 * The id component every payment surface now shows its ids through.
 *
 * The honesty cases are the reason it exists. The copies it replaces reported
 * "copied" from a `void`ed promise — before the browser had answered — so a
 * refused write and a successful one looked the same to the operator, who then
 * pasted whatever was on the clipboard before into a message to a payment
 * provider. Each honesty case pins the clipboard's ANSWER and asserts the
 * sentence that follows it.
 */

const PAYMENT_ID = 'cmfk2x9pq0000abcd1234efgh'

let writeText: ReturnType<typeof vi.fn>
let execCommand: ReturnType<typeof vi.fn>

function installClipboard(answer: 'resolve' | 'reject' | 'absent'): void {
  writeText = vi.fn(async () => {
    if (answer === 'reject') throw new DOMException('Document is not focused.', 'NotAllowedError')
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: answer === 'absent' ? undefined : { writeText },
  })
}

function installExecCommand(result: boolean | 'throws'): void {
  execCommand = vi.fn(() => {
    if (result === 'throws') throw new Error('execCommand is not supported')
    return result
  })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
}

/**
 * `document.execCommand('copy')` as Chromium runs it, which jsdom does not.
 *
 * It asks the page first (`beforecopy`), then fires `copy` at the focused
 * element with a live `clipboardData`: a handler that cancels the event decides
 * what is copied; otherwise the browser copies whatever is SELECTED at that
 * moment — the selected part of a focused text field, or the document
 * selection. And it answers `true` either way, which is the whole problem the
 * dialog case below is about: copying an empty selection is still a "success".
 *
 * `'refuses'` is a browser that will not run the command at all.
 */
function installBrowserCopy(
  behaviour: 'copies' | 'refuses' | 'copies-selection-only' = 'copies',
): { readonly text: () => string | null } {
  let copied: string | null = null
  execCommand = vi.fn((command: string): boolean => {
    if (behaviour === 'refuses' || command !== 'copy') return false
    const target: EventTarget = document.activeElement ?? document
    target.dispatchEvent(new Event('beforecopy', { bubbles: true, cancelable: true }))
    const written = new Map<string, string>()
    const copy = new Event('copy', { bubbles: true, cancelable: true })
    // `copies-selection-only` is an older engine whose `copy` event carries no
    // `clipboardData`: nothing but the selection can ever be copied there.
    Object.defineProperty(copy, 'clipboardData', {
      value:
        behaviour === 'copies-selection-only'
          ? null
          : { setData: (type: string, data: string): void => void written.set(type, data) },
    })
    const selectedNow = selectedText()
    target.dispatchEvent(copy)
    copied = copy.defaultPrevented ? (written.get('text/plain') ?? '') : selectedNow
    return true
  })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
  return { text: () => copied }
}

function selectedText(): string {
  const active = document.activeElement
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    return active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0)
  }
  return window.getSelection()?.toString() ?? ''
}

function renderId(props: Partial<Parameters<typeof CopyableId>[0]> = {}) {
  const user = userEvent.setup()
  const onRowClick = vi.fn()
  render(
    <I18nextProvider i18n={i18n}>
      {/* A clickable row, the way the payments table and the operations tab hold these. */}
      <div role="row" onClick={onRowClick}>
        <CopyableId value={PAYMENT_ID} label="Payment ID" {...props} />
      </div>
      <button type="button">elsewhere</button>
    </I18nextProvider>,
  )
  return { user, onRowClick }
}

beforeAll(async () => {
  await i18nReady
  await i18n.changeLanguage('en')
})

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('CopyableId — showing the id', () => {
  it('shows a value that fits in full, with no reveal to open', () => {
    renderId()

    expect(screen.getByText(PAYMENT_ID)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: `Payment ID: ${PAYMENT_ID}` })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy Payment ID' })).toBeInTheDocument()
  })

  it('shortens a long value and names the reveal with the WHOLE value', () => {
    renderId({ maxLength: 10 })

    expect(screen.getByText('cmfk2x9pq0…')).toBeInTheDocument()
    expect(screen.queryByText(PAYMENT_ID)).not.toBeInTheDocument()
    // A screen reader gets the full id without having to open anything.
    expect(screen.getByRole('button', { name: `Payment ID: ${PAYMENT_ID}` })).toBeInTheDocument()
  })

  it('can keep both ends of a long id instead of only its start', () => {
    renderId({ maxLength: 14, ellipsis: 'middle' })

    expect(screen.getByText('cmfk2x9…234efgh')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `Payment ID: ${PAYMENT_ID}` })).toBeInTheDocument()
  })

  it("keeps an importer's namespace whole and the tail that tells its rows apart", () => {
    // Cut at the end, every one of these rows read `remnashop:…`.
    render(
      <I18nextProvider i18n={i18n}>
        <CopyableId value="remnashop:1234567" label="Payment ID" maxLength={14} ellipsis="middle" />
        <CopyableId value="remnashop:1234599" label="Payment ID" maxLength={14} ellipsis="middle" />
        <CopyableId value="bedolaga:4821" label="Payment ID" maxLength={14} ellipsis="middle" />
      </I18nextProvider>,
    )

    expect(screen.getByText('remnashop:…4567')).toBeInTheDocument()
    expect(screen.getByText('remnashop:…4599')).toBeInTheDocument()
    // Short enough to show whole: nothing to hide.
    expect(screen.getByText('bedolaga:4821')).toBeInTheDocument()
  })

  it('reveals the full value on hover', async () => {
    const { user } = renderId({ maxLength: 10 })

    await user.hover(screen.getByRole('button', { name: `Payment ID: ${PAYMENT_ID}` }))

    expect(await screen.findByRole('tooltip')).toHaveTextContent(PAYMENT_ID)
  })

  it('reveals it on keyboard focus, and the copy button is the next stop', async () => {
    const { user } = renderId({ maxLength: 10 })

    await user.tab()
    expect(screen.getByRole('button', { name: `Payment ID: ${PAYMENT_ID}` })).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(PAYMENT_ID)

    await user.tab()
    expect(screen.getByRole('button', { name: 'Copy Payment ID' })).toHaveFocus()
  })

  it('reveals it on a tap and hides it on a second tap', async () => {
    const { user } = renderId({ maxLength: 10 })
    const reveal = screen.getByRole('button', { name: `Payment ID: ${PAYMENT_ID}` })

    await user.pointer({ keys: '[TouchA]', target: reveal })
    expect(await screen.findByRole('tooltip')).toHaveTextContent(PAYMENT_ID)

    await user.pointer({ keys: '[TouchA]', target: reveal })
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  it('draws the placeholder and no controls for an absent id', () => {
    renderId({ value: null, empty: 'Not assigned yet' })

    expect(screen.getByText('Not assigned yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Payment ID/ })).not.toBeInTheDocument()
  })

  it('names its controls in Russian for a Russian panel', async () => {
    await i18n.changeLanguage('ru')
    renderId({ label: 'ID платежа', maxLength: 10 })

    expect(await screen.findByRole('button', { name: 'Скопировать: ID платежа' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `ID платежа: ${PAYMENT_ID}` })).toBeInTheDocument()
  })
})

describe('CopyableId — copying, honestly', () => {
  it('reports success only once the clipboard accepted the value', async () => {
    const { user } = renderId({ maxLength: 10 })
    installClipboard('resolve')
    installExecCommand(false)
    const success = vi.spyOn(toast, 'success').mockReturnValue('ok')
    const error = vi.spyOn(toast, 'error').mockReturnValue('err')

    await user.click(screen.getByRole('button', { name: 'Copy Payment ID' }))

    // The FULL value, not what the shortened text shows.
    expect(writeText).toHaveBeenCalledWith(PAYMENT_ID)
    await waitFor(() => expect(success).toHaveBeenCalledWith('Payment ID copied'))
    expect(error).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Copy Payment ID' }).querySelector('.lucide-check')).not.toBeNull()
  })

  it('says it failed, with the value to copy by hand, when the browser refuses both ways', async () => {
    const { user } = renderId({ maxLength: 10 })
    installClipboard('reject')
    installExecCommand(false)
    const success = vi.spyOn(toast, 'success').mockReturnValue('ok')
    const error = vi.spyOn(toast, 'error').mockReturnValue('err')

    await user.click(screen.getByRole('button', { name: 'Copy Payment ID' }))

    await waitFor(() => expect(error).toHaveBeenCalledTimes(1))
    expect(error).toHaveBeenCalledWith(
      'Could not copy Payment ID: the browser did not allow access to the clipboard. The value is below — select it and copy it by hand.',
      { description: PAYMENT_ID },
    )
    expect(success).not.toHaveBeenCalled()
    // No tick either: the icon must not claim what the toast denies.
    expect(screen.getByRole('button', { name: 'Copy Payment ID' }).querySelector('.lucide-check')).toBeNull()
  })

  it('falls back to execCommand where navigator.clipboard does not exist, and says so only if it worked', async () => {
    const { user } = renderId()
    installClipboard('absent')
    const clipboard = installBrowserCopy('copies')
    const success = vi.spyOn(toast, 'success').mockReturnValue('ok')
    const error = vi.spyOn(toast, 'error').mockReturnValue('err')

    await user.click(screen.getByRole('button', { name: 'Copy Payment ID' }))

    await waitFor(() => expect(success).toHaveBeenCalledWith('Payment ID copied'))
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(clipboard.text()).toBe(PAYMENT_ID)
    expect(error).not.toHaveBeenCalled()
  })

  it('does not take execCommand at its word: a "true" that copied nothing is a failure', async () => {
    // A browser that answers yes without ever firing `copy` — the answer the
    // old fallback trusted — has put nothing of ours on the clipboard.
    const { user } = renderId()
    installClipboard('absent')
    installExecCommand(true)
    const success = vi.spyOn(toast, 'success').mockReturnValue('ok')
    const error = vi.spyOn(toast, 'error').mockReturnValue('err')

    await user.click(screen.getByRole('button', { name: 'Copy Payment ID' }))

    await waitFor(() => expect(error).toHaveBeenCalledTimes(1))
    expect(success).not.toHaveBeenCalled()
  })

  it('reports a failure, not a crash, when neither path exists', async () => {
    const { user } = renderId()
    installClipboard('absent')
    installExecCommand('throws')
    const success = vi.spyOn(toast, 'success').mockReturnValue('ok')
    const error = vi.spyOn(toast, 'error').mockReturnValue('err')

    await user.click(screen.getByRole('button', { name: 'Copy Payment ID' }))

    await waitFor(() => expect(error).toHaveBeenCalledTimes(1))
    expect(success).not.toHaveBeenCalled()
  })

  it('copies from the keyboard', async () => {
    const { user } = renderId()
    installClipboard('resolve')
    vi.spyOn(toast, 'success').mockReturnValue('ok')

    screen.getByRole('button', { name: 'Copy Payment ID' }).focus()
    await user.keyboard('{Enter}')

    expect(writeText).toHaveBeenCalledWith(PAYMENT_ID)
  })

  it('does not press the row around it — neither the copy nor the reveal', async () => {
    const { user, onRowClick } = renderId({ maxLength: 10 })
    installClipboard('resolve')
    vi.spyOn(toast, 'success').mockReturnValue('ok')

    await user.click(screen.getByRole('button', { name: 'Copy Payment ID' }))
    await user.click(screen.getByRole('button', { name: `Payment ID: ${PAYMENT_ID}` }))

    expect(onRowClick).not.toHaveBeenCalled()
  })
})

describe('copyTextToClipboard', () => {
  it('answers false instead of throwing when the write is refused and there is no fallback', async () => {
    installClipboard('reject')
    installExecCommand(false)

    await expect(copyTextToClipboard('x')).resolves.toBe(false)
  })

  it('leaves no helper field behind in the document', async () => {
    installClipboard('absent')
    installExecCommand(true)

    await copyTextToClipboard('x')

    expect(document.querySelector('textarea')).toBeNull()
  })
})

/**
 * The fallback inside a dialog — where the payment details sheet puts it.
 *
 * Without `navigator.clipboard` (a panel served over plain http) the copy goes
 * through a hidden field and `execCommand('copy')`. A Radix dialog traps focus:
 * a field appended to `document.body` is outside the trap, so the moment it is
 * focused the dialog pulls focus back to its own last element, the field's
 * selection goes with it, and Chromium copies the EMPTY selection — and answers
 * `true`. The operator was told «copied» with nothing on the clipboard.
 *
 * `installBrowserCopy` models that browser, so these fail on a false success:
 * whenever "copied" is reported, the clipboard has to hold the id.
 */
describe('CopyableId — the fallback inside a focus-trapped dialog', () => {
  function renderInDialog() {
    const user = userEvent.setup()
    render(
      <I18nextProvider i18n={i18n}>
        <Dialog open>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Payment</DialogTitle>
            <CopyableId value={PAYMENT_ID} label="Payment ID" />
          </DialogContent>
        </Dialog>
      </I18nextProvider>,
    )
    return user
  }

  it('puts the id itself on the clipboard before it says «copied»', async () => {
    const user = renderInDialog()
    installClipboard('absent')
    const clipboard = installBrowserCopy('copies')
    const success = vi.spyOn(toast, 'success').mockReturnValue('ok')
    const error = vi.spyOn(toast, 'error').mockReturnValue('err')

    await user.click(await screen.findByRole('button', { name: 'Copy Payment ID' }))

    await waitFor(() => expect(success.mock.calls.length + error.mock.calls.length).toBe(1))
    expect(clipboard.text()).toBe(PAYMENT_ID)
    expect(success).toHaveBeenCalledWith('Payment ID copied')
    expect(error).not.toHaveBeenCalled()
  })

  it('keeps its field inside the dialog, where an engine that copies only the selection still gets the id', async () => {
    // With no `clipboardData` to write, only a selection that survives the focus
    // trap is copied — which a field appended to `document.body` never is.
    const user = renderInDialog()
    installClipboard('absent')
    const clipboard = installBrowserCopy('copies-selection-only')
    const success = vi.spyOn(toast, 'success').mockReturnValue('ok')
    const error = vi.spyOn(toast, 'error').mockReturnValue('err')

    await user.click(await screen.findByRole('button', { name: 'Copy Payment ID' }))

    await waitFor(() => expect(success.mock.calls.length + error.mock.calls.length).toBe(1))
    expect(clipboard.text()).toBe(PAYMENT_ID)
    expect(success).toHaveBeenCalledWith('Payment ID copied')
  })

  it('says it failed when the browser will not copy, even inside the dialog', async () => {
    const user = renderInDialog()
    installClipboard('absent')
    const clipboard = installBrowserCopy('refuses')
    const success = vi.spyOn(toast, 'success').mockReturnValue('ok')
    const error = vi.spyOn(toast, 'error').mockReturnValue('err')

    await user.click(await screen.findByRole('button', { name: 'Copy Payment ID' }))

    await waitFor(() => expect(error).toHaveBeenCalledTimes(1))
    expect(success).not.toHaveBeenCalled()
    expect(clipboard.text()).toBeNull()
  })

  it('gives focus back to the copy button and leaves no field behind', async () => {
    const user = renderInDialog()
    installClipboard('absent')
    installBrowserCopy('copies')
    vi.spyOn(toast, 'success').mockReturnValue('ok')
    const button = await screen.findByRole('button', { name: 'Copy Payment ID' })

    await user.click(button)

    await waitFor(() => expect(button).toHaveFocus())
    expect(document.querySelector('textarea')).toBeNull()
  })
})
