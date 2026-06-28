/**
 * NotificationEditor — inspector editor for `notification` nodes.
 *
 * Wave 2: side-by-side RU/EN title + body, an `isActive` switch, and an
 * inline editor for the `buttons` array (kind / labelRu / labelEn /
 * target). All fields persist through the existing
 * `PATCH /admin/notifications/templates/:id` endpoint, which Wave 1
 * extended to accept the new locale + buttons fields.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bell, Plus, Save as SaveIcon, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { EmojiPicker } from '@/features/broadcast/emoji-picker'
import { insertAtCaret } from '../../utils/insert-at-caret'

import {
  BOT_MAP_QUERY_KEY,
  patchNotificationTemplate,
} from '../../bot-map-api'
import type { NotificationButtonShape, NotificationMapNode } from '../../types'
import { BannerField } from '../BannerField'
import { LocaleTextarea } from './LocaleTextarea'

interface NotificationEditorProps {
  readonly node: NotificationMapNode
}

interface DraftButton {
  readonly localId: string
  labelRu: string
  labelEn: string
  kind: 'webApp' | 'url' | 'callback'
  target: string
  style: 'primary' | 'success' | 'danger' | 'default'
  row: number
}

let buttonIdCounter = 0
function makeLocalId(): string {
  buttonIdCounter += 1
  return `btn-${Date.now().toString(36)}-${buttonIdCounter}`
}

function fromShape(button: NotificationButtonShape, index: number): DraftButton {
  return {
    localId: makeLocalId(),
    labelRu: button.labelRu,
    labelEn: button.labelEn ?? '',
    kind: button.kind,
    target: button.target,
    style: button.style ?? 'default',
    // Legacy buttons carry no row → fall back to their position so each keeps
    // its own row (the historical one-per-row layout) until the operator groups
    // them.
    row: typeof button.row === 'number' && button.row >= 0 ? button.row : index,
  }
}

function toShape(button: DraftButton): NotificationButtonShape {
  return {
    labelRu: button.labelRu,
    labelEn: button.labelEn.length === 0 ? null : button.labelEn,
    kind: button.kind,
    target: button.target,
    style: button.style,
    row: button.row,
  }
}

export function NotificationEditor({ node }: NotificationEditorProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [titleRu, setTitleRu] = useState(node.titleRu)
  const [titleEn, setTitleEn] = useState(node.titleEn ?? '')
  const [bodyRu, setBodyRu] = useState(node.bodyRu)
  const [bodyEn, setBodyEn] = useState(node.bodyEn ?? '')
  const [isActive, setIsActive] = useState(node.isActive)
  const [buttons, setButtons] = useState<DraftButton[]>(() => node.buttons.map(fromShape))

  // Re-sync local state when the canonical node identity changes.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setTitleRu(node.titleRu)
    setTitleEn(node.titleEn ?? '')
    setBodyRu(node.bodyRu)
    setBodyEn(node.bodyEn ?? '')
    setIsActive(node.isActive)
    setButtons(node.buttons.map(fromShape))
  }, [
    node.templateId,
    node.titleRu,
    node.titleEn,
    node.bodyRu,
    node.bodyEn,
    node.isActive,
    node.buttons,
  ])
  /* eslint-enable react-hooks/set-state-in-effect */

  const mutation = useMutation({
    mutationFn: (patch: Parameters<typeof patchNotificationTemplate>[1]) =>
      patchNotificationTemplate(node.templateId, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_MAP_QUERY_KEY })
      toast.success(t('botMapPage.inspector.saved'))
    },
    onError: () => toast.error(t('botMapPage.inspector.saveFailed')),
  })

  const saveCopy = (patch: { ru?: string; en?: string | null }, kind: 'title' | 'body') => {
    const writePatch: {
      title?: string
      body?: string
      titleEn?: string | null
      bodyEn?: string | null
    } = {}
    if (patch.ru !== undefined) {
      if (kind === 'title') writePatch.title = patch.ru
      else writePatch.body = patch.ru
    }
    if (patch.en !== undefined) {
      if (kind === 'title') writePatch.titleEn = patch.en
      else writePatch.bodyEn = patch.en
    }
    if (Object.keys(writePatch).length > 0) mutation.mutate(writePatch)
  }

  const saveActive = (next: boolean) => {
    setIsActive(next)
    mutation.mutate({ isActive: next })
  }

  const addButton = () => {
    setButtons((prev) => [
      ...prev,
      {
        localId: makeLocalId(),
        labelRu: '',
        labelEn: '',
        kind: 'webApp',
        target: '',
        style: 'default',
        // New button starts on its own row (one past the current max).
        row: prev.reduce((max, b) => Math.max(max, b.row), -1) + 1,
      },
    ])
  }

  const removeButton = (localId: string) => {
    setButtons((prev) => prev.filter((b) => b.localId !== localId))
  }

  const updateButton = (localId: string, patch: Partial<DraftButton>) => {
    setButtons((prev) =>
      prev.map((b) => (b.localId === localId ? { ...b, ...patch } : b)),
    )
  }

  const buttonsDirty = !sameButtons(node.buttons, buttons)
  const saveButtons = () => {
    mutation.mutate({ buttons: buttons.map(toShape) })
  }

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Bell className="h-3.5 w-3.5" aria-hidden />
          {t('botMapPage.notification.title')}
        </p>
        <h2 className="text-base font-semibold">{node.title}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-[10px]">
            {t('botMapPage.notification.typeLabel')}: {node.type}
          </Badge>
          {node.status === 'ACTIVE' && (
            <Badge variant="default" className="text-[10px]">
              {t('botMapPage.badges.active')}
            </Badge>
          )}
          {node.status === 'DISABLED' && (
            <Badge variant="outline" className="text-[10px]">
              {t('botMapPage.badges.disabled')}
            </Badge>
          )}
        </div>
      </header>

      <div className="flex items-center justify-between rounded-lg border p-3">
        <Label className="text-sm font-medium">{t('botMapPage.notification.isActive')}</Label>
        <Switch
          checked={isActive}
          onCheckedChange={saveActive}
          disabled={mutation.isPending}
        />
      </div>

      <div className="rounded-lg border p-3">
        <BannerField
          value={node.bannerUrl}
          onChange={(url) => mutation.mutate({ bannerUrl: url ?? '' })}
          disabled={mutation.isPending}
        />
      </div>

      <LocaleTextarea
        labelRu={t('botMapPage.notification.titleRu')}
        labelEn={t('botMapPage.notification.titleEn')}
        placeholderRu={t('botMapPage.notification.placeholderTitleRu')}
        placeholderEn={t('botMapPage.notification.placeholderTitleEn')}
        valueRu={titleRu}
        valueEn={titleEn}
        rows={2}
        onSave={(patch) => {
          if (patch.ru !== undefined) setTitleRu(patch.ru)
          if (patch.en !== undefined) setTitleEn(patch.en ?? '')
          saveCopy(patch, 'title')
        }}
        disabled={mutation.isPending}
      />

      <LocaleTextarea
        labelRu={t('botMapPage.notification.bodyRu')}
        labelEn={t('botMapPage.notification.bodyEn')}
        placeholderRu={t('botMapPage.notification.placeholderBodyRu')}
        placeholderEn={t('botMapPage.notification.placeholderBodyEn')}
        valueRu={bodyRu}
        valueEn={bodyEn}
        rows={6}
        onSave={(patch) => {
          if (patch.ru !== undefined) setBodyRu(patch.ru)
          if (patch.en !== undefined) setBodyEn(patch.en ?? '')
          saveCopy(patch, 'body')
        }}
        disabled={mutation.isPending}
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">
              {t('botMapPage.notification.buttonsTitle')}
            </h3>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t('botMapPage.notification.buttonsHint')}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={addButton}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
            {t('botMapPage.notification.addButton')}
          </Button>
        </div>

        {buttons.length === 0 ? (
          <p className="rounded-md border border-dashed bg-muted/20 p-3 text-[11px] text-muted-foreground">
            {t('botMapPage.notification.defaultTargetHint')}
          </p>
        ) : (
          <ul className="space-y-2">
            {buttons.map((b) => (
              <NotificationButtonRow
                key={b.localId}
                button={b}
                disabled={mutation.isPending}
                onUpdate={(patch) => updateButton(b.localId, patch)}
                onRemove={() => removeButton(b.localId)}
              />
            ))}
          </ul>
        )}

        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={saveButtons}
            disabled={!buttonsDirty || mutation.isPending}
          >
            <SaveIcon className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t('botMapPage.notification.save')}
          </Button>
        </div>
      </section>
    </div>
  )
}

