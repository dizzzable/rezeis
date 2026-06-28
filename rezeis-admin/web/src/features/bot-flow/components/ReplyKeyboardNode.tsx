/**
 * ReplyKeyboardNode — pinned canvas node for the global reply-keyboard.
 *
 * Architectural notes
 * ───────────────────
 * In Telegram a bot has TWO independent keyboards living at the same time:
 *
 *   1. The reply keyboard, attached to the chat as a whole. It sits below
 *      the input field and is sent on every message. There is exactly one
 *      reply keyboard per bot instance — it is a GLOBAL resource.
 *
 *   2. Inline keyboards, attached to a specific message. Each screen in
 *      the bot-flow graph defines its own. They are PER-SCREEN.
 *
 * The graph editor models case (2) — every screen is a node, every
 * inline button is a handle, every navigation link is an edge. The reply
 * keyboard does not fit that mental model: it has no edges, no per-screen
 * scope, no source / target. So we render it as a *pinned pseudo-node* —
 * present on the canvas for context (operators can see "this is the
 * keyboard that always shows under the input"), but visually distinct so
 * nobody confuses it with a regular screen.
 *
 * The id `__reply_keyboard__` is a sentinel. The page treats it specially
 * for routing the right-side editor panel — it never reaches the
 * `/admin/bot-flows/...` endpoints. Its data flows from
 * `/admin/bot-config/buttons` instead.
 *
 * Banner preview: when an operator-uploaded banner exists in
 * `BotText['bot.banner_url']`, we render its thumbnail at the top of
 * the pseudo-node so the canvas matches what users see on /start.
 */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Globe2, Image as ImageIcon, Keyboard } from 'lucide-react'

import { cn } from '@/lib/utils'

import type { BotButton } from '@/features/bot-config/bot-config-api'
import { resolveReplyButtonColor, replyButtonHandleId } from './reply-keyboard-utils'

export const REPLY_KEYBOARD_NODE_ID = '__reply_keyboard__'
export const REPLY_KEYBOARD_NODE_TYPE = 'replyKeyboard'

const STYLE_COLORS: Record<string, { bg: string; text: string }> = {
  PRIMARY: { bg: '#3b82f6', text: '#ffffff' },
  SUCCESS: { bg: '#10b981', text: '#ffffff' },
  DANGER: { bg: '#ef4444', text: '#ffffff' },
  DEFAULT: { bg: 'var(--color-muted)', text: 'var(--color-foreground)' },
}

/**
 * Resolution: which screen `name` does this reply-button id default to?
 * Mirrors the override matching in reiwa's
 * `help-callback` / `rules` / `invite` pages — when a screen has the
 * same name as one of these ids, it overrides the built-in handler.
 *
 * Operators get a visual reminder of the routing on the canvas: under
 * each reply-button label we show "→ <screen name>" so it's obvious
 * which sub-screen will open when the user taps the button.
 */
const REPLY_BUTTON_TARGET_BY_ID: Record<string, string> = {
  cabinet: 'screen.cabinet',
  invite: 'screen.invite',
  rules: 'screen.rules',
  help: 'screen.help',
}

export interface ReplyKeyboardNodeData extends Record<string, unknown> {
  buttons: readonly BotButton[]
  bannerUrl: string | null
}

