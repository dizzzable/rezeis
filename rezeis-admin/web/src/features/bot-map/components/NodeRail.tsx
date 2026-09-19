/**
 * NodeRail — left rail of the "Карта бота" page.
 *
 * Lists every addressable surface in the bot under fixed groups and
 * lets the operator filter them with a single search input. Selection
 * is controlled by the parent (BotMapShell), so the same selection
 * drives both the list view and the future canvas tab.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

import type { BotMapNode } from '../types'
import { filterNodesByQuery } from '../utils/filter-nodes-by-query'
import { groupNodes } from '../utils/group-nodes'

interface NodeRailProps {
  readonly nodes: ReadonlyArray<BotMapNode>
  readonly selectedId: string | null
  readonly onSelect: (nodeId: string) => void
  readonly query: string
  readonly onQueryChange: (next: string) => void
}

export function NodeRail({
  nodes,
  selectedId,
  onSelect,
  query,
  onQueryChange,
}: NodeRailProps) {
  const { t } = useTranslation()
  const filtered = useMemo(() => filterNodesByQuery(nodes, query), [nodes, query])
  const groups = useMemo(() => groupNodes(filtered), [filtered])

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-3 space-y-2">
        <div className="relative">
          <Search
            className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t('botMapPage.rail.searchPlaceholder')}
            className="pl-8"
            aria-label={t('botMapPage.rail.searchPlaceholder')}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t('botMapPage.rail.total', { count: filtered.length })}
        </p>
      </div>
      <ScrollArea className="flex-1">
        {filtered.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">{t('botMapPage.rail.empty')}</p>
        ) : (
          <ul className="space-y-3 p-2">
            {groups.map((group) => (
              <li key={group.key}>
                <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {/* `nsSeparator: false`: the notification groups are keyed
                      `notification:expires`, and i18next reads a ':' as a
                      namespace boundary — the raw key was the header. */}
                  {t(`botMapPage.rail.groups.${group.key}` as never, {
                    defaultValue: group.key,
                    nsSeparator: false,
                  })}
                </p>
                <ul className="space-y-0.5">
                  {group.nodes.map((node) => {
                    const selected = node.id === selectedId
                    return (
                      <li key={node.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(node.id)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors',
                            selected
                              ? 'bg-accent text-accent-foreground'
                              : 'text-foreground/80 hover:bg-muted',
                          )}
                          aria-current={selected ? 'true' : undefined}
                        >
                          <span
                            className={cn(
                              'h-1.5 w-1.5 shrink-0 rounded-full',
                              statusDotClass(node.status),
                            )}
                            aria-hidden
                          />
                          <span className="truncate">{node.title}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}

function statusDotClass(status: BotMapNode['status']): string {
  switch (status) {
    case 'PUBLISHED':
    case 'ACTIVE':
      return 'bg-emerald-500'
    case 'DRAFT':
      return 'bg-amber-500'
    case 'DISABLED':
      return 'bg-zinc-500'
    default:
      return 'bg-zinc-400'
  }
}
