/**
 * SystemScreenTexts — inline editor for the reiwa i18n text keys that drive a
 * built-in screen (invite / rules / help). These screens render their copy in
 * the bot from `BotText` rows (referral.hub.*, rules.*, support.* …), not from
 * the graph screen's own text. They used to be editable only in the global
 * «Тексты» drawer; this surfaces the exact keys right inside the screen
 * inspector so the operator sees and edits what the bot actually shows. The
 * keys per screen are `SCREEN_TEXT_KEYS` (`../system-screens`).
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

import { SCREEN_TEXT_KEYS } from '../system-screens'

/**
 * A plain-language name above the key, for the keys an operator looks for by
 * what the customer receives rather than by name: the two «Поделиться»
 * messages, which is how they were asked about («the text people send from
 * the bot»). A key without one shows its name alone, as every key did.
 *
 * `sharePrompt` and `shareWebLine` say what the owner could not see from the
 * key: Telegram puts the bot link above the prompt by itself, and the website
 * line has to keep its `{{link}}` — passed in as `token` so i18next does not
 * read it as a variable of its own.
 *
 * The rest say WHEN the bot shows a text that is not simply part of this
 * screen (reiwa `invite.ts`, `help-callback.ts`, `help.ts`): a message sent
 * instead of the hub, a text a partner gets instead of the screen's own, a
 * hub text the screen's own text replaces, the `/help` command's own text.
 */
const KEY_CAPTIONS: Readonly<Record<string, string>> = {
  'referral.hub.title': 'botFlow.screenTexts.captions.hubTitle',
  'referral.hub.description': 'botFlow.screenTexts.captions.hubDescription',
  'referral.hub.link_label': 'botFlow.screenTexts.captions.hubLinkLabel',
  'referral.hub.web_link_label': 'botFlow.screenTexts.captions.hubWebLinkLabel',
  'partner.hub.title': 'botFlow.screenTexts.captions.partnerTitle',
  'partner.hub.description': 'botFlow.screenTexts.captions.partnerDescription',
  'referral.disabled': 'botFlow.screenTexts.captions.referralDisabled',
  'referral.invited_only': 'botFlow.screenTexts.captions.referralInvitedOnly',
  'referral.link_unavailable': 'botFlow.screenTexts.captions.referralLinkUnavailable',
  // Read only while there is no «rules» screen (reiwa `rules.ts` takes the
  // screen's own text first) — and this editor sits on that very screen.
  'rules.intro': 'botFlow.screenTexts.captions.rulesIntro',
  'rules.unavailable': 'botFlow.screenTexts.captions.rulesUnavailable',
  'support.title': 'botFlow.screenTexts.captions.supportTitle',
  'support.not_configured': 'botFlow.screenTexts.captions.supportNotConfigured',
  'help.contact_support': 'botFlow.screenTexts.captions.helpContactSupport',
  // The main menu's texts (`MAIN_MENU_TEXT_KEYS`).
  'bot.welcome_message': 'botFlow.screenTexts.captions.welcomeMessage',
  'menu.choose_action': 'botFlow.screenTexts.captions.chooseAction',
  'profile.subscription': 'botFlow.screenTexts.captions.subscriptionLine',
  'profile.devices': 'botFlow.screenTexts.captions.subscriptionLine',
  'profile.devices_unlimited': 'botFlow.screenTexts.captions.subscriptionLine',
  'profile.traffic': 'botFlow.screenTexts.captions.subscriptionLine',
  'profile.unlimited': 'botFlow.screenTexts.captions.subscriptionLine',
  'profile.until': 'botFlow.screenTexts.captions.subscriptionLine',
  'common.not_available': 'botFlow.screenTexts.captions.subscriptionLine',
  // «Меню обновилось» — only when an old button the bot no longer knows is
  // pressed (reiwa `stale-button.ts`); by its key nobody would look for it.
  'menu.updated': 'botFlow.screenTexts.captions.menuUpdated',
  'invite.share_button': 'botFlow.screenTexts.captions.shareButton',
  'invite.share_prompt': 'botFlow.screenTexts.captions.sharePrompt',
  'invite.share_web_line': 'botFlow.screenTexts.captions.shareWebLine',
  'inline.share.message': 'botFlow.screenTexts.captions.inlineMessage',
  'inline.share.title': 'botFlow.screenTexts.captions.inlineTitle',
  'inline.share.description': 'botFlow.screenTexts.captions.inlineDescription',
  'inline.share.open': 'botFlow.screenTexts.captions.inlineOpen',
  'inline.share.message_plain': 'botFlow.screenTexts.captions.inlineMessagePlain',
  'inline.share.title_plain': 'botFlow.screenTexts.captions.inlineTitlePlain',
  'inline.share.description_plain': 'botFlow.screenTexts.captions.inlineDescriptionPlain',
  'inline.share.start': 'botFlow.screenTexts.captions.inlineStart',
}