function ReplyKeyboardNodeComponent({ data, selected }: NodeProps) {
  const { t } = useTranslation()
  const { buttons, bannerUrl } = data as unknown as ReplyKeyboardNodeData

  // Group reply-keyboard buttons into rows the way Telegram will render
  // them. The contract: a button with `onePerRow=true` always claims a
  // full row; buttons with `onePerRow=false` flow horizontally and pack
  // up to two-per-row to mirror reiwa's keyboard builder.
  const rows = groupReplyButtonsIntoRows(buttons.filter((b) => b.visible))

  return (
    <div
      className={cn(
        'relative w-[300px] rounded-xl border-2 border-dashed bg-card shadow-md transition-shadow',
        selected ? 'ring-2 ring-primary border-primary' : 'border-amber-500/60',
      )}
    >
      {/*
        Target handle so "main menu" edges INTO this node render — e.g. a
        notification "Главное меню" (callback `menu:main`) arrows here, since
        the reply keyboard IS the bot's main menu. `buildMapEdges` points the
        edge's `targetHandle` at `${REPLY_KEYBOARD_NODE_ID}-target`; without
        this anchor React Flow silently drops the edge.
      */}
      <Handle
        type="target"
        position={Position.Left}
        id={`${REPLY_KEYBOARD_NODE_ID}-target`}
        style={{
          top: '18px',
          left: '-8px',
          background: 'var(--color-amber-500, #f59e0b)',
          border: '2px solid var(--color-background)',
          width: 10,
          height: 10,
        }}
      />
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-t-xl border-b text-xs font-medium',
          'bg-amber-500/10 text-amber-700 dark:text-amber-400',
        )}
      >
        <Keyboard className="h-3 w-3" aria-hidden />
        <span className="truncate">{t('botStudio.replyKeyboard.nodeTitle')}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider opacity-80">
          <Globe2 className="h-3 w-3" aria-hidden />
          {t('botStudio.replyKeyboard.globalBadge')}
        </span>
      </div>

      {/* Banner preview — mirrors what users see on /start. */}
      {bannerUrl !== null && bannerUrl.length > 0 ? (
        <div className="border-b">
          <img
            src={bannerUrl}
            alt={t('botStudio.replyKeyboard.bannerAlt')}
            className="h-24 w-full object-cover"
          />
        </div>
      ) : (
        <div className="flex h-12 items-center justify-center gap-1.5 border-b bg-muted/20 text-[10px] text-muted-foreground">
          <ImageIcon className="h-3 w-3" aria-hidden />
          <span>{t('botStudio.replyKeyboard.bannerPlaceholder')}</span>
        </div>
      )}

      <div className="px-3 py-2 text-[10px] text-muted-foreground">
        {t('botStudio.replyKeyboard.nodeHint')}
      </div>

      {rows.length === 0 ? (
        <div className="px-3 pb-3 text-[11px] italic text-muted-foreground">
          {t('botStudio.replyKeyboard.empty')}
        </div>
      ) : (
        <div className="space-y-1.5 px-2 pb-2">
          {rows.map((row, rowIdx) => (
            <div key={rowIdx} className="flex gap-1">
              {row.map((button) => {
                const colors = STYLE_COLORS[button.style] ?? STYLE_COLORS.DEFAULT
                const targetKey = REPLY_BUTTON_TARGET_BY_ID[button.buttonId]
                const edgeColor = resolveReplyButtonColor(button.buttonId)
                return (
                  <div
                    key={button.id}
                    className="relative flex-1 min-w-0 space-y-0.5"
                  >
                    <div
                      className="truncate rounded-md px-2 py-1 text-center text-[10px] font-medium"
                      style={{ backgroundColor: colors.bg, color: colors.text }}
                    >
                      {button.label}
                    </div>
                    {targetKey !== undefined ? (
                      <div
                        className="flex items-center justify-center gap-0.5 text-[9px] font-medium"
                        style={{ color: edgeColor }}
                      >
                        <ArrowRight className="h-2.5 w-2.5" aria-hidden />
                        <span className="truncate">{t(targetKey)}</span>
                      </div>
                    ) : null}
                    {/*
                      Per-button source handle. Positioned absolute
                      against this button cell so the edge emerges
                      from the cell's right edge — visually identical
                      to the way snoups / leadteh / other bot
                      constructors anchor connections to specific
                      buttons. The handle id matches the convention
                      `buildReplyToScreenEdges` uses on the edge's
                      `sourceHandle`.
                    */}
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={replyButtonHandleId(button.buttonId)}
                      style={{
                        top: '12px',
                        right: '-8px',
                        background: edgeColor,
                        border: '2px solid var(--color-background)',
                        width: 10,
                        height: 10,
                      }}
                    />
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const ReplyKeyboardNode = memo(ReplyKeyboardNodeComponent)

/**
 * Reply-keyboard row packer. Mirrors the layout reiwa applies when it
 * actually builds the `Keyboard` object: a `onePerRow=true` button always
 * takes a full row; a run of `onePerRow=false` neighbours fills up rows
 * of size 2.
 *
 * The exact reiwa implementation may pack 3+ buttons per row in some
 * future revision. We deliberately match the *current* contract — when
 * reiwa's packer changes, we revisit this helper, not the other way
 * around (the node is meant to mirror what users will see in Telegram,
 * so drift is undesirable).
 */
function groupReplyButtonsIntoRows(buttons: readonly BotButton[]): BotButton[][] {
  const sorted = [...buttons].sort((a, b) => a.orderIndex - b.orderIndex)
  const rows: BotButton[][] = []
  let pending: BotButton[] = []

  function flushPending() {
    if (pending.length > 0) {
      rows.push(pending)
      pending = []
    }
  }

  for (const button of sorted) {
    if (button.onePerRow) {
      flushPending()
      rows.push([button])
    } else {
      pending.push(button)
      if (pending.length === 2) flushPending()
    }
  }
  flushPending()
  return rows
}
