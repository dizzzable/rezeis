/**
 * Theme Toggle Component
 * 
 * Button component for toggling between light and dark modes.
 * Displays sun icon for dark mode (switch to light) and moon icon for light mode (switch to dark).
 * 
 * @module components/ThemeToggle
 */

import { Sun, Moon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useThemeStore } from '@/stores/theme.store';
import { cn } from '@/lib/utils';

/**
 * Props for the ThemeToggle component
 */
interface ThemeToggleProps {
  /** Additional CSS classes */
  className?: string;
  /** Button variant style */
  variant?: 'default' | 'outline' | 'ghost';
  /** Button size */
  size?: 'default' | 'sm' | 'lg' | 'icon';
}

/**
 * Theme toggle button component
 * 
 * Renders a button that toggles between light and dark modes.
 * Shows appropriate icon based on current mode.
 * 
 * @param props - Component props
 * @returns The theme toggle button
 */
export function ThemeToggle({
  className,
  variant = 'outline',
  size = 'icon',
}: ThemeToggleProps) {
  const { isDarkMode, toggleDarkMode } = useThemeStore((state) => ({
    isDarkMode: state.isDarkMode,
    toggleDarkMode: state.toggleDarkMode,
  }));

  /**
   * Handle toggle button click
   */
  const handleToggle = () => {
    toggleDarkMode();
  };

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleToggle}
      className={cn(
        'relative overflow-hidden transition-colors',
        className
      )}
      aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <span className="sr-only">
        {isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
      </span>
      
      {/* Sun icon - shown when in dark mode */}
      <Sun
        className={cn(
          'h-5 w-5 transition-all duration-300',
          isDarkMode
            ? 'rotate-0 scale-100'
            : '-rotate-90 scale-0 absolute'
        )}
        aria-hidden="true"
      />
      
      {/* Moon icon - shown when in light mode */}
      <Moon
        className={cn(
          'h-5 w-5 transition-all duration-300',
          isDarkMode
            ? 'rotate-90 scale-0 absolute'
            : 'rotate-0 scale-100'
        )}
        aria-hidden="true"
      />
    </Button>
  );
}

export default ThemeToggle;
