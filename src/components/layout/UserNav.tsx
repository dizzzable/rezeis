import { useNavigate } from 'react-router';
import { User, Settings, LogOut, Palette } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeSelector } from '@/components/ThemeSelector';
import { useAuth, useAuthStore } from '@/stores/auth.store';

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
 * User navigation dropdown component
 */
export function UserNav({ className }: { className?: string }): React.ReactElement {
  const navigate = useNavigate();
  const { user } = useAuth();
  const logout = useAuthStore((state) => state.logout);

  const handleLogout = async (): Promise<void> => {
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch {
      navigate('/login', { replace: true });
    }
  };

  const displayName = user?.name || user?.firstName || user?.username || 'User';
  const initials = getUserInitials(user?.name || user?.firstName);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn('relative h-9 w-9 rounded-full', className)}
          aria-label="Open user menu"
        >
          <Avatar className="h-9 w-9">
            <AvatarImage src={user?.photoUrl} alt={displayName} />
            <AvatarFallback className="bg-primary/10 text-primary font-medium">
              {initials}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end" forceMount>
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{displayName}</p>
            <p className="text-xs leading-none text-muted-foreground">
              {user?.username || user?.telegramId || 'admin'}
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => navigate('/settings')}
            className="cursor-pointer"
          >
            <User className="mr-2 h-4 w-4" aria-hidden="true" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => navigate('/settings')}
            className="cursor-pointer"
          >
            <Settings className="mr-2 h-4 w-4" aria-hidden="true" />
            Settings
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <div className="flex items-center gap-2 text-sm">
            <Palette className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-muted-foreground">Theme</span>
          </div>
          <div className="mt-2">
            <ThemeSelector variant="outline" size="sm" />
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleLogout}
          className="cursor-pointer text-destructive focus:text-destructive"
        >
          <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default UserNav;