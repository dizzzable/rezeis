/**
 * SystemButtonCard — one button the bot adds by itself, as the inspectors of
 * «Карта бота» list it: its default caption, WHEN the bot shows it, its
 * premium icon and the caption the operator can rewrite.
 *
 * The condition is not decoration. reiwa builds most of these buttons behind
 * an `if` — an https cabinet, a bot username, a support @username, partner
 * status — and a card without it reads as a button every customer gets.
 *
 * `iconKey` is given only where reiwa reads an icon slot for the button
 * (`renderSystemButton(…, '<iconKey>', …)` → `bot.sysbtn_icon.<iconKey>`): a
 * picker on a button the bot renders without one would save an icon nobody
 * ever sees. `textKey` is the bot text the caption comes from.
 */
import { Lock } from 'lucide-react'

import { SystemButtonIconPicker } from './SystemButtonIconPicker'
import { TextKeyEditor } from './SystemScreenTexts'

interface SystemButtonCardProps {
  readonly label: string
  readonly condition: string | null
  readonly iconKey?: string
  readonly textKey?: string
}

export function SystemButtonCard({ label, condition, iconKey, textKey }: SystemButtonCardProps) {
  return (
    <div role="group" aria-label={label} className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate text-[11px] font-medium">{label}</span>
      </div>
      {condition !== null ? (
        <p data-condition className="text-[10px] leading-snug text-amber-700 dark:text-amber-400">
          {condition}
        </p>
      ) : null}
      {iconKey !== undefined ? <SystemButtonIconPicker storageKey={iconKey} /> : null}
      {textKey !== undefined ? <TextKeyEditor textKey={textKey} layout="buttonLabel" /> : null}
    </div>
  )
}
