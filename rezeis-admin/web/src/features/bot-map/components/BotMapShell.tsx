/**
 * BotMapShell — three-column layout for the bot-map page:
 *
 *   ┌──────────┬─────────────────┬──────────────┐
 *   │ NodeRail │  List / Diagram │  Inspector   │
 *   └──────────┴─────────────────┴──────────────┘
 *
 * Tab state ("Список" / "Схема") and the last-selected node id are
 * persisted in localStorage so reloads don't yank the operator's
 * context. Diagram tab is a placeholder until Wave 3.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutList, Network, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

import type { BotMapNode, BotMapPayload } from '../types'
import { filterNodesByQuery } from '../utils/filter-nodes-by-query'
import { CanvasView } from './CanvasView'
import { InspectorRouter } from './inspector/InspectorRouter'
import { ListView } from './ListView'
import { NodeRail } from './NodeRail'

const SELECTED_KEY = 'bot-map.selected-id'
const TAB_KEY = 'bot-map.active-tab'

interface BotMapShellProps {
  readonly payload: BotMapPayload
  readonly isFetching: boolean
  readonly onRefresh: () => void
}

export function BotMapShell({ payload, isFetching, onRefresh }: BotMapShellProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(() => readSelectedId())
  const [tab, setTab] = useState<string>(() => readTab())

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    try {
      if (selectedId === null) localStorage.removeItem(SELECTED_KEY)
      else localStorage.setItem(SELECTED_KEY, selectedId)
    } catch {
      /* localStorage unavailable — silently ignore */
    }
  }, [selectedId])

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab)
    } catch {
      /* ignore */
    }
  }, [tab])

  // If the saved selection no longer matches a real node (e.g. the
  // payload changed and the screen was deleted), drop it.
  useEffect(() => {
    if (selectedId === null) return
    if (!payload.nodes.some((n) => n.id === selectedId)) {
      setSelectedId(null)
    }
  }, [payload.nodes, selectedId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const selected: BotMapNode | null = useMemo(() => {
    if (selectedId === null) return null
    return payload.nodes.find((n) => n.id === selectedId) ?? null
  }, [payload.nodes, selectedId])

  const visibleNodes = useMemo(
    () => filterNodesByQuery(payload.nodes, query),
    [payload.nodes, query],
  )

  return (
    <div className="flex h-[calc(100dvh-7rem)] min-h-[600px] flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <div className="space-y-0.5">
          <h1 className="text-2xl font-semibold tracking-tight">{t('botMapPage.title')}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{t('botMapPage.subtitle')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}>
          <RefreshCw
            className={cn('mr-1.5 h-3.5 w-3.5', isFetching && 'animate-spin')}
            aria-hidden
          />
          {t('botMapPage.refresh')}
        </Button>
      </header>

      <Tabs
        value={tab}
        onValueChange={setTab}
        className="flex flex-1 min-h-0 flex-col"
      >
        <TabsList className="self-start">
          <TabsTrigger value="list" className="gap-1.5">
            <LayoutList className="h-3.5 w-3.5" aria-hidden />
            {t('botMapPage.tabs.list')}
          </TabsTrigger>
          <TabsTrigger value="diagram" className="gap-1.5">
            <Network className="h-3.5 w-3.5" aria-hidden />
            {t('botMapPage.tabs.diagram')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-3 flex flex-1 min-h-0 gap-3">
          <div className="hidden w-64 shrink-0 overflow-hidden rounded-lg border bg-card md:flex md:flex-col">
            <NodeRail
              nodes={payload.nodes}
              selectedId={selectedId}
              onSelect={setSelectedId}
              query={query}
              onQueryChange={setQuery}
            />
          </div>
          <div className="flex-1 min-w-0 overflow-hidden rounded-lg border bg-card">
            <ListView
              payload={payload}
              visibleNodes={visibleNodes}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
          <div className="hidden w-96 shrink-0 overflow-hidden rounded-lg border bg-card lg:flex lg:flex-col">
            <div className="flex-1 overflow-y-auto p-4">
              <InspectorRouter node={selected} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="diagram" className="mt-3 flex flex-1 min-h-0 gap-3">
          <div className="flex-1 min-w-0 overflow-hidden rounded-lg border bg-card">
            <CanvasView payload={payload} selectedId={selectedId} onSelect={setSelectedId} />
          </div>
          <div className="hidden w-96 shrink-0 overflow-hidden rounded-lg border bg-card lg:flex lg:flex-col">
            <div className="flex-1 overflow-y-auto p-4">
              <InspectorRouter node={selected} />
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function readSelectedId(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY)
  } catch {
    return null
  }
}

function readTab(): string {
  try {
    const value = localStorage.getItem(TAB_KEY)
    return value === 'diagram' ? 'diagram' : 'list'
  } catch {
    return 'list'
  }
}
