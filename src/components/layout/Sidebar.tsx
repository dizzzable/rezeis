import { useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Users,
  CreditCard,
  Package,
  BarChart3,
  Settings,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Shield,
  Menu,
  X,
  Lock,
  Database,
  Megaphone,
  Ticket,
  Wallet,
  Image,
  Handshake,
  Gift,
  Server,
  Upload,
  Bell,
  Clock,
  Activity,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useAuth } from '@/stores/auth.store';

/**
 * Navigation item interface
 */
interface NavItem {
  icon: LucideIcon;
  label: string;
  href: string;
  children?: NavItem[];
}

/**
 * Sidebar props interface
 */
interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Navigation items configuration
 */
const getNavItems = (isSuperAdmin: boolean): NavItem[] => {
  const items: NavItem[] = [
    {
      icon: LayoutDashboard,
      label: 'Dashboard',
      href: '/dashboard',
    },
    {
      icon: Users,
      label: 'Users',
      href: '/users',
      children: [
        { icon: Users, label: 'All Users', href: '/users' },
        { icon: Users, label: 'Active', href: '/users/active' },
        { icon: Users, label: 'Expired', href: '/users/expired' },
      ],
    },
    {
      icon: CreditCard,
      label: 'Subscriptions',
      href: '/subscriptions',
      children: [
        { icon: CreditCard, label: 'All', href: '/subscriptions' },
        { icon: CreditCard, label: 'Active', href: '/subscriptions/active' },
        { icon: CreditCard, label: 'Expiring Soon', href: '/subscriptions/expiring' },
      ],
    },
    {
      icon: Package,
      label: 'Plans',
      href: '/plans',
    },
    {
      icon: BarChart3,
      label: 'Statistics',
      href: '/statistics',
    },
    {
      icon: Activity,
      label: 'Monitoring',
      href: '/monitoring',
    },
    {
      icon: Megaphone,
      label: 'Broadcast',
      href: '/broadcast',
    },
    {
      icon: Bell,
      label: 'Notifications',
      href: '/notifications',
    },
    // Admin section
    {
      icon: Ticket,
      label: 'Admin Promocodes',
      href: '/admin/promocodes',
    },
    {
      icon: Clock,
      label: 'Trial Settings',
      href: '/admin/trial-settings',
    },
    {
      icon: Ticket,
      label: 'Promocodes',
      href: '/promocodes',
    },
    {
      icon: Wallet,
      label: 'Gateways',
      href: '/gateways',
    },
    {
      icon: Image,
      label: 'Banners',
      href: '/banners',
    },
    {
      icon: Handshake,
      label: 'Partners',
      href: '/partners',
    },
    {
      icon: Gift,
      label: 'Referrals',
      href: '/referrals',
    },
    {
      icon: Server,
      label: 'Remnawave',
      href: '/remnawave',
    },
    {
      icon: Upload,
      label: 'Importer',
      href: '/importer',
    },
  ];

  // Only show Access and Backup for super_admin
  if (isSuperAdmin) {
    items.push({
      icon: Lock,
      label: 'Access',
      href: '/access',
    });
    items.push({
      icon: Database,
      label: 'Backup',
      href: '/backup',
    });
  }

  items.push({
    icon: Settings,
    label: 'Settings',
    href: '/settings',
  });

  return items;
};

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
  const [isExpanded, setIsExpanded] = useState(() => {
    if (!item.children) return false;
    return item.children.some((child) => location.pathname === child.href);
  });
  const isActive = location.pathname === item.href;
  const hasChildren = item.children && item.children.length > 0;
  const Icon = item.icon;

  if (hasChildren) {
    return (
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CollapsibleTrigger asChild>
          <button
            className={cn(
              'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive && 'bg-accent text-accent-foreground'
            )}
            aria-expanded={isExpanded}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {!isCollapsed && (
              <>
                <span className="flex-1 text-left">{item.label}</span>
                <ChevronDown
                  className={cn(
                    'h-4 w-4 shrink-0 transition-transform',
                    isExpanded && 'rotate-180'
                  )}
                  aria-hidden="true"
                />
              </>
            )}
          </button>
        </CollapsibleTrigger>
        {!isCollapsed && (
          <CollapsibleContent className="space-y-1 pl-9">
            {item.children?.map((child) => {
              const ChildIcon = child.icon;
              const isChildActive = location.pathname === child.href;
              return (
                <NavLink
                  key={child.href}
                  to={child.href}
                  onClick={onItemClick}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                    'hover:bg-accent hover:text-accent-foreground',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isChildActive && 'bg-accent/50 text-accent-foreground font-medium'
                  )}
                  aria-current={isChildActive ? 'page' : undefined}
                >
                  <ChildIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                  {child.label}
                </NavLink>
              );
            })}
          </CollapsibleContent>
        )}
      </Collapsible>
    );
  }

  const linkContent = (
    <>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!isCollapsed && <span>{item.label}</span>}
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
                'flex items-center justify-center rounded-md px-3 py-2 transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive && 'bg-accent text-accent-foreground'
              )}
              aria-current={isActive ? 'page' : undefined}
            >
              {linkContent}
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
 * Sidebar component for navigation
 */
export function Sidebar({ isOpen, onClose }: SidebarProps): React.ReactElement {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { user } = useAuth();

  const toggleCollapse = (): void => {
    setIsCollapsed((prev) => !prev);
  };

  const handleItemClick = (): void => {
    if (window.innerWidth < 768) {
      onClose();
    }
  };

  const isUserSuperAdmin = user?.role === 'super_admin';
  const navItems = getNavItems(isUserSuperAdmin);

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
        <nav className="space-y-1" aria-label="Main navigation">
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
                {user?.role || 'Admin'}
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
        aria-label="Sidebar navigation"
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

export default Sidebar;