/**
 * Reusable Edit / Create dialogs for the global reply-keyboard buttons.
 *
 * Pulled out of the original CRUD-tab so the same dialogs can drive the
 * Bot Studio's right-inspector panel and the Sheet drawer that opens
 * from the canvas toolbar. Each dialog owns its own form state and
 * mutation pipeline; consumers just toggle `open`.
 *
 * `actionType` / `actionTarget` carry the per-button routing so an
 * operator can attach a URL, Mini App link, or jump to a flow screen
 * directly to any reply-keyboard button — no need to bake every
 * button id into reiwa code. The target field renders conditionally
 * (URL / WEBAPP take a string, SCREEN takes a dropdown of shortIds
 * from the active draft flow, CALLBACK / SUPPORT_URL take nothing).
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { EmojiPicker } from '@/features/broadcast/emoji-picker'
import { insertAtCaret } from '@/features/bot-map/utils/insert-at-caret'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

import {
  BOT_CONFIG_KEYS,
  type BotButton,
  type BotButtonAction,
  type BotButtonStyle,
  botConfigApi,
  type CreateBotButtonPayload,
  type UpdateBotButtonPayload,
} from './bot-config-api'

const STYLES: BotButtonStyle[] = ['DEFAULT', 'PRIMARY', 'SUCCESS', 'DANGER']
const ACTION_TYPES: BotButtonAction[] = ['CALLBACK', 'URL', 'WEBAPP', 'SCREEN', 'SUPPORT_URL']

const FLOW_NAME = 'Main Flow'

interface FlowScreenSummary {
  readonly id: string
  readonly shortId: string
  readonly name: string
}

interface FlowDraft {
  readonly screens?: readonly FlowScreenSummary[]
}

/**
 * Fetch the active draft flow so the SCREEN action target dropdown
 * shows the operator a list of real shortIds rather than asking them
 * to type one in. Re-fetched lazily — the dialog only opens on demand,
 * so there's no point keeping the data warm.
 */
function useFlowScreens() {
  return useQuery<FlowDraft>({
    queryKey: ['bot-flow', 'draft', FLOW_NAME],
    queryFn: async () =>
      (await api.get(`/admin/bot-flows/draft/${encodeURIComponent(FLOW_NAME)}`)).data,
  })
}

/**
 * Pull i18n placeholder / hint copy for the active actionType. Keeps
 * the JSX terse and the i18n keys all under a single `actionTarget.*`
 * namespace.
 */
function useActionTargetCopy(action: BotButtonAction): { placeholder: string; hint: string } {
  const { t } = useTranslation()
  switch (action) {
    case 'URL':
      return {
        placeholder: t('botConfigPage.buttons.fields.actionTarget.urlPlaceholder'),
        hint: t('botConfigPage.buttons.fields.actionTarget.urlHint'),
      }
    case 'WEBAPP':
      return {
        placeholder: t('botConfigPage.buttons.fields.actionTarget.webappPlaceholder'),
        hint: t('botConfigPage.buttons.fields.actionTarget.webappHint'),
      }
    case 'SCREEN':
      return {
        placeholder: t('botConfigPage.buttons.fields.actionTarget.screenPlaceholder'),
        hint: t('botConfigPage.buttons.fields.actionTarget.screenHint'),
      }
    default:
      return { placeholder: '', hint: '' }
  }
}

interface ActionFieldsProps {
  readonly idPrefix: string
  readonly actionType: BotButtonAction
  readonly actionTarget: string
  readonly onActionTypeChange: (next: BotButtonAction) => void
  readonly onActionTargetChange: (next: string) => void
}

/**
 * Renders the action-type select plus the conditional target field
 * (URL / WebApp text input, SCREEN dropdown). CALLBACK and SUPPORT_URL
 * don't need a target — their behaviour is fully described by the
 * action kind alone.
 */
