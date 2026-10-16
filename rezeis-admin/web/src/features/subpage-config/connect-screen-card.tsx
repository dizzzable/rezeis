/**
 * The switch that moves "Подключить" inside the cabinet.
 *
 * A card of its own rather than a field in the editor below it, because it is
 * not part of the catalog an operator edits — it is the decision about whether
 * anybody sees that catalog at all, and it stays usable while the catalog is
 * half-written.
 *
 * It reads and writes the v2 config directly. The editor beside it is still
 * bound to v1 and the two are stored under separate keys, so neither can save
 * over the other.
 *
 * ── One key, one reader ───────────────────────────────────────────
 *
 * This card used to declare its own `['admin','connect-page']` with its own
 * shallow schema, and both it and the editor are always mounted. React Query
 * keys ARE the cache entry: two observers on one key share the row, and the
 * fetch runs whichever `queryFn` the winning observer had. When this card's won,
 * its schema dropped `corrupted` on the floor — and `corrupted` is the flag that
 * says "the row in the database cannot be read, what you see below is the
 * built-in default, saving over it destroys your real catalog". The editor's red
 * banner went dark, silently, decided by mount order.
 *
 * So the key and the reader come from the editor's module now. This card wants
 * one boolean out of that answer; it does not want a second opinion about the
 * shape of it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Footprints, Link2, ListChecks } from 'lucide-react';
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { CONNECT_PAGE_KEYS, connectPageApi } from '@/features/connect-page/connect-page-api';
import { usePermissionStore } from '@/features/rbac/use-permission-store';

/**
 * Writes the switch and NOTHING else.
 *
 * It used to PUT the whole config back with one boolean changed, which meant
 * the first flick froze the built-in default catalog into the database
 * forever — no later improvement to it would ever reach this install — and a
 * catalog draft branched before the flick silently turned the screen off
 * again on the next save. The switch has its own row and its own endpoint.
 */
async function setEnabled(enabled: boolean): Promise<boolean> {
  const response = await api.put('/admin/connect-page/enabled', { enabled });
  return z.object({ enabled: z.boolean() }).parse(response.data).enabled;
}

type ConnectScreenMode = 'screen' | 'interactive';

/** The mode, on its own row and its own endpoint, for the reason the switch has one. */
async function setMode(mode: ConnectScreenMode): Promise<ConnectScreenMode> {
  const response = await api.put('/admin/connect-page/mode', { mode });
  return z.object({ mode: z.enum(['screen', 'interactive']) }).parse(response.data).mode;
}

const MODE_OPTIONS = [
  {
    mode: 'screen',
    icon: ListChecks,
    title: 'connectScreen.modeScreen',
    hint: 'connectScreen.modeScreenHint',
  },
  {
    mode: 'interactive',
    icon: Footprints,
    title: 'connectScreen.modeInteractive',
    hint: 'connectScreen.modeInteractiveHint',
  },
] as const satisfies ReadonlyArray<{
  readonly mode: ConnectScreenMode;
  readonly icon: typeof Link2;
  readonly title: string;
  readonly hint: string;
}>;

export function ConnectScreenCard(): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canEdit = usePermissionStore((state) => state.hasPermission('subpage_config', 'edit'));

  const { data, isLoading } = useQuery({
    queryKey: CONNECT_PAGE_KEYS.all,
    queryFn: connectPageApi.get,
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setEnabled(enabled),
    onSuccess: (_written, enabled) => {
      void queryClient.invalidateQueries({ queryKey: CONNECT_PAGE_KEYS.all });
      toast.success(
        enabled ? t('connectScreen.turnedOn') : t('connectScreen.turnedOff'),
      );
    },
    onError: () => toast.error(t('connectScreen.saveFailed')),
  });

  const pickMode = useMutation({
    mutationFn: (mode: ConnectScreenMode) => setMode(mode),
    onSuccess: (written) => {
      void queryClient.invalidateQueries({ queryKey: CONNECT_PAGE_KEYS.all });
      toast.success(
        written === 'interactive'
          ? t('connectScreen.modeSavedInteractive')
          : t('connectScreen.modeSavedScreen'),
      );
    },
    onError: () => toast.error(t('connectScreen.saveFailed')),
  });

  const enabled = data?.config.connectScreenEnabled === true;
  const mode: ConnectScreenMode = data?.config.connectScreenMode === 'interactive' ? 'interactive' : 'screen';
  // "Unknown" is not "off". A failed read used to render a confident off
  // position for a switch nobody had touched.
  const unknown = !isLoading && data === undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Link2 className="h-5 w-5" /> {t('connectScreen.title')}
        </CardTitle>
        <CardDescription>{t('connectScreen.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : unknown ? (
          <p className="text-sm text-muted-foreground">{t('connectScreen.unknown')}</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/30 p-3">
              <div className="space-y-0.5">
                <Label className="text-sm">{t('connectScreen.label')}</Label>
                <p className="text-xs text-muted-foreground">
                  {enabled ? t('connectScreen.hintOn') : t('connectScreen.hintOff')}
                </p>
              </div>
              <Switch
                checked={enabled}
                disabled={toggle.isPending || !canEdit}
                onCheckedChange={(next) => toggle.mutate(next)}
                aria-label={t('connectScreen.label')}
              />
            </div>

            {/* Chosen whether the switch is on or off: picking the walk ahead
                of turning the screen on is a legitimate order, and the choice
                does nothing until the switch says so — which the line under
                the options states rather than leaving it to be discovered. */}
            <div className="space-y-2">
              <p id="connect-screen-mode-label" className="text-sm font-medium">
                {t('connectScreen.modeLabel')}
              </p>
              <div
                role="radiogroup"
                aria-labelledby="connect-screen-mode-label"
                className="grid gap-2 sm:grid-cols-2"
              >
                {MODE_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const selected = mode === option.mode;
                  return (
                    <button
                      key={option.mode}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-connect-screen-mode={option.mode}
                      disabled={pickMode.isPending || !canEdit}
                      onClick={() => {
                        if (!selected) pickMode.mutate(option.mode);
                      }}
                      className={cn(
                        'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                        selected
                          ? 'border-primary bg-primary/10'
                          : 'border-border/60 bg-muted/30 hover:bg-muted/60',
                      )}
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn('mt-0.5 h-4 w-4 shrink-0', selected ? 'text-primary' : 'text-muted-foreground')}
                      />
                      <span className="space-y-0.5">
                        <span className="block text-sm font-medium">{t(option.title)}</span>
                        <span className="block text-xs text-muted-foreground">{t(option.hint)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {enabled
                  ? mode === 'interactive'
                    ? t('connectScreen.modeOldCabinet')
                    : t('connectScreen.modeScreenNote')
                  : t('connectScreen.modeOffNote')}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
