/**
 * GraphScreenEditor — inspector editor for `graph-screen` nodes.
 *
 * Wave 2: text RU + text EN side-by-side, blur-save through the existing
 * `PUT /admin/bot-flows/screens/:id` endpoint. Buttons + media editing
 * stays in the legacy graph editor for now (deep link below); the map
 * page is RU/EN copy + structure overview, not a full structural editor.
 */
import { Workflow } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'

import { BOT_MAP_QUERY_KEY, patchGraphScreen } from '../../bot-map-api'
import type { GraphScreenMapNode } from '../../types'
import { BannerField } from '../BannerField'
import { LocaleTextarea } from './LocaleTextarea'

interface GraphScreenEditorProps {
  readonly node: GraphScreenMapNode
}

export function GraphScreenEditor({ node }: GraphScreenEditorProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) => patchGraphScreen(node.id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_MAP_QUERY_KEY })
      toast.success(t('botMapPage.inspector.saved'))
    },
    onError: () => toast.error(t('botMapPage.inspector.saveFailed')),
  })

  const save = (patch: Record<string, unknown>) => mutation.mutate(patch)

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Workflow className="h-3.5 w-3.5" aria-hidden />
          {t('botMapPage.graphScreen.title')}
        </p>
        <h2 className="text-base font-semibold">{node.title}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-[10px]">
            {t('botMapPage.graphScreen.shortIdLabel')}: {node.shortId}
          </Badge>
          {node.isRoot && (
            <Badge variant="default" className="text-[10px]">
              {t('botMapPage.badges.root')}
            </Badge>
          )}
          {node.status === 'PUBLISHED' && (
            <Badge variant="secondary" className="text-[10px]">
              {t('botMapPage.badges.published')}
            </Badge>
          )}
          {node.status === 'DRAFT' && (
            <Badge variant="outline" className="text-[10px]">
              {t('botMapPage.badges.draft')}
            </Badge>
          )}
        </div>
      </header>

      <div className="flex items-center justify-between rounded-lg border p-3">
        <div className="space-y-0.5">
          <Label className="text-sm font-medium">{t('botMapPage.graphScreen.isRoot')}</Label>
        </div>
        <Switch
          checked={node.isRoot}
          onCheckedChange={(next) => save({ isRoot: next })}
          disabled={mutation.isPending}
          aria-label={t('botMapPage.graphScreen.isRoot')}
        />
      </div>

      <LocaleTextarea
        labelRu={t('botMapPage.graphScreen.textRu')}
        labelEn={t('botMapPage.graphScreen.textEn')}
        placeholderRu={t('botMapPage.graphScreen.placeholderRu')}
        placeholderEn={t('botMapPage.graphScreen.placeholderEn')}
        valueRu={node.textRu}
        valueEn={node.textEn}
        rows={5}
        onSave={({ ru, en }) => {
          const patch: Record<string, unknown> = {}
          if (ru !== undefined) patch.textRu = ru
          if (en !== undefined) patch.textEn = en === null ? '' : en
          if (Object.keys(patch).length > 0) save(patch)
        }}
        disabled={mutation.isPending}
      />

      {/* Per-screen banner. Writes the screen's own photo media (mediaType=PHOTO
          + mediaUrl), which reiwa renders regardless of the global "one banner
          for all screens" toggle. Clearing removes the media so the screen
          falls back to no banner (or the global one when that toggle is on). */}
      <div className="space-y-1.5 rounded-lg border p-3">
        <Label className="text-xs font-medium">{t('botMapPage.graphScreen.banner')}</Label>
        <BannerField
          value={node.bannerUrl}
          onChange={(url) =>
            save(
              url
                ? { mediaType: 'PHOTO', mediaUrl: url, mediaFileId: null }
                : { mediaType: null, mediaUrl: null, mediaFileId: null },
            )
          }
          disabled={mutation.isPending}
        />
        <p className="text-[10px] leading-snug text-muted-foreground">
          {t('botMapPage.graphScreen.bannerHint')}
        </p>
      </div>

      <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <p className="mb-2">{t('botMapPage.graphScreen.tooltipFullEditor')}</p>
        <p>
          {t('botMapPage.graphScreen.buttonCountLabel')}:{' '}
          <Badge variant="outline" className="ml-1 text-[10px]">
            {node.buttonCount}
          </Badge>
        </p>
      </div>
    </div>
  )
}
