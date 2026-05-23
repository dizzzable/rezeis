import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
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
  GripVertical,
  Pencil,
  RotateCcw,
  Heart,
  Wallet,
  ExternalLink,
} from 'lucide-react';
import {
  DndContext,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
import { getUpdateStatus } from '@/features/update-checker/update-checker-api';
import { useThemeStore } from '@/lib/theme/theme-store';
import type { ColorMode } from '@/lib/theme/theme-store';
import { useLocaleStore } from '@/stores/locale-store';
import { useSidebarStore, type SidebarGroupOrder } from '@/stores/sidebar-store';
import { useGlassStore } from '@/lib/theme/glass-store';

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
      { key: 'referrals', path: '/referrals', icon: Share2 },
      { key: 'partners', path: '/partners', icon: Handshake },
    ],
  },
  {
    key: 'configuration',
    items: [
      { key: 'platform', path: '/settings', icon: Settings },
      { key: 'gateways', path: '/payments/gateways', icon: CreditCard },
      { key: 'botConfig', path: '/bot-config', icon: Bot },
      { key: 'remnawave', path: '/remnawave', icon: Server },
      { key: 'notifications', path: '/notifications', icon: Bell },
      { key: 'faq', path: '/faq', icon: HelpCircle },
    ],
  },
  {
    key: 'system',
    items: [
      { key: 'panelSettings', path: '/settings/panel', icon: Settings },
      { key: 'admins', path: '/admins', icon: Shield },
      { key: 'imports', path: '/imports', icon: Upload },
      { key: 'audit', path: '/audit', icon: ClipboardList },
    ],
  },
];

/** Lookup map: item key → NavItem (for resolving custom orders) */
const navItemMap = new Map<string, NavItem>(
  navGroups.flatMap((g) => g.items.map((item) => [item.key, item])),
);

/** Build resolved nav groups respecting user's custom order */
function resolveNavOrder(
  customGroups: SidebarGroupOrder[] | null,
  customGroupOrder: string[] | null,
): NavGroup[] {
  // If no custom order, return defaults
  if (!customGroups && !customGroupOrder) return navGroups;

  const defaultGroupMap = new Map(navGroups.map((g) => [g.key, g]));

  // Determine group ordering
  const groupKeys = customGroupOrder ?? navGroups.map((g) => g.key);

  return groupKeys
    .map((gKey) => {
      const customGroup = customGroups?.find((cg) => cg.groupKey === gKey);
      const defaultGroup = defaultGroupMap.get(gKey);
      if (!defaultGroup) return null;

      if (!customGroup) return defaultGroup;

      // Resolve items from custom key order, filtering out any removed items
      const items = customGroup.itemKeys
        .map((key) => navItemMap.get(key))
        .filter((item): item is NavItem => item != null);

      return { key: gKey, items };
    })
    .filter((g): g is NavGroup => g != null);
}

// ── Empty group drop zone ──────────────────────────────────────────────────
function EmptyGroupDropZone({ groupKey }: { groupKey: string }) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: `__group__${groupKey}` });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'mx-1 rounded-md border border-dashed px-3 py-3 text-center text-xs italic transition-colors',
        isOver
          ? 'border-sidebar-primary/60 bg-sidebar-primary/10 text-sidebar-foreground/60'
          : 'border-sidebar-border/40 text-sidebar-foreground/30',
      )}
    >
      {t('adminNav.emptyGroup')}
    </div>
  );
}

// ── Sortable nav item ──────────────────────────────────────────────────────
function SortableNavItem({
  item,
  isCurrent,
  collapsed,
  editMode,
  onNavigate,
  globalIndex,
}: {
  item: NavItem;
  isCurrent: boolean;
  collapsed: boolean;
  editMode: boolean;
  onNavigate?: () => void;
  globalIndex: number;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.key, disabled: !editMode });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  const label = t(`adminNav.items.${item.key}`);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div ref={setNodeRef} style={style} className="relative">
          <NavLink
            to={item.path}
            end
            onClick={editMode ? (e) => e.preventDefault() : onNavigate}
            className={cn(
              'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isCurrent
                ? 'text-sidebar-primary-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              collapsed && 'justify-center px-2',
              editMode && 'cursor-grab active:cursor-grabbing',
              isDragging && 'bg-sidebar-accent rounded-md shadow-lg',
            )}
            {...(editMode ? { ...attributes, ...listeners } : {})}
          >
            <>
              {isCurrent && !editMode && (
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
                className="relative z-10 flex items-center gap-3 w-full"
              >
                {editMode && !collapsed && (
                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40" />
                )}
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{label}</span>}
              </motion.span>
            </>
          </NavLink>
        </div>
      </TooltipTrigger>
      {collapsed && <TooltipContent side="right">{label}</TooltipContent>}
    </Tooltip>
  );
}

