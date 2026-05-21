/**
 * Saved-filters helper.
 *
 * Per-page filter presets are persisted in `localStorage`. Each preset is
 * a JSON-serialisable record keyed by a free-form name. The hook is
 * intentionally untyped at the value level — pages know their own filter
 * shape and pass it through `T`.
 *
 * Storage key: `rezeis-admin:filters:<pageKey>`
 */
import { useCallback, useEffect, useState } from 'react';

export interface SavedFilter<T> {
  readonly name: string;
  readonly value: T;
}

function getStorageKey(pageKey: string): string {
  return `rezeis-admin:filters:${pageKey}`;
}

function readFromStorage<T>(pageKey: string): SavedFilter<T>[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(getStorageKey(pageKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SavedFilter<T> =>
        typeof item === 'object' && item !== null && typeof item.name === 'string',
    );
  } catch {
    return [];
  }
}

function writeToStorage<T>(pageKey: string, filters: readonly SavedFilter<T>[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(getStorageKey(pageKey), JSON.stringify(filters));
  } catch {
    /* swallow quota / privacy-mode errors */
  }
}

/**
 * Save / load / delete named filter presets for a single page.
 *
 * `pageKey` should be a stable identifier (e.g. `'audit'`, `'fraud'`).
 * The returned helpers are stable references suitable for passing to
 * memoised components.
 */
export function useSavedFilters<T>(pageKey: string): {
  presets: SavedFilter<T>[];
  save: (name: string, value: T) => void;
  load: (name: string) => T | null;
  remove: (name: string) => void;
} {
  const [presets, setPresets] = useState<SavedFilter<T>[]>(() => readFromStorage<T>(pageKey));

  // Cross-tab sync.
  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key === getStorageKey(pageKey)) {
        setPresets(readFromStorage<T>(pageKey));
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [pageKey]);

  const save = useCallback(
    (name: string, value: T) => {
      const trimmed = name.trim();
      if (trimmed.length === 0) return;
      setPresets((prev) => {
        const next = [
          ...prev.filter((p) => p.name !== trimmed),
          { name: trimmed, value },
        ];
        writeToStorage(pageKey, next);
        return next;
      });
    },
    [pageKey],
  );

  const load = useCallback(
    (name: string): T | null => {
      const found = presets.find((p) => p.name === name);
      return found ? found.value : null;
    },
    [presets],
  );

  const remove = useCallback(
    (name: string) => {
      setPresets((prev) => {
        const next = prev.filter((p) => p.name !== name);
        writeToStorage(pageKey, next);
        return next;
      });
    },
    [pageKey],
  );

  return { presets, save, load, remove };
}
