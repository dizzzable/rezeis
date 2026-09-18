import * as React from 'react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * What pressing a button will do, on hover and on keyboard focus — and, for a
 * button that cannot be pressed right now, on a tap as well.
 *
 * ── One wrapper, whatever the button's state ────────────────────────────────
 *
 * A disabled `<button>` receives no pointer events and cannot be focused, so a
 * tooltip hung on it never opens — and a disabled button is exactly the one
 * whose tooltip matters most, because it is the one that has to say why. So the
 * tooltip hangs on a `<span>` around the button, ALWAYS: hover and focus reach
 * it from the button inside by bubbling, and while the button is disabled the
 * span takes focus and pointer events itself.
 *
 * It used to be a span only while disabled and the bare button otherwise. A
 * button that became disabled — «Сохранить» pressed with Enter — was then
 * unmounted and mounted again inside the new wrapper, so keyboard focus fell to
 * the page; and the tooltip went from uncontrolled to controlled on every flip,
 * which Radix warns about. One tree, always controlled, removes both.
 *
 * On a phone a tap on a DISABLED button toggles the tip, the way `InfoTip` does:
 * pressing it does nothing, so the tap is free to explain it. An enabled button
 * keeps the tap for itself.
 *
 * ── Why it carries its own provider ──────────────────────────────────────────
 *
 * For the reason `InfoTip` does: a component rendered outside the app shell — a
 * test, a portalled dialog — throws without one, and a missing explanation must
 * never take the button down with it.
 */
export function ButtonTip({
  tip,
  disabled = false,
  children,
  className,
  side = 'top',
}: {
  /** What pressing does, or why it cannot be pressed. */
  readonly tip: React.ReactNode
  /** Whether the wrapped button is disabled; it decides who receives hover, focus and a tap. */
  readonly disabled?: boolean
  /** The button — or a Radix trigger `asChild` around it. */
  readonly children: React.ReactElement
  /** For the wrapper: its place in the layout, e.g. full width in a card. */
  readonly className?: string
  readonly side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  const [open, setOpen] = React.useState(false)
  const wrapper = React.useRef<HTMLSpanElement>(null)
  /** Whether the tip was up when the press on the wrapper began. */
  const openAtPress = React.useRef(false)
  /** The pointer of the press in progress, or `null` for a key press. */
  const pressPointer = React.useRef<string | null>(null)
  /** Names the button for the wrapper around it, unless it already has an id. */
  const generatedId = React.useId()
  const labelledBy =
    React.isValidElement<{ id?: string }>(children) && children.props.id !== undefined
      ? children.props.id
      : generatedId
  const labelled = React.isValidElement<{ id?: string }>(children)
    ? React.cloneElement(children, { id: labelledBy })
    : children

  // WHERE FOCUS IS NOW, read while rendering — before the commit that disables
  // the button. A browser may blur a control the moment it becomes unfocusable,
  // and the blur then arrives before any effect: asking afterwards ("is focus
  // still inside?") answers no in exactly the case this exists for.
  //
  // The lint rule below forbids reading a ref while rendering, and is right in
  // general — a value read here can belong to a render that is thrown away.
  // This one is deliberate and safe both ways: the answer is only ever USED by
  // the layout effect of a commit that happened, and a discarded render simply
  // discards it. There is no later moment to ask: React mutates the DOM before
  // it runs any effect, and by then the browser has already moved focus.
  // eslint-disable-next-line react-hooks/refs -- read before the commit on purpose; see above
  const focusWasInside = wrapper.current?.contains(document.activeElement) ?? false

  // A focused button that turns disabled loses focus to the page. The wrapper
  // becomes focusable in the same commit, so it takes the focus instead — and
  // hands it back to the button once the button can be pressed again, so the
  // operator's place in the tab order survives a save either way.
  React.useLayoutEffect(() => {
    const element = wrapper.current
    if (element === null) return
    if (disabled) {
      if (focusWasInside && document.activeElement !== element) element.focus()
      return
    }
    if (document.activeElement === element) element.querySelector('button')?.focus()
  }, [disabled, focusWasInside])

  function toggle(pointer: string | null): void {
    if (pointer === 'mouse') setOpen(true)
    else if (pointer === null) setOpen((current) => !current)
    else setOpen(!openAtPress.current)
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <span
            ref={wrapper}
            // A GROUP WITH THE BUTTON'S OWN NAME, while the button is disabled
            // and the wrapper is what the keyboard lands on. Without it a screen
            // reader announced an unnamed element and a reason, with nothing
            // saying which button the reason was about. An enabled button is its
            // own stop, so the wrapper stays out of the tree entirely.
            role={disabled ? 'group' : undefined}
            aria-labelledby={disabled ? labelledBy : undefined}
            tabIndex={disabled ? 0 : undefined}
            data-disabled={disabled ? '' : undefined}
            className={cn(
              'inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              disabled && 'cursor-not-allowed',
              className,
            )}
            onPointerDown={(event) => {
              if (!disabled) return
              openAtPress.current = open
              pressPointer.current = event.pointerType
            }}
            onClick={(event) => {
              // An enabled button's press is its own, and Radix closes the tip.
              if (!disabled) return
              // Taken over for the reason `InfoTip` takes its click over: Radix
              // closes a tip on a click on its trigger, and a tap would then
              // never show one. Nothing behind a disabled button runs anyway.
              event.preventDefault()
              event.stopPropagation()
              const pointer = pressPointer.current
              pressPointer.current = null
              toggle(pointer)
            }}
            onKeyDown={(event) => {
              if (!disabled || event.target !== event.currentTarget) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setOpen((current) => !current)
              }
            }}
          >
            {labelled}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side={side}
          collisionPadding={8}
          className="max-w-xs whitespace-pre-line text-xs leading-snug"
        >
          {tip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
