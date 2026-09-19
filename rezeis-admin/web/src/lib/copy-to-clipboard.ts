// Copying to the clipboard, answered truthfully. Kept apart from the
// `CopyableId` component so that the app shell (the top bar’s support menu),
// which ships in the entry bundle, can copy without pulling the component and
// the (i) tip and label it draws into the render-blocking payload that
// `npm run check:build-graph` holds to 15 chunks.
export interface CopyTextOptions {
  /**
   * Where the fallback's hidden field goes: an element next to the control
   * that asked for the copy. Inside a dialog it has to be INSIDE the dialog —
   * a focus trap pulls focus back from anything outside it. Defaults to
   * `document.body`.
   */
  readonly container?: Element | null
}

/**
 * Copies `value` and answers whether it actually reached the clipboard.
 *
 * `navigator.clipboard` first; the `execCommand('copy')` fallback when it is
 * absent (an insecure context — the panel served over plain http on a LAN
 * address) or refuses, because a refused write is not a reason to report
 * failure while the older path would have worked. Never throws.
 */
export async function copyTextToClipboard(value: string, options: CopyTextOptions = {}): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // The fallback below answers a refused write too.
  }
  return copyThroughCopyEvent(value, options.container ?? null)
}

/**
 * The fallback, and why it does not trust `execCommand`'s answer.
 *
 * `execCommand('copy')` copies whatever is selected when it runs and answers
 * `true` either way. The old version selected a hidden field on `document.body`
 * and returned that answer; inside a Radix dialog the focus trap pulled focus
 * straight back out of the field, the selection went with it, and Chromium
 * copied NOTHING — then said yes, and the details sheet said «Скопировано».
 *
 * So the value is written by a one-shot `copy` listener into the event's own
 * `clipboardData`, which no focus trap or lost selection can touch, and success
 * is reported only when that listener actually ran. A cancelled `beforecopy`
 * lets Blink run Copy with nothing selected at all. The field stays, as the
 * last resort for a browser whose `copy` event carries no `clipboardData` —
 * and then counts only if it still holds the whole value when the copy runs.
 */
function copyThroughCopyEvent(value: string, container: Element | null): boolean {
  if (typeof document === 'undefined') return false
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const field = document.createElement('textarea')
  let delivered = false
  const onBeforeCopy = (event: Event): void => event.preventDefault()
  const onCopy = (event: Event): void => {
    const data = (event as ClipboardEvent).clipboardData
    if (data) {
      data.setData('text/plain', value)
      event.preventDefault()
      delivered = true
      return
    }
    delivered =
      document.activeElement === field && field.selectionStart === 0 && field.selectionEnd === value.length
  }
  document.addEventListener('beforecopy', onBeforeCopy, true)
  document.addEventListener('copy', onCopy, true)
  try {
    field.value = value
    field.setAttribute('readonly', '')
    field.setAttribute('aria-hidden', 'true')
    field.tabIndex = -1
    field.style.position = 'fixed'
    field.style.top = '0'
    field.style.left = '0'
    field.style.opacity = '0'
    field.style.pointerEvents = 'none'
    ;(container ?? document.body).append(field)
    field.focus({ preventScroll: true })
    field.select()
    field.setSelectionRange(0, value.length)
    return document.execCommand('copy') && delivered
  } catch {
    return false
  } finally {
    document.removeEventListener('beforecopy', onBeforeCopy, true)
    document.removeEventListener('copy', onCopy, true)
    field.remove()
    previouslyFocused?.focus({ preventScroll: true })
  }
}
