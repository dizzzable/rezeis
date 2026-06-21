/**
 * ReplyButtonEditor — inspector editor for the reply-keyboard pseudo-node.
 *
 * Wave 2: edit label + visibility per row; the structural fields
 * (`actionType`, `actionTarget`) are read-only here and live in the
 * legacy bot-config editor. Each row's `Save` button persists through
 * the existing `/admin/bot-config/buttons/:id` endpoint.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Save as SaveIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

import { BOT_MAP_QUERY_KEY, patchReplyButton } from '../../bot-map-api'
import type { ReplyKeyboardMapNode } from '../../types'

interface ReplyButtonEditorProps {
  readonly node: ReplyKeyboardMapNode
}

export function ReplyButtonEditor({ node }: ReplyButtonEditorProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">{t('botMapPage.replyKeyboard.title')}</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('botMapPage.replyKeyboard.subtitle')}
        </p>
      </header>

      {node.buttons.length === 0 ? (
        <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p>{t('botMapPage.replyKeyboard.empty')}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {node.buttons.map((button) => (
            <li key={button.id}>
              <ReplyButtonRow button={button} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface ReplyButtonRowProps {
  readonly button: ReplyKeyboardMapNode['buttons'][number]
}

function ReplyButtonRow({ button }: ReplyButtonRowProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [label, setLabel] = useState(button.label)
  const [visible, setVisible] = useState(button.visible)
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setLabel(button.label)
    setVisible(button.visible)
  }, [button.id, button.label, button.visible])
  /* eslint-enable react-hooks/set-state-in-effect */

  const mutation = useMutation({
    mutationFn: (patch: { label?: string; visible?: boolean }) =>
      patchReplyButton(button.id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_MAP_QUERY_KEY })
      toast.success(t('botMapPage.inspector.saved'))
    },
    onError: () => toast.error(t('botMapPage.inspector.saveFailed')),
  })

  const dirty = label !== button.label || visible !== button.visible
  const save = () => {
    if (!dirty) return
    const patch: { label?: string; visible?: boolean } = {}
    if (label !== button.label) patch.label = label
    if (visible !== button.visible) patch.visible = visible
    mutation.mutate(patch)
  }

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[10px]">
          {t('botMapPage.replyKeyboard.buttonId')}: {button.buttonId}
        </Badge>
        <Badge variant="secondary" className="text-[10px]">
          {t('botMapPage.replyKeyboard.action')}: {button.actionType}
        </Badge>
        {button.actionTarget && (
          <Badge variant="outline" className="font-mono text-[10px]">
            {t('botMapPage.replyKeyboard.target')}: {button.actionTarget}
          </Badge>
        )}
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">{t('botMapPage.replyKeyboard.label')}</Label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={64}
          className="text-sm"
        />
      </div>

      <div className="flex items-center justify-between rounded-md bg-muted/30 p-2">
        <Label className="text-xs">{t('botMapPage.replyKeyboard.visible')}</Label>
        <Switch checked={visible} onCheckedChange={setVisible} disabled={mutation.isPending} />
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || mutation.isPending}
        >
          <SaveIcon className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {t('botMapPage.replyKeyboard.saveLabel')}
        </Button>
      </div>
    </div>
  )
}