interface NotificationButtonRowProps {
  readonly button: DraftButton
  readonly disabled?: boolean
  readonly onUpdate: (patch: Partial<DraftButton>) => void
  readonly onRemove: () => void
}

/**
 * Editable row for a single notification button. Mirrors the graph
 * `ScreenEditorPanel` button editor: RU/EN labels each carry an inline emoji
 * picker that inserts at the caret. Edits flow into the parent's local draft
 * (`onUpdate`) and persist on the section's "Save" — same as typing.
 */
function NotificationButtonRow({
  button,
  disabled,
  onUpdate,
  onRemove,
}: NotificationButtonRowProps) {
  const { t } = useTranslation()
  const labelRuRef = useRef<HTMLInputElement | null>(null)
  const labelEnRef = useRef<HTMLInputElement | null>(null)

  const insertRu = (emoji: string) => {
    const el = labelRuRef.current
    const start = el?.selectionStart ?? button.labelRu.length
    const end = el?.selectionEnd ?? button.labelRu.length
    const { value: next, caret } = insertAtCaret(button.labelRu, start, end, emoji)
    onUpdate({ labelRu: next })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }
  const insertEn = (emoji: string) => {
    const el = labelEnRef.current
    const start = el?.selectionStart ?? button.labelEn.length
    const end = el?.selectionEnd ?? button.labelEn.length
    const { value: next, caret } = insertAtCaret(button.labelEn, start, end, emoji)
    onUpdate({ labelEn: next })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  return (
    <li className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-[11px]">{t('botMapPage.notification.labelRu')}</Label>
            <EmojiPicker onSelect={insertRu} ariaLabel={t('emojiPicker.trigger')} />
          </div>
          <Input
            ref={labelRuRef}
            value={button.labelRu}
            onChange={(e) => onUpdate({ labelRu: e.target.value })}
            maxLength={64}
            className="text-xs"
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-[11px]">{t('botMapPage.notification.labelEn')}</Label>
            <EmojiPicker onSelect={insertEn} ariaLabel={t('emojiPicker.trigger')} />
          </div>
          <Input
            ref={labelEnRef}
            value={button.labelEn}
            onChange={(e) => onUpdate({ labelEn: e.target.value })}
            maxLength={64}
            className="text-xs"
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px]">{t('botMapPage.notification.kind')}</Label>
          <Select
            value={button.kind}
            onValueChange={(v) => onUpdate({ kind: v as DraftButton['kind'] })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="webApp" className="text-xs">
                {t('botMapPage.notification.kindOptions.webApp')}
              </SelectItem>
              <SelectItem value="url" className="text-xs">
                {t('botMapPage.notification.kindOptions.url')}
              </SelectItem>
              <SelectItem value="callback" className="text-xs">
                {t('botMapPage.notification.kindOptions.callback')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="col-span-2 space-y-1">
          <Label className="text-[11px]">{t(targetLabelKey(button.kind))}</Label>
          <Input
            value={button.target}
            onChange={(e) => onUpdate({ target: e.target.value })}
            placeholder={t(targetLabelKey(button.kind))}
            maxLength={2_000}
            className="font-mono text-xs"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px]">{t('botMapPage.notification.style')}</Label>
          <Select
            value={button.style}
            onValueChange={(v) => onUpdate({ style: v as DraftButton['style'] })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default" className="text-xs">
                {t('botMapPage.notification.styleOptions.default')}
              </SelectItem>
              <SelectItem value="primary" className="text-xs">
                {t('botMapPage.notification.styleOptions.primary')}
              </SelectItem>
              <SelectItem value="success" className="text-xs">
                {t('botMapPage.notification.styleOptions.success')}
              </SelectItem>
              <SelectItem value="danger" className="text-xs">
                {t('botMapPage.notification.styleOptions.danger')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">{t('botMapPage.notification.row')}</Label>
          <Input
            type="number"
            min={0}
            max={7}
            value={button.row}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10)
              onUpdate({ row: Number.isInteger(next) && next >= 0 ? next : 0 })
            }}
            className="h-8 text-xs"
          />
          <p className="text-[10px] leading-snug text-muted-foreground">
            {t('botMapPage.notification.rowHint')}
          </p>
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          onClick={onRemove}
          disabled={disabled}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="mr-1 h-3 w-3" aria-hidden />
          {t('botMapPage.notification.removeButton')}
        </Button>
      </div>
    </li>
  )
}

function targetLabelKey(kind: DraftButton['kind']): string {
  switch (kind) {
    case 'webApp':
      return 'botMapPage.notification.targetWebApp'
    case 'url':
      return 'botMapPage.notification.targetUrl'
    case 'callback':
      return 'botMapPage.notification.targetCallback'
  }
}

function sameButtons(
  a: ReadonlyArray<NotificationButtonShape>,
  b: ReadonlyArray<DraftButton>,
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]
    const right = b[i]
    const leftRow = typeof left.row === 'number' && left.row >= 0 ? left.row : i
    if (
      left.labelRu !== right.labelRu ||
      (left.labelEn ?? '') !== right.labelEn ||
      left.kind !== right.kind ||
      left.target !== right.target ||
      (left.style ?? 'default') !== right.style ||
      leftRow !== right.row
    ) {
      return false
    }
  }
  return true
}
