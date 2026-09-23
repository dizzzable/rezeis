/**
 * The page a «Mini App» button opens, picked from the cabinet's own pages.
 *
 * Every Mini App button in the panel — a notification's, a main-menu button's,
 * a screen's — used to be a text box, and the box asked for a guess: the
 * main-menu form for «Полный https:// URL Mini App», the map for a path, with a
 * list of pages beside it that offered «Покупка подписки» at `/subscribe`, a
 * page the cabinet does not have. A tester set «Пригласить» to open the
 * referral program through such a box and the Mini App opened on its home
 * screen — which is where any path the cabinet has no page for lands.
 *
 * The list is the server's catalog (`miniAppScreens` on `GET /admin/bot-map`),
 * pinned to the cabinet's routes. «Свой путь…» stays for a page with
 * parameters (`/promo?code=…`) or one not listed, and a saved value that is not
 * on the list opens in that box exactly as it was typed, so nothing an operator
 * saved before is rewritten by opening the form.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { BOT_MAP_QUERY_KEY, fetchBotMap } from '../bot-map-api'

const CUSTOM_SCREEN = '__custom__'

interface MiniAppScreenFieldProps {
  readonly value: string
  readonly onChange: (target: string) => void
  /** The id of the label naming this field. */
  readonly labelId: string
  /** What the free-text box suggests: a path, or for buttons that take one, an address too. */
  readonly placeholder: string
  /** Id for the free-text box, so a `<label htmlFor>` can point at it. */
  readonly inputId?: string
}

export function MiniAppScreenField({
  value,
  onChange,
  labelId,
  placeholder,
  inputId,
}: MiniAppScreenFieldProps) {
  const { t, i18n } = useTranslation()
  // The screens hosting a Mini App button already hold this query on the
  // map and in the constructor; «Кнопки бота» fetches it once. The list is
  // the server's catalog and does not go stale while a form is open.
  const { data: botMap } = useQuery({
    queryKey: BOT_MAP_QUERY_KEY,
    queryFn: fetchBotMap,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const screens = botMap?.miniAppScreens ?? []
  const [customChosen, setCustomChosen] = useState(false)
  const listed = screens.find((screen) => screen.route === value)
  const typing = customChosen || (value.length > 0 && listed === undefined)
  const english = i18n.language.startsWith('en')

  const pathInput = (
    <Input
      id={inputId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-labelledby={labelId}
      maxLength={2_000}
      className="font-mono text-xs"
    />
  )

  // No list — a payload cached by a tab left open across the upgrade — is the
  // old text box, not an empty picker.
  if (screens.length === 0) return pathInput

  return (
    <div className="space-y-1.5">
      <Select
        value={typing ? CUSTOM_SCREEN : (listed?.route ?? '')}
        onValueChange={(next) => {
          if (next === CUSTOM_SCREEN) {
            setCustomChosen(true)
            return
          }
          setCustomChosen(false)
          onChange(next)
        }}
      >
        <SelectTrigger className="h-8 text-xs" aria-labelledby={labelId}>
          <SelectValue placeholder={t('botConfigPage.buttons.fields.actionTarget.miniAppChoose')} />
        </SelectTrigger>
        <SelectContent>
          {screens.map((screen) => (
            <SelectItem key={screen.route} value={screen.route} className="text-xs">
              {english ? screen.nameEn : screen.nameRu}
              <span className="ml-1.5 font-mono text-muted-foreground">{screen.route}</span>
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_SCREEN} className="text-xs">
            {t('botConfigPage.buttons.fields.actionTarget.miniAppCustom')}
          </SelectItem>
        </SelectContent>
      </Select>
      {typing && pathInput}
    </div>
  )
}