function NavItems({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const {
    groupsOrder,
    groupKeyOrder,
    editMode,
    isDirty,
    draftGroupsOrder,
    customGroupLabels,
    setGroupsOrder,
    setDraftGroupsOrder,
    startEditing,
    cancelEditing,
    saveEditing,
    addCustomGroup,
    removeCustomGroup,
    resetOrder,
  } = useSidebarStore();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState('');

  // Use draft in edit mode, persisted otherwise
  const effectiveGroups = editMode ? draftGroupsOrder : groupsOrder;

  // Resolve the effective nav structure
  const resolvedGroups = useMemo(
    () => resolveNavOrder(effectiveGroups, groupKeyOrder),
    [effectiveGroups, groupKeyOrder],
  );

  // Initialize store with defaults if not yet set
  useEffect(() => {
    if (!groupsOrder) {
      setGroupsOrder(
        navGroups.map((g) => ({ groupKey: g.key, itemKeys: g.items.map((i) => i.key) })),
      );
    }
  }, [groupsOrder, setGroupsOrder]);

  // ── Most-specific-match resolution ──────────────────────────────────
  const allPaths = resolvedGroups.flatMap((g) => g.items.map((i) => i.path));
  const bestMatch = allPaths
    .filter((p) =>
      p === '/'
        ? pathname === '/'
        : pathname === p || pathname.startsWith(p + '/'),
    )
    .reduce((best, candidate) =>
      candidate.length > best.length ? candidate : best, '');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // All item keys in a flat list for the single DndContext
  const allItemKeys = useMemo(
    () => resolvedGroups.flatMap((g) => g.items.map((i) => i.key)),
    [resolvedGroups],
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const currentGroups = draftGroupsOrder ?? navGroups.map((g) => ({
      groupKey: g.key,
      itemKeys: g.items.map((i) => i.key),
    }));

    const activeKey = active.id as string;
    const overId = over.id as string;

    // Handle drop on empty group zone
    if (overId.startsWith('__group__')) {
      const targetGroupKey = overId.replace('__group__', '');
      const srcGroup = currentGroups.find((g) => g.itemKeys.includes(activeKey));
      if (!srcGroup) return;

      const newGroups = currentGroups.map((g) => {
        if (g.groupKey === srcGroup.groupKey) {
          return { ...g, itemKeys: g.itemKeys.filter((k) => k !== activeKey) };
        }
        if (g.groupKey === targetGroupKey) {
          return { ...g, itemKeys: [...g.itemKeys, activeKey] };
        }
        return g;
      });
      setDraftGroupsOrder(newGroups);
      return;
    }

    // Find source and destination groups
    const srcGroup = currentGroups.find((g) => g.itemKeys.includes(activeKey));
    const dstGroup = currentGroups.find((g) => g.itemKeys.includes(overId));
    if (!srcGroup || !dstGroup) return;

    if (srcGroup.groupKey === dstGroup.groupKey) {
      // Same group — reorder
      const oldIndex = srcGroup.itemKeys.indexOf(activeKey);
      const newIndex = srcGroup.itemKeys.indexOf(overId);
      const newGroups = currentGroups.map((g) => {
        if (g.groupKey !== srcGroup.groupKey) return g;
        return { ...g, itemKeys: arrayMove(g.itemKeys, oldIndex, newIndex) };
      });
      setDraftGroupsOrder(newGroups);
    } else {
      // Cross-group move
      const newGroups = currentGroups.map((g) => {
        if (g.groupKey === srcGroup.groupKey) {
          return { ...g, itemKeys: g.itemKeys.filter((k) => k !== activeKey) };
        }
        if (g.groupKey === dstGroup.groupKey) {
          const overIndex = g.itemKeys.indexOf(overId);
          const newItems = [...g.itemKeys];
          newItems.splice(overIndex, 0, activeKey);
          return { ...g, itemKeys: newItems };
        }
        return g;
      });
      setDraftGroupsOrder(newGroups);
    }
  }

  /** Resolve group label — built-in uses i18n, custom uses customGroupLabels */
  function getGroupLabel(groupKey: string): string {
    if (customGroupLabels[groupKey]) return customGroupLabels[groupKey];
    return t(`adminNav.groups.${groupKey}`);
  }

  function handleAddGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    addCustomGroup(name);
    setNewGroupName('');
  }

  return (
    <nav className="flex flex-col gap-1 px-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={allItemKeys} strategy={verticalListSortingStrategy}>
          {resolvedGroups.map((group, groupIndex) => {
            // Hide empty groups when NOT in edit mode
            if (!editMode && group.items.length === 0) return null;

            return (
            <div key={group.key}>
              {groupIndex > 0 && <div className="my-1 h-px bg-sidebar-border/50 mx-1" />}
              {!collapsed && (
                <div className="flex items-center justify-between px-3 py-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
                    {getGroupLabel(group.key)}
                  </p>
                  {groupIndex === 0 && !editMode && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 text-sidebar-foreground/40 hover:text-sidebar-foreground"
                      onClick={startEditing}
                      aria-label={t('adminNav.editOrder')}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  )}
                  {editMode && customGroupLabels[group.key] && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 text-destructive/60 hover:text-destructive"
                      onClick={() => removeCustomGroup(group.key)}
                      aria-label={t('adminNav.removeGroup')}
                    >
                      <RotateCcw className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              )}
              {group.items.map((item, index) => {
                const globalIndex = resolvedGroups
                  .slice(0, groupIndex)
                  .reduce((acc, g) => acc + g.items.length, 0) + index;
                const isCurrent = item.path === bestMatch;
                return (
                  <SortableNavItem
                    key={item.key}
                    item={item}
                    isCurrent={isCurrent}
                    collapsed={collapsed}
                    editMode={editMode}
                    onNavigate={onNavigate}
                    globalIndex={globalIndex}
                  />
                );
              })}
              {editMode && group.items.length === 0 && (
                <EmptyGroupDropZone groupKey={group.key} />
              )}
            </div>
            );
          })}
        </SortableContext>
        <DragOverlay>
          {activeId && navItemMap.get(activeId) && (() => {
            const item = navItemMap.get(activeId)!;
            return (
              <div className="flex items-center gap-3 rounded-md bg-sidebar-accent px-3 py-2 text-sm font-medium text-sidebar-foreground shadow-lg">
                <GripVertical className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40" />
                <item.icon className="h-4 w-4 shrink-0" />
                <span>{t(`adminNav.items.${item.key}`)}</span>
              </div>
            );
          })()}
        </DragOverlay>
      </DndContext>

      {/* Edit mode toolbar */}
      {editMode && !collapsed && (
        <div className="mt-2 flex flex-col gap-2 px-2 border-t border-sidebar-border/50 pt-2">
          {/* Add custom group */}
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddGroup()}
              placeholder={t('adminNav.newGroupPlaceholder')}
              className="flex-1 rounded-md bg-sidebar-accent/50 px-2 py-1 text-xs text-sidebar-foreground placeholder:text-sidebar-foreground/30 outline-none focus:ring-1 focus:ring-sidebar-primary"
              aria-label={t('adminNav.newGroupPlaceholder')}
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground"
              onClick={handleAddGroup}
              disabled={!newGroupName.trim()}
            >
              +
            </Button>
          </div>

          {/* Save / Cancel / Reset */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 h-7 text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground"
              onClick={cancelEditing}
            >
              {t('adminNav.cancel')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-sidebar-foreground/40 hover:text-sidebar-foreground"
              onClick={resetOrder}
              aria-label={t('adminNav.resetOrder')}
            >
              <RotateCcw className="h-3 w-3" />
            </Button>
            <Button
              variant="default"
              size="sm"
              className="flex-1 h-7 text-xs"
              onClick={saveEditing}
              disabled={!isDirty}
            >
              {t('adminNav.save')}
            </Button>
          </div>
        </div>
      )}
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

  // Glass settings — used to compute classes; backdrop-filter handled in index.css
  const glassEnabled = useGlassStore((s) => s.glassEnabled);
  const sidebarGlassEnabled = useGlassStore((s) => s.sidebar.enabled);
  const headerGlassEnabled = useGlassStore((s) => s.header.enabled);
  const sidebarGlassActive = glassEnabled && sidebarGlassEnabled;
  const headerGlassActive = glassEnabled && headerGlassEnabled;

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
      <div className="flex h-screen overflow-hidden relative z-10">
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
            'relative hidden md:flex flex-col text-sidebar-foreground transition-all duration-300',
            collapsed ? 'w-16' : 'w-64',
            sidebarGlassActive
              ? 'bg-sidebar/50 border-r border-sidebar-border/30'
              : 'bg-sidebar',
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
                onClick={() => setMobileOpen(true)}
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

              {/* GitHub / Update checker */}
              <UpdateIndicator />

              {/* Telegram */}
              <Button
                variant="ghost"
                size="icon"
                asChild
                aria-label="Telegram"
              >
                <a href="https://t.me/rezies_reiwa" target="_blank" rel="noreferrer">
                  <TelegramIcon className="h-4 w-4 text-[#2AABEE]" />
                </a>
              </Button>

              {/* Support */}
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

          {/* Page content */}
          <main className={cn(
            'flex-1 overflow-auto relative',
            glassEnabled ? 'bg-transparent' : 'bg-muted/20',
          )}>
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


// ── GitHub SVG Icon (lucide doesn't include brand logos) ───────────────────────
function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

// ── Telegram SVG Icon ──────────────────────────────────────────────────────────
function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

// ── GitHub Update Indicator ────────────────────────────────────────────────────
function UpdateIndicator() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['update-checker', 'status'],
    queryFn: () => getUpdateStatus(false),
    staleTime: 5 * 60_000,
    refetchInterval: 30 * 60_000,
  });

  const hasUpdate = data?.hasUpdate && data.latest;
  const currentVersion = data?.current ?? '0.1.3';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={t('adminShell.github.label')}
        >
          <GitHubIcon className={cn('h-4 w-4', hasUpdate && 'text-[#2dd4bf]')} />
          {hasUpdate && (
            <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-[#2dd4bf] animate-pulse" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{t('adminShell.github.title')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <span className="text-xs text-muted-foreground">
            {t('adminShell.github.current')}: <code className="font-mono">{currentVersion}</code>
          </span>
        </DropdownMenuItem>
        {hasUpdate && (
          <>
            <DropdownMenuItem disabled>
              <span className="text-xs text-[#2dd4bf] font-medium">
                {t('adminShell.github.available')}: <code className="font-mono">{data.latest}</code>
              </span>
            </DropdownMenuItem>
            {data.htmlUrl && (
              <DropdownMenuItem asChild>
                <a href={data.htmlUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2">
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t('adminShell.github.releaseNotes')}
                </a>
              </DropdownMenuItem>
            )}
          </>
        )}
        {!hasUpdate && (
          <DropdownMenuItem disabled>
            <span className="text-xs text-green-500">{t('adminShell.github.upToDate')}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="https://github.com/dizzzable/rezeis" target="_blank" rel="noreferrer" className="flex items-center gap-2">
            <GitHubIcon className="h-3.5 w-3.5" />
            {t('adminShell.github.repo')}
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Support / Donate Dropdown ──────────────────────────────────────────────────
function SupportDropdown() {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('adminShell.support.label')}>
          <Heart className="h-4 w-4 text-red-500" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{t('adminShell.support.title')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a
            href="https://www.donationalerts.com/r/dizzzable"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2"
          >
            <Heart className="h-3.5 w-3.5 text-pink-500" />
            {t('adminShell.support.donate')}
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            navigator.clipboard?.writeText('TNmxGN8iL5p2yfreNF1DtCEzpQCLuVZjeR');
            // toast would be nice but we don't import it here
          }}
          className="flex items-center gap-2"
        >
          <Wallet className="h-3.5 w-3.5 text-blue-500" />
          <div className="flex flex-col">
            <span className="text-xs">{t('adminShell.support.crypto')}</span>
            <code className="text-[10px] text-muted-foreground font-mono truncate max-w-44">
              TNmxGN8iL5p2yfreNF1DtCEzpQCLuVZjeR
            </code>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <span className="text-[10px] text-muted-foreground">
            {t('adminShell.support.thanks')}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
