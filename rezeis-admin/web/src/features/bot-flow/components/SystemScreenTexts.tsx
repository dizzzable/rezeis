/**
 * SystemScreenTexts — inline editor for the reiwa i18n text keys that drive a
 * built-in screen (invite / rules / help). These screens render their copy in
 * the bot from `BotText` rows (referral.hub.*, rules.*, support.* …), not from
 * the graph screen's own text. They used to be editable only in the global
 * "Тексты бота" drawer; this surfaces the exact keys right inside the screen
 * inspector so the operator sees and edits what the bot actually shows.
 *
 * Each key is upserted through the existing bot-config text endpoints
 * (`createText` / `updateText`, which carry the reiwa cache-bust interceptor),
 * with an optional EN sibling (`<key>@en`). RU + EN both get an emoji picker.
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Languages, Save as SaveIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { EmojiPicker } from '@/features/broadcast/emoji-picker'
import { insertAtCaret } from '@/features/bot-map/utils/insert-at-caret'
import { EmojiFieldOverlay } from '@/features/custom-emoji/emoji-field-overlay'
import { botTextKeyMode } from '@/features/bot-config/bot-text-key-mode'
import { getErrorMessage } from '@/lib/http-errors'
import {
  BOT_CONFIG_KEYS,
  botConfigApi,
} from '@/features/bot-config/bot-config-api'

/**
 * The reiwa i18n keys each built-in screen renders from. Keyed by the
 * lowercase screen name (matches the `name` field operators give the
 * built-in screens, and reiwa's `SCREEN_OVERRIDE_NAME` sentinels).
 */
const SCREEN_TEXT_KEYS: Readonly<Record<string, readonly string[]>> = {
  invite: [
    'referral.hub.title',
    'referral.hub.description',
    'referral.hub.stat_invited',
    'referral.hub.stat_qualified',
    'referral.hub.stat_pending',
    'referral.hub.stat_points',
    'referral.hub.link_label',
    'referral.hub.open_cabinet',
    'referral.hub.open_exchange',
    'invite.share_button',
    'invite.copy_button',
    'invite.share_prompt',
    'partner.hub.title',
    'partner.hub.description',
    'partner.hub.stat_balance',
    'partner.hub.stat_earned',
    'partner.hub.stat_referred',
    'partner.hub.open_cabinet',
  ],
  rules: ['rules.intro', 'rules.unavailable', 'rules.open_button'],
  help: [
    'support.title',
    'support.not_configured',
    'help.open_app_button',
    'help.contact_button',
    'help.contact_prefill',
    'help.contact_support',
  ],
}

interface SystemScreenTextsProps {
  readonly screenName: string
}

export function SystemScreenTexts({ screenName }: SystemScreenTextsProps) {
  const { t } = useTranslation()
  const keys = SCREEN_TEXT_KEYS[screenName.trim().toLowerCase()]

  if (keys === undefined || keys.length === 0) return null

  return (
    <>
      <Separator />
      <div className="space-y-2">
        <div>
          <Label className="text-xs font-medium">{t('botFlow.screenTexts.title')}</Label>
          <p className="text-[10px] leading-snug text-muted-foreground">
            {t('botFlow.screenTexts.hint')}
          </p>
        </div>
        {/*
          `layout` stays at its default here on purpose. Eight of these keys ARE
          button captions and must be DRAWN as captions — but that is the
          overlay's mode, which `TextKeyEditor` now derives from the key itself,
          not the shape of the card. The compact card is a different decision:
          it caps input at 64 characters and drops the key name, and this
          section lists eighteen keys for `invite` alone, where the key name is
          the only thing telling them apart.
        */}
        {keys.map((key) => (
          <TextKeyEditor key={key} textKey={key} />
        ))}
      </div>
    </>
  )
}

interface TextKeyEditorProps {
  readonly textKey: string
  /**
   * `text` (default) — stacked RU textarea + collapsible EN textarea, for the
   * multi-line bot copy in the system-screen texts section.
   * `buttonLabel` — compact RU/EN single-line label card matching the
   * notification/screen button editor, for system-button labels.
   */
  readonly layout?: 'text' | 'buttonLabel'
}

/**
 * Inline RU/EN editor for a single bot-config text key (with emoji picker).
 * Self-fetches its row from the shared texts query so it can be dropped in
 * anywhere (system-screen texts section AND system-button rows). Upserts the
 * key (visible:true) so reiwa picks it up via `translations`.
 */
