/**
 * ReplyKeyboardNode — pinned canvas node for the global reply-keyboard.
 *
 * WHAT IT IS IN THE BOT: the main menu. reiwa sends these buttons as the
 * INLINE keyboard under the greeting (`src/bot/widgets/main-keyboard.ts`,
 * `buildMainKeyboard`) on `/start` and «◀️ В меню» — no reply keyboard is ever
 * sent, whatever the name and the notes below say. The node therefore also
 * draws the trial button reiwa puts on top, and under each button where the
 * bot really sends the tap (`menuButtonRoute`).
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
import { MAIN_MENU_CHIPS } from '../system-screens'
import {
  isBrokenRoute,
  menuButtonRoute,
  resolveReplyButtonColor,
  replyButtonHandleId,
  type MenuButtonRoute,
  type RouteContext,
} from './reply-keyboard-utils'

export const REPLY_KEYBOARD_NODE_ID = '__reply_keyboard__'
export const REPLY_KEYBOARD_NODE_TYPE = 'replyKeyboard'

const STYLE_COLORS: Record<string, { bg: string; text: string }> = {
  PRIMARY: { bg: '#3b82f6', text: '#ffffff' },
  SUCCESS: { bg: '#10b981', text: '#ffffff' },
  DANGER: { bg: '#ef4444', text: '#ffffff' },
  DEFAULT: { bg: 'var(--color-muted)', text: 'var(--color-foreground)' },
}

/**
 * The line under a menu button: where the bot sends the tap, in words
 * (`menuButtonRoute` — the route «Список» draws from its copy of the same
 * rules). It used to come from the button's ID alone through i18n keys no
 * dictionary had, so the canvas printed `screen.invite` — and printed it under
 * «Пригласить» even when the button opened another screen.
 */
function routeCaption(
  route: MenuButtonRoute,
  t: (key: string, vars?: Record<string, string>) => string,
): string | null {
  switch (route.kind) {
    case 'screen':
      return t('botFlow.replyTargets.screen', { name: route.name })
    case 'mainMenu':
      return t('botFlow.replyTargets.mainMenu')
    case 'missingScreen':
      return t('botFlow.replyTargets.missingScreen', { shortId: route.shortId })
    case 'unanswered':
      return t('botFlow.replyTargets.unhandled')
    case 'support':
      // Without a public support @username the tap opens the help screen: say
      // so while the panel cannot tell whether there is one.
      return route.fallback?.kind === 'screen'
        ? t('botFlow.replyTargets.supportOrScreen', { name: route.fallback.name })
        : t('botFlow.replyTargets.support')
    case 'cabinetBrowser':
      return t('botFlow.replyTargets.cabinetBrowser')
    case 'miniApp':
      return route.known
        ? t('botFlow.replyTargets.miniApp', { path: route.path })
        : t('botFlow.replyTargets.missingPage', { path: route.path })
    case 'site':
      return t('botFlow.replyTargets.site', { path: route.path })
    case 'url':
      return route.safe
        ? t('botFlow.replyTargets.url', { host: route.host })
        : t('botFlow.replyTargets.unsafeUrl', { host: route.host })
    case 'answered':
      return null
  }
}

/** Before the page has the flow: no screens, no catalog — nothing is called missing. */
const NO_ROUTE_CONTEXT: RouteContext = { screens: [], miniAppRoutes: null, supportChat: null }

export interface ReplyKeyboardNodeData extends Record<string, unknown> {
  buttons: readonly BotButton[]
  bannerUrl: string | null
  /** The flow's screens and the Mini App catalog, which decide where a button leads. */
  routeContext?: RouteContext
}

function ReplyKeyboardNodeComponent({ data, selected }: NodeProps) {
  const { t } = useTranslation()
  const { buttons, bannerUrl, routeContext = NO_ROUTE_CONTEXT } = data as unknown as ReplyKeyboardNodeData

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

      {/* The trial button reiwa puts ABOVE the operator's buttons for a
          customer with no active subscription while a trial is on offer
          (`start.ts` → `resolveTrialButton` → `buildMainKeyboard`). Stored
          nowhere, so drawn here as a system chip with its condition — from
          the list the «Список» card reads too (`MAIN_MENU_CHIPS`). */}
      {MAIN_MENU_CHIPS.map((chip) => (
        <div key={chip.key} className="px-2 pb-1.5" data-system-button>
          <div className="truncate rounded-md border border-dashed border-border/70 bg-muted/30 px-2 py-1 text-center text-[10px] font-medium text-muted-foreground">
            {t(chip.labelKey)}
          </div>
          {chip.conditionKey !== undefined ? (
            <p
              data-condition
              className="px-1 pt-0.5 text-center text-[8px] leading-tight text-amber-700/90 dark:text-amber-400/90"
            >
              {t(chip.conditionKey)}
            </p>
          ) : null}
        </div>
      ))}

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
                const route = menuButtonRoute(button, routeContext)
                const caption = routeCaption(route, t)
                const broken = isBrokenRoute(route)
                const edgeColor = broken ? '#ef4444' : resolveReplyButtonColor(button.buttonId)
                return (
                  <div
                    key={button.id}
                    className="relative flex-1 min-w-0 space-y-0.5"
                    data-menu-button
                  >
                    <div
                      className="truncate rounded-md px-2 py-1 text-center text-[10px] font-medium"
                      style={{ backgroundColor: colors.bg, color: colors.text }}
                    >
                      {button.label}
                    </div>
                    {caption !== null ? (
                      <div
                        className="flex items-center justify-center gap-0.5 text-[9px] font-medium"
                        style={{ color: edgeColor }}
                        title={caption}
                        data-broken={broken ? 'true' : undefined}
                      >
                        <ArrowRight className="h-2.5 w-2.5 shrink-0" aria-hidden />
                        <span className="truncate">{caption}</span>
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
