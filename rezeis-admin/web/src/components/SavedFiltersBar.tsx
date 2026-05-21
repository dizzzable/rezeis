import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bookmark, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSavedFilters } from '@/lib/saved-filters';

interface SavedFiltersBarProps<T> {
  /** Stable identifier for the page (e.g. `'audit'`, `'fraud'`). */
  pageKey: string;
  /** Current filter snapshot — what we save when the operator clicks "Save". */
  current: T;
  /** Called when a saved preset is selected. */
  onLoad: (value: T) => void;
}

/**
 * Reusable filter-presets row.
 *
 * Renders a "Saved" dropdown with operator-defined presets and a "Save…"
 * dialog. The whole component is generic so any filter shape can be
 * persisted without per-page boilerplate.
 *
 * Wire this above the existing filter inputs and pass the current filter
 * state as `current`; on `onLoad`, call your `setX` setters.
 */
export function SavedFiltersBar<T>({
  pageKey,
  current,
  onLoad,
}: SavedFiltersBarProps<T>) {
  const { t } = useTranslation();
  const { presets, save, remove } = useSavedFilters<T>(pageKey);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <Bookmark className="h-3.5 w-3.5" />
            {t('savedFiltersBar.title')}
            {presets.length > 0 && (
              <span className="text-[10px] text-muted-foreground rounded bg-muted px-1.5 py-0.5">
                {presets.length}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>{t('savedFiltersBar.presets')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {presets.length === 0 ? (
            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
              {t('savedFiltersBar.empty')}
            </DropdownMenuItem>
          ) : (
            presets.map((preset) => (
              <DropdownMenuItem
                key={preset.name}
                className="flex items-center justify-between gap-2"
                onClick={() => onLoad(preset.value)}
              >
                <span className="truncate">{preset.name}</span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(preset.name);
                  }}
                  aria-label={t('savedFiltersBar.deletePreset')}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <Plus className="h-3.5 w-3.5" />
            {t('savedFiltersBar.saveOpen')}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('savedFiltersBar.saveDialogTitle')}</DialogTitle>
            <DialogDescription>{t('savedFiltersBar.saveDialogDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>{t('savedFiltersBar.nameLabel')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              placeholder={t('savedFiltersBar.namePlaceholder')}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('savedFiltersBar.cancel')}
            </Button>
            <Button
              onClick={() => {
                const trimmed = name.trim();
                if (trimmed.length === 0) return;
                save(trimmed, current);
                toast.success(t('savedFiltersBar.savedToast', { name: trimmed }));
                setName('');
                setOpen(false);
              }}
              disabled={name.trim().length === 0}
            >
              {t('savedFiltersBar.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
