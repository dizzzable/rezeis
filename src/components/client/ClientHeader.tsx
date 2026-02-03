import { Bell, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/ThemeToggle';
import { MobileSidebarTrigger } from './ClientSidebar';
import { useClientNotifications } from '@/stores/client.store';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth, useAuthStore } from '@/stores/auth.store';
import { useNavigate } from 'react-router';

/**
 * ClientHeader props interface
 */
interface ClientHeaderProps {
  onMenuClick: () => void;
}

/**
 * ClientHeader component for the client dashboard
 */
export function ClientHeader({ onMenuClick }: ClientHeaderProps): React.ReactElement {
  const { unreadCount } = useClientNotifications();
  const { user } = useAuth();
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();

  const handleLogout = async (): Promise<void> => {
    await logout();
    navigate('/login');
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4 lg:px-6">
      {/* Left side - Menu button */}
      <div className="flex items-center gap-4">
        <MobileSidebarTrigger onClick={onMenuClick} />
        <span className="text-sm text-muted-foreground hidden md:inline">
          Личный кабинет
        </span>
      </div>

      {/* Right side - Actions */}
      <div className="flex items-center gap-2">
        {/* Notifications */}
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={`Уведомления ${unreadCount > 0 ? `(${unreadCount} непрочитанных)` : ''}`}
        >
          <Bell className="h-5 w-5" aria-hidden="true" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -right-1 -top-1 h-5 w-5 items-center justify-center rounded-full p-0 text-xs"
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </Badge>
          )}
        </Button>

        {/* Theme Toggle */}
        <ThemeToggle variant="ghost" size="icon" />

        {/* User Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative h-8 w-8 rounded-full">
              <User className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="end" forceMount>
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-medium leading-none">
                  {user?.name || user?.firstName || user?.username}
                </p>
                <p className="text-xs leading-none text-muted-foreground">
                  {user?.username}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/client/settings')}>
              Настройки
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate('/client/subscriptions')}>
              Мои подписки
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout}>
              Выйти
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

export default ClientHeader;
