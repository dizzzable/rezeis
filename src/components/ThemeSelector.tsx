/**
 * Theme Selector Component
 * 
 * Dropdown component for selecting themes with search, category grouping,
 * and live preview of theme colors.
 * 
 * @module components/ThemeSelector
 */

import { useState, useRef, useEffect } from 'react';
import { Palette, Check, ChevronDown, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useThemeStore } from '@/stores/theme.store';
import { themes, getThemesByCategory, categoryLabels, type Theme, type ThemeCategory } from '@/themes';
import { cn } from '@/lib/utils';

/**
 * Props for the ThemeSelector component
 */
interface ThemeSelectorProps {
  /** Additional CSS classes */
  className?: string;
  /** Button variant style */
  variant?: 'default' | 'outline' | 'ghost';
  /** Button size */
  size?: 'default' | 'sm' | 'lg';
}

/**
 * Theme preview component showing color swatches
 * @param props - Component props with preview colors
 * @returns Color preview element
 */
function ThemePreview({ colors }: { colors: Theme['previewColors'] }) {
  return (
    <div className="flex gap-1">
      <div
        className="w-4 h-4 rounded-full border border-border"
        style={{ backgroundColor: colors.background }}
        aria-hidden="true"
      />
      <div
        className="w-4 h-4 rounded-full border border-border"
        style={{ backgroundColor: colors.primary }}
        aria-hidden="true"
      />
      <div
        className="w-4 h-4 rounded-full border border-border"
        style={{ backgroundColor: colors.accent }}
        aria-hidden="true"
      />
    </div>
  );
}

/**
 * Theme selector dropdown component
 * 
 * Provides a searchable dropdown with grouped themes and color previews.
 * 
 * @param props - Component props
 * @returns The theme selector component
 */
export function ThemeSelector({
  className,
  variant = 'outline',
  size = 'default',
}: ThemeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  const { currentThemeId, setTheme } = useThemeStore((state) => ({
    currentThemeId: state.currentThemeId,
    setTheme: state.setTheme,
  }));

  const currentTheme = themes.find((t) => t.id === currentThemeId) ?? themes[0];

  // Filter themes based on search query
  const filteredThemes = searchQuery
    ? themes.filter(
        (theme) =>
          theme.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          theme.description.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : themes;

  // Group themes by category when not searching
  const groupedThemes = getThemesByCategory();

  /**
   * Handle theme selection
   * @param themeId - Selected theme ID
   */
  const handleSelectTheme = (themeId: string) => {
    setTheme(themeId);
    setIsOpen(false);
    setSearchQuery('');
  };

  /**
   * Handle click outside to close dropdown
   */
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      // Focus search input when opened
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  /**
   * Handle keyboard navigation
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return;

      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  return (
    <div ref={dropdownRef} className={cn('relative', className)}>
      {/* Trigger button */}
      <Button
        variant={variant}
        size={size}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 min-w-[160px]"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      >
        <Palette className="h-4 w-4" aria-hidden="true" />
        <span className="flex-1 text-left truncate">{currentTheme.name}</span>
        <ThemePreview colors={currentTheme.previewColors} />
        <ChevronDown
          className={cn(
            'h-4 w-4 transition-transform duration-200',
            isOpen && 'rotate-180'
          )}
          aria-hidden="true"
        />
      </Button>

      {/* Dropdown menu */}
      {isOpen && (
        <Card className="absolute right-0 top-full mt-2 w-[320px] max-h-[500px] overflow-hidden z-50 border shadow-lg">
          {/* Search header */}
          <div className="p-3 border-b bg-muted/50">
            <div className="relative">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                ref={searchInputRef}
                type="text"
                placeholder="Search themes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9"
                aria-label="Search themes"
              />
            </div>
          </div>

          {/* Theme list */}
          <div className="overflow-y-auto max-h-[400px] p-2 space-y-1">
            {filteredThemes.length > 0 ? (
              searchQuery ? (
                // Flat list when searching
                filteredThemes.map((theme) => (
                  <ThemeItem
                    key={theme.id}
                    theme={theme}
                    isSelected={theme.id === currentThemeId}
                    onSelect={() => handleSelectTheme(theme.id)}
                  />
                ))
              ) : (
                // Grouped list when not searching
                (Object.keys(groupedThemes) as ThemeCategory[])
                  .filter((category) => groupedThemes[category]?.length > 0)
                  .map((category) => (
                    <div key={category} className="mb-4">
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 py-2">
                        {categoryLabels[category]}
                      </h3>
                      <div className="space-y-1">
                        {groupedThemes[category]?.map((theme: Theme) => (
                          <ThemeItem
                            key={theme.id}
                            theme={theme}
                            isSelected={theme.id === currentThemeId}
                            onSelect={() => handleSelectTheme(theme.id)}
                          />
                        ))}
                      </div>
                    </div>
                  ))
              )
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                No themes found
              </div>
            )}
          </div>

          {/* Footer with count */}
          <div className="px-3 py-2 border-t bg-muted/50 text-xs text-muted-foreground text-center">
            {filteredThemes.length} theme{filteredThemes.length !== 1 ? 's' : ''} available
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * Individual theme item component
 * @param props - Component props
 * @returns Theme item element
 */
interface ThemeItemProps {
  theme: Theme;
  isSelected: boolean;
  onSelect: () => void;
}

function ThemeItem({ theme, isSelected, onSelect }: ThemeItemProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors',
        'hover:bg-accent focus:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
        isSelected && 'bg-accent'
      )}
      role="option"
      aria-selected={isSelected}
    >
      {/* Color preview */}
      <div className="flex-shrink-0">
        <ThemePreview colors={theme.previewColors} />
      </div>

      {/* Theme info */}
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{theme.name}</div>
        <div className="text-xs text-muted-foreground truncate">
          {theme.description}
        </div>
      </div>

      {/* Selected indicator */}
      {isSelected && (
        <Check className="h-4 w-4 text-primary flex-shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

export default ThemeSelector;
