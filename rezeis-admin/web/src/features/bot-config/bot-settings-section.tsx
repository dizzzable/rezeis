/**
 * Bot settings — the panel-side half of the bot card.
 *
 * Everything here persists as a `visible: false` `BotText` row, exactly like
 * `bot.banner_apply_all`: no migration, and the rows stay out of the
 * `translations` copy map so they never reach the i18n layer.
 *
 * ── Why only two feature switches ─────────────────────────────────────────
 *
 * The payload carries six feature flags. Reiwa reads two. The other four are
 * constants on the panel side with no reader anywhere in the bot, so a switch
 * for them would be a control that visibly does nothing — the worst kind of
 * setting, because the operator flips it, sees no change, and stops trusting
 * the rest of this screen. If a reader is added later, the switch belongs here
 * at that point and not before.
 *
 * ── Why the profile fields say "leave empty to keep" ──────────────────────
 *
 * Reiwa applies them with `setMyName` / `setMyDescription` /
 * `setMyShortDescription`, and treats an empty value as "leave whatever
 * Telegram already has" rather than as "clear it". Most installs never open
 * this screen, and their profile was written in @BotFather; the alternative
 * would wipe it on the next deploy. So there is deliberately no way to CLEAR a
 * field from here, and the hint says so instead of pretending otherwise.
 */
