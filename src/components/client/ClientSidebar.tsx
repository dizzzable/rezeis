import { useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  CreditCard,
  Package,
  History,
  Users,
  Handshake,
  Settings,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
  Shield,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useAuth } from '@/stores/auth.store';
import { useClientNotifications } from '@/stores/client.store';

/**
 * Navigation item interface
 */
interface NavItem {
  icon: LucideIcon;
  label: string;
  href: string;
  badge?: number;
}

/**
 * ClientSidebar props interface
 */
interface ClientSidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Navigation items configuration for client dashboard
 */
const getNavItems = (unreadCount: number): NavItem[] => [
  {
    icon: LayoutDashboard,
    label: 'Dashboard',
    href: '/client',
  },
  {
    icon: CreditCard,
    label: 'Мои подписки',
    href: '/client/subscriptions',
  },
  {
    icon: Package,
    label: 'Тарифы',
    href: '/client/plans',
  },
  {
    icon: History,
    label: 'История платежей',
    href: '/client/payments',
  },
  {
    icon: Users,
    label: 'Рефералы',
    href: '/client/referrals',
  },
  {
    icon: Handshake,
    label: 'Партнерка',
    href: '/client/partner',
  },
  {
    icon: Settings,
    label: 'Настройки',
    href: '/client/settings',
    badge: unreadCount > 0 ? unreadCount : undefined,
  },
];

/**
 * Get user initials from name
 */
function getUserInitials(name: string | undefined): string {
  if (!name) return 'U';
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/**
 * NavItem component for individual navigation links
 */
function NavItemComponent({
  item,
  isCollapsed,
  onItemClick,
}: {
  item: NavItem;
  isCollapsed: boolean;
  onItemClick?: () => void;
}): React.ReactElement {
  const location = useLocation();
  const isActive = location.pathname === item.href || location.pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;

  const linkContent = (
    <>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!isCollapsed && (
        <>
          <span className="flex-1">{item.label}</span>
          {item.badge !== undefined && item.badge > 0 && (
            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
              {item.badge > 99 ? '99+' : item.badge}
            </span>
          )}
        </>
      )}
    </>
  );

  if (isCollapsed) {
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to={item.href}
              onClick={onItemClick}
              className={cn(
                'flex items-center justify-center rounded-md px-3 py-2 transition-colors relative',
                'hover:bg-accent hover:text-accent-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive && 'bg-accent text-accent-foreground'
              )}
              aria-current={isActive ? 'page' : undefined}
            >
              {linkContent}
              {item.badge !== undefined && item.badge > 0 && (
                <span className="absolute right-1 top-1 flex h-2 w-2 rounded-full bg-primary" />
              )}
            </NavLink>
          </TooltipTrigger>
          <TooltipContent side="right" className="border-border bg-popover text-popover-foreground">
            {item.label}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <NavLink
      to={item.href}
      onClick={onItemClick}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isActive && 'bg-accent text-accent-foreground'
      )}
      aria-current={isActive ? 'page' : undefined}
    >
      {linkContent}
    </NavLink>
  );
}

/**
 * ClientSidebar component for client dashboard navigation
 */
export function ClientSidebar({ isOpen, onClose }: ClientSidebarProps): React.ReactElement {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { user } = useAuth();
  const { unreadCount } = useClientNotifications();

  const toggleCollapse = (): void => {
    setIsCollapsed((prev) => !prev);
  };

  const handleItemClick = (): void => {
    if (window.innerWidth < 768) {
      onClose();
    }
  };

  const navItems = getNavItems(unreadCount);

  const sidebarContent = (
    <div className="flex h-full flex-col">
      {/* Logo Section */}
      <div className="flex h-16 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary">
            <Shield className="h-5 w-5 text-primary-foreground" aria-hidden="true" />
          </div>
          {!isCollapsed && (
            <span className="truncate text-lg font-semibold">AltShop</span>
          )}
        </div>
        {/* Collapse Toggle (Desktop) */}
        <Button
          variant="ghost"
          size="icon"
          className="hidden h-8 w-8 shrink-0 md:flex"
          onClick={toggleCollapse}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {isCollapsed ? (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
        {/* Close Button (Mobile) */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 md:hidden"
          onClick={onClose}
          aria-label="Close sidebar"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 px-3 py-4">
        <nav className="space-y-1" aria-label="Client navigation">
          {navItems.map((item) => (
            <NavItemComponent
              key={item.href}
              item={item}
              isCollapsed={isCollapsed}
              onItemClick={handleItemClick}
            />
          ))}
        </nav>
      </ScrollArea>

      {/* User Info Section */}
      <div className="border-t p-4">
        <div
          className={cn(
            'flex items-center gap-3 overflow-hidden',
            isCollapsed && 'justify-center'
          )}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
            {user?.photoUrl ? (
              <img
                src={user.photoUrl}
                alt=""
                className="h-full w-full rounded-full object-cover"
              />
            ) : (
              <span className="text-sm font-medium text-primary">
                {getUserInitials(user?.name || user?.firstName)}
              </span>
            )}
          </div>
          {!isCollapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {user?.name || user?.firstName || user?.username || 'User'}
              </p>
              <p className="truncate text-xs text-muted-foreground capitalize">
                {user?.role === 'user' ? 'Клиент' : user?.role}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        className={cn(
          'fixed left-0 top-0 z-40 hidden h-screen border-r bg-sidebar text-sidebar-foreground transition-all duration-300 md:block',
          isCollapsed ? 'w-16' : 'w-64'
        )}
        aria-label="Client sidebar navigation"
      >
        {sidebarContent}
      </aside>

      {/* Mobile Sidebar (Sheet) */}
      <Sheet open={isOpen} onOpenChange={onClose}>
        <SheetContent side="left" className="w-64 p-0">
          {sidebarContent}
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * MobileSidebarTrigger component for mobile menu button
 */
export function MobileSidebarTrigger({ onClick }: { onClick: () => void }): React.ReactElement {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="md:hidden"
      onClick={onClick}
      aria-label="Open sidebar"
    >
      <Menu className="h-5 w-5" aria-hidden="true" />
    </Button>
  );
}

export default ClientSidebar;
