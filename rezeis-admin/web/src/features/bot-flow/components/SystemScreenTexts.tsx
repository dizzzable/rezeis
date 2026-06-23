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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Languages, Save as SaveIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { EmojiPicker } from '@/features/broadcast/emoji-picker'
import { insertAtCaret } from '@/features/bot-map/utils/insert-at-caret'
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
        {keys.map((key) => (
          <TextKeyEditor key={key} textKey={key} />
        ))}
      </div>
    </>
  )
}

interface TextKeyEditorProps {
  readonly textKey: string
}

/**
 * Inline RU/EN editor for a single bot-config text key (with emoji picker).
 * Self-fetches its row from the shared texts query so it can be dropped in
 * anywhere (system-screen texts section AND system-button rows). Upserts the
 * key (visible:true) so reiwa picks it up via `translations`.
 */
export function TextKeyEditor({ textKey }: TextKeyEditorProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

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
  const ruRef = useRef<HTMLTextAreaElement | null>(null)
  const enRef = useRef<HTMLTextAreaElement | null>(null)

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
    onError: () => toast.error(t('botFlow.screenTexts.saveFailed')),
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

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/20 p-2">
      <code className="block truncate text-[10px] text-muted-foreground">{textKey}</code>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-[10px]">{t('botFlow.screenTexts.ru')}</Label>
          <EmojiPicker onSelect={insertRu} ariaLabel={t('emojiPicker.trigger')} />
        </div>
        <textarea
          ref={ruRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={2}
          maxLength={8000}
          placeholder={t('botFlow.screenTexts.placeholder')}
          className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
        />
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
          <textarea
            ref={enRef}
            value={valueEn}
            onChange={(e) => setValueEn(e.target.value)}
            rows={2}
            maxLength={8000}
            placeholder={t('botFlow.screenTexts.placeholder')}
            className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
          />
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
