import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { InfoTip } from '@/components/ui/info-tip'
import { copyTextToClipboard } from '@/lib/copy-to-clipboard'
import { cn } from '@/lib/utils'

/**
 * An identifier an operator reads out, pastes into a search or quotes to a
 * payment provider — shown, revealed in full, and copied.
 *
 * ── What it does that the thirteen hand-rolled copies did not ──────────────
 *
 *   • The full value is reachable when the text is shortened: on a hover, on
 *     keyboard focus, and on a TAP. The reveal is an `InfoTip`, which exists
 *     because a plain Radix tooltip never opens on a touch.
 *   • The copy button is named for WHAT it copies («Скопировать: ID платежа»),
 *     so a screen reader walking a table hears which of three ids it is on.
 *   • The feedback is honest. Most copies in the panel ran
 *     `void navigator.clipboard.writeText(v); toast.success(…)` — "copied"
 *     whether or not the browser agreed, and a TypeError instead of anything
 *     at all where `navigator.clipboard` does not exist (a panel opened over
 *     plain http). Here success is reported only after the write resolved,
 *     and every failure says so and says what to do instead.
 *   • Pressing either control never presses the row or card around it.
 */
export interface CopyableIdProps {
  /** The identifier. Absent or empty renders `empty` and no controls. */
  readonly value: string | null | undefined
  /** What the value IS, in the operator's language — «ID платежа». */
  readonly label: string
  /** Show at most this many characters; the rest is behind the reveal. */
  readonly maxLength?: number
  /**
   * Where a shortened value loses its characters. `end` (the default) keeps
   * the start: `provider-event-1…`. `middle` keeps both ends, and an importer's
   * namespace whole — `remnashop:…4821`, `cmfk2x9…34efgh` — for columns of ids
   * that share a start: fifty imported rows cut at the end all read
   * `remnashop:…`, the same text on every row.
   */
  readonly ellipsis?: 'end' | 'middle'
  /** Drawn for an absent value. */
  readonly empty?: string
  readonly className?: string
}

/** How long the tick replaces the copy icon after a copy that worked. */
const COPIED_FEEDBACK_MS = 2000

/** An importer's namespace at the front of an id: `remnashop:`, `bedolaga:`. */
const NAMESPACE = /^[a-z][a-z0-9]*:/

/** Characters of the tail a middle-shortened id always keeps. */
const MIN_TAIL = 4

function shorten(value: string, maxLength: number, ellipsis: 'end' | 'middle'): string {
  if (value.length <= maxLength) return value
  if (ellipsis === 'end') return `${value.slice(0, maxLength)}…`
  const namespace = NAMESPACE.exec(value)?.[0]
  if (namespace !== undefined && namespace.length < value.length) {
    const rest = value.slice(namespace.length)
    const tail = Math.max(MIN_TAIL, maxLength - namespace.length)
    return rest.length <= tail ? value : `${namespace}…${rest.slice(-tail)}`
  }
  const head = Math.ceil(maxLength / 2)
  return `${value.slice(0, head)}…${value.slice(-(maxLength - head))}`
}

export function CopyableId({
  value,
  label,
  maxLength,
  ellipsis = 'end',
  empty = '—',
  className,
}: CopyableIdProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // The copy fallback's field is put in here, so inside a dialog it stays
  // inside the dialog's focus trap.
  const holder = React.useRef<HTMLSpanElement>(null)

  React.useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    },
    [],
  )

  if (value === null || value === undefined || value === '') {
    return <span className={cn('text-muted-foreground', className)}>{empty}</span>
  }

  const shown = maxLength === undefined ? value : shorten(value, maxLength, ellipsis)
  const shortened = shown !== value

  async function handleCopy(): Promise<void> {
    if (value === null || value === undefined) return
    const ok = await copyTextToClipboard(value, { container: holder.current })
    if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    if (!ok) {
      setCopied(false)
      // The value rides along as the description: shortened in a table cell it
      // cannot be selected by hand, and in a toast it can.
      toast.error(t('copyableId.copyFailed', { label }), { description: value })
      return
    }
    setCopied(true)
    resetTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    toast.success(t('copyableId.copied', { label }))
  }

  return (
    <span ref={holder} className={cn('inline-flex min-w-0 max-w-full items-center gap-1 align-middle', className)}>
      {shortened ? (
        <InfoTip
          label={t('copyableId.valueAria', { label, value })}
          icon={<span className="font-mono">{shown}</span>}
          className="min-w-0 shrink rounded-sm text-current underline decoration-muted-foreground/50 decoration-dotted underline-offset-2 hover:text-current"
          contentClassName="max-w-[min(90vw,28rem)] select-all break-all font-mono"
          side="top"
        >
          {value}
        </InfoTip>
      ) : (
        <span className="min-w-0 break-all font-mono">{value}</span>
      )}
      <button
        type="button"
        aria-label={t('copyableId.copy', { label })}
        title={t('copyableId.copy', { label })}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          // A copy button inside a clickable row must not also open the row.
          event.stopPropagation()
          void handleCopy()
        }}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-600" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
    </span>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export { copyTextToClipboard, type CopyTextOptions } from '@/lib/copy-to-clipboard'
