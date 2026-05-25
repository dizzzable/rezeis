import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { LogOut, Menu, Palette, Search } from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/features/auth/auth-provider'
import { cn } from '@/lib/utils'
import { useGlassStore } from '@/lib/theme/glass-store'

import { TelegramIcon } from './brand-icons'
import { LanguageToggle } from './language-toggle'
import { SupportDropdown } from './support-dropdown'
import { ThemeToggle } from './theme-toggle'
import { UpdateIndicator } from './update-indicator'

interface AdminTopbarProps {
  readonly onOpenMobileSidebar: () => void
  readonly onOpenSearch: () => void
}

/**
 * Top bar — search, version indicator, brand link, theme/language pickers,
 * and the admin avatar dropdown. Renders inside the main column of
 * `<AdminShell>` and never re-renders on route changes (no router state).
 */
export function AdminTopbar({ onOpenMobileSidebar, onOpenSearch }: AdminTopbarProps) {
  const { t } = useTranslation()
  const { logout, admin } = useAuth()
  const navigate = useNavigate()

  const glassEnabled = useGlassStore((s) => s.glassEnabled)
  const headerGlassEnabled = useGlassStore((s) => s.header.enabled)
  const headerGlassActive = glassEnabled && headerGlassEnabled

  const adminInitials = admin?.login ? admin.login.slice(0, 2).toUpperCase() : 'AD'

  function handleLogout(): void {
    logout()
    navigate('/sign-in')
  }

  return (
    <header
      className={cn(
        'flex h-14 items-center justify-between px-4 md:px-6',
        !glassEnabled
          ? 'bg-background border-b border-border'
          : headerGlassActive
            ? 'bg-background/50 border-b border-border/30'
            : 'bg-transparent',
      )}
    >
      <div className="flex items-center gap-2">
        {/* Mobile hamburger */}
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onOpenMobileSidebar}
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">{t('adminShell.openMenu')}</span>
        </Button>
      </div>

      <div className="flex items-center gap-2">
        {/* Quick search button */}
        <Button
          variant="outline"
          size="sm"
          className="hidden md:flex items-center gap-2 text-muted-foreground w-48 justify-start"
          onClick={onOpenSearch}
        >
          <Search className="h-3.5 w-3.5" />
          <span className="text-xs">{t('adminShell.search')}</span>
          <kbd className="ml-auto font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded">⌘K</kbd>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onOpenSearch}
          aria-label={t('adminShell.search')}
        >
          <Search className="h-4 w-4" />
        </Button>

        <UpdateIndicator />

        {/* Telegram link */}
        <Button variant="ghost" size="icon" asChild aria-label={t('adminShell.telegramAria')}>
          <a href="https://t.me/rezies_reiwa" target="_blank" rel="noreferrer">
            <TelegramIcon className="h-4 w-4 text-[#2AABEE]" />
          </a>
        </Button>

        <SupportDropdown />
        <LanguageToggle />
        <ThemeToggle />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="relative h-8 w-8 rounded-full">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                  {adminInitials}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-48" align="end">
            <DropdownMenuItem disabled>
              <span className="text-sm font-medium">{admin?.login ?? t('adminShell.administrator')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/settings/panel')}>
              <Palette className="mr-2 h-4 w-4" />
              {t('panelSettings.title')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleLogout}>
              <LogOut className="mr-2 h-4 w-4" />
              {t('adminShell.signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
