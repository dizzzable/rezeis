/**
 * «Часовой пояс» of Settings → «Платформа» (`platformBranding.timezone`).
 *
 * A searchable list of the IANA zones this browser knows
 * (`Intl.supportedValuesOf('timeZone')`), each with its offset from UTC right
 * now, and «UTC (не задан)» for none. Under it, what the time is in the zone
 * chosen — the quickest check that it is the right one.
 *
 * The browser's list only proposes. What may be stored is the server's call
 * (`platform-timezone.util.ts`): a zone both `Intl` and PostgreSQL know, in its
 * IANA spelling; anything else is a 400 whose code the card turns into one of
 * `settingsPage.platform.timezone.errors`. A browser without the list still
 * lets the operator type a name and send it for that check.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { InfoTip } from '@/components/ui/info-tip'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

import { listTimeZones, zoneNowLabel, zoneOffsetLabel } from './platform-timezone'

export interface PlatformTimezoneFieldProps {
  /** The zone chosen; `''` for none — UTC everywhere. */
  readonly value: string
  readonly onChange: (next: string) => void
  readonly disabled?: boolean
  /** The moment the offsets and the clock line are shown for. */
  readonly now?: Date
  /** The zones to offer; the browser's own by default. */
  readonly zones?: readonly string[] | null
}

export function PlatformTimezoneField({ value, onChange, disabled = false, now, zones }: PlatformTimezoneFieldProps) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const at = useMemo(() => now ?? new Date(), [now])
  const listed = useMemo(() => (zones === undefined ? listTimeZones() : zones), [zones])
  const options = useMemo(() => {
    const names = [...(listed ?? [])]
    // A saved zone the list does not carry (an alias, an older spelling) is still shown as chosen.
    if (value !== '' && !names.includes(value)) names.unshift(value)
    return names.map((zone) => ({ zone, offset: zoneOffsetLabel(zone, at) }))
  }, [listed, value, at])

  const typed = search.trim()
  const offerTyped = typed !== '' && !options.some((option) => option.zone.toLowerCase() === typed.toLowerCase())
  const clockZone = value === '' ? 'UTC' : value
  const clock = zoneNowLabel(clockZone, at, i18n.language)
  const offset = value === '' ? 'UTC' : zoneOffsetLabel(value, at)
  const choose = (next: string) => {
    onChange(next)
    setSearch('')
    setOpen(false)
  }

  return (
    <div className="space-y-2" data-platform-timezone>
      <div className="flex items-center gap-1.5">
        <Label htmlFor="platform-timezone">{t('settingsPage.platform.timezone.label')}</Label>
        <InfoTip label={t('settingsPage.platform.timezone.infoLabel')}>{t('settingsPage.platform.timezone.info')}</InfoTip>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id="platform-timezone"
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={t('settingsPage.platform.timezone.label')}
            className="w-full justify-between font-normal"
            disabled={disabled}
          >
            <span className={cn('truncate', value === '' && 'text-muted-foreground')}>
              {value === '' ? t('settingsPage.platform.timezone.empty') : offset === null ? value : `${value} · ${offset}`}
            </span>
            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command>
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder={t('settingsPage.platform.timezone.searchPlaceholder')}
              aria-label={t('settingsPage.platform.timezone.searchPlaceholder')}
            />
            <CommandList>
              <CommandEmpty>{t('settingsPage.platform.timezone.notFound')}</CommandEmpty>
              <CommandGroup>
                <CommandItem value={`UTC ${t('settingsPage.platform.timezone.empty')}`} onSelect={() => choose('')}>
                  <Check className={cn('mr-2 h-4 w-4', value === '' ? 'opacity-100' : 'opacity-0')} />
                  {t('settingsPage.platform.timezone.empty')}
                </CommandItem>
                {options.map(({ zone, offset: zoneOffset }) => (
                  <CommandItem key={zone} value={`${zone} ${zoneOffset ?? ''}`} onSelect={() => choose(zone)}>
                    <Check className={cn('mr-2 h-4 w-4', value === zone ? 'opacity-100' : 'opacity-0')} />
                    <span className="flex-1 truncate">{zone}</span>
                    {zoneOffset === null ? null : <span className="ml-2 text-xs text-muted-foreground">{zoneOffset}</span>}
                  </CommandItem>
                ))}
                {offerTyped ? (
                  <CommandItem value={typed} onSelect={() => choose(typed)}>
                    {t('settingsPage.platform.timezone.useTyped', { zone: typed })}
                  </CommandItem>
                ) : null}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {clock === null ? (
        <p className="text-xs text-destructive" data-platform-timezone-unknown>
          {t('settingsPage.platform.timezone.unknownStored', { zone: value })}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" data-platform-timezone-clock>
          {value === ''
            ? t('settingsPage.platform.timezone.nowUtc', { time: clock })
            : t('settingsPage.platform.timezone.now', { time: clock, offset: offset ?? '' })}
        </p>
      )}
    </div>
  )
}