export function TextKeyEditor({ textKey, layout = 'text' }: TextKeyEditorProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  // How the value is DRAWN, which is not the same question as how the card is
  // SHAPED. A caption is a different medium — reiwa lifts a leading `:slug:`
  // out of it into `icon_custom_emoji_id` and draws it before the label — and
  // that is true of the key wherever it is edited. `layout` stays the caller's
  // choice of card, so the system-screen section keeps the roomy card with the
  // key name on it and still draws its eight caption keys correctly.
  const fieldMode = botTextKeyMode(textKey)

  const { data: texts } = useQuery({
    queryKey: BOT_CONFIG_KEYS.texts,
    queryFn: botConfigApi.listTexts,
  })
  const row = texts?.find((r) => r.key === textKey) ?? null

  const rowId = row?.id ?? null
  const rowValue = row?.value ?? ''
  const rowValueEn = row?.valueEn ?? ''

  const [value, setValue] = useState(rowValue)
  const [valueEn, setValueEn] = useState(rowValueEn)
  const [enOpen, setEnOpen] = useState(rowValueEn.length > 0)
  const ruRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  const enRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)

  // Re-sync when the underlying row changes (refetch after save, or the
  // operator selects a different screen feeding the same component tree).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setValue(rowValue)
    setValueEn(rowValueEn)
    setEnOpen(rowValueEn.length > 0)
  }, [rowId, rowValue, rowValueEn])
  /* eslint-enable react-hooks/set-state-in-effect */

  const mutation = useMutation({
    mutationFn: async () => {
      const en = enOpen && valueEn.length > 0 ? valueEn : null
      if (rowId !== null) {
        await botConfigApi.updateText(rowId, { value, valueEn: en })
      } else {
        await botConfigApi.createText({ key: textKey, value, visible: true, valueEn: en })
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.texts })
      void queryClient.invalidateQueries({ queryKey: ['bot-texts'] })
      toast.success(t('botFlow.screenTexts.saved'))
    },
    // The write path refuses specific things and says why — a duplicate key, a
    // key that is not alphanumeric. Collapsing all of that into one generic
    // "could not save" left the operator with nothing to act on, so the
    // server's own sentence is shown when it sent one.
    onError: (error) => toast.error(getErrorMessage(error, t('botFlow.screenTexts.saveFailed'))),
  })

  const insertRu = (emoji: string) => {
    const el = ruRef.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    const { value: next, caret } = insertAtCaret(value, start, end, emoji)
    setValue(next)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }
  const insertEn = (emoji: string) => {
    const el = enRef.current
    const start = el?.selectionStart ?? valueEn.length
    const end = el?.selectionEnd ?? valueEn.length
    const { value: next, caret } = insertAtCaret(valueEn, start, end, emoji)
    setValueEn(next)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  const dirty = rowValue !== value || rowValueEn !== (enOpen ? valueEn : '')
  const canSave = value.trim().length > 0 && dirty && !mutation.isPending

  if (layout === 'buttonLabel') {
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-[11px]">{t('botFlow.systemButtons.labelRu')}</Label>
              <EmojiPicker onSelect={insertRu} ariaLabel={t('emojiPicker.trigger')} />
            </div>
            {/* `buttonLabel`: this key IS a button caption, so a leading
                shortcode never stays in it — reiwa lifts it into
                `icon_custom_emoji_id` and it is drawn as a separate row. */}
            <EmojiFieldOverlay value={value} mode={fieldMode} overlayClassName="text-xs">
              <Input
                ref={ruRef as RefObject<HTMLInputElement>}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                maxLength={64}
                placeholder={t('botFlow.screenTexts.placeholder')}
                className="text-xs"
              />
            </EmojiFieldOverlay>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-[11px]">{t('botFlow.systemButtons.labelEn')}</Label>
              <EmojiPicker onSelect={insertEn} ariaLabel={t('emojiPicker.trigger')} />
            </div>
            <EmojiFieldOverlay value={valueEn} mode={fieldMode} overlayClassName="text-xs">
              <Input
                ref={enRef as RefObject<HTMLInputElement>}
                value={valueEn}
                onChange={(e) => {
                  setValueEn(e.target.value)
                  setEnOpen(true)
                }}
                maxLength={64}
                placeholder={t('botFlow.screenTexts.placeholder')}
                className="text-xs"
              />
            </EmojiFieldOverlay>
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            onClick={() => mutation.mutate()}
            disabled={!canSave}
          >
            <SaveIcon className="mr-1 h-3 w-3" aria-hidden />
            {t('botFlow.screenTexts.save')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/20 p-2">
      <code className="block truncate text-[10px] text-muted-foreground">{textKey}</code>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-[10px]">{t('botFlow.screenTexts.ru')}</Label>
          <EmojiPicker onSelect={insertRu} ariaLabel={t('emojiPicker.trigger')} />
        </div>
        {/* Raw `<textarea>`, not the shadcn one, so the layer cannot inherit
            the field's typography — it is repeated here by hand and must keep
            matching the `className` below. */}
        <EmojiFieldOverlay value={value} mode={fieldMode} multiline overlayClassName="px-2 py-1.5 text-[11px]">
          <textarea
            ref={ruRef as RefObject<HTMLTextAreaElement>}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={2}
            maxLength={8000}
            placeholder={t('botFlow.screenTexts.placeholder')}
            className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </EmojiFieldOverlay>
      </div>

      <button
        type="button"
        onClick={() => setEnOpen((o) => !o)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        <Languages className="h-3 w-3" aria-hidden />
        {t('botFlow.screenTexts.enToggle')}
      </button>

      {enOpen && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-[10px]">{t('botFlow.screenTexts.en')}</Label>
            <EmojiPicker onSelect={insertEn} ariaLabel={t('emojiPicker.trigger')} />
          </div>
          <EmojiFieldOverlay value={valueEn} mode={fieldMode} multiline overlayClassName="px-2 py-1.5 text-[11px]">
            <textarea
              ref={enRef as RefObject<HTMLTextAreaElement>}
              value={valueEn}
              onChange={(e) => setValueEn(e.target.value)}
              rows={2}
              maxLength={8000}
              placeholder={t('botFlow.screenTexts.placeholder')}
              className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </EmojiFieldOverlay>
        </div>
      )}

      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[10px]"
          onClick={() => mutation.mutate()}
          disabled={!canSave}
        >
          <SaveIcon className="mr-1 h-3 w-3" aria-hidden />
          {t('botFlow.screenTexts.save')}
        </Button>
      </div>
    </div>
  )
}
