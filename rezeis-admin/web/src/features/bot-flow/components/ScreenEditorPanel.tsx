import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CustomEmojiPicker } from './CustomEmojiPicker'
import type { BotFlowButton, BotFlowButtonAction, BotFlowButtonStyle, BotFlowScreen } from '../types'

interface ScreenEditorPanelProps {
  screen: BotFlowScreen
  flowName: string
}

const ACTION_TYPES: BotFlowButtonAction[] = ['NAVIGATE', 'URL', 'WEBAPP', 'CALLBACK', 'BACK', 'START_OVER']
const BUTTON_STYLES: BotFlowButtonStyle[] = ['DEFAULT', 'PRIMARY', 'SUCCESS', 'DANGER']

export function ScreenEditorPanel({ screen, flowName }: ScreenEditorPanelProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  // Destructure to avoid react-doctor false positive on "screen.*" in deps
  const { id: screenId, name: screenName, textRu: screenTextRu, textEn: screenTextEn, isRoot: screenIsRoot } = screen

  // Local state for debounced editing
  const [name, setName] = useState(screenName)
  const [textRu, setTextRu] = useState(screenTextRu)
  const [textEn, setTextEn] = useState(screenTextEn)
  const [isRoot, setIsRoot] = useState(screenIsRoot)

  // Sync when screen changes (user clicks different node)
  // TODO: refactor — derive these values inline from props/key instead of mirroring into state.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setName(screenName)
    setTextRu(screenTextRu)
    setTextEn(screenTextEn)
    setIsRoot(screenIsRoot)
  }, [screenId, screenName, screenTextRu, screenTextEn, screenIsRoot])
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Screen mutations ────────────────────────────────────────────────────────
  const updateScreenMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      await api.put(`/admin/bot-flows/screens/${screen.id}`, data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', flowName] })
    },
  })

  const deleteScreenMutation = useMutation({
    mutationFn: async () => {
      await api.delete(`/admin/bot-flows/screens/${screen.id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', flowName] })
      toast.success(t('botFlow.screenDeleted'))
    },
  })

  // ── Button mutations ────────────────────────────────────────────────────────
  const createButtonMutation = useMutation({
    mutationFn: async () => {
      const maxRow = screen.buttons.reduce((max, btn) => Math.max(max, btn.row), -1)
      await api.post('/admin/bot-flows/buttons', {
        screenId: screen.id,
        labelRu: 'Кнопка',
        labelEn: 'Button',
        row: maxRow + 1,
        col: 0,
        actionType: 'NAVIGATE',
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', flowName] })
    },
  })

  const updateButtonMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Record<string, unknown> }) => {
      await api.put(`/admin/bot-flows/buttons/${id}`, data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', flowName] })
    },
  })

  const deleteButtonMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/admin/bot-flows/buttons/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', flowName] })
    },
  })

  // ── Save screen on blur ─────────────────────────────────────────────────────
  const handleScreenBlur = useCallback(() => {
    const changes: Record<string, unknown> = {}
    if (name !== screenName) changes.name = name
    if (textRu !== screenTextRu) changes.textRu = textRu
    if (textEn !== screenTextEn) changes.textEn = textEn
    if (isRoot !== screenIsRoot) changes.isRoot = isRoot
    if (Object.keys(changes).length > 0) {
      updateScreenMutation.mutate(changes)
    }
  }, [name, textRu, textEn, isRoot, screenName, screenTextRu, screenTextEn, screenIsRoot, updateScreenMutation])

  return (
    <div className="space-y-4">
      {/* Screen name */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t('botFlow.fields.name')}</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleScreenBlur}
          className="h-8 text-xs"
        />
      </div>

      {/* Is root toggle */}
      <div className="flex items-center justify-between">
        <Label className="text-xs">{t('botFlow.fields.isRoot')}</Label>
        <Switch
          checked={isRoot}
          onCheckedChange={(checked) => {
            setIsRoot(checked)
            updateScreenMutation.mutate({ isRoot: checked })
          }}
          aria-label={t('botFlow.fields.isRoot')}
        />
      </div>

      <Separator />

      {/* Text RU */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t('botFlow.fields.textRu')}</Label>
        <textarea
          value={textRu}
          onChange={(e) => setTextRu(e.target.value)}
          onBlur={handleScreenBlur}
          rows={3}
          className="w-full rounded-md border bg-background px-3 py-2 text-xs resize-y min-h-[60px] focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder={t('botFlow.fields.textRuPlaceholder')}
        />
      </div>

      {/* Text EN */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t('botFlow.fields.textEn')}</Label>
        <textarea
          value={textEn}
          onChange={(e) => setTextEn(e.target.value)}
          onBlur={handleScreenBlur}
          rows={3}
          className="w-full rounded-md border bg-background px-3 py-2 text-xs resize-y min-h-[60px] focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder={t('botFlow.fields.textEnPlaceholder')}
        />
      </div>

      <Separator />

      {/* Media upload */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t('botFlow.fields.media')}</Label>
        {screen.mediaUrl ? (
          <div className="relative rounded-md overflow-hidden border">
            <img src={screen.mediaUrl} alt="" className="w-full h-24 object-cover" />
            <Button
              variant="destructive"
              size="sm"
              className="absolute top-1 right-1 h-6 w-6 p-0"
              onClick={() => updateScreenMutation.mutate({ mediaType: null, mediaUrl: null, mediaFileId: null })}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        ) : (
          <label className="flex items-center justify-center h-16 rounded-md border border-dashed cursor-pointer hover:border-primary hover:bg-primary/5 transition-colors">
            <input
              type="file"
              accept="image/*,video/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                const formData = new FormData()
                formData.append('file', file)
                try {
                  await api.post(`/admin/bot-flows/screens/${screen.id}/media`, formData, {
                    headers: { 'Content-Type': 'multipart/form-data' },
                  })
                  queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', flowName] })
                } catch {
                  toast.error(t('botFlow.mediaUploadError'))
                }
              }}
            />
            <span className="text-xs text-muted-foreground">{t('botFlow.fields.mediaHint')}</span>
          </label>
        )}
      </div>

      <Separator />
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">{t('botFlow.button.add')}</Label>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px] px-2"
            onClick={() => createButtonMutation.mutate()}
            disabled={createButtonMutation.isPending}
          >
            <Plus className="h-3 w-3 mr-1" />
            {t('botFlow.button.add')}
          </Button>
        </div>

        {screen.buttons
          .sort((a, b) => a.row - b.row || a.col - b.col)
          .map((btn) => (
            <ButtonEditor
              key={btn.id}
              button={btn}
              onUpdate={(data) => updateButtonMutation.mutate({ id: btn.id, data })}
              onDelete={() => deleteButtonMutation.mutate(btn.id)}
            />
          ))}
      </div>

      <Separator />

      {/* Delete screen */}
      <Button
        variant="destructive"
        size="sm"
        className="w-full"
        onClick={() => deleteScreenMutation.mutate()}
        disabled={deleteScreenMutation.isPending}
      >
        <Trash2 className="h-3.5 w-3.5 mr-1.5" />
        {t('botFlow.deleteScreen')}
      </Button>
    </div>
  )
}

// ── Button Editor (inline) ────────────────────────────────────────────────────

interface ButtonEditorProps {
  button: BotFlowButton
  onUpdate: (data: Record<string, unknown>) => void
  onDelete: () => void
}

function ButtonEditor({ button, onUpdate, onDelete }: ButtonEditorProps) {
  const { t } = useTranslation()
  const [labelRu, setLabelRu] = useState(button.labelRu)
  const [labelEn, setLabelEn] = useState(button.labelEn)

  // TODO: refactor — re-derive labelRu/labelEn from `button` prop directly via key/identity.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setLabelRu(button.labelRu)
    setLabelEn(button.labelEn)
  }, [button.labelRu, button.labelEn])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleLabelBlur = () => {
    const changes: Record<string, unknown> = {}
    if (labelRu !== button.labelRu) changes.labelRu = labelRu
    if (labelEn !== button.labelEn) changes.labelEn = labelEn
    if (Object.keys(changes).length > 0) onUpdate(changes)
  }

  return (
    <div className="rounded-lg border p-2.5 space-y-2 bg-muted/30">
      {/* Label RU/EN */}
      <div className="grid grid-cols-2 gap-1.5">
        <Input
          value={labelRu}
          onChange={(e) => setLabelRu(e.target.value)}
          onBlur={handleLabelBlur}
          placeholder={t('botFlow.button.labelRuPlaceholder')}
          className="h-7 text-[11px]"
        />
        <Input
          value={labelEn}
          onChange={(e) => setLabelEn(e.target.value)}
          onBlur={handleLabelBlur}
          placeholder={t('botFlow.button.labelEnPlaceholder')}
          className="h-7 text-[11px]"
        />
      </div>

      {/* Row / Col — same row = same line in Telegram keyboard */}
      <div className="grid grid-cols-2 gap-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground shrink-0">{t('botFlow.button.row')}</span>
          <Input
            type="number"
            min={0}
            value={button.row}
            onChange={(e) => onUpdate({ row: parseInt(e.target.value) || 0 })}
            className="h-7 text-[11px] w-14"
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground shrink-0">{t('botFlow.button.col')}</span>
          <Input
            type="number"
            min={0}
            value={button.col}
            onChange={(e) => onUpdate({ col: parseInt(e.target.value) || 0 })}
            className="h-7 text-[11px] w-14"
          />
        </div>
      </div>

      {/* Action type */}
      <div className="grid grid-cols-2 gap-1.5">
        <Select
          value={button.actionType}
          onValueChange={(v) => onUpdate({ actionType: v })}
        >
          <SelectTrigger className="h-7 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTION_TYPES.map((action) => (
              <SelectItem key={action} value={action} className="text-xs">
                {t(`botFlow.actions.${action}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Style */}
        <Select
          value={button.style}
          onValueChange={(v) => onUpdate({ style: v })}
        >
          <SelectTrigger className="h-7 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BUTTON_STYLES.map((style) => (
              <SelectItem key={style} value={style} className="text-xs">
                {t(`botFlow.styles.${style}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Custom Emoji Picker */}
      <CustomEmojiPicker
        value={button.iconCustomEmojiId}
        onChange={(emojiId) => onUpdate({ iconCustomEmojiId: emojiId })}
      />

      {/* Action-specific fields */}
      {button.actionType === 'URL' && (
        <Input
          value={button.url ?? ''}
          onChange={(e) => onUpdate({ url: e.target.value || null })}
          placeholder={t('botFlow.button.url')}
          className="h-7 text-[11px]"
        />
      )}
      {button.actionType === 'WEBAPP' && (
        <Input
          value={button.webAppUrl ?? ''}
          onChange={(e) => onUpdate({ webAppUrl: e.target.value || null })}
          placeholder={t('botFlow.button.webAppUrl')}
          className="h-7 text-[11px]"
        />
      )}
      {button.actionType === 'CALLBACK' && (
        <Input
          value={button.callbackAction ?? ''}
          onChange={(e) => onUpdate({ callbackAction: e.target.value || null })}
          placeholder={t('botFlow.button.callbackAction')}
          className="h-7 text-[11px]"
        />
      )}

      {/* Delete button */}
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}