interface SystemScreenTextsProps {
  readonly screenName: string
}

export function SystemScreenTexts({ screenName }: SystemScreenTextsProps) {
  const keys = SCREEN_TEXT_KEYS[screenName.trim().toLowerCase()]

  if (keys === undefined || keys.length === 0) return null

  return <BotTextKeysSection keys={keys} />
}

interface BotTextKeysSectionProps {
  readonly keys: readonly string[]
  /** i18n key of the section title; the built-in screens' own by default. */
  readonly titleKey?: string
  /** A caption (i18n key) per text key, over `KEY_CAPTIONS`. */
  readonly captions?: Readonly<Record<string, string>>
}

/**
 * The editors of a list of bot text keys, under a title and the screen-texts
 * hint — the section a built-in screen shows, reused for the texts of the main
 * menu and of the bot's screens that have no block (`SystemScreenPanel`).
 */
export function BotTextKeysSection({
  keys,
  titleKey = 'botFlow.screenTexts.title',
  captions,
}: BotTextKeysSectionProps) {
  const { t } = useTranslation()

  return (
    <>
      <Separator />
      <div className="space-y-2">
        <div>
          <Label className="text-xs font-medium">{t(titleKey)}</Label>
          <p className="text-[10px] leading-snug text-muted-foreground">
            {t('botFlow.screenTexts.hint')}
          </p>
        </div>
        {/*
          `layout` stays at its default here on purpose. Nine of these keys ARE
          button captions and must be DRAWN as captions — but that is the
          overlay's mode, which `TextKeyEditor` now derives from the key itself,
          not the shape of the card. The compact card is a different decision:
          it caps input at 64 characters and drops the key name, and this
          section lists thirty-two keys for `invite` alone, where the key name
          (with a caption above it on the share texts and the conditional ones,
          `KEY_CAPTIONS`) is what tells them apart.
        */}
        {keys.map((key) => (
          <TextKeyEditor key={key} textKey={key} captionKey={captions?.[key]} />
        ))}
      </div>
    </>
  )
}

interface TextKeyEditorProps {
  readonly textKey: string
  /** The caption above the key (i18n key); `KEY_CAPTIONS` decides when absent. */
  readonly captionKey?: string
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
export function TextKeyEditor({ textKey, captionKey, layout = 'text' }: TextKeyEditorProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  // How the value is DRAWN, which is not the same question as how the card is
  // SHAPED. A caption is a different medium — reiwa lifts a leading `:slug:`
  // out of it into `icon_custom_emoji_id` and draws it before the label — and
  // that is true of the key wherever it is edited. `layout` stays the caller's
  // choice of card, so the system-screen section keeps the roomy card with the
  // key name on it and still draws its nine caption keys correctly.
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

  const caption = captionKey ?? KEY_CAPTIONS[textKey]

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/20 p-2">
      {caption !== undefined && (
        <p className="text-[11px] font-medium leading-snug">{t(caption, { token: '{{link}}' })}</p>
      )}
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
