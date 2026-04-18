import type { ComponentType, JSX } from 'react'
import { useMemo, useState } from 'react'
import { LayoutDashboard, LogOut, Menu, Megaphone, ScanSearch, Settings2, Shield, TicketPercent, UserRoundSearch, Users, Waypoints, Waves, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { z } from 'zod'
import { queryClient } from '@/lib/query-client'
import { authUserSchema } from '@/features/auth/auth-user'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { useLocaleStore } from '@/stores/locale-store'

type AuthUser = z.infer<typeof authUserSchema>

interface NavigationChildItem {
  readonly to: string
  readonly label: string
}

interface NavigationItem {
  readonly key: string
  readonly to: string
  readonly label: string
  readonly icon: ComponentType<{ className?: string }>
  readonly children?: readonly NavigationChildItem[]
}

function readUserLabel(user: AuthUser | null, fallbackLabel: string): string {
  if (!user) {
    return fallbackLabel
  }
  const name: unknown = user.login ?? user.name ?? user.email
  return typeof name === 'string' && name.trim() ? name : fallbackLabel
}

function readSectionLabel(pathname: string, items: readonly NavigationItem[]): string {
  const matchedItem: NavigationItem | undefined = items.find((item) => pathname.startsWith(item.to))
  return matchedItem?.label ?? items[0].label
}

interface SidebarContentProps {
  readonly items: readonly NavigationItem[]
  readonly navigationLabel: string
  readonly settingsGroupLabel: string
  readonly generalGroupLabel: string
  readonly handleNavigate: () => void
}

function SidebarContent({ items, navigationLabel, settingsGroupLabel, generalGroupLabel, handleNavigate }: SidebarContentProps): JSX.Element {
  const generalItems: NavigationItem[] = items.filter((item) => item.key !== 'settings')
  const settingsItem: NavigationItem | undefined = items.find((item) => item.key === 'settings')
  return (
    <div className="flex h-full flex-col">
      <p className="px-2 text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">{navigationLabel}</p>
      <div className="mt-4 space-y-5 overflow-y-auto pr-1">
        <div className="space-y-2">
          <p className="px-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{generalGroupLabel}</p>
          <nav className="flex flex-col gap-1">
            {generalItems.map((item: NavigationItem) => (
              <SidebarNavItem key={item.to} item={item} onNavigate={handleNavigate} />
            ))}
          </nav>
        </div>
        {settingsItem ? (
          <div className="space-y-2">
            <p className="px-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{settingsGroupLabel}</p>
            <nav className="flex flex-col gap-1">
              <SidebarNavItem item={settingsItem} onNavigate={handleNavigate} />
            </nav>
          </div>
        ) : null}
      </div>
    </div>
  )
}

interface SidebarNavItemProps {
  readonly item: NavigationItem
  readonly onNavigate: () => void
}

function SidebarNavItem({ item, onNavigate }: SidebarNavItemProps): JSX.Element {
  return (
    <div className="space-y-1">
      <NavLink
        to={item.to}
        className={({ isActive }): string =>
          cn(
            'flex items-center gap-3 rounded-2xl px-3 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
            isActive && 'bg-accent text-accent-foreground',
          )
        }
        onClick={onNavigate}
      >
        <item.icon className="size-4" />
        <span>{item.label}</span>
      </NavLink>
      {item.children ? (
        <div className="ml-4 flex flex-col gap-1 border-l border-border/70 pl-4">
          {item.children.map((child: NavigationChildItem) => (
            <NavLink
              key={child.to}
              to={child.to}
              className={({ isActive }): string =>
                cn(
                  'rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                  isActive && 'bg-accent text-accent-foreground',
                )
              }
              onClick={onNavigate}
            >
              {child.label}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function AdminShell(): JSX.Element {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const [isMobileOpen, setIsMobileOpen] = useState<boolean>(false)
  const clearSession = useAuthStore((state) => state.clearSession)
  const user: AuthUser | null = useAuthStore((state) => state.user)
  const locale: string = useLocaleStore((state) => state.locale)
  const setLocale = useLocaleStore((state) => state.setLocale)
  const navigationItems: readonly NavigationItem[] = useMemo(
    () => [
      { key: 'dashboard', to: '/dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
      {
        key: 'users',
        to: '/users/search',
        label: t('nav.users'),
        icon: Users,
        children: [
          { to: '/users/search', label: t('nav.userSearch') },
          { to: '/users/recent-registered', label: t('nav.usersRecentRegistered') },
          { to: '/users/recent-active', label: t('nav.usersRecentActive') },
          { to: '/users/blacklist', label: t('nav.usersBlacklist') },
          { to: '/users/invited', label: t('nav.usersInvited') },
        ],
      },
      { key: 'broadcast', to: '/broadcast', label: t('nav.broadcast'), icon: Megaphone },
      { key: 'promocodes', to: '/promocodes', label: t('nav.promocodes'), icon: TicketPercent },
      { key: 'access-mode', to: '/access-mode', label: t('nav.accessMode'), icon: Workflow },
      { key: 'remnawave', to: '/remnawave', label: t('nav.remnawave'), icon: Waves },
      { key: 'ruid', to: '/ruid', label: t('nav.ruid'), icon: ScanSearch },
      { key: 'imports', to: '/imports', label: t('nav.imports'), icon: Waypoints },
      {
        key: 'settings',
        to: '/settings/panel',
        label: t('nav.settings'),
        icon: Settings2,
        children: [
          { to: '/settings/panel', label: t('nav.settingsPanel') },
          { to: '/settings/platform', label: t('nav.settingsPlatform') },
          { to: '/settings/api-tokens', label: t('nav.settingsApiTokens') },
        ],
      },
    ],
    [t],
  )
  const sectionTitle: string = readSectionLabel(location.pathname, navigationItems)
  const userLabel: string = readUserLabel(user, t('common.authenticatedAdmin'))
  function handleLogout(): void {
    clearSession()
    queryClient.removeQueries({ queryKey: ['auth'] })
    navigate('/login', { replace: true })
  }
  function handleLocaleChange(nextValue: string): void {
    const nextLocale: string = nextValue === 'ru' ? 'ru' : 'en'
    setLocale(nextLocale)
  }
  function handleCloseMobileNavigation(): void {
    setIsMobileOpen(false)
  }
  return (
    <div className="min-h-screen px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-7xl flex-col gap-4 lg:min-h-[calc(100vh-3rem)]">
        <header className="flex flex-col gap-4 rounded-[28px] border border-border/80 bg-card/95 px-5 py-4 shadow-sm backdrop-blur sm:px-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex size-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
                <Shield className="size-5" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">{t('common.appName')}</p>
                <h1 className="mt-1 text-xl font-semibold tracking-tight">{sectionTitle}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{userLabel}</p>
              </div>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative sm:min-w-[180px]">
                <UserRoundSearch className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
                <Select value={locale} onValueChange={handleLocaleChange}>
                  <SelectTrigger aria-label={t('common.language')} className="w-full pl-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="en">{t('common.localeNames.en')}</SelectItem>
                    <SelectItem value="ru">{t('common.localeNames.ru')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={handleLogout}>
                <LogOut className="size-4" />
                {t('common.logout')}
              </Button>
              <Sheet open={isMobileOpen} onOpenChange={setIsMobileOpen}>
                <SheetTrigger asChild>
                  <Button type="button" variant="outline" className="lg:hidden">
                    <Menu className="size-4" />
                    {t('common.navigation')}
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-full max-w-[320px] gap-0 p-0">
                  <SheetHeader className="border-b px-5 py-4 text-left">
                    <SheetTitle className="text-base font-semibold">{t('shell.mobileNavigationTitle')}</SheetTitle>
                    <SheetDescription>{t('shell.subtitle')}</SheetDescription>
                  </SheetHeader>
                  <div className="flex flex-1 flex-col px-5 py-4">
                    <Separator className="mb-4" />
                    <SidebarContent
                      items={navigationItems}
                      navigationLabel={t('common.navigation')}
                      generalGroupLabel={t('shell.groups.general')}
                      settingsGroupLabel={t('shell.groups.settings')}
                      handleNavigate={handleCloseMobileNavigation}
                    />
                  </div>
                </SheetContent>
              </Sheet>
            </div>
          </div>
        </header>
        <div className="grid flex-1 gap-4 lg:grid-cols-[290px_minmax(0,1fr)]">
          <aside className="hidden rounded-[28px] border border-border/80 bg-card/90 p-4 shadow-sm backdrop-blur lg:block">
            <SidebarContent
              items={navigationItems}
              navigationLabel={t('common.navigation')}
              generalGroupLabel={t('shell.groups.general')}
              settingsGroupLabel={t('shell.groups.settings')}
              handleNavigate={handleCloseMobileNavigation}
            />
          </aside>
          <main className="min-w-0">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  )
}
