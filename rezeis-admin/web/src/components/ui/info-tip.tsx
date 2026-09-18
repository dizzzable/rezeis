import * as React from 'react'
import { Info } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * An (i) beside a setting or a button that says what it is for — on hover, on
 * keyboard focus, and on a TAP.
 *
 * ── Why a shared one, when five pages already draw this icon ──────────────
 *
 * Quests, advertising, plans, partners and add-ons each carry their own copy of
 * the same Radix tooltip, and on a phone every one of them is decoration. Radix
 * opens a tooltip on a hover and on focus and deliberately never on a touch: its
 * trigger ignores a `touch` pointer move, suppresses the open that the focus of
 * a tap would cause, and closes on the click that follows. An operator on a
 * tablet sees the icon and cannot reach the sentence behind it.
 *
 * So the press is taken over. A tap toggles: the first opens, the second closes,
 * and a tap anywhere else closes it the way any tooltip does. A mouse click
 * keeps the tip open instead of closing the one the hover just opened, and a
 * key press on the focused icon toggles, since focus has already opened it.
 *
 * ── Why it carries its own provider ───────────────────────────────────────
 *
 * The app shell mounts one, but a component rendered outside the shell — a test,
 * a dialog portalled before the providers — throws without it, and a missing
 * explanation must never take a form down with it.
 */
export interface InfoTipProps {
  /** The accessible name of the icon, e.g. «Подробнее: Ключ». */
  readonly label: string
  /** The explanation. A string's line breaks are kept, so `\n\n` is a paragraph. */
  readonly children: React.ReactNode
  readonly side?: 'top' | 'right' | 'bottom' | 'left'
  readonly align?: 'start' | 'center' | 'end'
  readonly className?: string
  readonly contentClassName?: string
  /**
   * What the button draws instead of the (i), for a marker that explains a
   * state rather than a setting — the map's amber "may never be shown". It gets
   * the same hover, focus and tap behaviour; mark the icon `aria-hidden`, the
   * button is named by `label`.
   */
  readonly icon?: React.ReactNode
}

export function InfoTip({
  label,
  children,
  side = 'top',
  align = 'center',
  className,
  contentClassName,
  icon,
}: InfoTipProps) {
  const [open, setOpen] = React.useState(false)
  /** Whether the tip was up when the press on the icon began. */
  const openAtPress = React.useRef(false)
  /** The pointer of the press in progress, or `null` for a key press. */
  const pressPointer = React.useRef<string | null>(null)

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(
              'inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              className,
            )}
            onPointerDown={(event) => {
              // Read BEFORE Radix's own handler runs: it closes an open tip on
              // any press, so afterwards "was it open" can no longer be asked.
              openAtPress.current = open
              pressPointer.current = event.pointerType
            }}
            onClick={(event) => {
              // Radix answers a click on its trigger by closing the tip. Taken
              // over here, and kept from reaching whatever row or card the icon
              // sits in: explaining a thing must not also press it.
              event.preventDefault()
              event.stopPropagation()
              const pointer = pressPointer.current
              pressPointer.current = null
              if (pointer === 'mouse') {
                setOpen(true)
              } else if (pointer === null) {
                setOpen((current) => !current)
              } else {
                setOpen(!openAtPress.current)
              }
            }}
          >
            {icon ?? <Info className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side={side}
          align={align}
          collisionPadding={8}
          className={cn('max-w-xs whitespace-pre-line text-xs leading-snug', contentClassName)}
        >
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export type LabelWithInfoProps = {
  readonly htmlFor?: string
  readonly children: React.ReactNode
  readonly className?: string
} & (
  | { readonly info?: undefined; readonly infoLabel?: undefined }
  | {
      /** The explanation behind the (i). */
      readonly info: React.ReactNode
      /**
       * The accessible name of the icon — «Подробнее: Ключ», not «Ключ». A name
       * equal to the label would make the field and its (i) the same thing to a
       * screen reader, and to every `getByLabelText`.
       */
      readonly infoLabel: string
    }
)

/**
 * A field label with its explanation behind an (i), in place of the grey
 * sentence that used to sit under the field.
 */
export function LabelWithInfo({ htmlFor, children, info, infoLabel, className }: LabelWithInfoProps) {
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{children}</Label>
      {info !== undefined && infoLabel !== undefined && <InfoTip label={infoLabel}>{info}</InfoTip>}
    </div>
  )
}
