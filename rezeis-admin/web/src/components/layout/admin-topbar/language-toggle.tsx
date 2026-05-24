import { useTranslation } from 'react-i18next'
import { Languages } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLocaleStore } from '@/stores/locale-store'

const SUPPORTED_LOCALES: ReadonlyArray<{ readonly id: string; readonly key: string }> = [
  { id: 'ru', key: 'adminShell.language.ru' },
  { id: 'en', key: 'adminShell.language.en' },
]

/**
 * Topbar widget: RU / EN language picker. Updates the locale store
 * (which persists to safe-storage) and asks i18next to switch
 * languages. The actual language bundle is loaded lazily — see
 * `i18n/i18n.ts`.
 */
export function LanguageToggle() {
  const { t, i18n } = useTranslation()
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)

  const handlePick = (id: string): void => {
    setLocale(id)
    void i18n.changeLanguage(id)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('adminShell.language.label')}>
          <Languages className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel>{t('adminShell.language.label')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {SUPPORTED_LOCALES.map((opt) => (
          <DropdownMenuItem key={opt.id} onClick={() => handlePick(opt.id)}>
            <span className="font-mono text-xs uppercase mr-2">{opt.id}</span>
            {t(opt.key)}
            {locale === opt.id && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