import { useEffect, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

export const SUPPORT_USERNAME_KEY = 'bot.support_username'
export const FEATURE_REFERRALS_KEY = 'bot.feature.referrals'
export const FEATURE_MINI_APP_KEY = 'bot.feature.mini_app'
export const PROFILE_NAME_KEY = 'bot.profile.name'
export const PROFILE_DESCRIPTION_KEY = 'bot.profile.description'
export const PROFILE_SHORT_DESCRIPTION_KEY = 'bot.profile.short_description'

/** Telegram's own limits — the same numbers reiwa refuses to exceed. */
const LIMITS = {
  [PROFILE_NAME_KEY]: 64,
  [PROFILE_DESCRIPTION_KEY]: 512,
  [PROFILE_SHORT_DESCRIPTION_KEY]: 120,
} as const

export interface BotTextRow {
  readonly id: string
  readonly key: string
  readonly value: string
  readonly visible: boolean
}

export interface BotSettingsSectionProps {
  readonly rows: readonly BotTextRow[] | undefined
  readonly onSave: (input: {
    readonly key: string
    readonly value: string
    readonly row: BotTextRow | null
  }) => void
  readonly disabled: boolean
}

function findRow(rows: readonly BotTextRow[] | undefined, key: string): BotTextRow | null {
  return rows?.find((r) => r.key === key) ?? null
}

/**
 * A text field that commits on blur rather than on every keystroke.
 *
 * Each save is a PATCH that triggers the reiwa cache-bust interceptor, so
 * saving per character would push a config invalidation per character — and
 * reiwa answers each of those by talking to Telegram.
 */
function SavedTextField(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly placeholder: string
  readonly value: string
  readonly limit?: number
  readonly multiline?: boolean
  readonly disabled: boolean
  readonly onCommit: (value: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState(props.value)
  // Re-sync when the server value changes underneath (another tab, a refetch).
  // Guarded on equality so it never fights the operator mid-edit.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setDraft(props.value)
  }, [props.value])
  /* eslint-enable react-hooks/set-state-in-effect */

  const over = props.limit !== undefined && draft.trim().length > props.limit
  const commit = (): void => {
    const next = draft.trim()
    if (next === props.value.trim()) return
    props.onCommit(next)
  }

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={props.id} className="text-xs">
          {props.label}
        </Label>
        {props.limit !== undefined ? (
          <span
            className={
              over
                ? 'text-[10px] font-medium text-destructive'
                : 'text-[10px] text-muted-foreground'
            }
          >
            {draft.trim().length}/{props.limit}
          </span>
        ) : null}
      </div>
      {props.multiline === true ? (
        <Textarea
          id={props.id}
          value={draft}
          rows={3}
          placeholder={props.placeholder}
          disabled={props.disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      ) : (
        <Input
          id={props.id}
          value={draft}
          placeholder={props.placeholder}
          disabled={props.disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      )}
      <p className="text-[10px] leading-snug text-muted-foreground">{props.hint}</p>
    </div>
  )
}

function SavedSwitch(props: {
  readonly label: string
  readonly hint: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (next: boolean) => void
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 p-2.5">
      <div className="min-w-0">
        <Label className="text-xs">{props.label}</Label>
        <p className="text-[10px] leading-snug text-muted-foreground">{props.hint}</p>
      </div>
      <Switch
        checked={props.checked}
        onCheckedChange={props.onChange}
        disabled={props.disabled}
        aria-label={props.label}
      />
    </div>
  )
}

export function BotSettingsSection({
  rows,
  onSave,
  disabled,
}: BotSettingsSectionProps): JSX.Element {
  const { t } = useTranslation()

  const read = (key: string): string => (findRow(rows, key)?.value ?? '').trim()
  /**
   * Absent row → the caller's default, NOT `false`. Both flags default to on,
   * and reading a missing row as off would switch features off for every
   * install that has never opened this screen. Mirrors `readFlag` on the
   * server, which has to make the same choice for the same reason.
   */
  const readFlag = (key: string): boolean => {
    const raw = read(key).toLowerCase()
    if (raw === 'true') return true
    if (raw === 'false') return false
    return true
  }
  const save = (key: string, value: string): void =>
    onSave({ key, value, row: findRow(rows, key) })

  return (
    <section className="space-y-3 rounded-md border p-3">
      <div>
        <h4 className="text-sm font-semibold">{t('botStudio.replyKeyboard.settings.title')}</h4>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t('botStudio.replyKeyboard.settings.subtitle')}
        </p>
      </div>

      <SavedTextField
        id="bot-support-username"
        label={t('botStudio.replyKeyboard.settings.supportUsername')}
        hint={t('botStudio.replyKeyboard.settings.supportUsernameHint')}
        placeholder="@support"
        value={read(SUPPORT_USERNAME_KEY)}
        disabled={disabled}
        onCommit={(v) => save(SUPPORT_USERNAME_KEY, v)}
      />

      <SavedSwitch
        label={t('botStudio.replyKeyboard.settings.referrals')}
        hint={t('botStudio.replyKeyboard.settings.referralsHint')}
        checked={readFlag(FEATURE_REFERRALS_KEY)}
        disabled={disabled}
        onChange={(next) => save(FEATURE_REFERRALS_KEY, next ? 'true' : 'false')}
      />

      <SavedSwitch
        label={t('botStudio.replyKeyboard.settings.miniApp')}
        hint={t('botStudio.replyKeyboard.settings.miniAppHint')}
        checked={readFlag(FEATURE_MINI_APP_KEY)}
        disabled={disabled}
        onChange={(next) => save(FEATURE_MINI_APP_KEY, next ? 'true' : 'false')}
      />

      <div className="space-y-3 rounded-md border border-dashed bg-muted/20 p-2.5">
        <div>
          <h5 className="text-xs font-semibold">
            {t('botStudio.replyKeyboard.settings.profileTitle')}
          </h5>
          <p className="text-[10px] leading-snug text-muted-foreground">
            {t('botStudio.replyKeyboard.settings.profileHint')}
          </p>
        </div>

        <SavedTextField
          id="bot-profile-name"
          label={t('botStudio.replyKeyboard.settings.profileName')}
          hint={t('botStudio.replyKeyboard.settings.profileNameHint')}
          placeholder="Rezeis VPN"
          value={read(PROFILE_NAME_KEY)}
          limit={LIMITS[PROFILE_NAME_KEY]}
          disabled={disabled}
          onCommit={(v) => save(PROFILE_NAME_KEY, v)}
        />

        <SavedTextField
          id="bot-profile-short-description"
          label={t('botStudio.replyKeyboard.settings.profileShortDescription')}
          hint={t('botStudio.replyKeyboard.settings.profileShortDescriptionHint')}
          placeholder=""
          value={read(PROFILE_SHORT_DESCRIPTION_KEY)}
          limit={LIMITS[PROFILE_SHORT_DESCRIPTION_KEY]}
          multiline
          disabled={disabled}
          onCommit={(v) => save(PROFILE_SHORT_DESCRIPTION_KEY, v)}
        />

        <SavedTextField
          id="bot-profile-description"
          label={t('botStudio.replyKeyboard.settings.profileDescription')}
          hint={t('botStudio.replyKeyboard.settings.profileDescriptionHint')}
          placeholder=""
          value={read(PROFILE_DESCRIPTION_KEY)}
          limit={LIMITS[PROFILE_DESCRIPTION_KEY]}
          multiline
          disabled={disabled}
          onCommit={(v) => save(PROFILE_DESCRIPTION_KEY, v)}
        />
      </div>
    </section>
  )
}