export function ActionFields({
  idPrefix,
  actionType,
  actionTarget,
  onActionTypeChange,
  onActionTargetChange,
}: ActionFieldsProps): JSX.Element {
  const { t } = useTranslation()
  const { data: flow } = useFlowScreens()
  const screens = useMemo(() => flow?.screens ?? [], [flow])
  const targetCopy = useActionTargetCopy(actionType)
  const showTextTarget = actionType === 'URL' || actionType === 'WEBAPP'
  const showScreenTarget = actionType === 'SCREEN'

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-action-type`}>
          {t('botConfigPage.buttons.fields.actionType.label')}
        </Label>
        <Select
          value={actionType}
          onValueChange={(v) => onActionTypeChange(v as BotButtonAction)}
        >
          <SelectTrigger id={`${idPrefix}-action-type`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTION_TYPES.map((a) => (
              <SelectItem key={a} value={a}>
                {t(`botConfigPage.buttons.fields.actionType.options.${a}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t(`botConfigPage.buttons.fields.actionType.hint.${actionType}`)}
        </p>
      </div>

      {showTextTarget && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-action-target`}>
            {t('botConfigPage.buttons.fields.actionTarget.label')}
          </Label>
          <Input
            id={`${idPrefix}-action-target`}
            value={actionTarget}
            onChange={(e) => onActionTargetChange(e.target.value)}
            placeholder={targetCopy.placeholder}
            maxLength={2_000}
            inputMode="url"
          />
          <p className="text-xs text-muted-foreground">{targetCopy.hint}</p>
        </div>
      )}

      {showScreenTarget && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-action-screen`}>
            {t('botConfigPage.buttons.fields.actionTarget.label')}
          </Label>
          {screens.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              {t('botConfigPage.buttons.fields.actionTarget.screenEmpty')}
            </p>
          ) : (
            <Select value={actionTarget} onValueChange={onActionTargetChange}>
              <SelectTrigger id={`${idPrefix}-action-screen`}>
                <SelectValue placeholder={targetCopy.placeholder} />
              </SelectTrigger>
              <SelectContent>
                {screens.map((s) => (
                  <SelectItem key={s.id} value={s.shortId}>
                    {s.name}
                    <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                      {s.shortId}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="text-xs text-muted-foreground">{targetCopy.hint}</p>
        </div>
      )}
    </>
  )
}

/**
 * Resolve the pair `{ actionType, actionTarget }` to send to the API.
 * Empty / whitespace target is normalised to `null`; CALLBACK and
 * SUPPORT_URL always reset target to `null` regardless of UI state so
 * stale typing doesn't leak through after switching action kinds.
 */
export function buildActionPayload(
  actionType: BotButtonAction,
  actionTarget: string,
): { actionType: BotButtonAction; actionTarget: string | null } {
  if (actionType === 'CALLBACK' || actionType === 'SUPPORT_URL') {
    return { actionType, actionTarget: null }
  }
  const trimmed = actionTarget.trim()
  return { actionType, actionTarget: trimmed.length > 0 ? trimmed : null }
}

// ── Edit ───────────────────────────────────────────────────────────────────

