import { useTranslation } from 'react-i18next'
import { Moon, Sun, Monitor } from 'lucide-react'

import { motion, AnimatePresence } from '@/lib/motion'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useThemeStore, type ColorMode } from '@/lib/theme/theme-store'

const THEME_OPTIONS: ReadonlyArray<{
  readonly id: ColorMode
  readonly labelKey: string
  readonly icon: typeof Sun
}> = [
  { id: 'light', labelKey: 'adminShell.theme.light', icon: Sun },
  { id: 'dark', labelKey: 'adminShell.theme.dark', icon: Moon },
  { id: 'system', labelKey: 'adminShell.theme.system', icon: Monitor },
]

/**
 * Topbar widget: light / dark / system theme picker. Subscribes only to
 * the theme store so the rest of the topbar does not re-render on
 * theme switches.
 */
export function ThemeToggle() {
  const { t } = useTranslation()
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)

  const currentIcon =
    mode === 'dark' ? <Moon className="h-4 w-4" /> :
    mode === 'light' ? <Sun className="h-4 w-4" /> :
    <Monitor className="h-4 w-4" />

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('adminShell.theme.toggleAria')}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={mode}
              initial={{ y: -6, opacity: 0, rotate: -30 }}
              animate={{ y: 0, opacity: 1, rotate: 0 }}
              exit={{ y: 6, opacity: 0, rotate: 30 }}
              transition={{ duration: 0.18 }}
              className="inline-flex"
            >
              {currentIcon}
            </motion.span>
          </AnimatePresence>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel>{t('adminShell.theme.label')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {THEME_OPTIONS.map((opt) => (
          <DropdownMenuItem key={opt.id} onClick={() => setMode(opt.id)}>
            <opt.icon className="mr-2 h-4 w-4" />
            {t(opt.labelKey)}
            {mode === opt.id && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
