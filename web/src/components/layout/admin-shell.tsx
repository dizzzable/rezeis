import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Package,
  CreditCard,
  DollarSign,
  Tag,
  Zap,
  Share2,
  Handshake,
  Megaphone,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  Bot,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Languages,
  Menu,
  Palette,
  Moon,
  Sun,
  Monitor,
  BarChart3,
  Bell,
  Search,
  Upload,
  ClipboardList,
  Puzzle,
  HelpCircle,
} from 'lucide-react';
import { QuickSearchOverlay } from '@/components/quick-search/quick-search-overlay';
import { OfflineIndicator } from '@/components/layout/offline-indicator';
import { UpdateBanner } from '@/features/update-checker/update-banner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/features/auth/auth-provider';
import { motion, AnimatePresence } from '@/lib/motion';
import { useRealtimeUpdates } from '@/lib/realtime/use-realtime-updates';
import { useThemeStore } from '@/lib/theme/theme-store';
import type { ColorMode } from '@/lib/theme/theme-store';
import { useLocaleStore } from '@/stores/locale-store';

interface NavItem {
  /** i18n key under `adminNav.items.*` */
  key: string;
  path: string;
  icon: React.ElementType;
}

interface NavGroup {
  /** i18n key under `adminNav.groups.*` */
  key: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    key: 'operations',
    items: [
      { key: 'dashboard', path: '/', icon: LayoutDashboard },
      { key: 'users', path: '/users', icon: Users },
      { key: 'subscriptions', path: '/subscriptions', icon: CreditCard },
      { key: 'payments', path: '/payments', icon: DollarSign },
      { key: 'supportTickets', path: '/support-tickets', icon: Bell },
      { key: 'fraudSignals', path: '/fraud', icon: ShieldAlert },
      { key: 'automations', path: '/automations', icon: Zap },
      { key: 'analytics', path: '/analytics', icon: BarChart3 },
    ],
  },
  {
    key: 'catalog',
    items: [
      { key: 'plans', path: '/plans', icon: Package },
      { key: 'addOns', path: '/add-ons', icon: Puzzle },
      { key: 'promocodes', path: '/promocodes', icon: Tag },
      { key: 'broadcast', path: '/broadcast', icon: Megaphone },
    ],
  },
  {
    key: 'growth',
    items: [
      // Referral Settings + Partner Settings live as tabs inside the
      // referrals/partners pages — no separate sidebar entries.
      // Withdrawals are also embedded as a tab inside /partners.
      { key: 'referrals', path: '/referrals', icon: Share2 },
      { key: 'partners', path: '/partners', icon: Handshake },
    ],
  },
  {
    key: 'configuration',
    items: [
      { key: 'platform', path: '/settings', icon: Settings },
      { key: 'gateways', path: '/payments/gateways', icon: CreditCard },
      { key: 'panelSettings', path: '/settings/panel', icon: Settings },
      { key: 'botConfig', path: '/bot-config', icon: Bot },
      { key: 'remnawave', path: '/remnawave', icon: Server },
      { key: 'notifications', path: '/notifications', icon: Bell },
      { key: 'faq', path: '/faq', icon: HelpCircle },
    ],
  },
  {
    key: 'system',
    items: [
      { key: 'admins', path: '/admins', icon: Shield },
      // Roles, IP allowlist, Webhooks, Blocked IPs are embedded as tabs in /admins.
      { key: 'imports', path: '/imports', icon: Upload },
      { key: 'audit', path: '/audit', icon: ClipboardList },
      // Config portability → /settings/panel#config
      // System logs → /audit (tab)
    ],
  },
];

