/**
 * SystemScreenNode — a screen the bot builds by itself that no flow block
 * stands in for (`SYSTEM_SCREENS`): the language picker, the channel gate's
 * prompt, the return from a payment, the error message…
 *
 * Read-only on the canvas: its title, how a customer gets there, its buttons
 * with WHEN the bot shows them, and how many texts it sends. Selecting it
 * opens `SystemScreenPanel`, where the captions and texts are edited. No
 * handles: nothing links into or out of these by the operator's choice —
 * reiwa decides both.
 */
import { memo } from 'react'
import { type NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { Cog } from 'lucide-react'

import { cn } from '@/lib/utils'

import { SYSTEM_SCREENS } from '../system-screens'

export interface SystemScreenNodeData extends Record<string, unknown> {
  /** `SystemScreen.id` of the screen drawn. */
  screenId: string
}

function SystemScreenNodeComponent({ data, selected }: NodeProps) {
  const { t } = useTranslation()
  const { screenId } = data as unknown as SystemScreenNodeData
  const screen = SYSTEM_SCREENS.find((candidate) => candidate.id === screenId)
  if (screen === undefined) return null

  return (
    <div
      className={cn(
        'relative w-[240px] rounded-xl border-2 border-dashed bg-card shadow-sm transition-shadow',
        selected ? 'ring-2 ring-primary border-primary' : 'border-violet-500/50',
      )}
    >
      <div className="flex items-center gap-2 rounded-t-xl border-b bg-violet-500/10 px-3 py-2 text-xs font-medium text-violet-700 dark:text-violet-400">
        <Cog className="h-3 w-3" aria-hidden />
        <span className="ml-auto text-[10px] font-semibold uppercase tracking-wider opacity-80">
          {t('botFlow.systemScreens.badge')}
        </span>
      </div>

      <div className="space-y-1 px-3 py-2">
        <p className="truncate text-[11px] font-semibold">{t(screen.titleKey)}</p>
        <p className="line-clamp-2 text-[9px] leading-snug text-muted-foreground">{t(screen.triggerKey)}</p>

        {screen.buttons.length > 0 ? (
          <div className="space-y-1 pt-1">
            {screen.buttons.map((button) => (
              <div key={button.key} data-system-button>
                <div className="truncate rounded-md border border-dashed border-border/70 bg-muted/30 px-2 py-1 text-center text-[10px] font-medium text-muted-foreground">
                  {t(button.labelKey)}
                </div>
                {button.conditionKey !== undefined ? (
                  <p
                    data-condition
                    className="px-1 pt-0.5 text-center text-[8px] leading-tight text-amber-700/90 dark:text-amber-400/90"
                  >
                    {t(button.conditionKey)}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <p className="pt-0.5 text-[9px] text-muted-foreground">
          {t('botFlow.systemScreens.textsCount', { count: screen.texts.length })}
        </p>
      </div>
    </div>
  )
}

export const SystemScreenNode = memo(SystemScreenNodeComponent)
