import { useContext, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Lock, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/http-errors'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EmojiPicker } from '@/features/broadcast/emoji-picker'
import { MiniAppScreenField } from '@/features/bot-map/components/MiniAppScreenField'
import { insertAtCaret } from '@/features/bot-map/utils/insert-at-caret'
import { EmojiFieldOverlay } from '@/features/custom-emoji/emoji-field-overlay'
import { CustomEmojiPicker } from './CustomEmojiPicker'
import { SystemButtonCard } from './SystemButtonCard'
import { SystemScreenTexts } from './SystemScreenTexts'
import { buttonTargetProblem, type ButtonTargetProblem } from './reply-keyboard-utils'
import { PendingEditsContext, usePendingDrafts } from '../pending-edits'
import { computeSystemButtons } from '../utils'
import type { BotFlowButton, BotFlowButtonAction, BotFlowButtonStyle, BotFlowParseMode, BotFlowScreen } from '../types'

interface ScreenEditorPanelProps {
  screen: BotFlowScreen
  flowName: string
}

const ACTION_TYPES: BotFlowButtonAction[] = ['NAVIGATE', 'URL', 'WEBAPP', 'CALLBACK', 'BACK', 'START_OVER', 'SUPPORT_URL']
const BUTTON_STYLES: BotFlowButtonStyle[] = ['DEFAULT', 'PRIMARY', 'SUCCESS', 'DANGER']
// reiwa distinguishes HTML (parse_mode) from everything else (entity render).
// Markdown isn't honoured at render time, so we only surface the two modes the
// bot actually behaves differently for.
const PARSE_MODES: BotFlowParseMode[] = ['HTML', 'PLAIN']

export function ScreenEditorPanel({ screen, flowName }: ScreenEditorPanelProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const edits = useContext(PendingEditsContext)
  const mediaInputRef = useRef<HTMLInputElement | null>(null)
  const textRuRef = useRef<HTMLTextAreaElement | null>(null)
  const textEnRef = useRef<HTMLTextAreaElement | null>(null)
  const systemButtonsTitleId = useId()

  // Destructure to avoid react-doctor false positive on "screen.*" in deps
  const { id: screenId, name: screenName, textRu: screenTextRu, textEn: screenTextEn, isRoot: screenIsRoot } = screen

  // Local state for debounced editing
  const [name, setName] = useState(screenName)
  const [textRu, setTextRu] = useState(screenTextRu)
  const [textEn, setTextEn] = useState(screenTextEn)
  const [isRoot, setIsRoot] = useState(screenIsRoot)
  // What each text field last saved or loaded. A draft that differs is not
  // saved yet (`usePendingDrafts`); a refetch replaces only a draft that does
  // not, so what is typed while the last save is on its way stays in the box.
  const savedScreen = useRef({ name: screenName, textRu: screenTextRu, textEn: screenTextEn })

  // Sync when the screen's row comes back changed (a save, another tab). The
  // page keys this panel by the screen, so another screen is another panel.
  // TODO: refactor — derive these values inline from props/key instead of mirroring into state.
  useEffect(() => {
    const previous = savedScreen.current
    savedScreen.current = { name: screenName, textRu: screenTextRu, textEn: screenTextEn }
    setName((draft) => (draft === previous.name ? screenName : draft))
    setTextRu((draft) => (draft === previous.textRu ? screenTextRu : draft))
    setTextEn((draft) => (draft === previous.textEn ? screenTextEn : draft))
    setIsRoot(screenIsRoot)
  }, [screenId, screenName, screenTextRu, screenTextEn, screenIsRoot])

  /**
   * Built-in callback screens (`help` / `rules` / `invite`) get
   * runtime values injected via `{{placeholders}}`. Show the operator
   * which placeholders are available for the current screen so they
   * can write copy like "Your link: {{link}}" without guessing.
   */
  const placeholderHintKey: string | null = (() => {
    const lower = screenName.trim().toLowerCase()
    if (lower === 'invite') return 'botFlow.fields.placeholders.invite'
    if (lower === 'rules') return 'botFlow.fields.placeholders.rules'
    if (lower === 'help') return 'botFlow.fields.placeholders.help'
    return null
  })()

  /**
   * The buttons reiwa adds to this screen at runtime — not stored in
   * `bot_flow_buttons`, so not in the editable list below. Their caption and
   * icon are set here. The list is the canvas's own (`computeSystemButtons`):
   * this panel kept a second copy, and the copies drifted apart from each
   * other and from the bot.
   */
  const systemButtons = computeSystemButtons(screen)

  // ── Screen mutations ────────────────────────────────────────────────────────
  const updateScreenMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      await api.put(`/admin/bot-flows/screens/${screen.id}`, data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', flowName] })
    },
    // A refused save of the screen's name or texts said nothing at all.
    onError: (error) => toast.error(getErrorMessage(error, t('botMapPage.inspector.saveFailed'))),
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
    // A refused save said nothing at all: the server's own reason — a target
    // the bot could not open names its field.
    onError: (error) => toast.error(getErrorMessage(error, t('botMapPage.inspector.saveFailed'))),
  })

  const deleteButtonMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/admin/bot-flows/buttons/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', flowName] })
    },
  })

  // ── Save the screen's texts: on leaving a field, before a publish, on unmount ─
  type ScreenTexts = typeof savedScreen.current
  /** Saves `changes` and marks them saved; a refused save marks them unsaved again. */
  const saveScreenTexts = (changes: Partial<ScreenTexts>): void => {
    const before = savedScreen.current
    savedScreen.current = { ...before, ...changes }
    void edits.track(updateScreenMutation.mutateAsync(changes)).catch(() => {
      savedScreen.current = revertUnsaved(savedScreen.current, before, changes)
      edits.changed()
    })
  }
  const saveScreenDrafts = (): void => {
    const saved = savedScreen.current
    const changes: Partial<ScreenTexts> = {}
    if (name !== saved.name) changes.name = name
    if (textRu !== saved.textRu) changes.textRu = textRu
    if (textEn !== saved.textEn) changes.textEn = textEn
    if (Object.keys(changes).length > 0) saveScreenTexts(changes)
  }
  usePendingDrafts({
    flush: saveScreenDrafts,
    dirty: () =>
      name !== savedScreen.current.name ||
      textRu !== savedScreen.current.textRu ||
      textEn !== savedScreen.current.textEn,
  })

  // ── Emoji insert into screen text (insert at caret + persist) ───────────────
  const insertEmojiRu = (emoji: string) => {
    const el = textRuRef.current
    const start = el?.selectionStart ?? textRu.length
    const end = el?.selectionEnd ?? textRu.length
    const { value: next, caret } = insertAtCaret(textRu, start, end, emoji)
    setTextRu(next)
    saveScreenTexts({ textRu: next })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }
  const insertEmojiEn = (emoji: string) => {
    const el = textEnRef.current
    const start = el?.selectionStart ?? textEn.length
    const end = el?.selectionEnd ?? textEn.length
    const { value: next, caret } = insertAtCaret(textEn, start, end, emoji)
    setTextEn(next)
    saveScreenTexts({ textEn: next })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  return (
    <div className="space-y-4">
      {/* Screen name */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t('botFlow.fields.name')}</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveScreenDrafts}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveScreenDrafts()
          }}
          className="h-8 text-xs"
        />
        <p className="text-[10px] leading-snug text-muted-foreground">
          {t('botFlow.fields.nameHint')}
        </p>
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

      {/* Parse mode (HTML formatting vs plain) */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t('botFlow.fields.parseMode')}</Label>
        <Select
          value={screen.parseMode === 'HTML' ? 'HTML' : 'PLAIN'}
          onValueChange={(v) => updateScreenMutation.mutate({ parseMode: v })}
        >
          <SelectTrigger className="h-8 text-xs" aria-label={t('botFlow.fields.parseMode')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PARSE_MODES.map((mode) => (
              <SelectItem key={mode} value={mode} className="text-xs">
                {t(`botFlow.fields.parseModes.${mode}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] leading-snug text-muted-foreground">
          {t('botFlow.fields.parseModeHint')}
        </p>
      </div>

      <Separator />

      {/* Text RU */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t('botFlow.fields.textRu')}</Label>
          <EmojiPicker onSelect={insertEmojiRu} ariaLabel={t('emojiPicker.trigger')} />
        </div>
        {/* Raw `<textarea>`: the layer repeats its `text-xs` by hand. The
            padding already matches the layer's own default. */}
        <EmojiFieldOverlay value={textRu} mode="text" multiline overlayClassName="text-xs">
          <textarea
            ref={textRuRef}
            value={textRu}
            onChange={(e) => setTextRu(e.target.value)}
            onBlur={saveScreenDrafts}
            rows={3}
            className="w-full rounded-md border bg-background px-3 py-2 text-xs resize-y min-h-[60px] focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={t('botFlow.fields.textRuPlaceholder')}
          />
        </EmojiFieldOverlay>
        {placeholderHintKey !== null ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-700 dark:text-amber-400">
            {t(placeholderHintKey)}
          </p>
        ) : null}
      </div>

      {/* Text EN */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t('botFlow.fields.textEn')}</Label>
          <EmojiPicker onSelect={insertEmojiEn} ariaLabel={t('emojiPicker.trigger')} />
        </div>
        <EmojiFieldOverlay value={textEn} mode="text" multiline overlayClassName="text-xs">
          <textarea
            ref={textEnRef}
            value={textEn}
            onChange={(e) => setTextEn(e.target.value)}
            onBlur={saveScreenDrafts}
            rows={3}
            className="w-full rounded-md border bg-background px-3 py-2 text-xs resize-y min-h-[60px] focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={t('botFlow.fields.textEnPlaceholder')}
          />
        </EmojiFieldOverlay>
      </div>

      <Separator />

      {/* Screen banner upload (image or video shown at the top of this screen) */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t('botFlow.fields.media')}</Label>
        {screen.mediaUrl ? (
          <div className="relative rounded-md overflow-hidden border">
            {screen.mediaType === 'VIDEO' ? (
              <video src={screen.mediaUrl} className="w-full h-24 object-cover" muted playsInline />
            ) : (
              <img src={screen.mediaUrl} alt="" className="w-full h-24 object-cover" />
            )}
            <Button
              variant="destructive"
              size="sm"
              className="absolute top-1 right-1 h-6 w-6 p-0"
              onClick={() => updateScreenMutation.mutate({ mediaType: null, mediaUrl: null, mediaFileId: null })}
              aria-label={t('botFlow.fields.removeMedia')}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="flex h-16 w-full items-center justify-center rounded-md border border-dashed transition-colors hover:border-primary hover:bg-primary/5"
              onClick={() => mediaInputRef.current?.click()}
              aria-label={t('botFlow.fields.chooseMedia')}
            >
              <span className="text-xs text-muted-foreground">{t('botFlow.fields.mediaHint')}</span>
            </button>
            <input
              ref={mediaInputRef}
              type="file"
              accept="image/*,video/*"
              className="hidden"
              aria-label={t('botFlow.fields.chooseMedia')}
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
          </>
        )}
      </div>

      <Separator />
      {systemButtons.length > 0 ? (
        <section className="space-y-2" aria-labelledby={systemButtonsTitleId}>
          <div className="flex items-center gap-1.5">
            <Lock className="h-3 w-3 text-muted-foreground" aria-hidden />
            <Label id={systemButtonsTitleId} className="text-xs font-medium">
              {t('botFlow.systemButtons.title')}
            </Label>
          </div>
          <p className="text-[10px] leading-snug text-muted-foreground">
            {t('botFlow.systemButtons.description')}
          </p>
          <div className="space-y-2">
            {systemButtons.map((btn) => (
              <SystemButtonCard
                key={btn.key}
                label={t(btn.labelKey)}
                condition={btn.conditionKey !== undefined ? t(btn.conditionKey) : null}
                iconKey={btn.iconKey}
                textKey={btn.textKey}
              />
            ))}
          </div>
        </section>
      ) : null}

      <SystemScreenTexts screenName={screenName} />

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
              onUpdate={(data) =>
                edits.track(updateButtonMutation.mutateAsync({ id: btn.id, data })).then(
                  () => true,
                  () => false,
                )
              }
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
  /** Saves `data`; resolves `false` when the server refused it. Never rejects. */
  onUpdate: (data: Record<string, unknown>) => Promise<boolean>
  onDelete: () => void
}

/** The typed fields of a button, `''` for an empty target. */
interface ButtonDrafts {
  readonly labelRu: string
  readonly labelEn: string
  readonly url: string
  readonly webAppUrl: string
}

function ButtonEditor({ button, onUpdate, onDelete }: ButtonEditorProps) {
  const { t } = useTranslation()
  const webAppLabelId = useId()
  const urlLabelId = useId()
  const problemId = useId()
  const [labelRu, setLabelRu] = useState(button.labelRu)
  const [labelEn, setLabelEn] = useState(button.labelEn)
  // The link's and the Mini App's targets as typed. They were saved on every
  // keystroke, so a target the rule refuses could not even be typed through:
  // `h` of `https://` was refused and the box snapped back. Now they save when
  // the box is left, on Enter, when a page is picked, before «Опубликовать» or
  // «Сохранить позиции», and when the editor goes — and only a target the bot
  // can open (`usePendingDrafts`).
  const [urlDraft, setUrlDraft] = useState(button.url ?? '')
  const [webAppDraft, setWebAppDraft] = useState(button.webAppUrl ?? '')
  // What each typed field last saved or loaded: a draft that differs is not
  // saved yet, and one that does not is saved again by nothing — not by a
  // second blur of an unchanged box. A refetch replaces only a draft that does
  // not differ, so text typed while the last save is on its way stays.
  const saved = useRef<ButtonDrafts>({
    labelRu: button.labelRu,
    labelEn: button.labelEn,
    url: button.url ?? '',
    webAppUrl: button.webAppUrl ?? '',
  })
  const labelRuRef = useRef<HTMLInputElement | null>(null)
  const labelEnRef = useRef<HTMLInputElement | null>(null)

  // TODO: refactor — re-derive labelRu/labelEn from `button` prop directly via key/identity.
  useEffect(() => {
    const previous = saved.current
    saved.current = { ...saved.current, labelRu: button.labelRu, labelEn: button.labelEn }
    setLabelRu((draft) => (draft === previous.labelRu ? button.labelRu : draft))
    setLabelEn((draft) => (draft === previous.labelEn ? button.labelEn : draft))
  }, [button.labelRu, button.labelEn])
  useEffect(() => {
    const previous = saved.current.url
    const stored = button.url ?? ''
    saved.current = { ...saved.current, url: stored }
    setUrlDraft((draft) => (draft === previous ? stored : draft))
  }, [button.url])
  useEffect(() => {
    const previous = saved.current.webAppUrl
    const stored = button.webAppUrl ?? ''
    saved.current = { ...saved.current, webAppUrl: stored }
    setWebAppDraft((draft) => (draft === previous ? stored : draft))
  }, [button.webAppUrl])

  /** Saves `changes` and marks them saved; a refused save marks them unsaved again. */
  const saveDrafts = (changes: Partial<ButtonDrafts>): void => {
    const before = saved.current
    saved.current = { ...before, ...changes }
    const body: Record<string, unknown> = { ...changes }
    for (const field of ['url', 'webAppUrl'] as const) {
      if (changes[field] === '') body[field] = null
    }
    void onUpdate(body).then((stored) => {
      if (!stored) saved.current = revertUnsaved(saved.current, before, changes)
    })
  }

  // Why the bot could not open the target, said under it — the main menu's
  // rule and words (`buttonTargetProblem`), which the server refuses the same
  // target with. A button saved before with such a target loads as it is, the
  // map draws it red, and this says why until it is fixed.
  const urlProblem = button.actionType === 'URL' ? buttonTargetProblem('screenUrl', urlDraft) : null
  const webAppProblem = button.actionType === 'WEBAPP' ? buttonTargetProblem('screenWebApp', webAppDraft) : null
  const problemNote = (problem: ButtonTargetProblem | null) =>
    problem === null ? null : (
      <p id={problemId} role="alert" className="text-[10px] leading-snug text-destructive">
        {t(`botConfigPage.buttons.fields.actionTarget.problems.${problem}`)}
      </p>
    )
  /** Saves a target — only one the bot can open, and only when it changed. */
  const commitTarget = (field: 'url' | 'webAppUrl', target: string): void => {
    const place = field === 'url' ? 'screenUrl' : 'screenWebApp'
    if (buttonTargetProblem(place, target) !== null) return
    if (target === saved.current[field]) return
    saveDrafts({ [field]: target })
  }

  const handleLabelBlur = () => {
    const changes: { labelRu?: string; labelEn?: string } = {}
    if (labelRu !== saved.current.labelRu) changes.labelRu = labelRu
    if (labelEn !== saved.current.labelEn) changes.labelEn = labelEn
    if (Object.keys(changes).length > 0) saveDrafts(changes)
  }

  // The drafts the page saves before a publish, and this editor as it goes.
  // A target the rule refuses stays unsaved — and counts as unsaved.
  usePendingDrafts({
    flush: () => {
      handleLabelBlur()
      if (button.actionType === 'URL') commitTarget('url', urlDraft)
      if (button.actionType === 'WEBAPP') commitTarget('webAppUrl', webAppDraft)
    },
    dirty: () =>
      labelRu !== saved.current.labelRu ||
      labelEn !== saved.current.labelEn ||
      (button.actionType === 'URL' && urlDraft !== saved.current.url) ||
      (button.actionType === 'WEBAPP' && webAppDraft !== saved.current.webAppUrl),
  })

  const insertLabelRu = (emoji: string) => {
    const el = labelRuRef.current
    const start = el?.selectionStart ?? labelRu.length
    const end = el?.selectionEnd ?? labelRu.length
    const { value: next, caret } = insertAtCaret(labelRu, start, end, emoji)
    setLabelRu(next)
    saveDrafts({ labelRu: next })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }
  const insertLabelEn = (emoji: string) => {
    const el = labelEnRef.current
    const start = el?.selectionStart ?? labelEn.length
    const end = el?.selectionEnd ?? labelEn.length
    const { value: next, caret } = insertAtCaret(labelEn, start, end, emoji)
    setLabelEn(next)
    saveDrafts({ labelEn: next })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  return (
    <div className="rounded-lg border p-2.5 space-y-2 bg-muted/30">
      {/* Label RU/EN */}
      <div className="grid grid-cols-2 gap-1.5">
        <div className="flex items-center gap-1">
          {/* `buttonLabel`: a leading shortcode is lifted out of this caption
              into `icon_custom_emoji_id`, so the layer shows it as the
              button's own icon above the field instead of inline. */}
          <EmojiFieldOverlay
            value={labelRu}
            mode="buttonLabel"
            overlayClassName="text-[11px]"
            className="min-w-0 flex-1"
          >
            <Input
              ref={labelRuRef}
              value={labelRu}
              onChange={(e) => setLabelRu(e.target.value)}
              onBlur={handleLabelBlur}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleLabelBlur()
              }}
              placeholder={t('botFlow.button.labelRuPlaceholder')}
              className="h-7 text-[11px]"
            />
          </EmojiFieldOverlay>
          <EmojiPicker onSelect={insertLabelRu} ariaLabel={t('emojiPicker.trigger')} />
        </div>
        <div className="flex items-center gap-1">
          <EmojiFieldOverlay
            value={labelEn}
            mode="buttonLabel"
            overlayClassName="text-[11px]"
            className="min-w-0 flex-1"
          >
            <Input
              ref={labelEnRef}
              value={labelEn}
              onChange={(e) => setLabelEn(e.target.value)}
              onBlur={handleLabelBlur}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleLabelBlur()
              }}
              placeholder={t('botFlow.button.labelEnPlaceholder')}
              className="h-7 text-[11px]"
            />
          </EmojiFieldOverlay>
          <EmojiPicker onSelect={insertLabelEn} ariaLabel={t('emojiPicker.trigger')} />
        </div>
      </div>

      {/* Row / Col — same row = same line in Telegram keyboard */}
      <div className="grid grid-cols-2 gap-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground shrink-0">{t('botFlow.button.row')}</span>
          <Input
            type="number"
            min={0}
            value={button.row}
            onChange={(e) => void onUpdate({ row: parseInt(e.target.value) || 0 })}
            className="h-7 text-[11px] w-14"
            aria-label={t('botFlow.button.row')}
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground shrink-0">{t('botFlow.button.col')}</span>
          <Input
            type="number"
            min={0}
            value={button.col}
            onChange={(e) => void onUpdate({ col: parseInt(e.target.value) || 0 })}
            className="h-7 text-[11px] w-14"
            aria-label={t('botFlow.button.col')}
          />
        </div>
      </div>

      {/* Action type */}
      <div className="grid grid-cols-2 gap-1.5">
        <Select
          value={button.actionType}
          onValueChange={(v) => void onUpdate({ actionType: v })}
        >
          <SelectTrigger className="h-7 text-[11px]" aria-label={t('botFlow.button.action')}>
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
          onValueChange={(v) => void onUpdate({ style: v })}
        >
          <SelectTrigger className="h-7 text-[11px]" aria-label={t('botFlow.button.style')}>
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
        onChange={(emojiId) => void onUpdate({ iconCustomEmojiId: emojiId })}
      />

      {/* Action-specific fields */}
      {button.actionType === 'URL' && (
        <div className="space-y-1">
          <span id={urlLabelId} className="sr-only">
            {t('botFlow.button.url')}
          </span>
          <Input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={() => commitTarget('url', urlDraft)}
            onKeyDown={(e) => {
              // Enter — a phone keyboard's «Go» among them — saves as leaving does.
              if (e.key === 'Enter') commitTarget('url', urlDraft)
            }}
            placeholder={t('botFlow.button.url')}
            aria-labelledby={urlLabelId}
            aria-invalid={urlProblem !== null}
            aria-describedby={urlProblem !== null ? problemId : undefined}
            className="h-7 text-[11px]"
          />
          {problemNote(urlProblem)}
        </div>
      )}
      {button.actionType === 'WEBAPP' && (
        <div className="space-y-1">
          <span id={webAppLabelId} className="sr-only">
            {t('botFlow.button.webAppUrl')}
          </span>
          <MiniAppScreenField
            value={webAppDraft}
            onChange={setWebAppDraft}
            onCommit={(target) => commitTarget('webAppUrl', target)}
            labelId={webAppLabelId}
            placeholder={t('botConfigPage.buttons.fields.actionTarget.webappPlaceholder')}
            describedBy={webAppProblem !== null ? problemId : undefined}
          />
          {problemNote(webAppProblem)}
        </div>
      )}
      {button.actionType === 'CALLBACK' && (
        <Input
          value={button.callbackAction ?? ''}
          onChange={(e) => void onUpdate({ callbackAction: e.target.value || null })}
          placeholder={t('botFlow.button.callbackAction')}
          className="h-7 text-[11px]"
        />
      )}
      {button.actionType === 'SUPPORT_URL' && (
        <p className="rounded-md border border-dashed bg-muted/30 px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
          {t('botFlow.button.supportUrlHint')}
        </p>
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

/**
 * The saved marks after a refused save: each field the save marked saved goes
 * back to what it was before it — unless a later save has marked it since. The
 * draft is then unsaved again, which is what it is.
 */
function revertUnsaved<T extends object>(current: T, before: T, changes: Partial<T>): T {
  const next = { ...current }
  for (const key of Object.keys(changes) as Array<keyof T>) {
    if (next[key] === changes[key]) next[key] = before[key]
  }
  return next
}