function NavItems({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  // ── Most-specific-match resolution ──────────────────────────────────
  // The nav contains both `/payments` (Payments) and `/payments/gateways`
  // (Gateways). Without help, NavLink would highlight *both* when the
  // pathname is `/payments/gateways` because the default matching is
  // prefix-based. We compute the longest matching item path here so only
  // that single item lights up.
  const allPaths = navGroups.flatMap((g) => g.items.map((i) => i.path));
  const bestMatch = allPaths
    .filter((p) =>
      p === '/'
        ? pathname === '/'
        : pathname === p || pathname.startsWith(p + '/'),
    )
    .reduce((best, candidate) =>
      candidate.length > best.length ? candidate : best, '');

  return (
    <nav className="flex flex-col gap-1 px-2">
      {navGroups.map((group, groupIndex) => (
        <div key={group.key}>
          {groupIndex > 0 && <div className="my-1 h-px bg-sidebar-border/50 mx-1" />}
          {!collapsed && (
            <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
              {t(`adminNav.groups.${group.key}`)}
            </p>
          )}
          {group.items.map((item, index) => {
            const globalIndex = navGroups
              .slice(0, groupIndex)
              .reduce((acc, g) => acc + g.items.length, 0) + index;
            const isCurrent = item.path === bestMatch;
            const label = t(`adminNav.items.${item.key}`);
            return (
              <Tooltip key={item.path}>
                <TooltipTrigger asChild>
                  <NavLink
                    to={item.path}
                    end
                    onClick={onNavigate}
                    className={cn(
                      'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      isCurrent
                        ? 'text-sidebar-primary-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                      collapsed && 'justify-center px-2',
                    )}
                  >
                    <>
                      {isCurrent && (
                        <motion.span
                          layoutId="sidebar-active-indicator"
                          className="absolute inset-0 rounded-md bg-sidebar-primary"
                          transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                        />
                      )}
                      <motion.span
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.22, delay: globalIndex * 0.015, ease: [0.16, 1, 0.3, 1] }}
                        className="relative z-10 flex items-center gap-3"
                      >
                        <item.icon className="h-4 w-4 shrink-0" />
                        {!collapsed && <span>{label}</span>}
                      </motion.span>
                    </>
                  </NavLink>
                </TooltipTrigger>
                {collapsed && <TooltipContent side="right">{label}</TooltipContent>}
              </Tooltip>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export default function AdminShell() {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { logout, admin } = useAuth();
  const navigate = useNavigate();

  // Subscribe to admin realtime updates as soon as the shell is rendered
  // (i.e. the admin is authenticated). Toasts are limited to WARNING/ERROR
  // events inside the hook itself.
  useRealtimeUpdates();

  // Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  function handleLogout() {
    logout();
    navigate('/sign-in');
  }

  const adminInitials = admin?.login ? admin.login.slice(0, 2).toUpperCase() : 'AD';

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen overflow-hidden">
        {/* Quick Search Overlay */}
        <QuickSearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
        {/* Mobile Sheet sidebar */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-64 bg-sidebar p-0 text-sidebar-foreground">
            <SheetHeader className="flex h-14 flex-row items-center px-4">
              <SheetTitle className="text-lg font-bold text-sidebar-foreground">
                Rezeis Admin
              </SheetTitle>
            </SheetHeader>
            <ScrollArea className="flex-1 py-2">
              <NavItems onNavigate={() => setMobileOpen(false)} />
            </ScrollArea>
          </SheetContent>
        </Sheet>

        {/* Desktop sidebar */}
        <aside
          className={cn(
            'relative hidden md:flex flex-col bg-sidebar text-sidebar-foreground transition-all duration-300',
            collapsed ? 'w-16' : 'w-64',
          )}
        >
          {/* Logo */}
          <div className="flex h-14 items-center px-4">
            {!collapsed && (
              <span className="text-lg font-bold text-sidebar-foreground">Rezeis Admin</span>
            )}
            {collapsed && <Shield className="h-6 w-6 text-sidebar-foreground" />}
          </div>

          {/* Nav */}
          <ScrollArea className="flex-1 py-2">
            <NavItems collapsed={collapsed} />
          </ScrollArea>

          {/* Collapse toggle */}
          <div className="p-2">
            <Button
              variant="ghost"
              size="icon"
              className="w-full text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <ChevronLeft className="h-4 w-4" />
              )}
            </Button>
          </div>
        </aside>

        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Top bar */}
          <header className="flex h-14 items-center justify-between bg-background px-4 md:px-6">
            <div className="flex items-center gap-2">
              {/* Mobile hamburger */}
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                onClick={() => setMobileOpen(true)}
              >
                <Menu className="h-5 w-5" />
                <span className="sr-only">{t('adminShell.openMenu')}</span>
              </Button>
              <h2 className="hidden text-sm font-medium text-muted-foreground md:block">
                {t('adminShell.headerSubtitle')}
              </h2>
            </div>

            <div className="flex items-center gap-2">
              {/* Quick search button */}
              <Button
                variant="outline"
                size="sm"
                className="hidden md:flex items-center gap-2 text-muted-foreground w-48 justify-start"
                onClick={() => setSearchOpen(true)}
              >
                <Search className="h-3.5 w-3.5" />
                <span className="text-xs">{t('adminShell.search')}</span>
                <kbd className="ml-auto font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded">⌘K</kbd>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                onClick={() => setSearchOpen(true)}
                aria-label={t('adminShell.search')}
              >
                <Search className="h-4 w-4" />
              </Button>
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

          {/* Page content */}
          <main className="flex-1 overflow-auto bg-muted/20">
            <OfflineIndicator />
            <UpdateBanner />
            <div className="p-4 md:p-6">
              <AnimatedOutlet />
            </div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

// ── Theme toggle (light/dark/system picker in top bar) ─────────────────────
function ThemeToggle() {
  const { t } = useTranslation();
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);

  const currentIcon =
    mode === 'dark' ? <Moon className="h-4 w-4" /> : mode === 'light' ? <Sun className="h-4 w-4" /> : <Monitor className="h-4 w-4" />;

  const options: Array<{ id: ColorMode; labelKey: string; icon: React.ElementType }> = [
    { id: 'light', labelKey: 'adminShell.theme.light', icon: Sun },
    { id: 'dark', labelKey: 'adminShell.theme.dark', icon: Moon },
    { id: 'system', labelKey: 'adminShell.theme.system', icon: Monitor },
  ];

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
        {options.map((opt) => (
          <DropdownMenuItem key={opt.id} onClick={() => setMode(opt.id)}>
            <opt.icon className="mr-2 h-4 w-4" />
            {t(opt.labelKey)}
            {mode === opt.id && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Language toggle (RU / EN) ──────────────────────────────────────────────
const SUPPORTED_LOCALES: ReadonlyArray<{ id: string; key: string }> = [
  { id: 'ru', key: 'adminShell.language.ru' },
  { id: 'en', key: 'adminShell.language.en' },
];

function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);

  const handlePick = (id: string): void => {
    setLocale(id);
    void i18n.changeLanguage(id);
  };

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
  );
}

// ── Animated outlet wrapper (page transitions) ─────────────────────────────
function AnimatedOutlet() {
  // Key the animation on the pathname so every route change triggers a new fade
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
    >
      <Outlet />
    </motion.div>
  );
}
