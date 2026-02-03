import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Breadcrumbs } from './Breadcrumbs';
import { UserNav } from './UserNav';
import { MobileSidebarTrigger } from './Sidebar';

/**
 * Header props interface
 */
interface HeaderProps {
  onMenuClick: () => void;
  isSidebarOpen?: boolean;
}

/**
 * Header component for the admin panel
 */
export function Header({ onMenuClick }: HeaderProps): React.ReactElement {
  // Placeholder notification count
  const notificationCount = 3;

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4 lg:px-6">
      {/* Left side - Menu button and Breadcrumbs */}
      <div className="flex items-center gap-4">
        <MobileSidebarTrigger onClick={onMenuClick} />
        <Breadcrumbs className="hidden md:flex" />
      </div>

      {/* Right side - Actions */}
      <div className="flex items-center gap-2">
        {/* Notifications */}
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={`Notifications ${notificationCount > 0 ? `(${notificationCount} unread)` : ''}`}
        >
          <Bell className="h-5 w-5" aria-hidden="true" />
          {notificationCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -right-1 -top-1 h-5 w-5 items-center justify-center rounded-full p-0 text-xs"
            >
              {notificationCount > 9 ? '9+' : notificationCount}
            </Badge>
          )}
        </Button>

        {/* Theme Toggle */}
        <ThemeToggle variant="ghost" size="icon" />

        {/* User Menu */}
        <UserNav />
      </div>
    </header>
  );
}

export default Header;