interface BotButtonEditDialogProps {
  readonly button: BotButton | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

export function BotButtonEditDialog({
  button,
  open,
  onOpenChange,
}: BotButtonEditDialogProps): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [label, setLabel] = useState('')
  const [style, setStyle] = useState<BotButtonStyle>('DEFAULT')
  const [iconCustomEmojiId, setIconCustomEmojiId] = useState('')
  const [visible, setVisible] = useState(true)
  const [onePerRow, setOnePerRow] = useState(false)
  const [actionType, setActionType] = useState<BotButtonAction>('CALLBACK')
  const [actionTarget, setActionTarget] = useState('')
  const labelRef = useRef<HTMLInputElement | null>(null)

    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
    if (button !== null && open) {
      setLabel(button.label)
      setStyle(button.style)
      setIconCustomEmojiId(button.iconCustomEmojiId ?? '')
      setVisible(button.visible)
      setOnePerRow(button.onePerRow)
      setActionType(button.actionType)
      setActionTarget(button.actionTarget ?? '')
    }
  }, [button, open])
    /* eslint-enable react-hooks/set-state-in-effect */

  const insertLabelEmoji = (emoji: string) => {
    const el = labelRef.current
    const start = el?.selectionStart ?? label.length
    const end = el?.selectionEnd ?? label.length
    const { value: next, caret } = insertAtCaret(label, start, end, emoji)
    setLabel(next)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { readonly id: string; readonly payload: UpdateBotButtonPayload }) =>
      botConfigApi.updateButton(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.buttons })
      toast.success(t('botConfigPage.buttons.toasts.updated'))
      onOpenChange(false)
    },
    onError: (err: unknown) => {
      const message =
        err !== null && typeof err === 'object' && 'response' in err
          ? extractErrorMessage(err)
          : null
      toast.error(message ?? t('botConfigPage.buttons.toasts.updateFailed'))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => botConfigApi.deleteButton(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.buttons })
      toast.success(t('botConfigPage.buttons.toasts.deleted'))
      onOpenChange(false)
    },
    onError: () => toast.error(t('botConfigPage.buttons.toasts.deleteFailed')),
  })

  function submit(): void {
    if (button === null) return
    const action = buildActionPayload(actionType, actionTarget)
    updateMutation.mutate({
      id: button.id,
      payload: {
        label,
        style,
        iconCustomEmojiId: iconCustomEmojiId.trim() === '' ? null : iconCustomEmojiId.trim(),
        visible,
        onePerRow,
        actionType: action.actionType,
        actionTarget: action.actionTarget,
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('botConfigPage.buttons.editTitle')}</DialogTitle>
          {button !== null && (
            <DialogDescription>
              <code className="font-mono text-xs">{button.buttonId}</code>
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="bbd-edit-label">{t('botConfigPage.buttons.fields.label')}</Label>
              <EmojiPicker onSelect={insertLabelEmoji} ariaLabel={t('emojiPicker.trigger')} />
            </div>
            <Input
              id="bbd-edit-label"
              ref={labelRef}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={120}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bbd-edit-style">{t('botConfigPage.buttons.fields.style')}</Label>
            <Select value={style} onValueChange={(v) => setStyle(v as BotButtonStyle)}>
              <SelectTrigger id="bbd-edit-style">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STYLES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`botConfigPage.buttons.styles.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ActionFields
            idPrefix="bbd-edit"
            actionType={actionType}
            actionTarget={actionTarget}
            onActionTypeChange={(next) => {
              setActionType(next)
              if (next === 'CALLBACK' || next === 'SUPPORT_URL') setActionTarget('')
            }}
            onActionTargetChange={setActionTarget}
          />

          <div className="space-y-1.5">
            <Label htmlFor="bbd-edit-emoji">
              {t('botConfigPage.buttons.fields.iconCustomEmojiId')}
            </Label>
            <Input
              id="bbd-edit-emoji"
              value={iconCustomEmojiId}
              onChange={(e) => setIconCustomEmojiId(e.target.value)}
              placeholder={t('botConfigPage.buttons.fields.iconCustomEmojiIdPlaceholder')}
              maxLength={120}
            />
            <p className="text-xs text-muted-foreground">
              {t('botConfigPage.buttons.fields.iconCustomEmojiIdHint')}
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="bbd-edit-visible" className="font-medium">
                {t('botConfigPage.buttons.fields.visible')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('botConfigPage.buttons.fields.visibleHint')}
              </p>
            </div>
            <Switch
              id="bbd-edit-visible"
              checked={visible}
              onCheckedChange={setVisible}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="bbd-edit-row" className="font-medium">
                {t('botConfigPage.buttons.fields.onePerRow')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('botConfigPage.buttons.fields.onePerRowHint')}
              </p>
            </div>
            <Switch id="bbd-edit-row" checked={onePerRow} onCheckedChange={setOnePerRow} />
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button
            variant="destructive"
            onClick={() => button !== null && deleteMutation.mutate(button.id)}
            disabled={button === null || deleteMutation.isPending}
          >
            <Trash2 className="mr-1 h-4 w-4" aria-hidden />
            {t('botConfigPage.buttons.delete')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('botConfigPage.buttons.cancel')}
            </Button>
            <Button onClick={submit} disabled={updateMutation.isPending || label.length === 0}>
              {t('botConfigPage.buttons.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Create ────────────────────────────────────────────────────────────────

interface BotButtonCreateDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

export function BotButtonCreateDialog({
  open,
  onOpenChange,
}: BotButtonCreateDialogProps): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [buttonId, setButtonId] = useState('')
  const [label, setLabel] = useState('')
  const [style, setStyle] = useState<BotButtonStyle>('DEFAULT')
  const [iconCustomEmojiId, setIconCustomEmojiId] = useState('')
  const [visible, setVisible] = useState(true)
  const [onePerRow, setOnePerRow] = useState(false)
  const [actionType, setActionType] = useState<BotButtonAction>('CALLBACK')
  const [actionTarget, setActionTarget] = useState('')
  const labelRef = useRef<HTMLInputElement | null>(null)

    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
    if (open) {
      setButtonId('')
      setLabel('')
      setStyle('DEFAULT')
      setIconCustomEmojiId('')
      setVisible(true)
      setOnePerRow(false)
      setActionType('CALLBACK')
      setActionTarget('')
    }
  }, [open])
    /* eslint-enable react-hooks/set-state-in-effect */

  const insertLabelEmoji = (emoji: string) => {
    const el = labelRef.current
    const start = el?.selectionStart ?? label.length
    const end = el?.selectionEnd ?? label.length
    const { value: next, caret } = insertAtCaret(label, start, end, emoji)
    setLabel(next)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  const createMutation = useMutation({
    mutationFn: (payload: CreateBotButtonPayload) => botConfigApi.createButton(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.buttons })
      toast.success(t('botConfigPage.buttons.toasts.created'))
      onOpenChange(false)
    },
    onError: (err: unknown) => {
      const message =
        err !== null && typeof err === 'object' && 'response' in err
          ? extractErrorMessage(err)
          : null
      toast.error(message ?? t('botConfigPage.buttons.toasts.createFailed'))
    },
  })

  function submit(): void {
    const action = buildActionPayload(actionType, actionTarget)
    createMutation.mutate({
      buttonId: buttonId.trim(),
      label: label.trim(),
      style,
      iconCustomEmojiId: iconCustomEmojiId.trim() === '' ? null : iconCustomEmojiId.trim(),
      visible,
      onePerRow,
      actionType: action.actionType,
      actionTarget: action.actionTarget,
    })
  }

  const canSubmit =
    buttonId.trim().length > 0 &&
    label.trim().length > 0 &&
    /^[a-z0-9._-]+$/i.test(buttonId.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('botConfigPage.buttons.createTitle')}</DialogTitle>
          <DialogDescription>{t('botConfigPage.buttons.createDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bbd-new-id">{t('botConfigPage.buttons.fields.buttonId')}</Label>
            <Input
              id="bbd-new-id"
              value={buttonId}
              onChange={(e) => setButtonId(e.target.value)}
              placeholder={t('botConfigPage.buttons.fields.buttonIdPlaceholder')}
              maxLength={64}
            />
            <p className="text-xs text-muted-foreground">
              {t('botConfigPage.buttons.fields.buttonIdHint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="bbd-new-label">{t('botConfigPage.buttons.fields.label')}</Label>
              <EmojiPicker onSelect={insertLabelEmoji} ariaLabel={t('emojiPicker.trigger')} />
            </div>
            <Input
              id="bbd-new-label"
              ref={labelRef}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={120}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bbd-new-style">{t('botConfigPage.buttons.fields.style')}</Label>
            <Select value={style} onValueChange={(v) => setStyle(v as BotButtonStyle)}>
              <SelectTrigger id="bbd-new-style">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STYLES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`botConfigPage.buttons.styles.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ActionFields
            idPrefix="bbd-new"
            actionType={actionType}
            actionTarget={actionTarget}
            onActionTypeChange={(next) => {
              setActionType(next)
              if (next === 'CALLBACK' || next === 'SUPPORT_URL') setActionTarget('')
            }}
            onActionTargetChange={setActionTarget}
          />

          <div className="space-y-1.5">
            <Label htmlFor="bbd-new-emoji">
              {t('botConfigPage.buttons.fields.iconCustomEmojiId')}
            </Label>
            <Input
              id="bbd-new-emoji"
              value={iconCustomEmojiId}
              onChange={(e) => setIconCustomEmojiId(e.target.value)}
              placeholder={t('botConfigPage.buttons.fields.iconCustomEmojiIdPlaceholder')}
              maxLength={120}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <Label htmlFor="bbd-new-visible" className="font-medium">
              {t('botConfigPage.buttons.fields.visible')}
            </Label>
            <Switch id="bbd-new-visible" checked={visible} onCheckedChange={setVisible} />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <Label htmlFor="bbd-new-row" className="font-medium">
              {t('botConfigPage.buttons.fields.onePerRow')}
            </Label>
            <Switch id="bbd-new-row" checked={onePerRow} onCheckedChange={setOnePerRow} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('botConfigPage.buttons.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit || createMutation.isPending}>
            {t('botConfigPage.buttons.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Surface backend validation messages (`BadRequestException` from
 * `BotButtonsService.validateAction`) to the operator instead of the
 * generic toast. Axios shape: `error.response.data.message` is either
 * a string or an array of strings (class-validator).
 */
function extractErrorMessage(err: unknown): string | null {
  if (err === null || typeof err !== 'object') return null
  const response = (err as { response?: { data?: unknown } }).response
  if (response === undefined) return null
  const data = response.data
  if (data === null || typeof data !== 'object') return null
  const message = (data as { message?: unknown }).message
  if (typeof message === 'string') return message
  if (Array.isArray(message) && message.length > 0 && typeof message[0] === 'string') {
    return message[0] as string
  }
  return null
}
